"""In-process appends of round events to events.jsonl.

The daemon injects the events-file path, the lock path, the inbox id, and the
round's target-id set via runtime-only DEVBOX_* env vars; in-process tools (such as
`harness memory`) use them to stream progress into the current round.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import NamedTuple

from harness.events import append_event


class _RoundEventEnv(NamedTuple):
    events_file: Path
    events_lock: Path
    inbox_id: str


def _round_event_env() -> _RoundEventEnv | None:
    """Return daemon-injected event append context, if fully available."""

    events_file = os.environ.get("DEVBOX_EVENTS_FILE")
    events_lock = os.environ.get("DEVBOX_EVENTS_LOCK")
    inbox_id = os.environ.get("DEVBOX_INBOX_ID")
    if not (events_file and events_lock and inbox_id):
        return None
    return _RoundEventEnv(Path(events_file), Path(events_lock), inbox_id)


def _target_ids_from_env() -> list[str]:
    """Round target ids in env order, skipping empty comma-separated entries."""

    return [t for t in (os.environ.get("DEVBOX_TARGET_IDS") or "").split(",") if t]


def append_agent_thought(body: str) -> int | None:
    """Best-effort programmatic append of an ``agent_thought`` round event.

    Intentionally quiet: callers such as in-process tools should not fail their
    primary work when the daemon event env is absent, no target id is
    available, or event append fails.
    """

    round_env = _round_event_env()
    target_ids = _target_ids_from_env()
    if round_env is None or not target_ids:
        return None

    payload: dict[str, object] = {
        "type": "agent_thought",
        "inbox_id": round_env.inbox_id,
        "target_id": target_ids[0],
        "body": body,
    }
    try:
        return append_event(round_env.events_file, round_env.events_lock, payload)
    except Exception:
        return None
