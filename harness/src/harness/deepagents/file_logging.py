"""Persistent file logging for DeepAgents sessions."""

from __future__ import annotations

import hashlib
import logging
import types
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Self

from harness.paths import DEEPAGENTS_LOGS_DIR

LOGGER_NAME = "deepagents.middleware.logging"
_LOG_FORMAT = "%(asctime)s %(levelname)-5s %(message)s"
_DATE_FORMAT = "%H:%M:%S"
_MAX_BYTES = 10 * 1024 * 1024
_BACKUP_COUNT = 3
_SAFE_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
)
_MAX_STEM_LENGTH = 120


class SessionFileLogHandle:
    """Owns a single session file handler and removes it idempotently."""

    def __init__(self, logger: logging.Logger, handler: RotatingFileHandler) -> None:
        self.logger = logger
        self.handler = handler
        self._closed = False

    @property
    def path(self) -> Path:
        """Path written by the owned handler."""
        return Path(self.handler.baseFilename)

    def close(self) -> None:
        """Remove and close the owned handler. Safe to call repeatedly."""
        if self._closed:
            return
        self._closed = True
        self.logger.removeHandler(self.handler)
        self.handler.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: types.TracebackType | None,
    ) -> None:
        self.close()


def _safe_log_basename(thread_id: str) -> str:
    """Return a deterministic, traversal-safe basename for *thread_id*."""
    digest = hashlib.sha256(thread_id.encode("utf-8")).hexdigest()[:12]
    stem = "".join(char if char in _SAFE_CHARS else "_" for char in thread_id)
    stem = stem[:_MAX_STEM_LENGTH]
    if stem in {"", ".", ".."}:
        stem = "thread"
    return f"{stem}-{digest}"


def session_log_path(thread_id: str, logs_dir: Path = DEEPAGENTS_LOGS_DIR) -> Path:
    """Return the log path used for *thread_id* under *logs_dir*."""
    return logs_dir / f"{_safe_log_basename(thread_id)}.log"


def _session_logger_name(thread_id: str) -> str:
    """Return a logger name whose session suffix cannot create descendants."""
    session_component = _safe_log_basename(thread_id).replace(".", "_")
    return f"{LOGGER_NAME}.{session_component}"


def setup_session_file_logging(
    thread_id: str,
    logs_dir: Path = DEEPAGENTS_LOGS_DIR,
) -> SessionFileLogHandle:
    """Attach a rotating file sink for one DeepAgents session.

    The handler is attached to a deterministic child logger unique to the thread.
    The returned handle is a context manager. Its ``close()`` removes and closes
    exactly the handler created here so parallel and later sessions do not
    cross-write.
    """
    logs_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        session_log_path(thread_id, logs_dir),
        maxBytes=_MAX_BYTES,
        backupCount=_BACKUP_COUNT,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT))
    handler.setLevel(logging.INFO)

    logger = logging.getLogger(_session_logger_name(thread_id))
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    return SessionFileLogHandle(logger, handler)
