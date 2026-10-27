# DeepAgents execution events — v1

This is the supported file format for DeepAgents execution evidence produced by
the harness. It records SDK-observed execution metadata, not prompts, successful
tool output, complete provider billing, or whole-harness usage.

## Enable collection and locate files

Set `HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING=true` to enable collection. The flag
defaults to `false`; when disabled, DeepAgents uses its existing `graph.invoke()`
path and writes no execution-event file.

Each `DeepAgentSession.run()` call writes one exclusive-create JSON Lines file:

```text
WORKSPACE/.harness/deepagents-events/<invocation_id>.jsonl
```

The adapter consumes `graph.stream_events(..., version="v3")` once and returns
the SDK's final output. SDK stream protocol **v3** and this persisted file format
**v1** are independent versions. There is no supported Python event-reader CLI;
offline consumers read the JSONL files directly and validate the contract below.

## Common envelope (field, JSON type, required/null semantics)

Every record is a JSON object with these required, non-null fields except where
shown:

| Field | JSON type | Meaning |
| --- | --- | --- |
| `version` | integer | Always `1`. |
| `event` | string | One event name documented below. |
| `invocation_id` | string | UUID for this invocation; also the filename stem. |
| `thread_id` | string | Nonempty opaque conversation/checkpoint identity. |
| `inbox_id` | string or null | Nonempty assignment identity when available; `null` for standalone execution. |
| `seq` | integer | Positive, contiguous sequence number starting at `1` in each file. |
| `ts` | string | UTC ISO 8601 timestamp when the harness observed the record. |
| `elapsed_ms` | number | Finite, nonnegative monotonic milliseconds since this invocation started. |

SDK-derived model, tool, and lifecycle records also require:

| Field | JSON type | Meaning |
| --- | --- | --- |
| `namespace` | array of strings | SDK graph path; `[]` is the root graph. |
| `source_timestamp_ms` | number or null | Finite, nonnegative SDK conversion timestamp when supplied; not an authoritative provider occurrence time. |

All numeric values in v1 must be finite and nonnegative. Token counts, sequence
numbers, and token-detail values are safe integers (at most `2^53 - 1`). Do not
compare monotonic `elapsed_ms` values across invocation files.

## Invocation events

Invocation records are harness-derived and therefore do not have `namespace` or
`source_timestamp_ms`.

| Event | Required additional fields |
| --- | --- |
| `invocation_started` | `stream_version`: string, always `"v3"`; `packages`: object described below. |
| `invocation_finished` | `write_ms_before_terminal`: finite nonnegative number. |
| `invocation_interrupted` | `write_ms_before_terminal`: finite nonnegative number. This means the SDK reported an interruption. |
| `invocation_failed` | `error_type`: string; `error_message`: string or null; `error_message_truncated`: boolean; `write_ms_before_terminal`: finite nonnegative number. |

`packages` has the required keys `devbox-harness`, `deepagents`, `langchain`,
`langchain-core`, `langchain-openai`, `langgraph`, and `langchain-protocol`.
Each value is a version string or `null` when package metadata was unavailable.

An invocation failure does not establish which outstanding model or tool call
failed. `invocation_interrupted` is never inferred from process death; a file
without a terminal record has an unknown invocation outcome.

Invocation failure example:

```json
{
  "version": 1,
  "event": "invocation_failed",
  "invocation_id": "11111111-1111-4111-8111-111111111111",
  "thread_id": "thread-7",
  "inbox_id": "inbox-42",
  "seq": 8,
  "ts": "2026-09-21T12:00:00.500000+00:00",
  "elapsed_ms": 500.25,
  "error_type": "RuntimeError",
  "error_message": "model stream ended unexpectedly",
  "error_message_truncated": false,
  "write_ms_before_terminal": 12.75
}
```

## Model events and token usage

`model_started` and `model_finished` require `model_run_id` (string) and the
following nullable fields, which are present even when the SDK supplies no
value: `model`, `provider`, `message_id`, and `node` (each string or null).

`model_finished` additionally requires `response_id` (string or null) and `usage`
(object or null). A non-null `usage` object requires safe-integer
`input_tokens`, `output_tokens`, and `total_tokens`, with input plus output equal
to total. `input_token_details` and `output_token_details` are optional objects:
absence means the provider supplied no usable detail map; if present, each maps
string names to nonnegative safe integers. A detail map may be present and empty.
Details partition or describe their corresponding total and are never added to
the totals again. `usage: null` means unavailable, not zero.

Root model finish example:

```json
{
  "version": 1,
  "event": "model_finished",
  "invocation_id": "11111111-1111-4111-8111-111111111111",
  "thread_id": "thread-7",
  "inbox_id": "inbox-42",
  "seq": 3,
  "ts": "2026-09-21T12:00:00.200000+00:00",
  "elapsed_ms": 200.5,
  "namespace": [],
  "source_timestamp_ms": 1790000000200,
  "model_run_id": "model-run-1",
  "model": "example-model",
  "provider": "example-provider",
  "message_id": "message-1",
  "node": "model",
  "response_id": "response-1",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 2,
    "total_tokens": 12,
    "input_token_details": {"cache_read": 4}
  }
}
```

## Tool events and error details

All tool events require `tool_call_id` (string).

| Event | Required additional fields |
| --- | --- |
| `tool_started` | `tool_name`: string or null. When `tool_name` is `"task"`, `subagent_type` is also present as string or null; it is absent for other tools. |
| `tool_finished` | `status`: `"success"`, `"error"`, or null; `error_message`: string or null; `error_message_truncated`: boolean. |
| `tool_failed` | `error_type`: string or null; `error_message`: string or null; `error_message_truncated`: boolean. |

`tool_failed` is an exception surfaced by the SDK. A `tool_finished` record with
`status: "error"` is a handled tool error. `status: null` means structured status
was unavailable. Framework success does not prove shell exit status or business
success.

Handled tool error example:

```json
{
  "version": 1,
  "event": "tool_finished",
  "invocation_id": "11111111-1111-4111-8111-111111111111",
  "thread_id": "thread-7",
  "inbox_id": "inbox-42",
  "seq": 6,
  "ts": "2026-09-21T12:00:00.400000+00:00",
  "elapsed_ms": 400,
  "namespace": [],
  "source_timestamp_ms": null,
  "tool_call_id": "tool-2",
  "status": "error",
  "error_message": "requested item was not found",
  "error_message_truncated": false
}
```

## Nested graph lifecycle and attribution

`subgraph_lifecycle` requires `status` (`"started"`, `"completed"`, `"failed"`,
or `"interrupted"`), `graph_name` (string or null), and `cause_tool_call_id`
(string or null). Nested work stays within its containing invocation.

A namespace is an opaque SDK graph path; it does not by itself prove delegation.
Resolve `cause_tool_call_id` only against an unambiguous tool call in an ancestor
namespace. Never assume a namespace component is a tool-call ID, and do not infer
agent type from thread or namespace labels.

Nested task linkage example (two complete JSON records):

```json
[
  {
    "version": 1,
    "event": "tool_started",
    "invocation_id": "11111111-1111-4111-8111-111111111111",
    "thread_id": "thread-7",
    "inbox_id": "inbox-42",
    "seq": 4,
    "ts": "2026-09-21T12:00:00.250000+00:00",
    "elapsed_ms": 250,
    "namespace": [],
    "source_timestamp_ms": 1790000000250,
    "tool_call_id": "task-1",
    "tool_name": "task",
    "subagent_type": "general-purpose"
  },
  {
    "version": 1,
    "event": "subgraph_lifecycle",
    "invocation_id": "11111111-1111-4111-8111-111111111111",
    "thread_id": "thread-7",
    "inbox_id": "inbox-42",
    "seq": 5,
    "ts": "2026-09-21T12:00:00.300000+00:00",
    "elapsed_ms": 300,
    "namespace": ["tools:task-1"],
    "source_timestamp_ms": 1790000000300,
    "status": "started",
    "graph_name": "general-purpose",
    "cause_tool_call_id": "task-1"
  }
]
```

## Ordering, identities, and replay exclusion

Records are ordered by contiguous `seq`, starting at `1`; `elapsed_ms` must be
nondecreasing. A file has exactly one `invocation_started` record and at most one
terminal invocation record, which must be last. Each invocation, including work
resumed on the same thread, receives a fresh invocation ID and file.

Model-call identity is `(invocation_id, namespace, model_run_id)`. Tool-call
identity is `(invocation_id, namespace, tool_call_id)`. Pair starts and finishes
using those full identities. Count each live `model_finished` usage object once,
including nested calls and usage observed before a later failure. Root and nested
usage are a partition, not additive views of separate work.

State-message replays and token, text, or reasoning deltas are excluded. Provider
HTTP retries that the SDK does not expose may be invisible. Repeated thread IDs do
not establish retries, and thread labels must not be parsed for lifecycle meaning.

## Best-effort writes and incomplete evidence

Retained records are serialized, newline-terminated, flushed, and `fsync`ed before
the next stream event is consumed. On the first metadata, serialization, file,
write, flush, or `fsync` failure, collection for that invocation stops, one
best-effort warning is emitted, and the same SDK execution continues. Collection
never falls back to a second graph execution and never replaces the graph's result
or exception. File-close and warning failures are also best-effort.

`write_ms_before_terminal` is cumulative serialization/write/flush/`fsync` time
before the terminal write, not invocation duration. A terminal outcome and file
integrity are separate: a terminated invocation can have an unterminated trailing
line, while abrupt process death can leave valid earlier records with no terminal.
A missing file, incomplete file, or failed final `fsync` is incomplete evidence,
not zero usage or proof of success. Best-effort collection cannot prove assignment-
wide worker coverage or complete provider billing, and it does not bound a stalled
filesystem operation.

## Privacy and diagnostic text

The format excludes prompts, full state, tool arguments, successful tool output,
tracebacks, exception objects, and provider response bodies. Failure text comes
only from exception messages or structured error-status tool messages when safe
extraction is available. `tool_failed.error_message` is null when the SDK supplies
only a rendered exception string, because that string may include a provider
response body.

`error_message` is limited to 1,000 characters; `error_message_truncated` is `true`
only when that limit shortened it. A null error message is valid. Error text is not
redacted: the sandbox holds no credentials, because they are injected at egress by
the proxy. These files remain internal diagnostic evidence.

## Versioning

The only supported persisted format is `version: 1`. Change the version explicitly
when required fields, event meanings, identity rules, or accounting semantics
change. Additive fields may be ignored by consumers that do not interpret them.
There is no promise of compatibility with the superseded experimental prototype
and no adapter or migration path for experimental captures.
