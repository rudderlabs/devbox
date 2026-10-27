"""Harness-owned DeepAgents planning orchestration."""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from langchain_core.language_models import BaseChatModel

from harness.deepagents import retry as _retry
from harness.deepagents.agents.orientation import OrientationAgent
from harness.deepagents.agents.plan_review import PlanReviewAgent
from harness.deepagents.agents.planning import PlanningAgent
from harness.deepagents.model import (
    ModelStage,
    build_model,
    resolve_model,
)
from harness.env_flags import classifier_skip_orientation_enabled
from harness.events import RoundEvents
from harness.paths import PLAN_REVIEW_JSON, WORKSPACE
from harness.plan_utils import knowledge_subpaths_for_repo, repo_checkout_path
from harness.schemas import (
    OrientationOutput,
    OrientedComponent,
    OrientedRepo,
    Plan,
    PlanComponent,
    PlanIssue,
    PlannedComponent,
    PlanRepo,
    PlanReviewOutput,
    RepoPlanOutput,
)
from harness.util import iso_now, write_json

_CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}


def _orientation_prompt(
    *,
    task: str,
    task_key: str,
    run_id: str,
) -> str:
    parts = [
        "<harness_context>",
        f"<task>{task}</task>",
        f"- **run_id**: {run_id}",
        "- **stage**: planning-orientation",
        f"- **task_key**: `{task_key}`",
        f"- **workspace**: `{WORKSPACE}`",
        "</harness_context>",
    ]
    return "\n".join(parts)


def _workspace_repo_names(*, workspace: Path | None = None) -> list[str]:
    root = workspace or WORKSPACE
    if not root.is_dir():
        return []
    return [
        child.name
        for child in sorted(root.iterdir())
        if child.is_dir() and (child / ".git").exists()
    ]


def _classification_prompt(
    *,
    task: str,
    task_key: str,
    available_repos: Sequence[str],
) -> str:
    return "\n".join([
        "Classify which checked-out repositories are likely needed for this task.",
        "Return high confidence only when the repository set is obvious from the task text.",
        "Select repository names only from the available repositories listed below.",
        "Use bare checkout directory names, not paths or owner/repo slugs.",
        f"<available_repositories>{json.dumps(list(available_repos))}</available_repositories>",
        f"<task>{task}</task>",
        f"<task_key>{task_key}</task_key>",
    ])


def _build_stage_model(stage: ModelStage) -> BaseChatModel:
    choice = resolve_model(stage)
    return build_model(model=choice.model, reasoning_effort=choice.reasoning_effort)


def classify_repos(
    *,
    task: str,
    task_key: str,
    available_repos: Sequence[str],
) -> OrientationOutput:
    """Do a cheap structured repository classification pass.

    Full orientation is skipped only by callers that receive at
    least one repository and every repository has high confidence.
    """
    model = _build_stage_model(ModelStage.ORIENTATION)
    structured = model.with_structured_output(
        OrientationOutput,
        method="json_schema",
        strict=True,
    )
    prompt = _classification_prompt(
        task=task,
        task_key=task_key,
        available_repos=available_repos,
    )
    output = _retry.run_model_with_retries(
        lambda: structured.invoke(prompt),
        max_retries=_retry.default_agent_max_retries(),
        label="repository classification",
    )
    return OrientationOutput.model_validate(output)


def _run_full_orientation(
    *,
    task: str,
    task_key: str,
    run_id: str,
    events: RoundEvents | None,
) -> OrientationOutput:
    model = _build_stage_model(ModelStage.ORIENTATION)
    prompt = _orientation_prompt(
        task=task,
        task_key=task_key,
        run_id=run_id,
    )

    def build_agent() -> OrientationAgent:
        return OrientationAgent(
            events=events,
            model=model,
            workspace_dir=WORKSPACE,
            thread_id=f"planning-orientation:{run_id}",
        )

    return OrientationOutput.model_validate(
        _retry.run_agent_with_retries(
            build_agent,
            prompt,
            max_retries=_retry.default_agent_max_retries(),
            label="DeepAgents orientation",
            resume_prior_state=False,
        )
    )


def _orientation_for_task(
    *,
    task: str,
    task_key: str,
    run_id: str,
    events: RoundEvents | None,
) -> OrientationOutput:
    if classifier_skip_orientation_enabled():
        if events is not None:
            events.thought(
                "Checking the task with the repository classifier to decide "
                "whether full orientation is needed."
            )
        available_repos = _workspace_repo_names()
        classification = classify_repos(
            task=task,
            task_key=task_key,
            available_repos=available_repos,
        )
        classified_names = {repo.name for repo in classification.repos}
        missing_repos = sorted(classified_names - set(available_repos))
        if (
            classification.repos
            and not missing_repos
            and all(repo.confidence == "high" for repo in classification.repos)
        ):
            repo_names = ", ".join(sorted({repo.name for repo in classification.repos}))
            if events is not None:
                events.thought(
                    "Skipped full orientation because the "
                    "classifier identified high-confidence repositories: "
                    f"{repo_names}."
                )
            return classification

    if events is not None:
        events.thought("Running full orientation.")
    orientation = _run_full_orientation(
        task=task,
        task_key=task_key,
        run_id=run_id,
        events=events,
    )
    repo_names = ", ".join(sorted({repo.name for repo in orientation.repos})) or "none"
    if events is not None:
        events.thought(
            f"Completed full orientation; identified repositories: {repo_names}."
        )
    return orientation


def _component_key(
    component: OrientedComponent | PlannedComponent | PlanComponent,
) -> tuple[str, str]:
    return (component.name, component.path)


def _normalize_oriented_repos(orientation: OrientationOutput) -> list[OrientedRepo]:
    by_name: dict[str, OrientedRepo] = {}
    for repo in orientation.repos:
        repo_path = repo_checkout_path(repo.name, workspace=WORKSPACE)
        if not repo_path.is_dir():
            raise FileNotFoundError(
                f"DeepAgents planning oriented missing workspace repository "
                f"{repo.name!r} at {repo_path}"
            )
        existing = by_name.get(repo.name)
        if existing is None:
            by_name[repo.name] = repo
            continue
        if _CONFIDENCE_RANK[repo.confidence] > _CONFIDENCE_RANK[existing.confidence]:
            existing.confidence = repo.confidence
        if repo.rationale and repo.rationale not in existing.rationale:
            existing.rationale = "; ".join(
                part for part in (existing.rationale, repo.rationale) if part
            )
        seen_components = {
            _component_key(component) for component in existing.components
        }
        for component in repo.components:
            key = _component_key(component)
            if key not in seen_components:
                existing.components.append(component)
                seen_components.add(key)
    return [by_name[name] for name in sorted(by_name)]


def _plan_component(
    component: OrientedComponent | PlannedComponent | PlanComponent,
) -> PlanComponent:
    return PlanComponent(name=component.name, path=component.path)


def _knowledge_subpaths(oriented_repo: OrientedRepo) -> list[str]:
    repo_path = repo_checkout_path(oriented_repo.name, workspace=WORKSPACE)
    repo = PlanRepo(
        name=oriented_repo.name,
        path=str(repo_path),
        goal="planning knowledge scope",
        components=[
            _plan_component(component) for component in oriented_repo.components
        ],
    )
    return knowledge_subpaths_for_repo(repo, workspace=WORKSPACE)


def _repo_planning_prompt(
    *,
    task: str,
    task_key: str,
    run_id: str,
    repo: OrientedRepo,
    repo_path: Path,
    orientation_notes: str,
    cross_repo_assumptions: Sequence[str],
) -> str:
    parts = [
        "<harness_context>",
        f"<task>{task}</task>",
        f"- **run_id**: {run_id}",
        "- **stage**: repo-planning",
        f"- **task_key**: `{task_key}`",
        f"- **repo**: `{repo.name}`",
        f"- **repo_path**: `{repo_path}`",
        f"- **orientation_confidence**: `{repo.confidence}`",
        f"- **orientation_rationale**: {repo.rationale}",
        f"- **orientation_components**: {json.dumps([c.model_dump(mode='json') for c in repo.components])}",
        f"- **orientation_notes**: {orientation_notes}",
        f"- **cross_repo_assumptions**: {json.dumps(list(cross_repo_assumptions))}",
        "</harness_context>",
    ]
    parts.append(
        "Produce a read-only per-repository implementation plan as structured output."
    )
    parts.append(
        "Set `additional_review_lenses` to the adversarial review lenses this repository's "
        "diff should get beyond the always-on generic `code-review` sweep. "
        "Choose from: `bug-hunter` (depth and proof — the change adds or alters "
        "non-trivial logic, state handling, or runtime behavior worth tracing "
        "to a repro), `bird-eye` (system integration — the change takes new "
        "external dependencies, wires across modules/services, or touches "
        "lifecycle/initialization paths), `security` (auth/authz, tenant "
        "isolation, secrets, user-controlled input reaching sensitive sinks, "
        "crypto, new external exposure), and `code-quality` (a complex or "
        "high-fan-in area where structural regressions are expensive). Leave "
        "it empty when none apply."
    )
    return "\n".join(parts)


def _repo_revision_prompt(*, issues: Sequence[PlanIssue]) -> str:
    return "\n".join([
        "Revise the previous per-repository plan using only these relevant reviewer issues.",
        "Do not re-review the whole plan and do not mutate files.",
        json.dumps(
            [issue.model_dump(mode="json", exclude_none=True) for issue in issues],
            indent=2,
        ),
    ])


def _review_added_repo_prompt(
    *,
    task: str,
    task_key: str,
    run_id: str,
    repo: OrientedRepo,
    repo_path: Path,
    orientation_notes: str,
    cross_repo_assumptions: Sequence[str],
    issues: Sequence[PlanIssue],
) -> str:
    return "\n".join([
        _repo_planning_prompt(
            task=task,
            task_key=task_key,
            run_id=run_id,
            repo=repo,
            repo_path=repo_path,
            orientation_notes=orientation_notes,
            cross_repo_assumptions=cross_repo_assumptions,
        ),
        "The adversarial reviewer added this repository to the plan.",
        "Address these repository-specific findings in the initial plan:",
        json.dumps(
            [issue.model_dump(mode="json", exclude_none=True) for issue in issues],
            indent=2,
        ),
    ])


def _canonical_repo_plan(
    *,
    oriented_repo: OrientedRepo,
    repo_path: Path,
    output: RepoPlanOutput,
) -> PlanRepo:
    agent_components = [_plan_component(component) for component in output.components]
    orientation_components = [
        _plan_component(component) for component in oriented_repo.components
    ]
    components: list[PlanComponent] = []
    seen_names: set[str] = set()
    seen_paths: set[str] = set()
    for component in [*orientation_components, *agent_components]:
        component_path = Path(component.path)
        resolved_path = str(
            (
                component_path
                if component_path.is_absolute()
                else repo_path / component_path
            ).resolve()
        )
        if component.name in seen_names or resolved_path in seen_paths:
            continue
        components.append(component)
        seen_names.add(component.name)
        seen_paths.add(resolved_path)

    return PlanRepo(
        name=oriented_repo.name,
        path=str(repo_path),
        goal=output.goal,
        planned_files_or_areas=output.planned_files_or_areas,
        implementation_steps=output.implementation_steps,
        validation_steps=output.validation_steps,
        risks=output.risks,
        components=components,
        additional_review_lenses=list(dict.fromkeys(output.additional_review_lenses)),
    )


def _run_repo_prompt_with_retries(
    *,
    agent: PlanningAgent,
    prompt: str,
    repo_name: str,
    max_retries: int,
) -> RepoPlanOutput:
    return RepoPlanOutput.model_validate(
        _retry.run_agent_with_retries(
            lambda: agent,
            prompt,
            max_retries=max_retries,
            label=f"DeepAgents planning worker for {repo_name}",
            resume_prior_state=False,
            close_agent=False,
        )
    )


def _compose_plan(
    *,
    run_id: str,
    task: str,
    task_key: str,
    repo_plans: dict[str, PlanRepo],
    repo_outputs: dict[str, RepoPlanOutput],
    orientation: OrientationOutput,
    review: PlanReviewOutput | None = None,
    unresolved_issues: Sequence[PlanIssue] = (),
) -> Plan:
    note_blocks: list[str] = []
    if orientation.orientation_notes:
        note_blocks.append(f"Orientation notes: {orientation.orientation_notes}")
    if orientation.cross_repo_assumptions:
        note_blocks.append(
            "Cross-repository assumptions:\n"
            + "\n".join(f"- {item}" for item in orientation.cross_repo_assumptions)
        )
    for repo_name in sorted(repo_outputs):
        output = repo_outputs[repo_name]
        if output.planning_notes:
            note_blocks.append(f"{repo_name} planning notes: {output.planning_notes}")
        if output.cross_repo_assumptions:
            note_blocks.append(
                f"{repo_name} assumptions:\n"
                + "\n".join(f"- {item}" for item in output.cross_repo_assumptions)
            )
    if review and review.review_notes:
        note_blocks.append(f"Plan review notes: {review.review_notes}")
    if unresolved_issues:
        note_blocks.append(
            "Unresolved plan review issues:\n"
            + "\n".join(
                f"- {issue.repo or 'unscoped'}: {issue.summary} {issue.details}".strip()
                for issue in unresolved_issues
            )
        )

    return Plan(
        stage="planning",
        run_id=run_id,
        task=task,
        task_key=task_key,
        status="completed",
        repos=[repo_plans[name] for name in sorted(repo_plans)],
        planning_notes="\n\n".join(note_blocks),
        generated_at=iso_now(),
    )


def _review_prompt(
    *,
    task: str,
    task_key: str,
    draft_plan: Plan,
    cross_repo_assumptions: Sequence[str],
) -> str:
    return "\n".join([
        "<harness_context>",
        f"<task>{task}</task>",
        f"- **task_key**: `{task_key}`",
        f"- **cross_repo_assumptions**: {json.dumps(list(cross_repo_assumptions))}",
        f"<draft_plan>{draft_plan.model_dump_json(indent=2)}</draft_plan>",
        "</harness_context>",
        "Review the draft plan adversarially and return structured output.",
    ])


def _persist_plan_review(*, run_id: str, review: PlanReviewOutput) -> None:
    """Persist the adversarial review verdict as a write-only debug artifact.

    Nothing in harness reads this back; it exists so review findings can be
    inspected after the fact. Failures must never fail planning.
    """
    try:
        write_json(
            PLAN_REVIEW_JSON,
            {
                "run_id": run_id,
                "generated_at": iso_now(),
                **review.model_dump(mode="json"),
            },
        )
    except OSError as exc:
        print(
            f"warning: failed to write plan review artifact: {exc}",
            file=sys.stderr,
        )


def _review_findings_thought(review: PlanReviewOutput) -> str:
    if review.status == "approved":
        body = "Plan review approved the draft plan."
        if review.review_notes:
            body = f"{body} Notes: {review.review_notes}"
        return body
    findings = "; ".join(
        f"{issue.repo or 'unscoped'}: {issue.summary}" for issue in review.issues
    )
    body = f"Plan review requested revisions with {len(review.issues)} issue(s)."
    if findings:
        body = f"{body} Findings: {findings}"
    if review.review_notes:
        body = f"{body} Notes: {review.review_notes}"
    return body


def _issues_by_repo(issues: Iterable[PlanIssue]) -> dict[str, list[PlanIssue]]:
    grouped: dict[str, list[PlanIssue]] = {}
    for issue in issues:
        if issue.repo:
            grouped.setdefault(issue.repo, []).append(issue)
    return grouped


def run_planning(
    *,
    task: str,
    task_key: str,
    run_id: str,
    events: RoundEvents | None,
) -> Plan:
    """Run the DeepAgents planning pipeline and return plan data.

    This orchestrator is pure with respect to harness artifacts: it does not write
    plan.json or plan.md. The assignment handler owns artifact reuse, validation,
    inbox stamping, and markdown generation. The one exception is the write-only
    plan-review debug artifact (`PLAN_REVIEW_JSON`), which nothing reads back.
    """
    orientation = _orientation_for_task(
        task=task,
        task_key=task_key,
        run_id=run_id,
        events=events,
    )

    oriented_repos = _normalize_oriented_repos(orientation)
    planning_model = _build_stage_model(ModelStage.PLANNING)
    max_retries = _retry.default_agent_max_retries()
    sessions: dict[str, PlanningAgent] = {}
    oriented_by_name: dict[str, OrientedRepo] = {
        repo.name: repo for repo in oriented_repos
    }
    repo_outputs: dict[str, RepoPlanOutput] = {}
    repo_plans: dict[str, PlanRepo] = {}

    try:
        for repo in oriented_repos:
            repo_path = repo_checkout_path(repo.name, workspace=WORKSPACE)
            sessions[repo.name] = PlanningAgent(
                events=events,
                model=planning_model,
                repo_path=repo_path,
                thread_id=f"planning:{run_id}:{repo.name}:{repo_path.resolve()}",
                knowledge_subpaths=_knowledge_subpaths(repo),
            )

        with ThreadPoolExecutor(max_workers=max(1, len(sessions))) as executor:
            futures = {
                executor.submit(
                    _run_repo_prompt_with_retries,
                    agent=session,
                    prompt=_repo_planning_prompt(
                        task=task,
                        task_key=task_key,
                        run_id=run_id,
                        repo=oriented_by_name[repo_name],
                        repo_path=repo_checkout_path(repo_name, workspace=WORKSPACE),
                        orientation_notes=orientation.orientation_notes,
                        cross_repo_assumptions=orientation.cross_repo_assumptions,
                    ),
                    repo_name=repo_name,
                    max_retries=max_retries,
                ): repo_name
                for repo_name, session in sessions.items()
            }
            for future in as_completed(futures):
                repo_name = futures[future]
                output = future.result()
                repo_outputs[repo_name] = output
                repo_plans[repo_name] = _canonical_repo_plan(
                    oriented_repo=oriented_by_name[repo_name],
                    repo_path=repo_checkout_path(repo_name, workspace=WORKSPACE),
                    output=output,
                )

        draft = _compose_plan(
            run_id=run_id,
            task=task,
            task_key=task_key,
            repo_plans=repo_plans,
            repo_outputs=repo_outputs,
            orientation=orientation,
        )

        review_model = _build_stage_model(ModelStage.PLAN_REVIEW)
        review_prompt = _review_prompt(
            task=task,
            task_key=task_key,
            draft_plan=draft,
            cross_repo_assumptions=orientation.cross_repo_assumptions,
        )

        def build_reviewer() -> PlanReviewAgent:
            return PlanReviewAgent(
                events=events,
                model=review_model,
                workspace_dir=WORKSPACE,
                thread_id=f"planning-review:{run_id}",
            )

        review = PlanReviewOutput.model_validate(
            _retry.run_agent_with_retries(
                build_reviewer,
                review_prompt,
                max_retries=max_retries,
                label="DeepAgents plan review",
                resume_prior_state=False,
            )
        )

        _persist_plan_review(run_id=run_id, review=review)
        if events is not None:
            events.thought(_review_findings_thought(review))

        if review.status == "approved":
            return _compose_plan(
                run_id=run_id,
                task=task,
                task_key=task_key,
                repo_plans=repo_plans,
                repo_outputs=repo_outputs,
                orientation=orientation,
                review=review,
            )

        unresolved: list[PlanIssue] = []
        for repo_name, issues in _issues_by_repo(review.issues).items():
            if repo_name in sessions:
                output = _run_repo_prompt_with_retries(
                    agent=sessions[repo_name],
                    prompt=_repo_revision_prompt(issues=issues),
                    repo_name=repo_name,
                    max_retries=max_retries,
                )
                repo_outputs[repo_name] = output
                repo_plans[repo_name] = _canonical_repo_plan(
                    oriented_repo=oriented_by_name[repo_name],
                    repo_path=repo_checkout_path(repo_name, workspace=WORKSPACE),
                    output=output,
                )
                continue

            try:
                repo_path = repo_checkout_path(repo_name, workspace=WORKSPACE)
            except ValueError:
                unresolved.extend(issues)
                continue
            if not repo_path.is_dir():
                unresolved.extend(issues)
                continue

            oriented = OrientedRepo(
                name=repo_name,
                confidence="high",
                rationale="Added by adversarial plan review.",
                components=[],
            )
            oriented_by_name[repo_name] = oriented
            sessions[repo_name] = PlanningAgent(
                events=events,
                model=planning_model,
                repo_path=repo_path,
                thread_id=f"planning:{run_id}:{repo_name}:{repo_path.resolve()}",
                knowledge_subpaths=[],
            )
            output = _run_repo_prompt_with_retries(
                agent=sessions[repo_name],
                prompt=_review_added_repo_prompt(
                    task=task,
                    task_key=task_key,
                    run_id=run_id,
                    repo=oriented,
                    repo_path=repo_path,
                    orientation_notes=orientation.orientation_notes,
                    cross_repo_assumptions=orientation.cross_repo_assumptions,
                    issues=issues,
                ),
                repo_name=repo_name,
                max_retries=max_retries,
            )
            repo_outputs[repo_name] = output
            repo_plans[repo_name] = _canonical_repo_plan(
                oriented_repo=oriented,
                repo_path=repo_path,
                output=output,
            )

        unresolved.extend(issue for issue in review.issues if not issue.repo)
        return _compose_plan(
            run_id=run_id,
            task=task,
            task_key=task_key,
            repo_plans=repo_plans,
            repo_outputs=repo_outputs,
            orientation=orientation,
            review=review,
            unresolved_issues=unresolved,
        )
    finally:
        for session in sessions.values():
            session.close()
