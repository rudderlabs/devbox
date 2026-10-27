"""Singleton SQLite checkpointer for durable agent sessions.

Call ``init_checkpointer(db_path)`` once at process startup before creating
any durable ``DeepAgentSession``. The module manages the singleton
internally; sessions call ``get_checkpointer()`` to obtain it.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.sqlite import SqliteSaver

# Checkpoint metadata key carrying the inbox id of the round that wrote it.
# Multi-round follow-up threads use it to tell a crashed round from a new one;
# single-use threads never set it.
ROUND_TAG_KEY = "harness_round"

_lock = threading.Lock()
_instance: SqliteSaver | None = None


def init_checkpointer(db_path: Path) -> None:
    """Initialize the module-level SQLite checkpointer.

    Creates parent directories if needed, instantiates the ``SqliteSaver``,
    and calls ``.setup()`` immediately to avoid the deadlock bug
    (langchain-ai/langgraph#5150).

    Raises ``RuntimeError`` if called a second time.
    """
    global _instance
    with _lock:
        if _instance is not None:
            raise RuntimeError(
                "Checkpointer already initialized — "
                "init_checkpointer() must be called exactly once"
            )
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.execute(
            "PRAGMA journal_mode=WAL"
        )  # WAL enables concurrent readers with a single writer for parallel agents
        saver = SqliteSaver(conn)
        saver.setup()
        _instance = saver


def get_checkpointer() -> SqliteSaver:
    """Return the initialized checkpointer.

    Raises ``RuntimeError`` if ``init_checkpointer()`` has not been called.
    """
    if _instance is None:
        raise RuntimeError(
            "Checkpointer not initialized — call init_checkpointer(db_path) at startup"
        )
    return _instance


def checkpoint_exists(thread_id: str) -> bool:
    """Whether the thread has any checkpoint (False when no checkpointer is set up)."""
    try:
        saver = get_checkpointer()
    except RuntimeError:
        return False
    return saver.get_tuple({"configurable": {"thread_id": thread_id}}) is not None


def round_tag_of(saver: BaseCheckpointSaver, thread_id: str) -> str | None:
    """The round tag of the thread's latest checkpoint on ``saver``, or ``None``."""
    saved = saver.get_tuple({"configurable": {"thread_id": thread_id}})
    if saved is None:
        return None
    tag = (saved.metadata or {}).get(ROUND_TAG_KEY)
    return tag if isinstance(tag, str) else None


def latest_round_tag(thread_id: str) -> str | None:
    """The round tag of the thread's latest checkpoint, needing no session.

    ``None`` without a checkpoint, an untagged one, or an uninitialized
    checkpointer.
    """
    try:
        saver = get_checkpointer()
    except RuntimeError:
        return None
    return round_tag_of(saver, thread_id)


def _reset_checkpointer() -> None:
    """Tear down the singleton. Test-only."""
    global _instance
    with _lock:
        if _instance is not None:
            _instance.conn.close()
        _instance = None
