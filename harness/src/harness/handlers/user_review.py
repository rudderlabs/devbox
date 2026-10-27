"""Handler for `kind='review'` inbox rows — a submitted GitHub PR review.

Structured payload: the review body and each inline comment is a discrete item
with its own `target_id`. Runs on the DeepAgents follow-up agent
(`followup.run_followup_review`), which continues the task's follow-up thread
and replies to each item independently; `fill_missed_replies_and_complete_round`
backfills any missing reply and emits the bare `completed` marker.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from harness.followup import run_followup_review
from harness.handlers._common import (
    fill_missed_replies_and_complete_round,
    require_task_key,
)

if TYPE_CHECKING:
    from harness.daemon import DaemonState


def process_user_review(entry: dict[str, Any], state: DaemonState) -> None:
    inbox_id = entry["id"]

    # Defensive: a prior daemon invocation already finished this inbox row.
    if state.has_event_for(inbox_id=inbox_id, type_="completed"):
        return

    payload = entry["payload"]  # kind='review' payload
    review_body = payload["review_body"]  # {target_id, body}
    inlines = payload["inline_comments"]  # [{target_id, path, line, body}, ...]
    require_task_key(payload, "review payload")
    # Reviews are GitHub-only today → no agent_action emit (GH has no
    # agent-session UI). A future live-channel review source would gate on
    # is_live_channel(entry["source"]) (harness.handlers._common).

    ordered_target_ids = [
        review_body["target_id"],
        *(c["target_id"] for c in inlines),
    ]

    run_followup_review(entry, state)
    # review_body is optional — the agent replies on it only when the summary
    # raises something distinct from the inlines, so a silent summary thread
    # should NOT get the "didn't post a reply" backfill. Inline comments stay
    # required.
    fill_missed_replies_and_complete_round(
        state,
        inbox_id,
        ordered_target_ids=ordered_target_ids,
        optional_target_ids={review_body["target_id"]},
    )
