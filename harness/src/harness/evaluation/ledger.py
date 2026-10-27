"""Summarize the harness assignment ledger (events.jsonl) for one inbox."""

from typing import Any

from .archive import LEDGER_PATH
from .event_records import EvidenceFile
from .parsing import (
    parse_json,
    require_object,
    require_text,
    safe_integer,
    timestamp_ms,
)

MISSING = object()


def _complete_lines(content: bytes) -> tuple[list[bytes], bool]:
    parts = content.split(b"\n")
    return parts[:-1], bool(parts[-1])


def _timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"Invalid {label}")  # noqa: TRY004
    try:
        timestamp_ms(value)
    except ValueError as error:
        raise ValueError(f"Invalid {label}") from error
    return value


def _assignment_record(line: bytes, line_number: int) -> dict[str, Any]:
    value = parse_json(line, f"assignment ledger line {line_number}")
    record = {
        "seq": safe_integer(value.get("seq"), "Assignment record sequence", minimum=1),
        "ts": _timestamp(value.get("ts"), "assignment timestamp"),
        "type": require_text(value.get("type"), "assignment event type"),
    }
    if "inbox_id" in value:
        record["inbox_id"] = require_text(value["inbox_id"], "assignment inbox ID")
    if "status" in value:
        if not isinstance(value["status"], str):
            raise ValueError("Assignment status must be a string")
        record["status"] = value["status"]
    if record["type"] == "agent_error" and isinstance(value.get("body"), str):
        record["body"] = value["body"]
    retryable = value.get("retryable_assignment_failure")
    if record["type"] == "agent_error" and isinstance(retryable, bool):
        record["retryable"] = retryable
    return record


def _records(ledger: EvidenceFile | None) -> tuple[list[dict[str, Any]], bool]:
    lines, truncated = _complete_lines(ledger.content) if ledger else ([], False)
    records = [
        _assignment_record(line, line_number)
        for line_number, line in enumerate(lines, 1)
    ]
    previous = 0
    for record in records:
        if record["seq"] <= previous:
            raise ValueError("Assignment record sequences must be increasing")
        previous = record["seq"]
    return records, truncated


def _endpoint(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "seq": record["seq"],
        "ts": record["ts"],
        "type": record["type"],
        "status": record.get("status"),
        "source": {"file": LEDGER_PATH, "seq": record["seq"]},
    }


def capture_terminal(value: Any, inbox_id: str) -> dict[str, Any] | None:
    """Validate the capture manifest's terminal event; MISSING means absent."""
    if value is MISSING:
        return None
    terminal = require_object(value, "capture terminal")
    safe_integer(terminal.get("seq"), "Capture terminal sequence", minimum=1)
    if terminal.get("type") != "completed" or terminal.get("inbox_id") != inbox_id:
        raise ValueError("Invalid capture terminal identity")
    _timestamp(terminal.get("ts"), "capture terminal timestamp")
    if "status" in terminal and not isinstance(terminal["status"], str):
        raise ValueError("Capture terminal status must be a string")
    return terminal


def _same_terminal(manifest: dict[str, Any], terminal: dict[str, Any]) -> bool:
    return all(
        manifest.get(name) == terminal.get(name)
        for name in ("seq", "ts", "type", "inbox_id")
    ) and manifest.get("status") == terminal.get("status")


def _bounded_error_body(body: str) -> tuple[str, bool]:
    return body[:1000], len(body) > 1000


def _error_observations(selected: list[dict[str, Any]]) -> list[dict[str, Any]]:
    observations = []
    for record in selected:
        if record["type"] != "agent_error":
            continue
        body = record.get("body")
        safe_body, body_truncated = (
            (None, False) if body is None else _bounded_error_body(body)
        )
        observations.append({
            "ts": record["ts"],
            "body": safe_body,
            "body_truncated": body_truncated,
            "retryable": record.get("retryable"),
            "source": {"file": LEDGER_PATH, "seq": record["seq"]},
        })
    return observations


def summarize_execution(
    ledger: EvidenceFile | None,
    inbox_id: str,
    manifest_terminal: dict[str, Any] | None,
) -> dict[str, Any]:
    """Return the report's execution section for *inbox_id*."""
    gaps = []
    if ledger is None:
        gaps.append({"kind": "missing_ledger", "file": LEDGER_PATH})
    records, truncated = _records(ledger)
    if truncated:
        gaps.append({"kind": "truncated_tail", "file": LEDGER_PATH})
    selected = [record for record in records if record.get("inbox_id") == inbox_id]
    first = selected[0] if selected else None
    terminals = [record for record in selected if record["type"] == "completed"]
    terminal = terminals[-1] if terminals else None
    if first is None:
        gaps.append({"kind": "missing_first_event", "file": LEDGER_PATH})
    if terminal is None:
        gaps.append({"kind": "missing_terminal", "file": LEDGER_PATH})
    if terminal is None or "status" not in terminal:
        gaps.append({"kind": "missing_status", "file": LEDGER_PATH})
    if (
        terminal
        and manifest_terminal
        and not _same_terminal(manifest_terminal, terminal)
    ):
        raise ValueError(
            "Assignment terminal does not match the capture manifest terminal"
        )
    elapsed = (
        timestamp_ms(terminal["ts"]) - timestamp_ms(first["ts"])
        if first and terminal
        else None
    )
    elapsed_ms = elapsed if elapsed is not None and elapsed >= 0 else None
    if elapsed is not None and elapsed < 0:
        gaps.append({"kind": "negative_duration", "file": LEDGER_PATH})
    return {
        "first_event": _endpoint(first) if first else None,
        "terminal": _endpoint(terminal) if terminal else None,
        "status": terminal.get("status") if terminal else None,
        "elapsed_ms": elapsed_ms,
        "error_observations": _error_observations(selected),
        "evidence_gaps": gaps,
    }
