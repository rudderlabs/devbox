"""Durable follow-up rounds on DeepAgents.

Briefs, per-round configuration, the round runner and the entry points the
comment, user-review and CI handlers call. A round runs on one of two durable
threads per ticket: ``followup:<ticket>`` (comments and reviews) or
``ci:<ticket>`` (CI failures).
"""

from __future__ import annotations

import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from harness.ci_logs import parse_run_url
from harness.deepagents.agents.followup import CiAgent, FollowUpAgent
from harness.deepagents.checkpointer import latest_round_tag
from harness.deepagents.middleware.ci_rerun import WorkflowRunRef
from harness.deepagents.middleware.memory_writing import RepoScope
from harness.deepagents.middleware.pull_request import PullRequestRef
from harness.deepagents.middleware.reply import ReplyTarget
from harness.deepagents.model import ModelStage, build_model, resolve_model
from harness.deepagents.retry import AttemptState, run_with_retry_policy
from harness.discussion_context import fetch_discussion_context_for_pr
from harness.distillation import post_code_round_distillation
from harness.events import iter_events
from harness.git import GitHubClient, parse_pr_url
from harness.handlers._common import (
    _covered_target_ids,
    _read_json_or_none,
    require_task_key,
    seeded_context_block,
)
from harness.memory import MemoryStore
from harness.obs import timed_stage
from harness.paths import PLAN_JSON, WORKSPACE
from harness.plan_utils import knowledge_subpaths_for_repo
from harness.schemas import Plan
from harness.stages import Stage
from harness.tracing import flush_trace, init_trace, trace_span
from harness.util import defang, fenced, new_run_id

if TYPE_CHECKING:
    from harness.daemon import DaemonState
    from harness.deepagents.session import DeepAgentSession


def followup_thread_id(task_key: str) -> str:
    return f"followup:{task_key}"


def ci_thread_id(task_key: str) -> str:
    return f"ci:{task_key}"


# ──── Briefs ────


def _header(stage: str, channel: str | None, pr: Mapping[str, Any] | None) -> list[str]:
    lines = ["<harness_context>", f"- **stage**: {stage}"]
    if channel is not None:
        lines.append(f"- **channel**: {channel}")
    if pr:
        lines += [
            f"- **repo**: `{defang(str(pr.get('repo', '')))}`",
            f"- **pull request**: {defang(str(pr.get('pr_url', '')))}",
        ]
    return lines


def _body(text: str) -> list[str]:
    return fenced(defang(text), "markdown")


def _line_label(comment: Mapping[str, Any]) -> str:
    # Same rules as user_review._inline_line_label: single-line anchors use
    # `line`; a range may also carry `start_line`, in either order.
    start_raw, end_raw = comment.get("start_line"), comment.get("line")
    start = start_raw if isinstance(start_raw, int) else None
    end = end_raw if isinstance(end_raw, int) else None
    if start is None and end is None:
        return ""
    if start is None:
        return str(end)
    if end is None or start == end:
        return str(start)
    lo, hi = sorted((start, end))
    return f"{lo}-{hi}"


def comment_brief(*, body: str, channel: str, pr: Mapping[str, Any] | None) -> str:
    return "\n".join([
        *_header("addressing comment", channel, pr),
        "",
        "### Comment",
        *_body(body),
        "</harness_context>",
        "",
        "Address the comment above, then answer it with `reply`.",
    ])


def review_brief(
    *,
    review_body: Mapping[str, Any],
    inlines: Sequence[Mapping[str, Any]],
    channel: str,
    pr: Mapping[str, Any] | None,
) -> str:
    summary = str(review_body.get("body") or "")
    lines = [
        *_header("addressing review", channel, pr),
        "",
        f"### Review summary (target `{review_body['target_id']}`)",
        *(_body(summary) if summary.strip() else ["_(no summary text)_"]),
    ]
    for i, comment in enumerate(inlines, start=1):
        label = _line_label(comment)
        file_line = f"- **file**: `{defang(str(comment.get('path', '')))}`"
        if label:
            file_line += f"  **lines**: {label}"
        lines += [
            "",
            f"### Inline comment {i} (target `{comment['target_id']}`)",
            file_line,
            *_body(str(comment.get("body") or "")),
        ]
    lines += [
        "</harness_context>",
        "",
        "Address every item above. Answer each inline comment with `reply`, naming "
        "its target; answer the review summary only if it raises a distinct concern.",
    ]
    return "\n".join(lines)


def ci_brief(
    *,
    payload: Mapping[str, Any],
    failed_jobs: Sequence[Mapping[str, Any]],
    errors: Sequence[str],
) -> str:
    pr = payload.get("pr") if isinstance(payload.get("pr"), Mapping) else None
    lines = [
        "<harness_context>",
        "- **stage**: addressing CI failure",
        f"- **workflow**: {defang(str(payload.get('workflow_name', 'unknown')))}",
        f"- **conclusion**: {defang(str(payload.get('conclusion', 'failure')))}",
        f"- **run**: {defang(str(payload.get('run_url', '')))}",
        f"- **head sha**: {defang(str(payload.get('head_sha', '')))}",
        f"- **head branch**: {defang(str(payload.get('head_branch', '')))}",
    ]
    if pr:
        lines += [
            f"- **repo**: `{defang(str(pr.get('repo', '')))}`",
            f"- **pull request**: {defang(str(pr.get('pr_url', '')))}",
        ]
    lines += [
        "",
        "### Failed job logs (on disk)",
        *(
            f"- **{defang(str(j['job_name']))}**: `{defang(str(j['log_path']))}`"
            for j in failed_jobs
        ),
    ]
    if errors:
        lines += [
            "",
            "### Log fetch errors",
            "Some failed jobs' logs could not be fetched. Mention this in your reply.",
            *(f"- {defang(e)}" for e in errors),
        ]
    lines += [
        "</harness_context>",
        "",
        "Find the root cause in the logs, fix it, then answer with `reply`.",
    ]
    return "\n".join(lines)


def review_targets(
    review_body: Mapping[str, Any], inlines: Sequence[Mapping[str, Any]]
) -> list[ReplyTarget]:
    targets = [ReplyTarget(str(review_body["target_id"]), "review summary")]
    for comment in inlines:
        where = defang(str(comment.get("path", "")))
        label = _line_label(comment)
        targets.append(
            ReplyTarget(
                str(comment["target_id"]),
                f"inline comment on {where}:{label}"
                if label
                else f"inline comment on {where}",
            )
        )
    return targets


# ──── Discussion ────


def comment_own_items(target_id: str, body: str) -> list[dict[str, Any]]:
    """The triggering comment as seen-set items (see handlers/comment.py)."""
    if not str(target_id).isdigit():
        return []
    return [
        {"type": "issue_comment", "id": int(target_id), "body": body},
        {"type": "review_comment", "id": int(target_id), "body": body},
    ]


def review_own_items(
    review_body: Mapping[str, Any], inlines: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """A review's own items as seen-set items (see handlers/user_review.py)."""
    items: list[dict[str, Any]] = [
        {
            "type": "review_comment",
            "id": int(c["target_id"]),
            "body": str(c.get("body", "")),
        }
        for c in inlines
        if str(c.get("target_id", "")).isdigit()
    ]
    if (
        str(review_body.get("target_id", "")).isdigit()
        and str(review_body.get("body", "")).strip()
    ):
        items.append({
            "type": "review",
            "id": int(review_body["target_id"]),
            "body": str(review_body.get("body", "")),
        })
    return items


def with_discussion(
    brief: str,
    *,
    pr: Mapping[str, Any] | None,
    session_key: str,
    before: str | None,
    own_items: list[dict[str, Any]],
) -> str:
    """Prepend the PR discussion not yet seen on this thread, defanged."""
    discussion = fetch_discussion_context_for_pr(pr, session_key, before, own_items)
    if not discussion:
        return brief
    return f"{defang(discussion)}\n\n{brief}"


# ──── Per-round configuration ────


def task_pull_requests(events_file: Path) -> tuple[PullRequestRef, ...]:
    """The task's pull requests: the latest valid ``pr_opened`` URL per repo."""
    by_repo: dict[str, str] = {}
    for event in iter_events(events_file):
        if event.get("type") != "pr_opened":
            continue
        repo, url = event.get("repo"), event.get("pr_url")
        if isinstance(repo, str) and isinstance(url, str) and parse_pr_url(url):
            by_repo[repo] = url
    return tuple(PullRequestRef(repo, url) for repo, url in by_repo.items())


def memory_repos(plan_data: Mapping[str, Any]) -> tuple[RepoScope, ...]:
    """The plan's repositories as memory scopes; none when the plan is unusable."""
    try:
        plan = Plan.model_validate(plan_data)
    except ValidationError:
        return ()
    return tuple(
        RepoScope(
            repo.name, tuple(knowledge_subpaths_for_repo(repo, workspace=WORKSPACE))
        )
        for repo in plan.repos
    )


@dataclass(frozen=True)
class RoundConfig:
    prs: tuple[PullRequestRef, ...]
    memory_repos: tuple[RepoScope, ...]


def round_config(*, events_file: Path, plan_data: Mapping[str, Any]) -> RoundConfig:
    return RoundConfig(
        prs=task_pull_requests(events_file),
        memory_repos=memory_repos(plan_data),
    )


# ──── Round runner ────

FINISHED_EVENT = "followup_agent_finished"

_NUDGE_HEAD = (
    "This round was interrupted. Continue from where you left off; "
    "your earlier work in this round is above."
)


def agent_finished(events_file: Path, inbox_id: str) -> bool:
    return any(
        e.get("type") == FINISHED_EVENT and e.get("inbox_id") == inbox_id
        for e in iter_events(events_file)
    )


def round_started(state: DaemonState, inbox_id: str, thread_id: str) -> bool:
    """Whether the round already ran: the agent returned, or its tag is the thread's latest.

    Callers that would otherwise short-circuit a round (CI without logs) use
    this to leave a started round to the runner, which skips or nudges it.
    """
    return (
        agent_finished(state.events_file, inbox_id)
        or latest_round_tag(thread_id) == inbox_id
    )


def _ids(ids: Sequence[str]) -> str:
    return ", ".join(f"`{i}`" for i in ids) + "." if ids else "none."


def continue_nudge(
    *, replied: Sequence[str], pending: Sequence[str], optional: Sequence[str]
) -> str:
    lines = [
        _NUDGE_HEAD,
        f"Already replied to: {_ids(replied)}",
        f"Still to reply to: {_ids(pending)}",
    ]
    if optional:
        lines.append(f"Optional: {_ids(optional)}")
    return "\n".join(lines)


def _round_prompt(
    agent: DeepAgentSession[Any],
    *,
    state: DaemonState,
    inbox_id: str,
    brief: Callable[[], str],
    seed: str,
    targets: Sequence[str],
    optional_targets: frozenset[str],
) -> str:
    """Decide what this attempt sends and repair the checkpoint tail.

    ``brief`` is called only on the paths that send it, never for a nudge.
    """
    if not agent.has_prior_state:
        return f"{seed}\n\n{brief()}"
    tag = agent.latest_round_tag
    # Repair under the tag of the checkpoint being repaired, so a crash right
    # after the repair still reads as the same round.
    agent.repair_dangling_tool_calls(round_tag=tag)
    if tag != inbox_id:
        return brief()
    covered = _covered_target_ids(state.events_file, inbox_id)
    return continue_nudge(
        replied=[t for t in targets if t in covered],
        pending=[t for t in targets if t not in covered and t not in optional_targets],
        optional=[t for t in targets if t not in covered and t in optional_targets],
    )


def run_followup_round(
    build_agent: Callable[[], DeepAgentSession[Any]],
    *,
    state: DaemonState,
    inbox_id: str,
    brief: Callable[[], str],
    seed: str,
    targets: Sequence[str],
    optional_targets: frozenset[str] = frozenset(),
    label: str,
    max_retries: int | None = None,
) -> None:
    """Run one follow-up round on its thread, surviving restarts and retries.

    Each attempt builds a fresh session and decides again: skip (the agent
    already returned), seed and brief (fresh thread), continue nudge (this
    round's tag is the latest), or brief (a new round). Retries reuse
    ``retry.py``'s classification and backoff; checkpoint progress resets the
    consecutive-failure budget, and a hard cap bounds the loop.

    ``brief`` is a factory: it runs only when a brief is actually sent (fresh
    thread or new round), at most once per call; a retry before the first
    checkpoint resends the first result. A skipped or nudged round never calls
    it, so building it can have side effects (the discussion fetch).
    """
    if agent_finished(state.events_file, inbox_id):
        return

    brief_text: list[str] = []

    def cached_brief() -> str:
        if not brief_text:
            brief_text.append(brief())
        return brief_text[0]

    def attempt_body(attempt: AttemptState) -> str:
        agent = attempt.agent
        prompt = _round_prompt(
            agent,
            state=state,
            inbox_id=inbox_id,
            brief=cached_brief,
            seed=seed,
            targets=targets,
            optional_targets=optional_targets,
        )
        # Measured after the repair: only the run counts as the attempted turn.
        attempt.begin_turn()
        agent.run(prompt, round_tag=inbox_id)
        # Right after the run, so the only crash window is the append itself.
        state.append_event({
            "type": FINISHED_EVENT,
            "inbox_id": inbox_id,
            "thread_id": agent.thread_id,
        })
        return agent.thread_id

    run_with_retry_policy(
        build_agent, attempt_body, label=label, max_retries=max_retries
    )


# ──── Entry points ────


def _model() -> Any:
    choice = resolve_model(ModelStage.FOLLOWUP)
    return build_model(model=choice.model, reasoning_effort=choice.reasoning_effort)


def _pr(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    pr = payload.get("pr")
    return pr if isinstance(pr, dict) else None


def _repo_slugs(pr: Mapping[str, Any] | None) -> list[str]:
    repo = pr.get("repo") if pr else None
    return [repo] if isinstance(repo, str) else []


def _shared_agent_kwargs(
    state: DaemonState,
    *,
    inbox_id: str,
    thread_id: str,
    event_target_id: str,
) -> dict[str, Any]:
    """Preset kwargs every round kind shares: config, events, model and clients."""
    plan_data = _read_json_or_none(PLAN_JSON) or {}
    config = round_config(events_file=state.events_file, plan_data=plan_data)
    return {
        "model": _model(),
        "thread_id": thread_id,
        "events": state.round_events(inbox_id, event_target_id),
        "prs": config.prs,
        "memory_repos": config.memory_repos,
        "memory": MemoryStore(),
        "github": GitHubClient(),
    }


def _run_round(
    *,
    state: DaemonState,
    inbox_id: str,
    task_key: str,
    stage: Stage,
    task: str,
    primary_target: str,
    pr: Mapping[str, Any] | None,
    build: Callable[[], DeepAgentSession[Any]],
    brief: Callable[[], str],
    targets: Sequence[str],
    optional_targets: frozenset[str],
    label: str,
) -> None:
    """The shared round frame: distillation, tracing, timing, runner.

    ``brief`` is the runner's factory (see ``run_followup_round``).
    """
    run_id = new_run_id()
    with post_code_round_distillation(
        state=state,
        inbox_id=inbox_id,
        repo_slugs=_repo_slugs(pr),
        run_id=run_id,
        task_key=task_key,
        target_id=primary_target,
    ):
        if agent_finished(state.events_file, inbox_id):
            # Re-entry after the agent returned: only distillation is left.
            return
        try:
            with (
                init_trace(
                    run_id=run_id,
                    task=task,
                    task_key=task_key,
                    agent="deepagents",
                ),
                trace_span(
                    "agent-run",
                    as_type="generation",
                    model="deepagents-followup",
                    input={"stage": str(stage), "task_key": task_key},
                ),
                timed_stage(stage, run_id=run_id, task_key=task_key),
            ):
                run_followup_round(
                    build,
                    state=state,
                    inbox_id=inbox_id,
                    brief=brief,
                    seed=seeded_context_block(),
                    targets=targets,
                    optional_targets=optional_targets,
                    label=label,
                )
        finally:
            try:
                flush_trace()
            except Exception as exc:
                print(
                    f"followup: flush_trace failed (ignored): {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )


def run_followup_comment(entry: dict[str, Any], state: DaemonState) -> None:
    inbox_id = entry["id"]
    payload = entry["payload"]
    target_id = str(payload["target_id"])
    body = payload["body"]
    ticket = require_task_key(payload, "comment payload")
    pr = _pr(payload)
    channel = entry["source"]

    def brief() -> str:
        text = comment_brief(body=body, channel=channel, pr=pr)
        if channel == "github" and pr:
            text = with_discussion(
                text,
                pr=pr,
                session_key=followup_thread_id(ticket),
                before=payload.get("created_at"),
                own_items=comment_own_items(target_id, body),
            )
        return text

    shared = _shared_agent_kwargs(
        state,
        inbox_id=inbox_id,
        thread_id=followup_thread_id(ticket),
        event_target_id=target_id,
    )

    def build() -> FollowUpAgent:
        return FollowUpAgent(**shared, targets=[ReplyTarget(target_id, "the comment")])

    _run_round(
        state=state,
        inbox_id=inbox_id,
        task_key=ticket,
        stage=Stage.COMMENT,
        task=body,
        primary_target=target_id,
        pr=pr,
        build=build,
        brief=brief,
        targets=[target_id],
        optional_targets=frozenset(),
        label=f"followup/{ticket}",
    )


def run_followup_review(entry: dict[str, Any], state: DaemonState) -> None:
    inbox_id = entry["id"]
    payload = entry["payload"]
    review_body = payload["review_body"]
    inlines = payload["inline_comments"]
    ticket = require_task_key(payload, "review payload")
    pr = _pr(payload)
    channel = entry["source"]
    summary_id = str(review_body["target_id"])
    targets = review_targets(review_body, inlines)

    def brief() -> str:
        text = review_brief(
            review_body=review_body, inlines=inlines, channel=channel, pr=pr
        )
        if channel == "github" and pr:
            text = with_discussion(
                text,
                pr=pr,
                session_key=followup_thread_id(ticket),
                before=payload.get("created_at"),
                own_items=review_own_items(review_body, inlines),
            )
        return text

    shared = _shared_agent_kwargs(
        state,
        inbox_id=inbox_id,
        thread_id=followup_thread_id(ticket),
        event_target_id=summary_id,
    )

    def build() -> FollowUpAgent:
        return FollowUpAgent(**shared, targets=targets)

    _run_round(
        state=state,
        inbox_id=inbox_id,
        task_key=ticket,
        stage=Stage.USER_REVIEW,
        task=str(review_body.get("body") or "PR review"),
        primary_target=summary_id,
        pr=pr,
        build=build,
        brief=brief,
        targets=[t.id for t in targets],
        optional_targets=frozenset({summary_id}),
        label=f"followup/{ticket}",
    )


def run_followup_ci(
    entry: dict[str, Any],
    state: DaemonState,
    *,
    failed_jobs: list[dict[str, Any]],
    errors: list[str],
) -> None:
    inbox_id = entry["id"]
    payload = entry["payload"]
    target_id = str(payload["target_id"])
    ticket = require_task_key(payload, "ci_result payload")
    pr = _pr(payload)
    parsed = parse_run_url(payload.get("run_url", ""))
    if parsed is None:
        raise ValueError(f"ci_result: unparseable run_url {payload.get('run_url')!r}")
    run = WorkflowRunRef(*parsed)

    def brief() -> str:
        return ci_brief(payload=payload, failed_jobs=failed_jobs, errors=errors)

    shared = _shared_agent_kwargs(
        state,
        inbox_id=inbox_id,
        thread_id=ci_thread_id(ticket),
        event_target_id=target_id,
    )

    def build() -> CiAgent:
        return CiAgent(**shared, run=run)

    _run_round(
        state=state,
        inbox_id=inbox_id,
        task_key=ticket,
        stage=Stage.CI,
        task=f"CI failure: {payload.get('workflow_name', 'unknown')}",
        primary_target=target_id,
        pr=pr,
        build=build,
        brief=brief,
        targets=[target_id],
        optional_targets=frozenset(),
        label=f"ci/{ticket}",
    )
