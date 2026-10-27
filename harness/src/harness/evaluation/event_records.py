"""Validate DeepAgents v1 JSONL evidence files and select one inbox's invocations."""

import hashlib
import json
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, NoReturn

from harness.deepagents.event_contract import (
    EVENTS,
    PACKAGES,
    STREAM_VERSION,
    SUBGRAPH_STATUSES,
    TERMINAL_EVENTS,
    VERSION,
)

from .parsing import MAX_SAFE_INTEGER, timestamp_ms


@dataclass(frozen=True)
class EvidenceFile:
    path: str
    content: bytes


_UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.IGNORECASE)


def _invalid(path: str, message: str) -> NoReturn:
    raise ValueError(f"Invalid DeepAgents evidence {path}: {message}")


def _object(value: Any, path: str, field: str = "record") -> dict[str, Any]:
    if not isinstance(value, dict):
        _invalid(path, f"{field} must be an object")
    return value


def _field(record: dict[str, Any], name: str, path: str) -> Any:
    if name not in record:
        _invalid(path, f"{name} is required")
    return record[name]


def _string(
    record: dict[str, Any], name: str, path: str, *, nonempty: bool = False
) -> str:
    value = _field(record, name, path)
    if not isinstance(value, str) or (nonempty and not value):
        qualifier = "a nonempty " if nonempty else "a "
        _invalid(path, f"{name} must be {qualifier}string")
    return value


def _nullable_string(record: dict[str, Any], name: str, path: str) -> str | None:
    value = _field(record, name, path)
    if value is not None and not isinstance(value, str):
        _invalid(path, f"{name} must be a string or null")
    return value


def _number(record: dict[str, Any], name: str, path: str) -> int | float:
    value = _field(record, name, path)
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
    ):
        _invalid(path, f"{name} must be a finite nonnegative number")
    return value


def _safe_count(record: dict[str, Any], name: str, path: str) -> int:
    value = _field(record, name, path)
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        _invalid(path, f"{name} must be a nonnegative safe integer")
    return value


def checked_add(left: int, right: int) -> int:
    total = left + right
    if total > MAX_SAFE_INTEGER:
        raise ValueError("Token total exceeds safe integer range")
    return total


def _usage(value: Any, path: str) -> dict[str, Any] | None:
    if value is None:
        return None
    record = _object(value, path, "usage")
    input_tokens = _safe_count(record, "input_tokens", path)
    output_tokens = _safe_count(record, "output_tokens", path)
    total_tokens = _safe_count(record, "total_tokens", path)
    if checked_add(input_tokens, output_tokens) != total_tokens:
        _invalid(path, "usage total is invalid")
    result: dict[str, Any] = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }
    for name in ("input_token_details", "output_token_details"):
        if name not in record:
            continue
        details = _object(record[name], path, name)
        result[name] = {
            key: _safe_count({"detail": detail}, "detail", path)
            for key, detail in details.items()
        }
    return result


def _validate_sdk(record: dict[str, Any], path: str) -> None:
    namespace = _field(record, "namespace", path)
    if not isinstance(namespace, list) or not all(
        isinstance(part, str) for part in namespace
    ):
        _invalid(path, "namespace must be an array of strings")
    source_timestamp = _field(record, "source_timestamp_ms", path)
    if source_timestamp is not None:
        _number(record, "source_timestamp_ms", path)


def _validate_record(value: Any, path: str) -> dict[str, Any]:
    record = _object(value, path)
    version = _field(record, "version", path)
    if isinstance(version, bool) or version != VERSION:
        _invalid(path, f"unsupported event version {version}")
    event = _string(record, "event", path)
    if event not in EVENTS:
        _invalid(path, f"unsupported event {event}")
    invocation_id = _string(record, "invocation_id", path, nonempty=True)
    if not _UUID.fullmatch(invocation_id):
        _invalid(path, "invocation_id must be a UUID")
    _string(record, "thread_id", path, nonempty=True)
    inbox_id = _field(record, "inbox_id", path)
    if inbox_id is not None:
        _string(record, "inbox_id", path, nonempty=True)
    sequence = _safe_count(record, "seq", path)
    if sequence < 1:
        _invalid(path, "seq must be positive")
    timestamp = _string(record, "ts", path)
    try:
        timestamp_ms(timestamp, sdk=True)
    except ValueError:
        _invalid(path, "ts must be a UTC timestamp")
    _number(record, "elapsed_ms", path)

    if event == "invocation_started":
        if _field(record, "stream_version", path) != STREAM_VERSION:
            _invalid(path, f'stream_version must be "{STREAM_VERSION}"')
        packages = _object(_field(record, "packages", path), path, "packages")
        for name in PACKAGES:
            _nullable_string(packages, name, path)
    elif event in TERMINAL_EVENTS:
        _number(record, "write_ms_before_terminal", path)
        if event == "invocation_failed":
            _string(record, "error_type", path)
            _nullable_string(record, "error_message", path)
            if not isinstance(_field(record, "error_message_truncated", path), bool):
                _invalid(path, "error_message_truncated must be a boolean")
    else:
        _validate_sdk(record, path)
        if event.startswith("model_"):
            _string(record, "model_run_id", path)
            for name in ("model", "provider", "message_id", "node"):
                _nullable_string(record, name, path)
            if event == "model_finished":
                _nullable_string(record, "response_id", path)
                record["usage"] = _usage(_field(record, "usage", path), path)
        elif event.startswith("tool_"):
            _string(record, "tool_call_id", path)
            if event == "tool_started":
                tool_name = _nullable_string(record, "tool_name", path)
                if tool_name == "task":
                    _nullable_string(record, "subagent_type", path)
                elif "subagent_type" in record:
                    _invalid(path, "subagent_type is only valid for task tools")
            else:
                _nullable_string(record, "error_message", path)
                if not isinstance(
                    _field(record, "error_message_truncated", path), bool
                ):
                    _invalid(path, "error_message_truncated must be a boolean")
                if event == "tool_finished" and _field(record, "status", path) not in (
                    "success",
                    "error",
                    None,
                ):
                    _invalid(path, "tool status is invalid")
                if event == "tool_failed":
                    _nullable_string(record, "error_type", path)
        else:
            status = _field(record, "status", path)
            if not isinstance(status, str) or status not in SUBGRAPH_STATUSES:
                _invalid(path, "subgraph status is invalid")
            _nullable_string(record, "graph_name", path)
            _nullable_string(record, "cause_tool_call_id", path)
    return record


def _decode_line(line: bytes, path: str, line_number: int) -> Any:
    try:
        text = line.decode("utf-8-sig")
    except UnicodeDecodeError:
        _invalid(path, f"line {line_number} is not valid UTF-8")
    try:
        return json.loads(
            text,
            parse_constant=lambda _constant: (_ for _ in ()).throw(ValueError()),
        )
    except (json.JSONDecodeError, ValueError):
        _invalid(path, f"line {line_number} is not valid JSON")


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def call_key(record: dict[str, Any], identifier: str) -> str:
    return compact_json([record["invocation_id"], record["namespace"], identifier])


def _validate_calls(records: list[dict[str, Any]], path: str) -> None:
    model_starts: set[str] = set()
    model_finishes: set[str] = set()
    tool_starts: set[str] = set()
    tool_finishes: set[str] = set()
    for record in records:
        event = record["event"]
        if event == "model_started":
            key = call_key(record, record["model_run_id"])
            if key in model_starts:
                _invalid(path, "duplicate model start")
            model_starts.add(key)
        elif event == "model_finished":
            key = call_key(record, record["model_run_id"])
            if key in model_finishes:
                _invalid(path, "duplicate model finish")
            if key not in model_starts:
                _invalid(path, "model finish without start")
            model_finishes.add(key)
        elif event == "tool_started":
            key = call_key(record, record["tool_call_id"])
            if key in tool_starts:
                _invalid(path, "duplicate tool start")
            tool_starts.add(key)
        elif event in ("tool_finished", "tool_failed"):
            key = call_key(record, record["tool_call_id"])
            if key in tool_finishes:
                _invalid(path, "duplicate tool finish")
            if key not in tool_starts:
                _invalid(path, "tool finish without start")
            tool_finishes.add(key)


def source_ref(path: str, record: dict[str, Any]) -> dict[str, Any]:
    return {"file": path, "seq": record["seq"]}


def empty_gap(kind: str, file: str, **values: Any) -> dict[str, Any]:
    return {
        "kind": kind,
        "file": file,
        "invocation_id": None,
        "thread_id": None,
        "namespace": None,
        "model_run_id": None,
        "tool_call_id": None,
        "model": None,
        "provider": None,
        "tool_name": None,
        "started_at": None,
        "ended_at": None,
        "invocation_outcome": None,
        "sources": [],
        **values,
    }


def _inventory(
    file: EvidenceFile, start: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "path": file.path,
        "sha256": hashlib.sha256(file.content).hexdigest(),
        "invocation_id": start["invocation_id"] if start else None,
        "thread_id": start["thread_id"] if start else None,
        "inbox_id": start["inbox_id"] if start else None,
        "version": start["version"] if start else None,
        "stream_version": start["stream_version"] if start else None,
        "packages": start["packages"] if start else None,
    }


def parse_evidence(files: Sequence[EvidenceFile], inbox_id: str) -> dict[str, Any]:
    paths: set[str] = set()
    invocation_ids: set[str] = set()
    selected = []
    included = []
    excluded = []
    unassigned = []
    gaps = []
    for file in sorted(files, key=lambda item: item.path):
        if file.path in paths:
            _invalid(file.path, "duplicate file")
        paths.add(file.path)
        parts = file.content.split(b"\n")
        lines = parts[:-1]
        truncated = bool(parts[-1])
        if not lines:
            unassigned.append(_inventory(file))
            kind = "empty_file" if not file.content else "unassigned_file"
            gaps.append(empty_gap(kind, file.path))
            continue
        first = _validate_record(_decode_line(lines[0], file.path, 1), file.path)
        if first["event"] != "invocation_started":
            _invalid(file.path, "first record must be invocation_started")
        if first["seq"] != 1:
            _invalid(file.path, "invocation start sequence must be 1")
        file_inventory = _inventory(file, first)
        if first["inbox_id"] != inbox_id:
            excluded.append(
                file_inventory | {"reason": "inbox_id does not match requested inbox"}
            )
            continue
        if file.path.rsplit("/", 1)[-1] != f"{first['invocation_id']}.jsonl":
            _invalid(file.path, "filename must match invocation_id")
        if first["invocation_id"] in invocation_ids:
            _invalid(file.path, "duplicate invocation")
        invocation_ids.add(first["invocation_id"])
        records = [first]
        records.extend(
            _validate_record(_decode_line(line, file.path, index), file.path)
            for index, line in enumerate(lines[1:], 2)
        )
        previous_elapsed = -1
        terminal_seen = False
        for index, record in enumerate(records, 1):
            if record["seq"] != index:
                _invalid(file.path, "record sequence must be contiguous from 1")
            if any(
                record[name] != first[name]
                for name in ("invocation_id", "thread_id", "inbox_id", "version")
            ):
                _invalid(file.path, "records must have stable identity and version")
            if record["elapsed_ms"] < previous_elapsed:
                _invalid(file.path, "elapsed_ms must be monotonic")
            previous_elapsed = record["elapsed_ms"]
            if index > 1 and record["event"] == "invocation_started":
                _invalid(file.path, "duplicate invocation start")
            if terminal_seen:
                _invalid(file.path, "complete record after invocation terminal")
            if record["event"] in TERMINAL_EVENTS:
                terminal_seen = True
        _validate_calls(records, file.path)
        included.append(file_inventory)
        selected.append({"path": file.path, "records": records, "truncated": truncated})
    return {
        "selected": selected,
        "included": included,
        "excluded": excluded,
        "unassigned": unassigned,
        "gaps": gaps,
    }
