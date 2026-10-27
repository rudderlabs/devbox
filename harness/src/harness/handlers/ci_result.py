"""Handler for `kind='ci_result'` inbox rows — a CI failure on a harness PR.

Fetches failed job logs from GitHub Actions, feeds them to the DeepAgents CI
agent for analysis and fix, then backfills any missing reply and marks the
round complete via fill_missed_replies_and_complete_round. No agent_action
progress events — ci_result is always source='github' and GitHub has no
agent-session UI.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, Any

from harness.ci_logs import fetch_failed_job_logs, parse_run_url
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

    run_url = payload.get("run_url", "")
    parsed = parse_run_url(run_url)
    if parsed:
        owner, repo, run_id = parsed
    else:
        owner, repo, run_id = "", "", None

    # No agent_action progress emit — ci_result is always source='github'
    # and GitHub has no agent-session UI (comment/review handlers also skip
    # progress events for GitHub source).

    failed_jobs: list[dict[str, Any]] = []
    errors: list[str] = []
    if run_id and owner and repo:
        log_dir = CI_LOGS_DIR / str(run_id)
        try:
            failed_jobs, errors = fetch_failed_job_logs(
                owner,
                repo,
                int(run_id),
                log_dir,
            )
        except Exception as exc:
            print(
                f"ci_result: log fetch failed (continuing without logs): "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
            )

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
