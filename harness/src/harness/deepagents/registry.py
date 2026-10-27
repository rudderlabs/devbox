"""Active thread_id registry — prevents concurrent use of the same session identity."""

from __future__ import annotations

import threading


class SessionConflictError(Exception):
    """Raised when a thread_id is already in use by an active session."""


_lock = threading.Lock()
_active: set[str] = set()


def claim(thread_id: str) -> None:
    """Mark *thread_id* as active.

    Raises ``SessionConflictError`` if *thread_id* is already claimed by
    another live session in this process.
    """
    with _lock:
        if thread_id in _active:
            raise SessionConflictError(
                f"thread_id {thread_id!r} is already in use by an active session"
            )
        _active.add(thread_id)


def release(thread_id: str) -> None:
    """Release a previously claimed *thread_id*. No-op if not claimed."""
    with _lock:
        _active.discard(thread_id)


def _reset() -> None:
    """Clear all claims. Test-only."""
    with _lock:
        _active.clear()
