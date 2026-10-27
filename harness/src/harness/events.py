"""Multi-writer append-only event log for `events.jsonl`.

Two processes append to `events.jsonl` — the always-on daemon and the
short-lived `harness memory` CLI. A shared, flock-guarded writer
keeps `seq` monotonic across both: the counter is (re)derived from the file tail
under `events.lock` on every append, so neither process keeps an in-memory
counter.

Imported by both `daemon.py` and `emit.py`; deliberately free of daemon state.
"""

from __future__ import annotations

import fcntl
import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from harness.util import iso_now

RETRYABLE_ASSIGNMENT_ERROR_EVENT_FIELD = "retryable_assignment_failure"


def iter_events(events_file: Path) -> Iterator[dict[str, Any]]:
    """Yield each event object from `events_file`, in file order.

    Centralises the read discipline shared by every event-log reader: a missing
    file yields nothing, and a torn or non-object line (a crash can leave a
    valid-JSON-but-not-an-object fragment, or invalid JSON) is skipped rather
    than raising.
    """
    if not events_file.exists():
        return
    with events_file.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue  # torn line — skip
            if isinstance(e, dict):
                yield e


def _scan_max_seq(events_file: Path) -> int:
    """Largest `seq` currently in the file. Tolerates a torn last line."""
    if not events_file.exists():
        return 0
    last = 0
    try:
        with events_file.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue  # torn line — skip
                # A torn line can be valid JSON but not an object (a bare `42` /
                # `null`); guard before `.get()` or it raises AttributeError.
                if not isinstance(parsed, dict):
                    continue
                v = parsed.get("seq")
                if isinstance(v, int) and v > last:
                    last = v
    except OSError:
        return 0
    return last


def append_event(events_file: Path, lock_file: Path, payload: dict[str, Any]) -> int:
    """Append one event to events.jsonl. THE single writer.

    Shared by the daemon and the `harness memory` CLI. flock(events.lock)
    serialises the two processes; `seq` is (re)derived from the file tail under
    the lock, so neither side keeps a counter. Returns the assigned seq.
    """
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    events_file.parent.mkdir(parents=True, exist_ok=True)
    with lock_file.open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)  # blocking — exclusive
        try:
            seq = _scan_max_seq(events_file) + 1
            event = {"seq": seq, "ts": iso_now(), **payload}
            line = json.dumps(event, separators=(",", ":")) + "\n"
            with events_file.open("a", encoding="utf-8") as f:
                # Write-integrity: a prior crash mid-write can leave a torn last
                # line with no trailing newline. A plain append would fuse the
                # new event onto that fragment. Prepend a newline when the
                # file's last byte is not "\n" so the torn fragment stays its
                # own droppable line.
                if events_file.stat().st_size > 0:
                    with events_file.open("rb") as rf:
                        rf.seek(-1, os.SEEK_END)
                        if rf.read(1) != b"\n":
                            f.write("\n")
                f.write(line)
                f.flush()
                os.fsync(f.fileno())  # CP sees it on the next reconcile tick
            return seq
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


_RESERVED_FIELDS = frozenset({"type", "inbox_id", "target_id", "body", "seq", "ts"})


class RoundEvents:
    """Publishes the events of one round (one inbox entry) to events.jsonl.

    Bound to the event log, the round's inbox id and the round's target, so a
    holder cannot publish into another round. Calls post to the bound target
    unless they name another one, for example ``reply`` in a round with
    several items.
    """

    def __init__(
        self,
        *,
        events_file: Path,
        events_lock: Path,
        inbox_id: str,
        target_id: str,
    ) -> None:
        if not inbox_id:
            raise ValueError("RoundEvents requires a non-empty inbox_id")
        if not target_id:
            raise ValueError("RoundEvents requires a non-empty target_id")
        self._events_file = events_file
        self._events_lock = events_lock
        self._inbox_id = inbox_id
        self._target_id = target_id

    @property
    def inbox_id(self) -> str:
        return self._inbox_id

    @property
    def target_id(self) -> str:
        return self._target_id

    def publish(
        self,
        event_type: str,
        *,
        body: str,
        target_id: str | None = None,
        **fields: Any,
    ) -> int:
        """Append one round event and return its seq. Raises on failure.

        Posts to the round's target unless ``target_id`` names another one.
        """
        target = self._target_id if target_id is None else target_id
        if not target:
            raise ValueError("RoundEvents.publish requires a target_id")
        reserved = _RESERVED_FIELDS.intersection(fields)
        if reserved:
            raise ValueError(
                f"RoundEvents.publish fields may not override {sorted(reserved)}"
            )
        payload: dict[str, Any] = {
            "type": event_type,
            "inbox_id": self._inbox_id,
            "target_id": target,
            "body": body,
            **fields,
        }
        return append_event(self._events_file, self._events_lock, payload)

    def thought(self, body: str) -> int | None:
        """Best-effort ``agent_thought`` to the round's target.

        Never raises; returns None on failure.
        """
        try:
            return self.publish("agent_thought", body=body)
        except Exception:
            return None
