"""Structured event logging for the harness (stdlib-only).

A dedicated ``harness.events`` logger renders one JSON object per line to
stdout, matching the ``{"level","ts","msg",...}`` shape the sandbox pod already
emits.

This is the structured-*event* surface (machine-readable and queryable),
deliberately distinct from the freeform ``print()`` diagnostics scattered
across the harness and from the per-round ``events.jsonl`` file written by
``events.py``. Freeform prints can migrate onto this logger incrementally;
nothing here requires that sweep up front.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from typing import Any

from harness.paths import HARNESS_DIR
from harness.stages import Stage

# Marks the stage wall-clock event that log queries can select with
# `| json | event="harness.stage_duration"`.
STAGE_DURATION_EVENT = "harness.stage_duration"

_LOGGER_NAME = "harness.events"
_MAX_BYTES = 10 * 1024 * 1024
_BACKUP_COUNT = 3
_STDOUT_HANDLER_ATTR = "_harness_events_stdout"
_FILE_HANDLER_ATTR = "_harness_events_file"

# Records carry caller-supplied fields under this attribute so they survive the
# stdlib LogRecord without colliding with reserved attribute names.
_FIELDS_ATTR = "event_fields"


class JSONFormatter(logging.Formatter):
    """Render each record as a single-line JSON object.

    Fields passed via :func:`log_event` arrive under ``record.event_fields``
    and are spread at the top level so a ``| json`` log query reads them as
    bare keys (``harness_stage``, ``duration_ms``, ...). ``ts`` is
    millisecond-precision UTC with a ``Z`` suffix to match the sandbox's
    existing log lines.
    """

    def format(self, record: logging.LogRecord) -> str:
        dt = datetime.fromtimestamp(record.created, UTC)
        payload: dict[str, Any] = {
            "level": record.levelname.lower(),
            "ts": dt.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "msg": record.getMessage(),
        }
        fields = getattr(record, _FIELDS_ATTR, None)
        if isinstance(fields, dict):
            payload.update(fields)
        return json.dumps(payload, separators=(",", ":"), default=str)


def _has_handler(logger: logging.Logger, marker_attr: str) -> bool:
    return any(getattr(handler, marker_attr, False) for handler in logger.handlers)


def _logger() -> logging.Logger:
    """Return the configured event logger, attaching stdout/file sinks once."""
    logger = logging.getLogger(_LOGGER_NAME)
    formatter = JSONFormatter()
    if not _has_handler(logger, _STDOUT_HANDLER_ATTR):
        handler = logging.StreamHandler(sys.stdout)
        setattr(handler, _STDOUT_HANDLER_ATTR, True)
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    if not _has_handler(logger, _FILE_HANDLER_ATTR):
        try:
            HARNESS_DIR.mkdir(parents=True, exist_ok=True)
            handler = RotatingFileHandler(
                HARNESS_DIR / "harness-events.log",
                maxBytes=_MAX_BYTES,
                backupCount=_BACKUP_COUNT,
                encoding="utf-8",
            )
        except OSError:
            # File persistence must never break the existing stdout event sink.
            pass
        else:
            setattr(handler, _FILE_HANDLER_ATTR, True)
            handler.setFormatter(formatter)
            logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    # Own sink only — never propagate to the root logger (would double-log
    # and bypass the JSON formatter).
    logger.propagate = False
    return logger


def log_event(event: str, **fields: Any) -> None:
    """Emit one structured JSON event line to stdout. Never raises.

    *event* becomes both the human ``msg`` and an ``event`` field, so the line
    stays legible in raw log views and filterable as ``| json | event="..."``.
    Telemetry is fire-and-forget: any failure is swallowed so it can never
    abort the caller.
    """
    try:
        _logger().info(event, extra={_FIELDS_ATTR: {"event": event, **fields}})
    except Exception:  # noqa: S110 — fire-and-forget: logging a logging failure risks recursion
        pass


def sandbox_id() -> str:
    """Return this sandbox's identity for telemetry events.

    Resolved from ``SANDBOX_ID``, then ``HOSTNAME``. The returned value
    populates the ``harness_sandbox_id`` attribute that log queries can
    filter on.
    """
    return (os.environ.get("SANDBOX_ID") or os.environ.get("HOSTNAME") or "").strip()


@contextmanager
def timed_stage(stage: Stage, *, run_id: str, task_key: str) -> Iterator[None]:
    """Bracket a stage's work and log its wall-clock duration on exit.

    Wall-clock measured around the whole stage spans the orchestration and idle
    gaps between model turns. Summing these durations covers the timed stages
    only; it does not equal a run's total elapsed time, because the commit
    stage and ``setup_workspace`` are deliberately not timed.
    Callers wrap only the work a stage actually does: a stage that reuses its
    artifact or is skipped by its gates emits nothing. Emits on the exception
    path too (``outcome="error"``) so a crashing stage still accounts for its
    elapsed time instead of silently vanishing.
    """
    start = time.monotonic()
    outcome = "ok"
    try:
        yield
    except BaseException:
        outcome = "error"
        raise
    finally:
        log_event(
            STAGE_DURATION_EVENT,
            harness_stage=str(stage),
            duration_ms=round((time.monotonic() - start) * 1000.0, 3),
            outcome=outcome,
            harness_run_id=run_id,
            harness_task_key=task_key,
            harness_sandbox_id=sandbox_id(),
        )
