"""Account DeepAgents v1 invocations: outcomes, usage, failures, and evidence gaps."""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from harness.deepagents.event_contract import TERMINAL_EVENTS

from .event_records import (
    EvidenceFile,
    call_key,
    checked_add,
    compact_json,
    empty_gap,
    parse_evidence,
    source_ref,
)

_OUTCOMES = {
    "invocation_finished": "finished",
    "invocation_failed": "failed",
    "invocation_interrupted": "interrupted",
}


def _add_usage(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not items:
        return None
    total: dict[str, Any] = {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
    }
    for item in items:
        for name in ("input_tokens", "output_tokens", "total_tokens"):
            total[name] = checked_add(total[name], item[name])
        for name in ("input_token_details", "output_token_details"):
            if name not in item:
                continue
            for key, value in item[name].items():
                details = total.setdefault(name, {})
                details[key] = checked_add(details.get(key, 0), value)
    return total


def _usage_from(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    return _add_usage([
        record["usage"] for record in records if record.get("usage") is not None
    ])


def _model_counts(records: list[dict[str, Any]]) -> dict[str, int]:
    starts = [record for record in records if record["event"] == "model_started"]
    finishes = [record for record in records if record["event"] == "model_finished"]
    finished_keys = {call_key(record, record["model_run_id"]) for record in finishes}
    return {
        "started": len(starts),
        "finished": len(finishes),
        "unfinished": sum(
            call_key(record, record["model_run_id"]) not in finished_keys
            for record in starts
        ),
        "missing_usage": sum(record["usage"] is None for record in finishes),
    }


def _tool_counts(records: list[dict[str, Any]]) -> dict[str, int]:
    starts = [record for record in records if record["event"] == "tool_started"]
    finishes = [record for record in records if record["event"] == "tool_finished"]
    failures = [record for record in records if record["event"] == "tool_failed"]
    finished_keys = {
        call_key(record, record["tool_call_id"]) for record in finishes + failures
    }
    return {
        "started": len(starts),
        "success": sum(record["status"] == "success" for record in finishes),
        "handled_error": sum(record["status"] == "error" for record in finishes),
        "exceptions": len(failures),
        "status_unavailable": sum(record["status"] is None for record in finishes),
        "unfinished": sum(
            call_key(record, record["tool_call_id"]) not in finished_keys
            for record in starts
        ),
    }


def _is_ancestor(ancestor: list[str], namespace: list[str]) -> bool:
    return len(ancestor) < len(namespace) and namespace[: len(ancestor)] == ancestor


def _coalesce(value: Any, fallback: Any) -> Any:
    return fallback if value is None else value


def _events(records: list[dict[str, Any]], *names: str) -> list[dict[str, Any]]:
    return [record for record in records if record["event"] in names]


@dataclass(frozen=True)
class _Invocation:
    """One selected invocation file with its records indexed once."""

    path: str
    records: list[dict[str, Any]]
    truncated: bool
    terminal: dict[str, Any] | None
    model_starts: list[dict[str, Any]]
    model_finishes: list[dict[str, Any]]
    model_finish_by_key: dict[str, dict[str, Any]]
    tool_starts: list[dict[str, Any]]
    tool_start_by_key: dict[str, dict[str, Any]]
    tool_results: list[dict[str, Any]]
    tool_result_keys: set[str]
    subgraph_records: list[dict[str, Any]]
    models: dict[str, int]
    tools: dict[str, int]
    usage: dict[str, Any] | None

    @classmethod
    def from_selected(cls, selected: dict[str, Any]) -> "_Invocation":
        records = selected["records"]
        model_finishes = _events(records, "model_finished")
        tool_starts = _events(records, "tool_started")
        tool_results = _events(records, "tool_finished", "tool_failed")
        return cls(
            path=selected["path"],
            records=records,
            truncated=selected["truncated"],
            terminal=next(
                (record for record in records if record["event"] in TERMINAL_EVENTS),
                None,
            ),
            model_starts=_events(records, "model_started"),
            model_finishes=model_finishes,
            model_finish_by_key={
                call_key(record, record["model_run_id"]): record
                for record in model_finishes
            },
            tool_starts=tool_starts,
            tool_start_by_key={
                call_key(record, record["tool_call_id"]): record
                for record in tool_starts
            },
            tool_results=tool_results,
            tool_result_keys={
                call_key(record, record["tool_call_id"]) for record in tool_results
            },
            subgraph_records=_events(records, "subgraph_lifecycle"),
            models=_model_counts(records),
            tools=_tool_counts(records),
            usage=_usage_from(model_finishes),
        )

    @property
    def start(self) -> dict[str, Any]:
        return self.records[0]

    @property
    def outcome(self) -> str:
        return "unknown" if self.terminal is None else _OUTCOMES[self.terminal["event"]]

    def source(self, record: dict[str, Any]) -> dict[str, Any]:
        return source_ref(self.path, record)

    def subgraph_cause(
        self, record: dict[str, Any]
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """Return the unique causing tool start and its cause reference, if any.

        The cause must be a tool started in a strict ancestor namespace.
        """
        cause_id = record["cause_tool_call_id"]
        if cause_id is None:
            return None, None
        candidates = [
            tool
            for tool in self.tool_starts
            if tool["tool_call_id"] == cause_id
            and _is_ancestor(tool["namespace"], record["namespace"])
        ]
        if len(candidates) != 1:
            return None, None
        tool = candidates[0]
        return tool, {"namespace": tool["namespace"], "tool_call_id": cause_id}


def _gap(kind: str, invocation: _Invocation, **values: Any) -> dict[str, Any]:
    return empty_gap(
        kind,
        invocation.path,
        invocation_id=invocation.start["invocation_id"],
        thread_id=invocation.start["thread_id"],
        invocation_outcome=invocation.outcome,
        **values,
    )


def _failure(
    kind: str, invocation: _Invocation, record: dict[str, Any], **values: Any
) -> dict[str, Any]:
    return {
        "kind": kind,
        "invocation_id": invocation.start["invocation_id"],
        "thread_id": invocation.start["thread_id"],
        "namespace": None,
        "model_run_id": None,
        "tool_call_id": None,
        "model": None,
        "provider": None,
        "tool_name": None,
        "ts": record["ts"],
        "error_type": None,
        "error_message": None,
        "error_message_truncated": None,
        "cause": None,
        "context": None,
        "sources": [invocation.source(record)],
        **values,
    }


def _model_gaps(invocation: _Invocation) -> list[dict[str, Any]]:
    gaps = []
    for start in invocation.model_starts:
        finish = invocation.model_finish_by_key.get(
            call_key(start, start["model_run_id"])
        )
        model = _coalesce(finish["model"] if finish else None, start["model"])
        provider = _coalesce(finish["provider"] if finish else None, start["provider"])
        if finish is None:
            gaps.append(
                _gap(
                    "unfinished_model",
                    invocation,
                    namespace=start["namespace"],
                    model_run_id=start["model_run_id"],
                    model=model,
                    provider=provider,
                    started_at=start["ts"],
                    sources=[invocation.source(start)],
                )
            )
        elif finish["usage"] is None:
            gaps.append(
                _gap(
                    "missing_usage",
                    invocation,
                    namespace=finish["namespace"],
                    model_run_id=finish["model_run_id"],
                    model=model,
                    provider=provider,
                    started_at=start["ts"],
                    ended_at=finish["ts"],
                    sources=[invocation.source(start), invocation.source(finish)],
                )
            )
    return gaps


def _invocation_gaps(invocation: _Invocation) -> list[dict[str, Any]]:
    start = invocation.start
    gaps = []
    if invocation.terminal is None:
        gaps.append(
            _gap(
                "missing_terminal",
                invocation,
                started_at=start["ts"],
                sources=[invocation.source(start)],
            )
        )
    if invocation.truncated:
        gaps.append(
            _gap(
                "truncated_tail",
                invocation,
                sources=[invocation.source(invocation.records[-1])],
            )
        )
    gaps.extend(_model_gaps(invocation))
    for tool in invocation.tool_starts:
        if call_key(tool, tool["tool_call_id"]) not in invocation.tool_result_keys:
            gaps.append(
                _gap(
                    "unfinished_tool",
                    invocation,
                    namespace=tool["namespace"],
                    tool_call_id=tool["tool_call_id"],
                    tool_name=tool["tool_name"],
                    started_at=tool["ts"],
                    sources=[invocation.source(tool)],
                )
            )
    for record in invocation.subgraph_records:
        has_cause = record["cause_tool_call_id"] is not None
        if has_cause and invocation.subgraph_cause(record)[1] is None:
            started = record["status"] == "started"
            gaps.append(
                _gap(
                    "unresolved_attribution",
                    invocation,
                    namespace=record["namespace"],
                    tool_call_id=record["cause_tool_call_id"],
                    started_at=record["ts"] if started else None,
                    ended_at=None if started else record["ts"],
                    sources=[invocation.source(record)],
                )
            )
    return gaps


def _invocation_failures(invocation: _Invocation) -> list[dict[str, Any]]:
    failures = []
    for result in invocation.tool_results:
        is_exception = result["event"] == "tool_failed"
        if not is_exception and result["status"] != "error":
            continue
        start = invocation.tool_start_by_key[call_key(result, result["tool_call_id"])]
        failures.append(
            _failure(
                "tool_exception" if is_exception else "handled_tool_error",
                invocation,
                result,
                namespace=result["namespace"],
                tool_call_id=result["tool_call_id"],
                tool_name=start["tool_name"],
                error_type=result["error_type"] if is_exception else None,
                error_message=result["error_message"],
                error_message_truncated=result["error_message_truncated"],
                sources=[invocation.source(start), invocation.source(result)],
            )
        )
    for record in invocation.subgraph_records:
        if record["status"] != "failed":
            continue
        tool, cause = invocation.subgraph_cause(record)
        failures.append(
            _failure(
                "subgraph_failed",
                invocation,
                record,
                namespace=record["namespace"],
                tool_call_id=record["cause_tool_call_id"],
                tool_name=tool["tool_name"] if tool else None,
                cause=cause,
            )
        )
    terminal = invocation.terminal
    if terminal and terminal["event"] == "invocation_failed":
        failures.append(
            _failure(
                "invocation_failed",
                invocation,
                terminal,
                error_type=terminal["error_type"],
                error_message=terminal["error_message"],
                error_message_truncated=terminal["error_message_truncated"],
                context={
                    "models": invocation.models,
                    "tools": invocation.tools,
                    "usage": invocation.usage,
                },
            )
        )
    return failures


def _namespaces(invocation: _Invocation) -> list[dict[str, Any]]:
    sdk_records = [
        record
        for record in invocation.records
        if not record["event"].startswith("invocation_")
    ]
    unique = {}
    for record in sdk_records:
        unique.setdefault(compact_json(record["namespace"]), record["namespace"])
    namespaces = []
    for namespace in unique.values():
        records = [record for record in sdk_records if record["namespace"] == namespace]
        namespaces.append({
            "namespace": namespace,
            "models": _model_counts(records),
            "tools": _tool_counts(records),
            "usage": _usage_from(_events(records, "model_finished")),
        })
    namespaces.sort(key=lambda item: compact_json(item["namespace"]))
    return namespaces


def _subgraphs(invocation: _Invocation) -> list[dict[str, Any]]:
    return [
        {
            "namespace": record["namespace"],
            "status": record["status"],
            "graph_name": record["graph_name"],
            "cause_tool_call_id": record["cause_tool_call_id"],
            "cause": invocation.subgraph_cause(record)[1],
            "ts": record["ts"],
            "source": invocation.source(record),
        }
        for record in invocation.subgraph_records
    ]


def _invocation_entry(invocation: _Invocation) -> dict[str, Any]:
    start = invocation.start
    terminal = invocation.terminal
    finishes = invocation.model_finishes
    return {
        "invocation_id": start["invocation_id"],
        "thread_id": start["thread_id"],
        "outcome": invocation.outcome,
        "started_at": start["ts"],
        "ended_at": terminal["ts"] if terminal else None,
        "elapsed_ms": terminal["elapsed_ms"] if terminal else None,
        "write_ms_before_terminal": (
            terminal["write_ms_before_terminal"] if terminal else None
        ),
        "models": invocation.models,
        "tools": invocation.tools,
        "usage": invocation.usage,
        "root_usage": _usage_from([
            record for record in finishes if not record["namespace"]
        ]),
        "nested_usage": _usage_from([
            record for record in finishes if record["namespace"]
        ]),
        "namespaces": _namespaces(invocation),
        "subgraphs": _subgraphs(invocation),
        "integrity": (
            "terminated" if terminal and not invocation.truncated else "incomplete"
        ),
        "source": {
            "start": invocation.source(start),
            "terminal": invocation.source(terminal) if terminal else None,
        },
    }


def _failure_order(failure: dict[str, Any]) -> str:
    return compact_json([
        failure["kind"],
        failure["invocation_id"],
        failure["namespace"],
        failure["model_run_id"],
        failure["tool_call_id"],
        failure["ts"],
    ])


def _gap_order(gap: dict[str, Any]) -> str:
    return compact_json([
        gap["kind"],
        gap["file"],
        gap["invocation_id"],
        gap["namespace"],
        gap["model_run_id"],
        gap["tool_call_id"],
        gap["started_at"],
    ])


def _usage_by_model(invocations: list[_Invocation]) -> list[dict[str, Any]]:
    starts = {
        call_key(record, record["model_run_id"]): record
        for invocation in invocations
        for record in invocation.model_starts
    }
    groups = {}
    for invocation in invocations:
        for finish in invocation.model_finishes:
            start = starts.get(call_key(finish, finish["model_run_id"]))
            provider = _coalesce(
                finish["provider"], start["provider"] if start else None
            )
            model = _coalesce(finish["model"], start["model"] if start else None)
            group = groups.setdefault(
                compact_json([provider, model]),
                {"provider": provider, "model": model, "usages": []},
            )
            if finish["usage"] is not None:
                group["usages"].append(finish["usage"])
    return [
        {
            "provider": group["provider"],
            "model": group["model"],
            "usage": _add_usage(group["usages"]),
        }
        for _, group in sorted(groups.items(), key=lambda item: item[0])
    ]


def _usage_by_thread(invocations: list[_Invocation]) -> list[dict[str, Any]]:
    thread_ids = sorted({invocation.start["thread_id"] for invocation in invocations})
    return [
        {
            "thread_id": thread_id,
            "usage": _usage_from([
                finish
                for invocation in invocations
                if invocation.start["thread_id"] == thread_id
                for finish in invocation.model_finishes
            ]),
        }
        for thread_id in thread_ids
    ]


def _summary(invocations: list[_Invocation]) -> dict[str, Any]:
    if not invocations:
        return {
            "availability": "unavailable",
            "invocations": None,
            "models": None,
            "tools": None,
            "usage": None,
            "usage_by_model": [],
            "usage_by_thread": [],
        }
    outcomes = {"finished": 0, "failed": 0, "interrupted": 0, "unknown": 0}
    models = {"started": 0, "finished": 0, "unfinished": 0, "missing_usage": 0}
    tools = {
        "started": 0,
        "success": 0,
        "handled_error": 0,
        "exceptions": 0,
        "status_unavailable": 0,
        "unfinished": 0,
    }
    for invocation in invocations:
        outcomes[invocation.outcome] += 1
        for name in models:
            models[name] += invocation.models[name]
        for name in tools:
            tools[name] += invocation.tools[name]
    return {
        "availability": "available",
        "invocations": outcomes,
        "models": models,
        "tools": tools,
        "usage": _usage_from([
            finish for invocation in invocations for finish in invocation.model_finishes
        ]),
        "usage_by_model": _usage_by_model(invocations),
        "usage_by_thread": _usage_by_thread(invocations),
    }


def summarize_events(files: Sequence[EvidenceFile], inbox_id: str) -> dict[str, Any]:
    """Return a deterministic DeepAgents v1 evidence report."""
    parsed = parse_evidence(files, inbox_id)
    invocations = [_Invocation.from_selected(item) for item in parsed["selected"]]
    gaps = list(parsed["gaps"])
    failures = []
    for invocation in invocations:
        gaps.extend(_invocation_gaps(invocation))
        failures.extend(_invocation_failures(invocation))
    entries = sorted(
        (_invocation_entry(invocation) for invocation in invocations),
        key=lambda entry: entry["invocation_id"],
    )
    return {
        "summary": _summary(invocations),
        "invocations": entries,
        "failures": sorted(failures, key=_failure_order),
        "evidence_gaps": sorted(gaps, key=_gap_order),
        "evidence": {
            "included": parsed["included"],
            "excluded": parsed["excluded"],
            "unassigned": parsed["unassigned"],
            "worker_coverage": "unknown",
        },
    }
