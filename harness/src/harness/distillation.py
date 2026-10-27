"""Distillation stage logic for the harness."""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from harness.env_flags import (
    distillation_enabled,
    knowledge_dir_for_scope,
    knowledge_dir_relative_path,
)
from harness.events import RoundEvents, iter_events
from harness.git import (
    candidate_repo_heads,
    candidate_repo_names,
    changed_repo_names_since,
    discard_paths,
    git_dirty_paths,
    has_working_tree_changes,
    is_knowledge_path,
    is_stray_knowledge_path,
    push_clean_commit_if_ahead,
    sync_target_repos_before_edit,
    unique_repo_names,
    update_existing_branch,
)
from harness.obs import timed_stage
from harness.paths import (
    DISTILLATION_JSON,
    MEMORY_DIR,
    PLAN_JSON,
    SESSION_JSON,
    WORKSPACE,
)
from harness.plan_utils import knowledge_subpaths_for_repo, repo_checkout_path
from harness.schemas import Distillation, DistillationRepo, Plan
from harness.stages import Stage
from harness.tracing import trace_span, traced_stage
from harness.util import (
    iso_now,
    load_json_file,
    write_json,
)

if TYPE_CHECKING:
    from harness.daemon import DaemonState


def _partition_distillation_repos(
    plan: Plan, knowledge_dir_relative: Path
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    eligible: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for repo in plan.repos:
        name = repo.name
        repo_path = repo_checkout_path(name, workspace=WORKSPACE)
        if not repo_path.is_dir():
            skipped.append({"repo": name, "skipped": "repository path missing"})
            continue
        knowledge_dir = knowledge_dir_for_scope(
            repo_path, knowledge_dir_relative, repo_root=repo_path
        )
        knowledge_subpaths = knowledge_subpaths_for_repo(repo, workspace=WORKSPACE)
        knowledge_dirs = list(
            dict.fromkeys(
                directory
                for directory in (
                    knowledge_dir,
                    *(
                        knowledge_dir_for_scope(
                            repo_path / sub, knowledge_dir_relative, repo_root=repo_path
                        )
                        for sub in knowledge_subpaths
                    ),
                )
                if directory is not None
            )
        )
        memory_dir = MEMORY_DIR / name
        memory_files = (
            sorted(
                str(p.relative_to(memory_dir))
                for p in memory_dir.rglob("*.md")
                if p.is_file()
            )
            if memory_dir.is_dir()
            else []
        )

        existing_knowledge_dirs = [
            directory
            for directory in knowledge_dirs
            if directory.is_dir() and any(directory.glob("*.md"))
        ]
        if not existing_knowledge_dirs:
            skipped_repo: dict[str, Any] = {
                "repo": name,
                "skipped": f"no {knowledge_dir_relative.as_posix()}/ bootstrap",
            }
            if memory_files:
                skipped_repo["memory_files_present"] = memory_files
            skipped.append(skipped_repo)
            continue

        eligible_repo: dict[str, Any] = {
            "repo": name,
            "path": str(repo_path),
            "memory_files_present": memory_files,
            "knowledge_dirs": [str(directory) for directory in existing_knowledge_dirs],
            "knowledge_subpaths": knowledge_subpaths,
        }
        # The root knowledge directory is absent when a symlink takes it
        # outside the repository; omit it rather than naming a destination.
        if knowledge_dir is not None:
            eligible_repo["knowledge_dir"] = str(knowledge_dir)
        eligible.append(eligible_repo)
    return eligible, skipped


def _coerce_plan(plan_data: Plan | Mapping[str, Any]) -> Plan:
    if isinstance(plan_data, Plan):
        return plan_data
    return Plan.model_validate(plan_data)


def _distillation_context(
    task: str,
    task_key: str,
    run_id: str,
    distillation_out: Path | None,
    eligible_repos: list[dict[str, Any]],
    skipped_repos: list[dict[str, Any]],
) -> str:
    eligible_block = "```json\n" + json.dumps(eligible_repos, indent=2) + "\n```"
    skipped_block = "```json\n" + json.dumps(skipped_repos, indent=2) + "\n```"
    ctx_lines = [
        "<harness_context>",
        f"<task>{task}</task>",
        f"- **run_id**: {run_id}",
        "- **stage**: distillation",
        f"- **memory_dir**: `{MEMORY_DIR}`",
        f"- **plan.json path**: `{PLAN_JSON.resolve()}`",
    ]
    if distillation_out is not None:
        ctx_lines.append(f"- **distillation.json output path**: `{distillation_out}`")
    ctx_lines += [
        f"- **task_key**: `{task_key}`",
        "",
        "### Distillation-eligible repos (pre-flight)",
        eligible_block,
        "",
        "### Distillation-skipped repos (pre-flight)",
        skipped_block,
        "</harness_context>",
    ]
    return "\n".join(ctx_lines)


def assemble_deepagents_distillation_prompt(
    task: str,
    task_key: str,
    run_id: str,
    eligible_repos: list[dict[str, Any]],
    skipped_repos: list[dict[str, Any]],
) -> str:
    """Assemble the standalone DeepAgents distillation brief."""
    return _distillation_context(
        task,
        task_key,
        run_id,
        None,
        eligible_repos,
        skipped_repos,
    )


def validate_distillation(data: Any) -> None:
    where = "distillation.json"

    if not isinstance(data, dict):
        raise TypeError(f"{where}: root must be object")

    d = data
    for k in ("stage", "run_id", "task", "repos", "generated_at"):
        if k not in d:
            raise ValueError(f"{where}: missing top-level key {k!r}")

    if d["stage"] != "distillation":
        raise ValueError(f'{where}: stage must be "distillation"')

    if not isinstance(d["repos"], list):
        raise TypeError(f"{where}: repos must be array")

    if "task_key" not in d:
        raise ValueError(f"{where}: task_key is required")

    for i, repo in enumerate(d["repos"]):
        rw = f"{where} repos[{i}]"
        if not isinstance(repo, dict):
            raise TypeError(f"{rw}: must be object")
        if "repo" not in repo:
            raise ValueError(f"{rw}: missing 'repo'")

        if "skipped" in repo:
            if not isinstance(repo["skipped"], str):
                raise TypeError(f"{rw}: skipped must be string")
            if "memory_files_present" in repo and not isinstance(
                repo["memory_files_present"], list
            ):
                raise TypeError(f"{rw}: memory_files_present must be array")
            if "response_summary" in repo:
                raise ValueError(
                    f"{rw}: response_summary is only valid for eligible repo entries"
                )
            continue

        for k in (
            "memory_files_read",
            "promoted_count",
            "dropped_count",
            "knowledge_files_updated",
        ):
            if k not in repo:
                raise ValueError(f"{rw}: missing {k!r}")

        if not isinstance(repo["memory_files_read"], list):
            raise TypeError(f"{rw}: memory_files_read must be array")
        if not isinstance(repo["knowledge_files_updated"], list):
            raise TypeError(f"{rw}: knowledge_files_updated must be array")
        if not isinstance(repo["promoted_count"], int):
            raise TypeError(f"{rw}: promoted_count must be integer")
        if not isinstance(repo["dropped_count"], int):
            raise TypeError(f"{rw}: dropped_count must be integer")
        if "dropped_examples" in repo and not isinstance(
            repo["dropped_examples"], list
        ):
            raise TypeError(f"{rw}: dropped_examples must be array")
        if "response_summary" in repo and not isinstance(repo["response_summary"], str):
            raise TypeError(f"{rw}: response_summary must be string")
        if "error" in repo and not isinstance(repo["error"], str):
            raise TypeError(f"{rw}: error must be string")


def _all_distillation_memory_files() -> list[str]:
    if not MEMORY_DIR.is_dir():
        return []
    memory_files: list[str] = []
    for repo_memory_dir in MEMORY_DIR.iterdir():
        if not repo_memory_dir.is_dir():
            continue
        memory_files.extend(
            str(path.relative_to(MEMORY_DIR))
            for path in repo_memory_dir.rglob("*.md")
            if path.is_file()
        )
    return sorted(memory_files)


def _read_json_or_none(path: Path) -> Any | None:
    if not path.exists():
        return None
    try:
        return load_json_file(path)
    except Exception:
        return None


def _distillation_response_summaries(data: Any) -> list[str]:
    if not isinstance(data, dict):
        return []
    repos = data.get("repos")
    if not isinstance(repos, list):
        return []
    summaries: list[str] = []
    for repo in repos:
        if not isinstance(repo, dict) or "skipped" in repo:
            continue
        summary = repo.get("response_summary")
        if isinstance(summary, str) and summary.strip():
            summaries.append(summary.strip())
    return summaries


def post_code_round_response_summary_from_artifact(path: Path | None = None) -> str:
    """Return the user-facing post-round knowledge summary from distillation output."""
    summaries = _distillation_response_summaries(
        _read_json_or_none(DISTILLATION_JSON if path is None else path)
    )
    if not summaries:
        return ""
    lines = ["Recorded knowledge from this round:"]
    for summary in summaries:
        lines.extend(line.strip() for line in summary.splitlines() if line.strip())
    return "\n".join(lines)


def _base_distillation_data(
    *,
    run_id: str,
    task: str,
    task_key: str,
    repos: list[dict[str, Any]],
    inbox_id: str | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "stage": "distillation",
        "run_id": run_id,
        "task": task,
        "task_key": task_key,
        "repos": repos,
        "generated_at": iso_now(),
    }
    if inbox_id is not None:
        data["inbox_id"] = inbox_id
    return data


def _log_skipped_repos(skipped_repos: list[dict[str, Any]]) -> None:
    for skipped in skipped_repos:
        repo_name = skipped.get("repo")
        reason = skipped.get("skipped")
        if isinstance(repo_name, str) and isinstance(reason, str):
            print(f"distillation: skipping {repo_name} — {reason}")


POST_CODE_ROUND_REPO_HEADS_EVENT = "post_code_round_repo_heads"
POST_CODE_ROUND_DISTILLATION_COMPLETED_EVENT = "post_code_round_distillation_completed"


@dataclass(frozen=True)
class PostCodeRoundDistillationResult:
    changed_repo_names: list[str] = field(default_factory=list)
    distilled_repo_names: list[str] = field(default_factory=list)
    knowledge_published: list[dict[str, str]] = field(default_factory=list)
    response_summary: str = ""
    distillation_ran: bool = False

    @property
    def knowledge_changed(self) -> bool:
        return bool(self.knowledge_published)


def candidate_repo_heads_for_round(
    repo_slugs: Sequence[str] | None = None,
) -> dict[str, str]:
    """Return current HEADs for the repos a follow-up round may mutate.

    GitHub-sourced rounds carry ``pr.repo`` (``owner/name`` or bare ``name``), so
    candidate detection is constrained to that checkout. Linear comments have no
    PR coordinate, so all current plan repos are candidates. The later HEAD
    comparison keeps answer-only rounds from triggering distillation.
    """
    plan_data = _read_json_or_none(PLAN_JSON)
    repos = plan_data.get("repos") if isinstance(plan_data, dict) else []
    fallback_names = (
        repo.get("name")
        for repo in repos
        if isinstance(repo, dict) and isinstance(repo.get("name"), str)
    )
    names = candidate_repo_names(
        repo_slugs or [],
        fallback_names,
        workspace=WORKSPACE,
    )
    heads = candidate_repo_heads(names, workspace=WORKSPACE)
    if not heads:
        planned_names = [
            repo.get("name")
            for repo in (repos if isinstance(repos, list) else [])
            if isinstance(repo, dict) and isinstance(repo.get("name"), str)
        ]
        if names:
            cause = (
                f"repo names resolved ({', '.join(names)}) but no matching "
                "local git checkout exists under the workspace"
            )
        elif repo_slugs:
            cause = "no local checkout matched the incoming repo slugs"
        elif not isinstance(plan_data, dict):
            cause = "plan.json is missing or unreadable at its expected path"
        elif not planned_names:
            cause = "plan.json has an empty or absent 'repos' list"
        else:
            cause = (
                f"planned repo names ({', '.join(planned_names)}) did not "
                "resolve to any local checkout under the workspace"
            )
        print(
            "post-code-round distillation has NO candidate repos: code "
            "changes made this round cannot be detected and distillation "
            f"will be skipped. Cause: {cause}. "
            f"(PLAN_JSON={PLAN_JSON}, repo_slugs={list(repo_slugs or [])})",
            file=sys.stderr,
        )
    return heads


def retryable_post_code_round_repo_heads(
    state: DaemonState,
    inbox_id: str,
    repo_slugs: Sequence[str] | None = None,
) -> dict[str, str]:
    """Return the durable pre-round HEAD snapshot for a follow-up round."""
    persisted = _post_code_round_repo_heads_from_events(state.events_file, inbox_id)
    if persisted is not None:
        return persisted
    heads = candidate_repo_heads_for_round(repo_slugs)
    state.append_event({
        "type": POST_CODE_ROUND_REPO_HEADS_EVENT,
        "inbox_id": inbox_id,
        "repo_heads": heads,
    })
    return heads


def post_code_round_distillation_completed(state: DaemonState, inbox_id: str) -> bool:
    return any(
        e.get("type") == POST_CODE_ROUND_DISTILLATION_COMPLETED_EVENT
        and e.get("inbox_id") == inbox_id
        for e in iter_events(state.events_file)
    )


def mark_post_code_round_distillation_completed(
    state: DaemonState,
    inbox_id: str,
    changed_repo_names: Sequence[str],
) -> None:
    state.append_event({
        "type": POST_CODE_ROUND_DISTILLATION_COMPLETED_EVENT,
        "inbox_id": inbox_id,
        "changed_repo_names": unique_repo_names(
            changed_repo_names, workspace=WORKSPACE
        ),
    })


def distill_and_publish_changed_repo_knowledge(
    run_id: str,
    task_key: str,
    changed_repo_names: Sequence[str],
    *,
    events: RoundEvents | None,
) -> PostCodeRoundDistillationResult:
    """Run standalone distillation for code-mutated repos and publish knowledge.

    This is for independent follow-up rounds (comment, CI, user-review) where the
    agent already committed and pushed code. It uses the default standalone
    DeepAgents distillation path, so no implementation-session marker is needed.
    """
    if not distillation_enabled():
        return PostCodeRoundDistillationResult()

    normalized = unique_repo_names(changed_repo_names, workspace=WORKSPACE)
    if not normalized:
        return PostCodeRoundDistillationResult()

    session = _read_json_or_none(SESSION_JSON)
    task = session.get("task") if isinstance(session, dict) else None
    if not isinstance(task, str) or not task.strip():
        raise RuntimeError(
            f"post-code-round distillation requires task in {SESSION_JSON}"
        )

    plan_data = _read_json_or_none(PLAN_JSON)
    if not isinstance(plan_data, dict):
        raise TypeError(
            f"post-code-round distillation requires plan data in {PLAN_JSON}"
        )
    filtered_plan = _filter_plan_to_repo_names(plan_data, normalized)
    filtered_repos = [
        repo
        for repo in filtered_plan.get("repos", [])
        if isinstance(repo, dict) and isinstance(repo.get("name"), str)
    ]
    filtered_names = [repo["name"] for repo in filtered_repos]
    plan_repos_by_name = {repo["name"]: repo for repo in filtered_repos}
    if not filtered_names:
        return PostCodeRoundDistillationResult(changed_repo_names=normalized)

    repo_paths = {
        name: repo_checkout_path(name, workspace=WORKSPACE) for name in filtered_names
    }
    clean_names = []
    for name, repo_path in repo_paths.items():
        if has_working_tree_changes(repo_path):
            print(
                "post-code-round distillation: skipping "
                f"{name} — worktree not clean before knowledge promotion"
            )
            continue
        clean_names.append(name)

    if not clean_names:
        return PostCodeRoundDistillationResult(changed_repo_names=normalized)

    filtered_plan = _filter_plan_to_repo_names(plan_data, clean_names)
    repo_paths = {name: repo_paths[name] for name in clean_names}

    run_distillation_stage(
        run_id,
        task,
        task_key,
        filtered_plan,
        events=events,
    )
    response_summary = post_code_round_response_summary_from_artifact()

    knowledge_commit_message = f"chore: distill {task_key} harness memory"
    published: list[dict[str, str]] = []
    for name, repo_path in repo_paths.items():
        plan_repo = plan_repos_by_name.get(name)
        dirty_paths = git_dirty_paths(repo_path)
        # Knowledge written outside the repo root and listed components is an
        # agent slip, not unreviewed code: drop it and publish the rest.
        stray = [
            path
            for path in dirty_paths
            if is_stray_knowledge_path(path, plan_repo=plan_repo, workspace=WORKSPACE)
        ]
        if stray:
            print(
                "post-code-round distillation: discarding knowledge outside the "
                f"repository root and listed components in {name}: {', '.join(stray)}"
            )
            discard_paths(repo_path, stray)
            dirty_paths = git_dirty_paths(repo_path)
        if not dirty_paths:
            publish = push_clean_commit_if_ahead(
                repo_path,
                commit_message=knowledge_commit_message,
            )
            if publish:
                published.append({"name": name, **publish})
            continue
        non_knowledge = [
            path
            for path in dirty_paths
            if not is_knowledge_path(path, plan_repo=plan_repo, workspace=WORKSPACE)
        ]
        if non_knowledge:
            raise RuntimeError(
                "post-code-round distillation produced non-knowledge changes in "
                f"{name}: {', '.join(non_knowledge)}"
            )
        publish = update_existing_branch(
            repo_path,
            commit_message=knowledge_commit_message,
        )
        published.append({"name": name, **publish})

    return PostCodeRoundDistillationResult(
        changed_repo_names=normalized,
        distilled_repo_names=clean_names,
        knowledge_published=published,
        response_summary=response_summary,
        distillation_ran=True,
    )


@contextmanager
def post_code_round_distillation(
    *,
    state: DaemonState,
    inbox_id: str,
    repo_slugs: Sequence[str],
    run_id: str,
    task_key: str,
    target_id: str,
) -> Iterator[None]:
    """Run post-code-round distillation around successful round work.

    The wrapped block remains responsible for round-specific agent execution,
    trace flushing, env wiring, and reply completion. This helper owns
    only the shared repo sync/snapshot/changed-HEAD/distill/mark lifecycle.
    If the wrapped block raises, distillation is skipped and the original
    exception propagates to the daemon's normal failure handling.
    """
    sync_target_repos_before_edit(repo_slugs)
    if not distillation_enabled():
        yield
        return

    before_heads = retryable_post_code_round_repo_heads(state, inbox_id, repo_slugs)

    yield

    changed_repos = changed_repo_names_since(before_heads)
    if changed_repos and not post_code_round_distillation_completed(state, inbox_id):
        result = distill_and_publish_changed_repo_knowledge(
            run_id,
            task_key,
            changed_repos,
            events=state.round_events(inbox_id, target_id),
        )
        if not result.distillation_ran:
            return
        mark_post_code_round_distillation_completed(state, inbox_id, changed_repos)
        state.append_event({
            "type": "agent_response",
            "inbox_id": inbox_id,
            "target_id": target_id,
            "body": result.response_summary.strip()
            or "Knowledge distillation completed",
        })


def _post_code_round_repo_heads_from_events(
    events_file: Path, inbox_id: str
) -> dict[str, str] | None:
    for event in iter_events(events_file):
        if (
            event.get("type") != POST_CODE_ROUND_REPO_HEADS_EVENT
            or event.get("inbox_id") != inbox_id
        ):
            continue
        raw_heads = event.get("repo_heads")
        if not isinstance(raw_heads, dict):
            continue
        return {
            name: head
            for name, head in raw_heads.items()
            if isinstance(name, str) and isinstance(head, str)
        }
    return None


def filter_plan_to_repo_names(
    plan_data: Mapping[str, Any], repo_names: Sequence[str]
) -> dict[str, Any]:
    """Return a copy of *plan_data* containing only the selected repositories."""
    return _filter_plan_to_repo_names(plan_data, repo_names)


def _filter_plan_to_repo_names(
    plan_data: Mapping[str, Any], repo_names: Sequence[str]
) -> dict[str, Any]:
    wanted = set(unique_repo_names(repo_names, workspace=WORKSPACE))
    filtered = json.loads(json.dumps(plan_data))
    repos = filtered.get("repos")
    if not isinstance(repos, list):
        filtered["repos"] = []
        return filtered
    filtered["repos"] = [
        repo
        for repo in repos
        if isinstance(repo, dict)
        and isinstance(repo.get("name"), str)
        and repo["name"] in wanted
    ]
    return filtered


def _merge_skipped_repos(
    distill_data: dict[str, Any], skipped_repos: list[dict[str, Any]]
) -> None:
    existing_repos = distill_data.get("repos")
    if not isinstance(existing_repos, list):
        return
    seen = {
        r.get("repo")
        for r in existing_repos
        if isinstance(r, dict) and isinstance(r.get("repo"), str)
    }
    for skipped in skipped_repos:
        repo_name = skipped.get("repo")
        if isinstance(repo_name, str) and repo_name not in seen:
            existing_repos.append(skipped)


def _write_valid_distillation(distill_data: dict[str, Any]) -> None:
    validate_distillation(distill_data)
    Distillation.model_validate(distill_data)
    write_json(DISTILLATION_JSON, distill_data)


@traced_stage("distillation")
def run_distillation_stage(
    run_id: str,
    task: str,
    task_key: str,
    plan_data: Plan | Mapping[str, Any],
    *,
    events: RoundEvents | None,
    inbox_id: str | None = None,
) -> None:
    """Run distillation for repositories with staged memory."""
    if not distillation_enabled():
        plan = _coerce_plan(plan_data)
        reason = "distillation disabled by HARNESS_DISTILLATION_ENABLED"
        _write_valid_distillation(
            _base_distillation_data(
                run_id=run_id,
                task=task,
                task_key=task_key,
                repos=[{"repo": repo.name, "skipped": reason} for repo in plan.repos],
                inbox_id=inbox_id,
            )
        )
        return

    from harness.deepagents.agents.distillation import DistillationAgent
    from harness.deepagents.model import (
        ModelStage,
        build_model,
        resolve_model,
    )

    plan = _coerce_plan(plan_data)
    knowledge_dir_relative = knowledge_dir_relative_path()
    eligible_repos, skipped_repos = _partition_distillation_repos(
        plan, knowledge_dir_relative
    )
    _log_skipped_repos(skipped_repos)

    if not _all_distillation_memory_files():
        print("no memory to distill")
        _write_valid_distillation(
            _base_distillation_data(
                run_id=run_id,
                task=task,
                task_key=task_key,
                repos=[],
                inbox_id=inbox_id,
            )
        )
        return

    if not eligible_repos:
        _write_valid_distillation(
            _base_distillation_data(
                run_id=run_id,
                task=task,
                task_key=task_key,
                repos=skipped_repos,
                inbox_id=inbox_id,
            )
        )
        return

    with timed_stage(Stage.DISTILLATION, run_id=run_id, task_key=task_key):
        choice = resolve_model(ModelStage.DISTILLATION)
        model_name = choice.model
        model = build_model(model=model_name, reasoning_effort=choice.reasoning_effort)
        repos: list[DistillationRepo] = []
        for repo in eligible_repos:
            repo_name = str(repo.get("repo", ""))
            repo_prompt = assemble_deepagents_distillation_prompt(
                task,
                task_key,
                run_id,
                [repo],
                [],
            )
            repo_path = repo_checkout_path(repo_name, workspace=WORKSPACE)
            raw_knowledge_subpaths = repo.get("knowledge_subpaths")
            knowledge_subpaths = [
                subpath
                for subpath in (
                    raw_knowledge_subpaths
                    if isinstance(raw_knowledge_subpaths, list)
                    else []
                )
                if isinstance(subpath, str)
            ]
            try:
                with (
                    trace_span(
                        "agent-run",
                        as_type="generation",
                        model=model_name,
                        input={"prompt": repo_prompt},
                    ),
                    DistillationAgent(
                        events=events,
                        model=model,
                        workspace_dir=WORKSPACE,
                        thread_id=f"distillation:{run_id}:{repo_name}:{repo_path}",
                        repo_path=repo_path,
                        knowledge_subpaths=knowledge_subpaths,
                        response_format=DistillationRepo,
                    ) as distillation_agent,
                ):
                    output = DistillationRepo.model_validate(
                        distillation_agent.run(repo_prompt)
                    )
                output_data = output.model_dump(mode="python", exclude={"repo"})
                repos.append(DistillationRepo(repo=repo_name, **output_data))
            except Exception as exc:
                repos.append(
                    DistillationRepo(
                        repo=repo_name,
                        memory_files_read=[],
                        promoted_count=0,
                        dropped_count=0,
                        knowledge_files_updated=[],
                        error=str(exc),
                    )
                )
                continue

        distill_data = _base_distillation_data(
            run_id=run_id,
            task=task,
            task_key=task_key,
            repos=[repo.model_dump(mode="json", exclude_none=True) for repo in repos],
            inbox_id=inbox_id,
        )

        _merge_skipped_repos(distill_data, skipped_repos)
        _write_valid_distillation(distill_data)
