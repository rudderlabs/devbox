"""Handler for `kind='comment'` inbox rows — a follow-up comment on a PR,
Linear session or API task.

Runs the round on the DeepAgents follow-up agent (`followup.run_followup_comment`),
which continues the task's follow-up thread. The agent posts its reply through
its reply tool; `fill_missed_replies_and_complete_round` backfills any missing
reply and emits the bare `completed` marker.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from harness.followup import run_followup_comment
from harness.handlers._common import (
    fill_missed_replies_and_complete_round,
    is_live_channel,
    require_task_key,
)

if TYPE_CHECKING:
    from harness.daemon import DaemonState


def process_comment(entry: dict[str, Any], state: DaemonState) -> None:
    inbox_id = entry["id"]

    # Defensive: a prior daemon invocation already finished this inbox row.
    if state.has_event_for(inbox_id=inbox_id, type_="completed"):
        return

    payload = entry["payload"]  # kind='comment' payload: {target_id, body, ...}
    target_id = payload["target_id"]
    # Validate the task key before any user-visible event.
    require_task_key(payload, "comment payload")

    # Live channels only (Linear agent session, API/CLI event log): surface a
    # conversational status. GitHub has no equivalent (the 👀 reaction was the
    # GH-side ack, fired by CP). Phrased like a normal agent message rather than
    # a system label.
    if is_live_channel(entry["source"]):
        state.append_event({
            "type": "agent_action",
            "inbox_id": inbox_id,
            "target_id": target_id,
            "body": "Working on it",
        })

    run_followup_comment(entry, state)
    fill_missed_replies_and_complete_round(
        state,
        inbox_id,
        ordered_target_ids=[target_id],
    )
