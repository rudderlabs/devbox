"""Handler for `kind='ci_result'` inbox rows — a CI failure on a harness PR.

Fetches failed job logs from GitHub Actions, or another CI tool's report, feeds
them to the DeepAgents CI agent for analysis and fix, then backfills any missing
reply and marks the round complete via fill_missed_replies_and_complete_round. No agent_action
progress events — ci_result is always source='github' and GitHub has no
agent-session UI.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, Any

from harness.ci_logs import (
    REPORTED_CI_SOURCES,
    fetch_check_run_report,
    fetch_failed_job_logs,
    parse_check_run_url,
    parse_run_url,
    write_reported_failure,
)
from harness.followup import ci_thread_id, round_started, run_followup_ci
from harness.handlers._common import (
    fill_missed_replies_and_complete_round,
    require_task_key,
)
from harness.paths import HARNESS_DIR

if TYPE_CHECKING:
    from harness.daemon import DaemonState

CI_LOGS_DIR = HARNESS_DIR / "ci-logs"


def _run_ci_round_and_complete(
    entry: dict[str, Any],
    state: DaemonState,
    *,
    failed_jobs: list[dict[str, Any]],
    errors: list[str],
) -> None:
    """Run the CI round on DeepAgents, then backfill replies and complete."""
    run_followup_ci(entry, state, failed_jobs=failed_jobs, errors=errors)
    fill_missed_replies_and_complete_round(
        state,
        entry["id"],
        ordered_target_ids=[entry["payload"]["target_id"]],
    )


def _fetch_actions_logs(
    payload: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    parsed = parse_run_url(payload.get("run_url", ""))
    if not parsed:
        return [], []
    owner, repo, run_id = parsed
    try:
        return fetch_failed_job_logs(owner, repo, run_id, CI_LOGS_DIR / str(run_id))
    except Exception as exc:
        print(
            f"ci_result: log fetch failed (continuing without logs): "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return [], []


def _fetch_reported_failure(
    payload: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    ci_source = payload["ci_source"]
    target_id = str(payload["target_id"])
    errors: list[str] = []
    if ci_source == "check_run":
        parsed = parse_check_run_url(payload.get("run_url", ""))
        if parsed:
            owner, repo, check_run_id = parsed
            try:
                return fetch_check_run_report(
                    owner, repo, check_run_id, CI_LOGS_DIR / f"check-run-{check_run_id}"
                )
            except Exception as exc:
                print(
                    f"ci_result: check run fetch failed (using the webhook's report): "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                errors.append(f"failed to fetch the check run's output: {exc}")
    failed_jobs = write_reported_failure(
        name=str(payload.get("workflow_name", "")),
        conclusion=str(payload.get("conclusion", "failure")),
        summary=str(payload.get("summary", "")),
        details_url=str(payload.get("details_url", "")),
        report_id=target_id,
        output_dir=CI_LOGS_DIR / f"{ci_source}-{target_id}",
    )
    return failed_jobs, errors


def process_ci_result(entry: dict[str, Any], state: DaemonState) -> None:
    inbox_id = entry["id"]

    if state.has_event_for(inbox_id=inbox_id, type_="completed"):
        # because of demon-restarts mid-round, we could have this stage
        # already completed and hence it makes sense to check it first thing
        # and return early.
        return

    payload = entry["payload"]
    target_id = payload["target_id"]
    task_key = require_task_key(payload, "ci_result payload")

    if round_started(state, inbox_id, ci_thread_id(task_key)):
        # A restart of a round the agent already ran (finished, or interrupted
        # mid-run): logs are neither needed nor reliable now (a rerun may have
        # cleared them), and the no-logs shortcut must not answer it twice. The
        # runner skips a finished round and nudges an interrupted one.
        _run_ci_round_and_complete(entry, state, failed_jobs=[], errors=[])
        return

    # No agent_action progress emit — ci_result is always source='github'
    # and GitHub has no agent-session UI (comment/review handlers also skip
    # progress events for GitHub source).

    if payload.get("ci_source") in REPORTED_CI_SOURCES:
        failed_jobs, errors = _fetch_reported_failure(payload)
    else:
        failed_jobs, errors = _fetch_actions_logs(payload)

    # No logs fetched — nothing for the agent to fix.
    # Emit the reply directly (deterministic, no agent needed).
    if not failed_jobs:
        error_summary = (
            "\n".join(f"- {e}" for e in errors) if errors else "No details available."
        )
        state.append_event({
            "type": "agent_response",
            "inbox_id": inbox_id,
            "target_id": target_id,
            "body": (
                f"⚠ CI failed on **{payload.get('workflow_name', 'unknown')}** "
                f"but I could not fetch any job logs to diagnose the failure.\n\n"
                f"**Errors encountered:**\n{error_summary}\n\n"
                f"[View the run]({payload.get('run_url', '')})"
            ),
        })
        state.append_event({"type": "completed", "inbox_id": inbox_id})
        return

    _run_ci_round_and_complete(entry, state, failed_jobs=failed_jobs, errors=errors)
