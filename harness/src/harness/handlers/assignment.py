"""Handler for `kind='assignment'` inbox rows — the full 5-stage pipeline.

A `kind='assignment'` row triggers a complete one-shot run: Setup -> Planning ->
Implementation -> Distillation -> Commit, emitting typed progress/terminal
events as it goes.

This module owns the entire assignment pipeline: the stage drivers
(`_run_planning_stage`, `_run_implementation_stage`, `run_commit_stage`,
`setup_workspace`) and the plan/implementation validators.
Distillation lives in its own module (`distillation.py`); `process_assignment`
imports `run_distillation_stage` from there.

Import direction: imports shared helpers (env flags, path constants) from
`cli.py` / `paths.py` at module top. `harness.py` must NOT
import this module (or `daemon`) at module top. The `DaemonState` type is
needed only for the `state` annotation, not at runtime; `from __future__ import
annotations` keeps annotations as lazy strings, so the `daemon` import lives
under `TYPE_CHECKING` and no import cycle forms.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from harness.cli import SYNC_REPOS_BEFORE_PLANNING
from harness.distillation import filter_plan_to_repo_names, run_distillation_stage
from harness.env_flags import bool_env, distillation_enabled
from harness.events import (
    RETRYABLE_ASSIGNMENT_ERROR_EVENT_FIELD,
    RoundEvents,
    iter_events,
)
from harness.git import (
    CommitPublishError,
    GitHubClient,
    git_dirty_paths,
    is_knowledge_path,
    setup_git_signing,
    sync_all_repos_from_origin,
)
from harness.handlers._common import (
    _commit_and_open_pr,
    _require_str,
    is_live_channel,
    require_task_key,
    set_round_env,
)
from harness.obs import timed_stage
from harness.paths import (
    DISTILLATION_JSON,
    HARNESS_DIR,
    IMPLEMENTATION_JSON,
    MEMORY_DIR,
    PLAN_JSON,
    PLAN_MD,
    REVIEW_JSON,
    REVIEW_STATE_JSON,
    WORKSPACE,
)
from harness.plan_utils import repo_checkout_path
from harness.schemas.review import OPTIONAL_REVIEW_LENSES
from harness.self_review import run_self_review_loop, validate_self_review
from harness.stages import Stage
from harness.tracing import (
    finalize_root_trace,
    flush_trace,
    init_trace,
    trace_span,
    traced_stage,
)
from harness.util import (
    _atomic_write,
    load_json_file,
    new_run_id,
    write_json,
    write_session,
)

if TYPE_CHECKING:
    from harness.daemon import DaemonState


def _require_list(d: Mapping[str, Any], key: str, where: str) -> list[Any]:
    if key not in d:
        raise ValueError(f"{where}: missing key {key!r}")
    v = d[key]
    if not isinstance(v, list):
        raise TypeError(f"{where}: {key!r} must be array")
    return v


def validate_plan(data: Any) -> None:
    where = "plan.json"

    if not isinstance(data, dict):
        raise TypeError(f"{where}: root must be object")

    d = data
    for k in (
        "stage",
        "run_id",
        "task",
        "status",
        "repos",
        "planning_notes",
        "generated_at",
    ):
        if k not in d:
            raise ValueError(f"{where}: missing top-level key {k!r}")

    if d["stage"] != "planning":
        raise ValueError(f'{where}: stage must be "planning"')

    if not isinstance(d["repos"], list):
        raise TypeError(f"{where}: repos must be array")

    if "task_key" not in d:
        raise ValueError(f"{where}: task_key is required")

    seen_names: set[str] = set()
    for i, repo in enumerate(d["repos"]):
        rw = f"{where} repos[{i}]"
        if not isinstance(repo, dict):
            raise TypeError(f"{rw}: must be object")
        for k in (
            "name",
            "path",
            "goal",
            "planned_files_or_areas",
            "implementation_steps",
            "validation_steps",
            "risks",
        ):
            if k not in repo:
                raise ValueError(f"{rw}: missing {k!r}")

        for ak in (
            "planned_files_or_areas",
            "implementation_steps",
            "validation_steps",
            "risks",
        ):
            if not isinstance(repo[ak], list):
                raise TypeError(f"{rw}: {ak!r} must be array")
        if not isinstance(repo["name"], str):
            raise TypeError(f"{rw}: 'name' must be string")
        if not isinstance(repo["path"], str):
            raise TypeError(f"{rw}: 'path' must be string")
        try:
            repo_root = repo_checkout_path(repo["name"], workspace=WORKSPACE)
        except ValueError as exc:
            raise ValueError(
                f"{rw}: invalid repo name {repo['name']!r}: {exc}"
            ) from exc
        if repo["name"] in seen_names:
            raise ValueError(f"{rw}: duplicate repo name {repo['name']!r}")
        seen_names.add(repo["name"])
        if "additional_review_lenses" in repo:
            # Advisory planner hint: normalize in place (drop unknown / non-
            # string / duplicate entries with a warning) instead of raising.
            # Planning output is model-generated JSON, and the only
            # consumer (`self_review.lens_set_for_repo`) already tolerates
            # exactly these inputs — a stray lens name must never fail the
            # assignment, let alone wedge it on restart.
            raw_lenses = repo["additional_review_lenses"]
            if not isinstance(raw_lenses, list):
                raise TypeError(f"{rw}: 'additional_review_lenses' must be array")
            kept_lenses: list[str] = []
            dropped_lenses: list[Any] = []
            for lens in raw_lenses:
                if (
                    isinstance(lens, str)
                    and lens in OPTIONAL_REVIEW_LENSES
                    and lens not in kept_lenses
                ):
                    kept_lenses.append(lens)
                else:
                    dropped_lenses.append(lens)
            if dropped_lenses:
                print(
                    f"warning: {rw}: dropping unknown/duplicate "
                    f"additional_review_lenses {dropped_lenses!r}; valid: "
                    f"{sorted(OPTIONAL_REVIEW_LENSES)}",
                    file=sys.stderr,
                )
                repo["additional_review_lenses"] = kept_lenses
        if "components" in repo:
            if not isinstance(repo["components"], list):
                raise TypeError(f"{rw}: 'components' must be array")
            seen_component_names: set[str] = set()
            seen_component_paths: set[str] = set()
            for j, component in enumerate(repo["components"]):
                cw = f"{rw} components[{j}]"
                if not isinstance(component, dict):
                    raise TypeError(f"{cw}: must be object")
                for key in ("name", "path"):
                    if key not in component:
                        raise ValueError(f"{cw}: missing {key!r}")
                    if not isinstance(component[key], str):
                        raise TypeError(f"{cw}: {key!r} must be string")
                if component["name"] in seen_component_names:
                    raise ValueError(
                        f"{cw}: duplicate component name {component['name']!r}"
                    )
                component_path_raw = Path(component["path"])
                component_path = str(
                    (
                        component_path_raw
                        if component_path_raw.is_absolute()
                        else repo_root / component_path_raw
                    ).resolve()
                )
                if component_path in seen_component_paths:
                    raise ValueError(
                        f"{cw}: duplicate component path {component['path']!r}"
                    )
                seen_component_names.add(component["name"])
                seen_component_paths.add(component_path)


def validate_implementation(data: Any) -> None:
    where = "implementation.json"

    if not isinstance(data, dict):
        raise TypeError(f"{where}: root must be object")

    d = data

    for k in ("stage", "run_id", "task", "status", "repos", "generated_at"):
        if k not in d:
            raise ValueError(f"{where}: missing top-level key {k!r}")

    if d["stage"] != "implementation":
        raise ValueError(f'{where}: stage must be "implementation"')

    if not isinstance(d["repos"], list):
        raise TypeError(f"{where}: repos must be array")

    if "task_key" not in d:
        raise ValueError(f"{where}: task_key is required")

    for i, repo in enumerate(d["repos"]):
        rw = f"{where} repos[{i}]"
        if not isinstance(repo, dict):
            raise TypeError(f"{rw}: must be object")
        for k in (
            "name",
            "path",
            "changed_files",
            "summary",
            "commit_message",
            "pr_title",
            "pr_body",
        ):
            if k not in repo:
                raise ValueError(f"{rw}: missing {k!r}")

        if not isinstance(repo["changed_files"], list):
            raise TypeError(f"{rw}: changed_files must be array")
        if not isinstance(repo["name"], str):
            raise TypeError(f"{rw}: 'name' must be string")
        if not isinstance(repo["path"], str):
            raise TypeError(f"{rw}: 'path' must be string")
        for optional_string in ("exercise_hint", "feature_baseline", "design_notes"):
            if optional_string in repo and not isinstance(repo[optional_string], str):
                raise TypeError(f"{rw}: {optional_string!r} must be string")
        try:
            repo_checkout_path(repo["name"], workspace=WORKSPACE)
        except ValueError as exc:
            raise ValueError(
                f"{rw}: invalid repo name {repo['name']!r}: {exc}"
            ) from exc


def _finalize_implementation_artifact(
    inbox_id: str, impl_data: Mapping[str, Any]
) -> dict[str, Any]:
    """Validate and stamp an implementation artifact."""
    impl_data = dict(impl_data)
    validate_implementation(impl_data)
    impl_data["inbox_id"] = inbox_id
    write_json(IMPLEMENTATION_JSON, impl_data)
    return impl_data


def plan_json_to_markdown(plan: Mapping[str, Any]) -> str:
    lines: list[str] = ["# Plan", ""]
    lines.append(f"- **run_id**: {plan.get('run_id', '')}")
    lines.append(f"- **task**: {plan.get('task', '')}")
    if plan.get("task_key"):
        lines.append(f"- **task_key**: {plan['task_key']}")
    lines.append(f"- **status**: {plan.get('status', '')}")
    lines.append(f"- **generated_at**: {plan.get('generated_at', '')}")
    lines.append("")
    lines.append("## Planning notes")
    lines.append("")
    lines.append(str(plan.get("planning_notes", "")))
    lines.append("")
    lines.append("## Repositories")
    lines.append("")
    repos = plan.get("repos") or []
    if not repos:
        lines.append("_No repository changes planned._")
        lines.append("")
        return "\n".join(lines)
    for r in repos:
        if not isinstance(r, dict):
            continue
        name = r.get("name", "")
        lines.append(f"### {name}")
        lines.append("")
        lines.append(f"- **path**: `{r.get('path', '')}`")
        lines.append(f"- **goal**: {r.get('goal', '')}")
        lines.append("")
        lines.append("**Planned files / areas**")
        for x in r.get("planned_files_or_areas") or []:
            lines.append(f"- {x}")
        lines.append("")
        lines.append("**Implementation steps**")
        for x in r.get("implementation_steps") or []:
            lines.append(f"- {x}")
        lines.append("")
        lines.append("**Validation steps**")
        for x in r.get("validation_steps") or []:
            lines.append(f"- {x}")
        lines.append("")
        lines.append("**Risks**")
        for x in r.get("risks") or []:
            lines.append(f"- {x}")
        if r.get("notes"):
            lines.append("")
            lines.append(f"**Notes**: {r['notes']}")
        lines.append("")
    return "\n".join(lines)


@traced_stage("commit")
def run_commit_stage(
    task_key: str,
    inbox_id: str,
    impl: Mapping[str, Any],
) -> tuple[str, list[dict[str, Any]] | None]:
    """
    Returns (terminal_status, summary_repos) where terminal_status is
    completed | partial_failure | failed.

    `HARNESS_SKIP_COMMIT` (truthy) short-circuits the stage: no branch, commit,
    push, or PR is created — the run still completes and writes its summary.
    Intended for test/dry runs that should exercise the full pipeline without
    opening PRs on real repositories.
    """
    if bool_env("HARNESS_SKIP_COMMIT"):
        print("HARNESS_SKIP_COMMIT set — skipping commit/PR stage (no PR opened)")
        repos_out = [
            {
                "name": entry["name"],
                "pr_url": None,
                "pr_status": "skipped",
                "branch": None,
                "commit_sha": None,
            }
            for entry in (impl.get("repos") or [])
            if isinstance(entry, dict) and entry.get("name")
        ]
        return "completed", repos_out

    repos_out: list[dict[str, Any]] = []
    any_opened = False
    any_failed = False
    client = GitHubClient()

    for entry in impl.get("repos") or []:
        if not isinstance(entry, dict):
            continue

        # _require_str here (outside the try) preserves the pre-extraction
        # behaviour: a missing `name` aborts the whole commit stage rather than
        # degrading to a per-repo failure.
        name = _require_str(entry, "name", "repo")

        try:
            summary = _commit_and_open_pr(entry, task_key, inbox_id, client)
            repos_out.append({
                "name": name,
                "pr_url": summary["pr_url"],
                "pr_status": "opened",
                "branch": summary["branch"],
                "commit_sha": summary["commit_sha"],
            })
            any_opened = True
        except CommitPublishError as e:
            print(f"error: {e}")
            is_no_change = str(e).startswith("No working tree changes in ")
            if not is_no_change:
                any_failed = True
            repos_out.append({
                "name": name,
                "pr_url": None,
                "pr_status": "no_changes" if is_no_change else "push_failed",
                "branch": e.branch,
                "commit_sha": e.commit_sha,
            })
        except Exception as e:
            print(f"error: {e}")
            any_failed = True
            repos_out.append({
                "name": name,
                "pr_url": None,
                "pr_status": "pr_failed",
                "branch": None,
                "commit_sha": None,
            })

    if any_failed and any_opened:
        return "partial_failure", repos_out

    if any_failed and not any_opened:
        return "failed", repos_out

    return "completed", repos_out


def setup_workspace(task_key: str, run_id: str, task: str) -> None:
    print(f"setting up workspace for task: {task_key} with run: {run_id}")
    print(f"WORKSPACE: {WORKSPACE}")

    if not WORKSPACE.is_dir():
        raise FileNotFoundError(f"Workspace missing: {WORKSPACE}")

    HARNESS_DIR.mkdir(parents=True, exist_ok=True)
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)

    setup_git_signing(required=False)

    # The attached repos are re-snapshotted only every ~30 min, so the checkouts
    # can boot stale — a change pushed minutes before this task would be invisible
    # to planning (and implementation) until the next snapshot. Fast-forward every
    # checkout to origin before planning reads any code. Best-effort per repo (see
    # sync_all_repos_from_origin); a transient sync failure must not fail the task.
    # Gated by HARNESS_SYNC_REPOS_BEFORE_PLANNING (default on) as a kill-switch.
    if SYNC_REPOS_BEFORE_PLANNING:
        synced = sync_all_repos_from_origin(WORKSPACE)
        print(f"synced {len(synced)} repo(s) from origin before planning")
    else:
        print("pre-planning repo sync disabled (HARNESS_SYNC_REPOS_BEFORE_PLANNING)")

    write_session(run_id, task, task_key)


# Per-assignment artifacts produced downstream of the implementation stage. When
# a stale upstream artifact is discarded on reassignment, ALL of these must go
# too — otherwise a later stage inherits a previous assignment's state (a stale
# review.json or distillation.json would be reused for the wrong run).
# Built fresh on each call (not import-time constants) so the module's path
# globals stay monkeypatchable in tests, and listed in one place so a new
# downstream artifact is added once.
def _post_impl_stale() -> tuple[Path, ...]:
    return (
        REVIEW_JSON,
        REVIEW_STATE_JSON,
        *sorted(HARNESS_DIR.glob("review-iter-*.json")),
        *sorted(HARNESS_DIR.glob("review-fix-iter-*.json")),
        DISTILLATION_JSON,
    )


def _post_plan_stale() -> tuple[Path, ...]:
    # Downstream of planning = implementation.json plus everything below it.
    return (IMPLEMENTATION_JSON, *_post_impl_stale())


def _assignment_artifact_reusable(
    path: Path,
    inbox_id: str,
    validator,
    *,
    stale_paths: tuple[Path, ...] = (),
) -> bool:
    """Return whether a per-assignment artifact belongs to this inbox.

    Artifacts from a different inbox are stale reassignment state.
    """
    if not path.exists():
        return False

    data = load_json_file(path)
    validator(data)
    artifact_inbox_id = data.get("inbox_id")
    if artifact_inbox_id == inbox_id:
        return True
    stale = (path, *stale_paths)
    for stale_path in stale:
        try:
            stale_path.unlink()
        except FileNotFoundError:
            pass
    print(
        f"ignoring stale {path.name} with inbox_id {artifact_inbox_id!r}; "
        f"current assignment is {inbox_id!r}",
        file=sys.stderr,
    )
    return False


def _validate_mapping_artifact(data: Any) -> None:
    if not isinstance(data, dict):
        raise TypeError("assignment artifact: root must be object")


@traced_stage("planning")
def _run_planning_stage(
    task: str,
    task_key: str,
    run_id: str,
    inbox_id: str,
    *,
    events: RoundEvents | None,
) -> dict[str, Any]:
    if _assignment_artifact_reusable(
        PLAN_JSON,
        inbox_id,
        validate_plan,
        stale_paths=_post_plan_stale(),
    ):
        # Already produced by a prior attempt (atomic write ⇒ complete/valid).
        plan_data = load_json_file(PLAN_JSON)
        return plan_data

    from harness.planning import run_planning

    with timed_stage(Stage.PLANNING, run_id=run_id, task_key=task_key):
        with trace_span(
            "agent-exec",
            as_type="generation",
            model="deepagents-planning",
            input={"task": task, "task_key": task_key},
        ):
            plan = run_planning(
                task=task,
                task_key=task_key,
                run_id=run_id,
                events=events,
            )
        plan_data = plan.model_dump(mode="json", exclude_none=True)
        validate_plan(plan_data)
        plan_data["inbox_id"] = inbox_id
        write_json(PLAN_JSON, plan_data)
        _atomic_write(PLAN_MD, plan_json_to_markdown(plan_data))
    return plan_data


@traced_stage("implementation")
def _run_implementation_stage(
    task_key: str,
    run_id: str,
    inbox_id: str,
    plan_data: Mapping[str, Any],
    *,
    events: RoundEvents | None,
) -> dict[str, Any]:
    if _assignment_artifact_reusable(
        IMPLEMENTATION_JSON,
        inbox_id,
        validate_implementation,
        stale_paths=_post_impl_stale(),
    ):
        return _finalize_implementation_artifact(
            inbox_id, load_json_file(IMPLEMENTATION_JSON)
        )

    from harness.implementation import run_implementation
    from harness.schemas import Plan

    # The workers' implementation.json is final: the harness validates and
    # stamps it, with no coordinator pass afterwards.
    with timed_stage(Stage.IMPLEMENTATION, run_id=run_id, task_key=task_key):
        run_implementation(
            plan=Plan.model_validate(plan_data),
            inbox_id=inbox_id,
            impl_out=IMPLEMENTATION_JSON,
            events=events,
        )
        return _finalize_implementation_artifact(
            inbox_id, load_json_file(IMPLEMENTATION_JSON)
        )


NO_ACTION_BODY = (
    "ℹ️ **No action needed.** The task required no code changes; "
    "no pull requests were opened."
)


def _format_completion_body(
    summary_repos: list[dict[str, Any]],
    plan_data: Mapping[str, Any],
    impl_data: Mapping[str, Any],
    status: str,
) -> str:
    """Build the user-facing completion message for an completed event.

    Two sections: a per-repo "Planned / Done" recap — the plan.json repo `goal`
    and the implementation.json repo `summary`, matched by repo name; a repo
    with neither is dropped from the recap — then a "Pull requests" list of
    every opened PR. CP relays this body verbatim — see CP eventDispatcher
    handleAssignmentCompleted.
    """
    plan_by_name = {
        r["name"]: r
        for r in (plan_data.get("repos") or [])
        if isinstance(r, dict) and isinstance(r.get("name"), str)
    }
    impl_by_name = {
        r["name"]: r
        for r in (impl_data.get("repos") or [])
        if isinstance(r, dict) and isinstance(r.get("name"), str)
    }
    opened = [
        r for r in summary_repos if r.get("pr_url") and r.get("pr_status") == "opened"
    ]

    blocks: list[str] = []
    for repo in opened:
        name = repo.get("name")
        lines: list[str] = []
        # plan.json repos carry `goal` (the planned intent); implementation.json
        # repos carry `summary` (what was done). Plan repos have no `summary`.
        planned = plan_by_name.get(name, {}).get("goal")
        done = impl_by_name.get(name, {}).get("summary")
        if planned:
            lines.append(f"- _Planned:_ {planned}")
        if done:
            lines.append(f"- _Done:_ {done}")
        if lines:
            blocks.append(f"**{name}**\n" + "\n".join(lines))
    recap = "\n\n".join(blocks)
    pr_list = "\n".join(f"- [{r['name']}]({r['pr_url']})" for r in opened)

    if status == "partial_failure":
        failed = [
            r
            for r in summary_repos
            if r.get("pr_status") not in ("opened", "no_changes")
        ]
        failed_list = "\n".join(
            f"- {r.get('name')} ({str(r.get('pr_status', '')).replace('_', ' ')})"
            for r in failed
        )
        parts = ["⚠️ **Task partially completed.** Some repositories failed."]
        if recap:
            parts.append(recap)
        if failed_list:
            parts.append(f"Failed:\n\n{failed_list}")
        if pr_list:
            parts.append(f"**Pull requests:**\n\n{pr_list}")
        return "\n\n".join(parts)

    if status == "failed":
        # At least one repo hit a genuine publish failure and no PRs were
        # opened. `recap` is empty (it is built from `opened`), so this is just
        # the failure headline + the failed list.
        failed = [
            r
            for r in summary_repos
            if r.get("pr_status") not in ("opened", "no_changes")
        ]
        failed_list = "\n".join(
            f"- {r.get('name')} ({str(r.get('pr_status', '')).replace('_', ' ')})"
            for r in failed
        )
        parts = ["❌ **Task failed.** No pull requests were opened."]
        if failed_list:
            parts.append(f"Failed:\n\n{failed_list}")
        return "\n\n".join(parts)

    # completed
    if not opened:
        return "✅ **Task completed.** No pull requests were opened."
    parts = ["✅ **Task completed.**"]
    if recap:
        parts.append(recap)
    parts.append(f"**Pull requests:**\n\n{pr_list}")
    return "\n\n".join(parts)


def _repo_names_with_implementation_changes(plan_data: Mapping[str, Any]) -> list[str]:
    """Return plan repo names with dirty, non-knowledge working-tree paths."""
    repos = plan_data.get("repos")
    if not isinstance(repos, list):
        return []

    changed_names: list[str] = []
    for repo in repos:
        if not isinstance(repo, dict):
            continue
        name = repo.get("name")
        if not isinstance(name, str) or not name:
            continue
        try:
            repo_path = repo_checkout_path(name, workspace=WORKSPACE)
        except ValueError:
            continue
        if not repo_path.is_dir():
            continue
        dirty_paths = git_dirty_paths(repo_path)
        if any(
            not is_knowledge_path(path, plan_repo=repo, workspace=WORKSPACE)
            for path in dirty_paths
        ):
            changed_names.append(name)
    return changed_names


def _terminal_assignment_message_emitted(
    state: DaemonState, inbox_id: str, terminal: str
) -> bool:
    """Return whether this assignment already has its final user message.

    Retryable daemon-failure `agent_error` events are intentionally excluded:
    they tell the user about a transient failed attempt, but must not suppress
    the eventual success or terminal failure message after CP restarts the pod.
    """
    if terminal != "failed":
        return state.has_event_for(inbox_id=inbox_id, type_="agent_response")
    return any(
        e.get("type") == "agent_error"
        and e.get("inbox_id") == inbox_id
        and not e.get(RETRYABLE_ASSIGNMENT_ERROR_EVENT_FIELD)
        for e in iter_events(state.events_file)
    )


def process_assignment(entry: dict[str, Any], state: DaemonState) -> None:
    """Run all 5 stages for a `kind='assignment'` inbox row, emitting events."""
    inbox_id = entry["id"]

    # Defensive: if a prior daemon invocation already finished this row, skip.
    if state.has_event_for(inbox_id=inbox_id, type_="completed"):
        return

    payload = entry["payload"]  # kind='assignment' payload; from inbox row jsonb
    task = payload["title"]
    description = payload.get("description")
    task_key = require_task_key(payload, "assignment payload")
    # reply target: Linear agent session or API task id
    target_id = payload["target_id"]

    # Stamp the per-round env so round-event appends carry this round's
    # inbox_id + target_id. The daemon already set DEVBOX_EVENTS_FILE /
    # DEVBOX_EVENTS_LOCK process-wide at startup.
    set_round_env(inbox_id, [target_id])
    events = state.round_events(inbox_id, target_id)

    full_task = f"{task}\n\n{description}" if description else task
    has_live_channel = is_live_channel(entry["source"])
    run_id = new_run_id()

    summary_status = "failed"
    error: str | None = None
    try:
        with init_trace(
            run_id=run_id,
            task=full_task,
            task_key=task_key,
            agent="deepagents",
        ) as root:
            try:
                setup_workspace(task_key, run_id, full_task)

                # Planning self-skips only for same-inbox artifacts; a missing or
                # mismatched stamp is stale reassignment state.
                plan_pending = not _assignment_artifact_reusable(
                    PLAN_JSON,
                    inbox_id,
                    validate_plan,
                    stale_paths=_post_plan_stale(),
                )
                if has_live_channel and plan_pending:
                    state.append_event({
                        "type": "agent_action",
                        "inbox_id": inbox_id,
                        "target_id": target_id,
                        "body": "Entered planning mode",
                    })
                plan_data = _run_planning_stage(
                    full_task,
                    task_key,
                    run_id,
                    inbox_id,
                    events=events,
                )

                if not plan_data.get("repos"):
                    summary_status = "no_action"
                    if not state.has_event_for(
                        inbox_id=inbox_id, type_="agent_response"
                    ):
                        state.append_event({
                            "type": "agent_response",
                            "inbox_id": inbox_id,
                            "target_id": target_id,
                            "body": NO_ACTION_BODY,
                        })
                    state.append_event({
                        "type": "completed",
                        "inbox_id": inbox_id,
                        "status": "no_action",
                    })
                    return

                # Implementation — announce only when no implementation worker
                # has run yet. On a mid-implementation resume the workers'
                # markers and checkpoints already exist, so we stay silent
                # rather than re-posting the plan thought for an in-progress
                # attempt.
                impl_pending = not _assignment_artifact_reusable(
                    IMPLEMENTATION_JSON,
                    inbox_id,
                    validate_implementation,
                    stale_paths=_post_impl_stale(),
                )
                from harness.implementation import implementation_started

                impl_is_fresh = not implementation_started(
                    inbox_id=inbox_id,
                    repo_names=[
                        r["name"]
                        for r in plan_data.get("repos") or []
                        if isinstance(r, Mapping) and isinstance(r.get("name"), str)
                    ],
                )
                if has_live_channel and impl_pending and impl_is_fresh:
                    try:
                        plan_body = PLAN_MD.read_text()
                    except OSError:
                        plan_body = ""
                    state.append_event({
                        "type": "agent_thought",
                        "inbox_id": inbox_id,
                        "target_id": target_id,
                        "body": plan_body,
                    })
                    state.append_event({
                        "type": "agent_action",
                        "inbox_id": inbox_id,
                        "target_id": target_id,
                        "body": "Entered implementation mode",
                    })

                impl_data = _run_implementation_stage(
                    task_key,
                    run_id,
                    inbox_id,
                    plan_data,
                    events=events,
                )

                # Adversarial review — bounded self-review loop between
                # implementation and distillation, DeepAgents-native. The harness
                # deterministically dispatches one lens agent per (repo, lens)
                # pair (always-on code-review + planner-flagged optional lenses) and one
                # fresh per-repo fix agent briefed with the implementer's
                # design notes. Gated by HARNESS_REVIEW_ENABLED (default on); a
                # disabled run is a no-op that returns impl_data unchanged.
                # Writes review.json + may annotate implementation.json PR
                # bodies, so the commit stage reads the post-review impl_data.
                # On resume, skip when review.json already exists — impl_data from
                # _run_implementation_stage is already the post-review on-disk version.
                #
                # Stage announcements are restart-guarded: the early stages skip via
                # their artifact/marker gates, but these later ones would re-post to
                # the user on a mid-pipeline restart. Skip any body already emitted.
                announced = state.action_bodies(inbox_id=inbox_id)
                if not _assignment_artifact_reusable(
                    REVIEW_JSON, inbox_id, validate_self_review
                ):
                    if has_live_channel and "Reviewing" not in announced:
                        state.append_event({
                            "type": "agent_action",
                            "inbox_id": inbox_id,
                            "target_id": target_id,
                            "body": "Reviewing",
                        })
                    _review_data, impl_data = run_self_review_loop(
                        run_id,
                        full_task,
                        task_key,
                        plan_data,
                        impl_data,
                        inbox_id=inbox_id,
                        events=events,
                    )

                # Distillation — promotes per-run memory into each repo's
                # configured knowledge directory. Internal housekeeping is surfaced
                # as a stage emit for visibility. On resume, skip when its
                # artifact already exists.
                if not _assignment_artifact_reusable(
                    DISTILLATION_JSON, inbox_id, _validate_mapping_artifact
                ):
                    impl_changed_names = _repo_names_with_implementation_changes(
                        plan_data
                    )
                    if impl_changed_names:
                        if (
                            distillation_enabled()
                            and has_live_channel
                            and "Distilling" not in announced
                        ):
                            state.append_event({
                                "type": "agent_action",
                                "inbox_id": inbox_id,
                                "target_id": target_id,
                                "body": "Distilling",
                            })
                        distill_plan = filter_plan_to_repo_names(
                            plan_data, impl_changed_names
                        )
                        run_distillation_stage(
                            run_id,
                            full_task,
                            task_key,
                            distill_plan,
                            events=events,
                            inbox_id=inbox_id,
                        )

                # Commit + PR — reconciliation makes re-entry idempotent; pr_opened
                # is emitted only for repos not already recorded.
                if has_live_channel and "Committing" not in announced:
                    state.append_event({
                        "type": "agent_action",
                        "inbox_id": inbox_id,
                        "target_id": target_id,
                        "body": "Committing",
                    })
                terminal, summary_repos = run_commit_stage(
                    task_key, inbox_id, impl_data
                )
                summary_status = terminal

                already_marked_opened = state.opened_repo_names(inbox_id=inbox_id)
                for repo in summary_repos or []:
                    if (
                        repo.get("pr_status") == "opened"
                        and repo["name"] not in already_marked_opened
                    ):
                        state.append_event({
                            "type": "pr_opened",
                            "inbox_id": inbox_id,
                            "repo": repo["name"],
                            "pr_url": repo["pr_url"],
                            "branch": repo.get("branch", ""),
                            "commit_sha": repo.get("commit_sha", ""),
                        })

                if not _terminal_assignment_message_emitted(state, inbox_id, terminal):
                    state.append_event({
                        "type": "agent_error"
                        if terminal == "failed"
                        else "agent_response",
                        "inbox_id": inbox_id,
                        "target_id": target_id,
                        "body": _format_completion_body(
                            summary_repos or [], plan_data, impl_data, terminal
                        ),
                    })
                state.append_event({
                    "type": "completed",
                    "inbox_id": inbox_id,
                    "status": terminal,
                })
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                raise  # process_one_inbox_file emits completed failed
            finally:
                # Telemetry must never alter task outcome — a faulty Langfuse
                # client raising here would propagate and cause a second,
                # contradictory terminal event to be appended on top of the
                # real one. Swallow + log instead.
                try:
                    finalize_root_trace(
                        root, summary_status=summary_status, error=error
                    )
                except Exception as trace_exc:
                    print(
                        f"daemon: finalize_root_trace failed (ignored): "
                        f"{type(trace_exc).__name__}: {trace_exc}",
                        file=sys.stderr,
                    )
    finally:
        try:
            flush_trace()
        except Exception as trace_exc:
            print(
                f"daemon: flush_trace failed (ignored): "
                f"{type(trace_exc).__name__}: {trace_exc}",
                file=sys.stderr,
            )
