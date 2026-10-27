"""Opt-in DeepAgents v1 execution events: per-invocation JSONL evidence."""

from __future__ import annotations

import json
import os
import sys
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, TextIO
from uuid import uuid4

from harness.deepagents.event_contract import PACKAGES, STREAM_VERSION, VERSION

# SDK lifecycle event -> contract subgraph status (see event_contract).
_LIFECYCLE_STATUSES = {
    "started": "started",
    "running": "started",
    "completed": "completed",
    "failed": "failed",
    "interrupted": "interrupted",
}


def _error_fields(value: Any) -> dict[str, Any]:
    """Return bounded diagnostic text without retaining structured error data."""
    empty = {"error_message": None, "error_message_truncated": False}
    try:
        if isinstance(value, BaseException):
            body = getattr(value, "body", None)
            if body is not None:
                text = body.get("message") if isinstance(body, Mapping) else None
                if not isinstance(text, str):
                    return empty
            else:
                text = str(value)
        elif isinstance(value, str):
            text = value
        else:
            return empty
        if not text:
            return empty
    except Exception:
        return empty
    return {
        "error_message": text[:1000],
        "error_message_truncated": len(text) > 1000,
    }


def _tool_messages(output: Any) -> list[Any]:
    from langchain_core.messages import ToolMessage
    from langgraph.types import Command

    if isinstance(output, ToolMessage):
        return [output]
    if isinstance(output, Command) and isinstance(output.update, Mapping):
        return [
            message
            for message in output.update.get("messages", [])
            if isinstance(message, ToolMessage)
        ]
    return []


def _tool_error_text(output: Any) -> str | None:
    for message in _tool_messages(output):
        if message.status != "error":
            continue
        content = message.content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text: list[str] = []
            for block in content:
                if isinstance(block, Mapping) and isinstance(block.get("text"), str):
                    text.append(block["text"])
            if text:
                return "\n".join(text)
    return None


def _tool_status(output: Any) -> str | None:
    """Read structured status, including task tools returning a Command."""
    statuses = [message.status for message in _tool_messages(output)]
    return (
        "error"
        if "error" in statuses
        else ("success" if "success" in statuses else None)
    )


def _usage(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise TypeError("Model usage must be a mapping")
    result: dict[str, Any] = {}
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        item = value.get(key)
        if type(item) is not int or not 0 <= item <= 2**53 - 1:
            return None
        result[key] = item
    if result["input_tokens"] + result["output_tokens"] != result["total_tokens"]:
        return None
    for key in ("input_token_details", "output_token_details"):
        if key not in value:
            continue
        details = value[key]
        if not isinstance(details, Mapping) or not all(
            isinstance(name, str) and type(item) is int and 0 <= item <= 2**53 - 1
            for name, item in details.items()
        ):
            continue
        result[key] = dict(details)
    return result


def _package_versions() -> dict[str, str | None]:
    packages: dict[str, str | None] = {}
    for name in PACKAGES:
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = None
    return packages


def _metric_event(event: Mapping[str, Any]) -> dict[str, Any] | None:
    """Select metadata from the SDK's raw stream, including nested namespaces."""
    from langchain_core.messages import AIMessage, AIMessageChunk

    method = event["method"]
    params = event["params"]
    data = params["data"]
    record: dict[str, Any] = {
        "namespace": params["namespace"],
        "source_timestamp_ms": params.get("timestamp"),
    }
    if method == "messages":
        payload, metadata = data
        if isinstance(payload, AIMessage) and not isinstance(payload, AIMessageChunk):
            return None
        if not isinstance(payload, dict) or payload.get("event") not in {
            "message-start",
            "message-finish",
        }:
            return None
        if payload.get("role", "ai") not in {"ai", "assistant"}:
            return None
        details = payload.get("metadata") or {}
        record.update(
            event=(
                "model_started"
                if payload["event"] == "message-start"
                else "model_finished"
            ),
            model_run_id=metadata["run_id"],
            message_id=payload.get("id") or payload.get("message_id"),
            node=metadata.get("langgraph_node"),
            model=details.get("model_name")
            or details.get("model")
            or metadata.get("ls_model_name"),
            provider=details.get("model_provider")
            or details.get("provider")
            or metadata.get("ls_provider"),
        )
        if record["event"] == "model_finished":
            record["usage"] = _usage(payload.get("usage"))
            record["response_id"] = details.get("id")
        return record
    if method == "tools":
        names = {
            "tool-started": "tool_started",
            "tool-finished": "tool_finished",
            "tool-error": "tool_failed",
        }
        if data.get("event") not in names:
            return None
        record.update(event=names[data["event"]], tool_call_id=data["tool_call_id"])
        if data["event"] == "tool-started":
            record["tool_name"] = data.get("tool_name")
            if record["tool_name"] == "task":
                record["subagent_type"] = (data.get("input") or {}).get("subagent_type")
        elif data["event"] == "tool-finished":
            record["status"] = _tool_status(data.get("output"))
            record.update(_error_fields(_tool_error_text(data.get("output"))))
        else:
            record["error_type"] = data.get("code")
            # The SDK has already rendered the exception, potentially including a
            # provider response body, so no safely bounded source remains here.
            record.update(_error_fields(None))
        return record
    if method == "lifecycle":
        status = _LIFECYCLE_STATUSES[data["event"]]
        return {
            **record,
            "event": "subgraph_lifecycle",
            "namespace": data["namespace"],
            "status": status,
            "graph_name": data.get("graph_name"),
            "cause_tool_call_id": (data.get("cause") or {}).get("tool_call_id"),
        }
    return None


def invoke_with_metrics(
    graph: Any,
    inputs: dict[str, Any],
    config: dict[str, Any],
    *,
    thread_id: str,
    directory: Path,
    inbox_id: str | None = None,
) -> dict[str, Any]:
    """Consume v3 once, persist metadata as it arrives, return the final state.

    Collection failures disable this invocation's writer without changing the
    single graph execution or replacing its result/exception.
    """
    invocation_id = str(uuid4())
    started = time.monotonic()
    common = {
        "version": VERSION,
        "invocation_id": invocation_id,
        "thread_id": thread_id,
        "inbox_id": inbox_id,
    }
    seq = 0
    write_seconds = 0.0
    recording = True
    warned = False
    output_file: TextIO | None = None

    def disable_capture(error: Exception) -> None:
        nonlocal recording, warned
        recording = False
        if warned:
            return
        warned = True
        try:
            print(
                "warning: DeepAgents metrics capture disabled for "
                f"invocation {invocation_id}: {type(error).__name__}",
                file=sys.stderr,
            )
        except Exception:
            return

    def write(record: dict[str, Any]) -> None:
        nonlocal seq, write_seconds
        if not recording or output_file is None:
            return
        before = time.monotonic()
        try:
            next_seq = seq + 1
            output_file.write(
                json.dumps(
                    {
                        **common,
                        "seq": next_seq,
                        "ts": datetime.now(UTC).isoformat(),
                        "elapsed_ms": round((before - started) * 1000, 3),
                        **record,
                    },
                    allow_nan=False,
                )
                + "\n"
            )
            output_file.flush()
            os.fsync(output_file.fileno())
            seq = next_seq
            write_seconds += time.monotonic() - before
        except Exception as error:
            disable_capture(error)

    try:
        directory.mkdir(parents=True, exist_ok=True)
        output_file = (directory / f"{invocation_id}.jsonl").open("x", encoding="utf-8")
    except Exception as error:
        disable_capture(error)

    if recording:
        try:
            write({
                "event": "invocation_started",
                "stream_version": STREAM_VERSION,
                "packages": _package_versions(),
            })
        except Exception as error:
            disable_capture(error)

    try:
        with graph.stream_events(
            inputs, config=config, version=STREAM_VERSION
        ) as stream:
            for event in stream:
                if recording:
                    try:
                        record = _metric_event(event)
                        if record is not None:
                            write(record)
                    except Exception as error:
                        disable_capture(error)
            result = stream.output
            if not isinstance(result, dict):
                raise TypeError("DeepAgents stream returned no final state")
            terminal = (
                "invocation_interrupted"
                if stream.interrupted
                else "invocation_finished"
            )
    except BaseException as error:
        write({
            "event": "invocation_failed",
            "error_type": type(error).__name__,
            **_error_fields(error),
            "write_ms_before_terminal": round(write_seconds * 1000, 3),
        })
        raise
    else:
        write({
            "event": terminal,
            "write_ms_before_terminal": round(write_seconds * 1000, 3),
        })
        return result
    finally:
        if output_file is not None:
            try:
                output_file.close()
            except Exception as error:
                disable_capture(error)
