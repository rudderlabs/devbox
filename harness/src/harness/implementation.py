"""Harness-owned per-repository implementation orchestration."""

from __future__ import annotations

from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from harness.deepagents import retry as _retry
from harness.deepagents.agents.implementation import ImplementationAgent
from harness.deepagents.checkpointer import checkpoint_exists
from harness.deepagents.model import (
    ModelStage,
    build_model,
    resolve_model,
)
from harness.events import RoundEvents
from harness.git import changed_files
from harness.paths import HARNESS_DIR, IMPLEMENTATION_JSON, WORKSPACE
from harness.plan_utils import knowledge_subpaths_for_repo, repo_checkout_path
from harness.schemas import (
    Implementation,
    ImplementationRepo,
    Plan,
    PlanRepo,
    RepoImplementationOutput,
)
from harness.util import iso_now, safe_marker_fragment, write_json

MARKERS_DIR = HARNESS_DIR / "implementation"


def default_agent_max_retries() -> int:
    """Compatibility wrapper for the shared DeepAgents retry knob."""
    return _retry.default_agent_max_retries()


def _is_structured_output_validation_error(exc: BaseException) -> bool:
    return _retry.is_structured_output_validation_error(exc)


def _is_transient_model_exception(exc: BaseException) -> bool:
    return _retry.is_transient_model_exception(exc)


def _retry_sleep_seconds(attempt: int) -> float:
    return _retry.retry_sleep_seconds(attempt)


def deterministic_thread_id(*, inbox_id: str, repo_name: str, repo_path: str) -> str:
    return f"implementation:{inbox_id}:{repo_name}:{Path(repo_path).resolve()}"


def _marker_path(markers_dir: Path, inbox_id: str, repo_name: str) -> Path:
    safe_inbox = safe_marker_fragment(inbox_id)
    safe_repo = safe_marker_fragment(repo_name)
    return markers_dir / f"{safe_inbox}-{safe_repo}.json"


def _repo_brief(
    *,
    task: str,
    task_key: str,
    repo: PlanRepo,
    repo_path: Path,
    knowledge_subpaths: Sequence[str],
) -> str:
    parts = [
        f"<repo>{repo.name}</repo>",
        f"<task>{task}</task>",
        "<context>",
        f"task_key: {task_key}",
        f"repo_path: {repo_path}",
        f"goal: {repo.goal}",
        f"planned_files_or_areas: {repo.planned_files_or_areas}",
        f"implementation_steps: {repo.implementation_steps}",
        f"validation_steps: {repo.validation_steps}",
        f"risks: {repo.risks}",
        f"knowledge_subpaths: {list(knowledge_subpaths)}",
        "</context>",
    ]
    return "\n".join(parts)


def _canonical_repo_output(
    *,
    repo: PlanRepo,
    repo_path: Path,
    output: ImplementationRepo | RepoImplementationOutput,
) -> ImplementationRepo:
    repo_output = ImplementationRepo.model_validate(output)
    return ImplementationRepo(
        name=repo.name,
        path=str(repo_path),
        changed_files=changed_files(repo_path),
        summary=repo_output.summary,
        exercise_hint=repo_output.exercise_hint,
        feature_baseline=repo_output.feature_baseline,
        design_notes=repo_output.design_notes,
        commit_message=repo_output.commit_message,
        pr_title=repo_output.pr_title,
        pr_body=repo_output.pr_body,
    )


def _run_one_repo_with_retries(
    *,
    model: Any,
    task: str,
    task_key: str,
    inbox_id: str,
    repo: PlanRepo,
    markers_dir: Path,
    max_retries: int,
    events: RoundEvents | None,
) -> ImplementationRepo:
    repo_path = repo_checkout_path(repo.name, workspace=WORKSPACE)
    marker = _marker_path(markers_dir, inbox_id, repo.name)
    if marker.exists():
        return _canonical_repo_output(
            repo=repo,
            repo_path=repo_path,
            output=ImplementationRepo.model_validate_json(
                marker.read_text(encoding="utf-8")
            ),
        )

    knowledge_subpaths = knowledge_subpaths_for_repo(repo, workspace=WORKSPACE)
    thread_id = deterministic_thread_id(
        inbox_id=inbox_id, repo_name=repo.name, repo_path=str(repo_path)
    )
    brief = _repo_brief(
        task=task,
        task_key=task_key,
        repo=repo,
        repo_path=repo_path,
        knowledge_subpaths=knowledge_subpaths,
    )

    def build_agent() -> ImplementationAgent:
        return ImplementationAgent(
            events=events,
            model=model,
            repo_path=repo_path,
            thread_id=thread_id,
            response_format=RepoImplementationOutput,
            knowledge_subpaths=knowledge_subpaths,
            repo=repo.name,
            stage="implementation",
        )

    # A durable thread with prior state is a crashed run: resume it rather
    # than re-sending the brief on top of the partial edits already on disk.
    output = _retry.run_agent_with_retries(
        build_agent,
        brief,
        label=repo.name,
        resume_prior_state=True,
        max_retries=max_retries,
    )
    repo_output = _canonical_repo_output(repo=repo, repo_path=repo_path, output=output)
    marker.parent.mkdir(parents=True, exist_ok=True)
    write_json(marker, repo_output.model_dump(mode="json", exclude_none=True))
    return repo_output


def unique_plan_repos(plan: Plan) -> list[PlanRepo]:
    seen_names: set[str] = set()
    repos: list[PlanRepo] = []
    for repo in plan.repos:
        name = repo.name
        if name in seen_names:
            continue
        seen_names.add(name)
        repos.append(repo)
    return repos


def run_implementation(
    *,
    plan: Plan,
    inbox_id: str,
    impl_out: Path = IMPLEMENTATION_JSON,
    events: RoundEvents | None,
) -> Implementation:
    """Run one implementation worker per unique planned repository."""
    choice = resolve_model(ModelStage.IMPLEMENTATION)
    model = build_model(model=choice.model, reasoning_effort=choice.reasoning_effort)
    repos = unique_plan_repos(plan)
    markers_dir = impl_out.parent / MARKERS_DIR.name
    results: list[ImplementationRepo] = []
    max_retries = default_agent_max_retries()
    with ThreadPoolExecutor(max_workers=max(1, len(repos))) as executor:
        futures = {
            executor.submit(
                _run_one_repo_with_retries,
                model=model,
                task=plan.task,
                task_key=plan.task_key or "",
                inbox_id=inbox_id,
                repo=repo,
                markers_dir=markers_dir,
                max_retries=max_retries,
                events=events,
            ): repo
            for repo in repos
        }
        for future in as_completed(futures):
            results.append(future.result())

    results.sort(key=lambda repo: repo.name)
    impl = Implementation(
        stage="implementation",
        run_id=plan.run_id,
        task=plan.task,
        task_key=plan.task_key,
        status="completed",
        repos=results,
        generated_at=iso_now(),
    )
    write_json(impl_out, impl.model_dump(mode="json", exclude_none=True))
    return impl


def implementation_started(
    *, inbox_id: str, repo_names: Sequence[str], markers_dir: Path = MARKERS_DIR
) -> bool:
    """Whether any implementation worker of this inbox has run (marker or checkpoint).

    Reads the checkpointer directly, without building a session, so no thread id
    is claimed.
    """
    for name in dict.fromkeys(repo_names):
        if _marker_path(markers_dir, inbox_id, name).exists():
            return True
        thread_id = deterministic_thread_id(
            inbox_id=inbox_id,
            repo_name=name,
            repo_path=str(repo_checkout_path(name, workspace=WORKSPACE)),
        )
        if checkpoint_exists(thread_id):
            return True
    return False
