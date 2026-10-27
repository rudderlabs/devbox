"""Exercise capture through real SDK graphs with deterministic model responses."""

from __future__ import annotations

import json
import math
import os
import tempfile
import unittest
from contextlib import ExitStack
from io import BufferedWriter, BytesIO, TextIOWrapper
from pathlib import Path
from unittest.mock import patch

from langchain_core.callbacks import UsageMetadataCallbackHandler
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import tool

from harness.deepagents.checkpointer import _reset_checkpointer, init_checkpointer
from harness.deepagents.file_logging import setup_session_file_logging
from harness.deepagents.session import DeepAgentSession
from harness.schemas.common import StrictOutputModel


class ProbeModel(BaseChatModel):
    """Replace only inference; retain actual tools, subgraphs, and persistence."""

    fail_stream: bool = False
    structured: bool = False

    @property
    def _llm_type(self):
        return "event-probe"

    def bind_tools(self, tools, **kwargs):
        return self

    def response(self, messages):
        child = str(
            next(m.content for m in messages if isinstance(m, HumanMessage))
        ).startswith("CHILD")
        tool_calls = []
        if not child and not any(isinstance(m, ToolMessage) for m in messages):
            tool_calls = [
                {
                    "name": "task",
                    "args": {
                        "subagent_type": "general-purpose",
                        "description": "CHILD: Return a word. private-prompt-marker",
                    },
                    "id": "probe-task",
                    "type": "tool_call",
                }
            ]
        return AIMessage(
            content='{"answer":"ok"}' if self.structured else "private-output-marker",
            tool_calls=tool_calls,
            usage_metadata={
                "input_tokens": 20 if child else 10,
                "output_tokens": 2 if child else 1,
                "total_tokens": 22 if child else 11,
            },
            response_metadata={"model_name": "probe", "model_provider": "test"},
        )

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return ChatResult(generations=[ChatGeneration(message=self.response(messages))])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                **self.response(messages).model_dump(exclude={"type"})
            )
        )
        if self.fail_stream:
            raise RuntimeError("private-error-marker")


class Answer(StrictOutputModel):
    answer: str


class StreamMetricsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.events = self.root / "events"
        self.enterContext(
            patch.dict(os.environ, {"HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING": "true"})
        )
        self.enterContext(
            patch(
                "harness.deepagents.session.DEEPAGENTS_EVENTS_DIR",
                self.events,
                create=True,
            )
        )
        self.enterContext(
            patch(
                "harness.deepagents.session.setup_session_file_logging",
                side_effect=lambda thread: setup_session_file_logging(
                    thread, self.root / "logs"
                ),
            )
        )
        _reset_checkpointer()
        self.addCleanup(_reset_checkpointer)

    def session(self, model=None, **kwargs):
        return DeepAgentSession(
            model=model or ProbeModel(),
            thread_id="probe-thread",
            workspace_dir=self.root,
            durable=kwargs.pop("durable", False),
            emit_progress=False,
            events=kwargs.pop("events", None),
            **kwargs,
        )

    def records(self):
        files = sorted(self.events.glob("*.jsonl"))
        self.assertEqual(len(files), 1, "The invocation must persist a metrics file")
        return [json.loads(line) for line in files[0].read_text().splitlines()]

    def test_nested_usage_is_written_once_and_does_not_export_content(self):
        from deepagents import create_deep_agent

        from harness.deepagents.stream_metrics import invoke_with_metrics

        graph = create_deep_agent(model=ProbeModel())
        comparison = UsageMetadataCallbackHandler()
        result = invoke_with_metrics(
            graph,
            {"messages": [{"role": "user", "content": "PARENT"}]},
            {"callbacks": [comparison]},
            thread_id="fixture-thread",
            directory=self.events,
        )
        records = self.records()
        finished = [r for r in records if r["event"] == "model_finished"]
        self.assertEqual(len(finished), 3)
        expected_usage = {"input_tokens": 40, "output_tokens": 4, "total_tokens": 44}
        self.assertEqual(
            {key: sum(r["usage"][key] for r in finished) for key in expected_usage},
            expected_usage,
        )
        self.assertEqual(sum(bool(r["namespace"]) for r in finished), 1)
        self.assertEqual(len({r["model_run_id"] for r in finished}), 3)
        self.assertEqual(
            {
                key: sum(usage[key] for usage in comparison.usage_metadata.values())
                for key in expected_usage
            },
            expected_usage,
        )
        self.assertTrue(result["messages"])
        self.assertEqual(records[-1]["event"], "invocation_finished")
        self.assertTrue(math.isfinite(records[-1]["write_ms_before_terminal"]))
        self.assertGreaterEqual(records[-1]["write_ms_before_terminal"], 0)
        self.assertEqual(
            set(records[0]["packages"]),
            {
                "devbox-harness",
                "deepagents",
                "langchain",
                "langchain-core",
                "langchain-openai",
                "langgraph",
                "langchain-protocol",
            },
        )
        lifecycle = [r["status"] for r in records if r["event"] == "subgraph_lifecycle"]
        self.assertTrue(lifecycle)
        self.assertLessEqual(
            set(lifecycle), {"started", "completed", "failed", "interrupted"}
        )
        self.assertFalse(any(r["event"] == "state_message" for r in records))
        self.assertNotIn("private-", json.dumps(records))

    def test_produced_events_round_trip_through_the_evaluator(self):
        from deepagents import create_deep_agent

        from harness.deepagents.stream_metrics import invoke_with_metrics
        from harness.evaluation import EvidenceFile, summarize_events

        invoke_with_metrics(
            create_deep_agent(model=ProbeModel()),
            {"messages": [{"role": "user", "content": "PARENT"}]},
            {},
            thread_id="round-trip-thread",
            directory=self.events,
            inbox_id="round-trip-inbox",
        )
        (path,) = self.events.glob("*.jsonl")
        evidence = [
            EvidenceFile(
                f"data/harness-artifacts/deepagents-events/{path.name}",
                path.read_bytes(),
            )
        ]

        report = summarize_events(evidence, "round-trip-inbox")

        self.assertEqual(report["evidence_gaps"], [])
        self.assertEqual(report["failures"], [])
        summary = report["summary"]
        self.assertEqual(summary["availability"], "available")
        self.assertEqual(
            summary["invocations"],
            {"finished": 1, "failed": 0, "interrupted": 0, "unknown": 0},
        )
        self.assertEqual(
            summary["models"],
            {"started": 3, "finished": 3, "unfinished": 0, "missing_usage": 0},
        )
        self.assertEqual(summary["tools"]["started"], summary["tools"]["success"])
        self.assertEqual(
            summary["usage"],
            {"input_tokens": 40, "output_tokens": 4, "total_tokens": 44},
        )
        (invocation,) = report["invocations"]
        self.assertEqual(invocation["integrity"], "terminated")
        self.assertEqual(invocation["root_usage"]["total_tokens"], 22)
        self.assertEqual(invocation["nested_usage"]["total_tokens"], 22)
        self.assertTrue(invocation["subgraphs"])

    def test_lifecycle_mapping_emits_only_contract_statuses(self):
        from harness.deepagents.event_contract import SUBGRAPH_STATUSES
        from harness.deepagents.stream_metrics import _LIFECYCLE_STATUSES

        self.assertLessEqual(set(_LIFECYCLE_STATUSES.values()), SUBGRAPH_STATUSES)

    def test_capture_open_failure_does_not_prevent_execution(self):
        real_open = Path.open
        calls = []

        class CountingModel(ProbeModel):
            def _stream(self, messages, **kwargs):
                calls.append(1)
                yield from super()._stream(messages, **kwargs)

        def open_capture(path, *args, **kwargs):
            if path.parent == self.events:
                raise OSError(28, "capture disk full")
            return real_open(path, *args, **kwargs)

        with (
            self.session(CountingModel()) as session,
            patch.object(Path, "open", open_capture),
        ):
            output = session.run("PARENT")
        self.assertEqual(output[-1].text, "private-output-marker")
        self.assertEqual(len(calls), 3)

        with self.session() as session:
            output = session.run("PARENT")
        self.assertEqual(output[-1].text, "private-output-marker")
        self.records()

    def test_error_propagates_and_partial_capture_remains_readable(self):
        with (
            self.session(ProbeModel(fail_stream=True)) as session,
            self.assertRaisesRegex(RuntimeError, "private-error-marker"),
        ):
            session.run("PARENT")
        records = self.records()
        self.assertEqual(records[-1]["event"], "invocation_failed")
        self.assertEqual(records[-1]["error_type"], "RuntimeError")
        self.assertEqual(records[-1]["error_message"], "private-error-marker")
        self.assertFalse(records[-1]["error_message_truncated"])
        self.assertTrue(math.isfinite(records[-1]["write_ms_before_terminal"]))
        self.assertGreaterEqual(records[-1]["write_ms_before_terminal"], 0)
        self.assertTrue(any(r["event"] == "model_started" for r in records))
        self.assertFalse(any(r["event"] == "model_finished" for r in records))
        self.assertNotIn("private-prompt-marker", json.dumps(records))
        self.assertNotIn("private-output-marker", json.dumps(records))

    def test_disk_failure_during_error_and_close_preserves_model_exception(self):
        failure = RuntimeError("original model failure")

        class FailedModel(ProbeModel):
            def _stream(self, messages, **kwargs):
                yield from super()._stream(messages, **kwargs)
                raise failure

        class FullDisk(BytesIO):
            def fileno(self):
                return 0  # fsync is stubbed for this in-memory fault-injection sink.

            def write(self, data):
                if b'"invocation_failed"' in bytes(data):
                    raise OSError(28, "No space left on device")
                return super().write(data)

        sink = TextIOWrapper(BufferedWriter(FullDisk()), encoding="utf-8")
        real_open = Path.open

        def open_capture(path, *args, **kwargs):
            return (
                sink if path.parent == self.events else real_open(path, *args, **kwargs)
            )

        with (
            self.session(FailedModel()) as session,
            patch.object(Path, "open", open_capture),
            patch("harness.deepagents.stream_metrics.os.fsync"),
            self.assertRaises(Exception) as raised,
        ):
            session.run("PARENT")
        self.assertIs(raised.exception, failure)

    def test_structured_output_and_checkpoint_resume_keep_their_contract(self):
        init_checkpointer(self.root / "checkpoints.db")
        with self.session(
            ProbeModel(structured=True), response_format=Answer, durable=True
        ) as session:
            self.assertEqual(session.run("PARENT"), Answer(answer="ok"))
            self.assertTrue(session.has_prior_state)
            self.assertEqual(session.resume_from_restart(), Answer(answer="ok"))
        files = list(self.events.glob("*.jsonl"))
        self.assertEqual(len(files), 2)
        usage = [json.loads(line) for p in files for line in p.read_text().splitlines()]
        # Resume adds one response, not another copy of historical messages.
        self.assertEqual(
            sum(r.get("usage", {}).get("total_tokens", 0) for r in usage), 55
        )

    def test_opt_out_uses_existing_path_without_metrics(self):
        with (
            patch.dict(os.environ, {"HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING": "false"}),
            self.session() as session,
        ):
            self.assertEqual(session.run("PARENT")[-1].content, "private-output-marker")
        self.assertFalse(self.events.exists())

    def test_error_fields_bound_diagnostic_text(self):
        from harness.deepagents.stream_metrics import _error_fields

        self.assertEqual(
            _error_fields(RuntimeError("provider unavailable")),
            {"error_message": "provider unavailable", "error_message_truncated": False},
        )

        fields = _error_fields(RuntimeError("x" * 1001))
        self.assertEqual(fields["error_message"], "x" * 1000)
        self.assertTrue(fields["error_message_truncated"])

        class UnprintableError(RuntimeError):
            def __str__(self):
                raise RuntimeError("cannot render")

        self.assertEqual(
            _error_fields(UnprintableError()),
            {"error_message": None, "error_message_truncated": False},
        )

    def test_error_fields_exclude_openai_response_body(self):
        import httpx
        from openai import OpenAI

        from harness.deepagents.stream_metrics import _error_fields

        request = httpx.Request("POST", "https://example.invalid/v1/responses")
        with OpenAI(api_key="offline-test") as client:
            error = client._make_status_error_from_response(
                httpx.Response(
                    400,
                    json={
                        "error": {
                            "message": "Invalid request",
                            "debug": {
                                "prompt": "private-prompt-marker",
                                "response_body": "private-body-marker",
                            },
                        }
                    },
                    request=request,
                )
            )
            no_message = client._make_status_error_from_response(
                httpx.Response(
                    400,
                    json={"error": {"debug": {"prompt": "private-prompt-marker"}}},
                    request=request,
                )
            )

        fields = _error_fields(error)
        self.assertEqual(
            fields,
            {
                "error_message": "Invalid request",
                "error_message_truncated": False,
            },
        )
        self.assertNotIn("private-prompt-marker", fields["error_message"])
        self.assertNotIn("private-body-marker", fields["error_message"])
        self.assertEqual(
            _error_fields(no_message),
            {"error_message": None, "error_message_truncated": False},
        )

    def test_sdk_tool_failure_omits_stringified_provider_body(self):
        import httpx
        from deepagents import create_deep_agent
        from openai import OpenAI

        from harness.deepagents.stream_metrics import invoke_with_metrics

        request = httpx.Request("POST", "https://example.invalid/v1/responses")
        with OpenAI(api_key="offline-test") as client:
            provider_error = client._make_status_error_from_response(
                httpx.Response(
                    400,
                    json={
                        "error": {
                            "message": "Invalid request",
                            "debug": {
                                "prompt": "private-prompt-marker",
                                "response_body": "private-body-marker",
                            },
                        }
                    },
                    request=request,
                )
            )

        @tool
        def failing_tool() -> str:
            """Raise a provider error containing private response metadata."""
            raise provider_error

        class ToolModel(ProbeModel):
            def response(self, messages):
                result = super().response(messages)
                if result.tool_calls:
                    result.tool_calls = [
                        {
                            "name": "failing_tool",
                            "args": {},
                            "id": "provider-failure",
                            "type": "tool_call",
                        }
                    ]
                return result

        graph = create_deep_agent(model=ToolModel(), tools=[failing_tool])
        with self.assertRaises(type(provider_error)):
            invoke_with_metrics(
                graph,
                {"messages": [{"role": "user", "content": "PARENT"}]},
                {},
                thread_id="tool-probe",
                directory=self.events,
            )
        records = self.records()
        failed = [record for record in records if record["event"] == "tool_failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["tool_call_id"], "provider-failure")
        self.assertIsNone(failed[0]["error_message"])
        self.assertFalse(failed[0]["error_message_truncated"])
        self.assertNotIn("private-prompt-marker", json.dumps(records))
        self.assertNotIn("private-body-marker", json.dumps(records))

    def test_collection_faults_do_not_change_successful_execution(self):
        from harness.deepagents import stream_metrics

        def run_with(*patchers):
            calls = []

            class CountingModel(ProbeModel):
                def _stream(self, messages, **kwargs):
                    calls.append(1)
                    yield from super()._stream(messages, **kwargs)

            with self.session(CountingModel()) as session, ExitStack() as stack:
                for patcher in patchers:
                    stack.enter_context(patcher)
                output = session.run("PARENT")
            self.assertEqual(output[-1].text, "private-output-marker")
            self.assertEqual(len(calls), 3)

        real_mkdir = Path.mkdir

        def fail_capture_mkdir(path, *args, **kwargs):
            if path == self.events:
                raise OSError(28, "capture mkdir failed")
            return real_mkdir(path, *args, **kwargs)

        run_with(patch.object(Path, "mkdir", fail_capture_mkdir))

        fsync_calls = 0

        def fail_intermediate_fsync(_file_descriptor):
            nonlocal fsync_calls
            fsync_calls += 1
            if fsync_calls == 2:
                raise OSError(28, "capture fsync failed")

        run_with(patch.object(stream_metrics.os, "fsync", fail_intermediate_fsync))

        run_with(
            patch.object(
                stream_metrics,
                "_metric_event",
                side_effect=ValueError("capture conversion failed"),
            )
        )
        run_with(
            patch.object(
                stream_metrics,
                "_metric_event",
                return_value={"event": "model_started", "invalid": math.nan},
            )
        )
        run_with(
            patch.object(
                stream_metrics, "version", side_effect=RuntimeError("metadata failed")
            )
        )

    def test_terminal_close_and_warning_faults_do_not_change_successful_execution(self):
        from harness.deepagents import stream_metrics

        real_open = Path.open

        class FaultyCapture:
            def __init__(self, *, terminal=False, close=False):
                self.fail_terminal = terminal
                self.fail_close = close

            def write(self, value):
                if self.fail_terminal and '"invocation_finished"' in value:
                    raise OSError(28, "terminal failed")
                return len(value)

            def flush(self):
                return None

            def fileno(self):
                return 0

            def close(self):
                if self.fail_close:
                    raise OSError(5, "close failed")

        for fault in ("terminal", "close"):
            with self.subTest(fault=fault):
                calls = []

                class CountingModel(ProbeModel):
                    def _stream(self, messages, call_log=calls, **kwargs):
                        call_log.append(1)
                        yield from super()._stream(messages, **kwargs)

                sink = FaultyCapture(
                    terminal=fault == "terminal", close=fault == "close"
                )

                def open_capture(path, *args, capture=sink, **kwargs):
                    if path.parent == self.events:
                        return capture
                    return real_open(path, *args, **kwargs)

                with (
                    self.session(CountingModel()) as session,
                    patch.object(Path, "open", open_capture),
                    patch.object(stream_metrics.os, "fsync"),
                ):
                    output = session.run("PARENT")
                self.assertEqual(output[-1].text, "private-output-marker")
                self.assertEqual(len(calls), 3)

        calls = []

        class WarningModel(ProbeModel):
            def _stream(self, messages, **kwargs):
                calls.append(1)
                yield from super()._stream(messages, **kwargs)

        def fail_capture_open(path, *args, **kwargs):
            if path.parent == self.events:
                raise OSError(28, "capture open failed")
            return real_open(path, *args, **kwargs)

        with (
            self.session(WarningModel()) as session,
            patch.object(Path, "open", fail_capture_open),
            patch("builtins.print", side_effect=OSError(5, "warning failed")),
        ):
            output = session.run("PARENT")
        self.assertEqual(output[-1].text, "private-output-marker")
        self.assertEqual(len(calls), 3)

    def test_missing_package_metadata_is_null(self):
        from importlib.metadata import PackageNotFoundError

        from harness.deepagents import stream_metrics

        real_version = stream_metrics.version

        def package_version(name):
            if name == "devbox-harness":
                raise PackageNotFoundError(name)
            return real_version(name)

        with (
            patch.object(stream_metrics, "version", package_version),
            self.session() as session,
        ):
            session.run("PARENT")
        self.assertIsNone(self.records()[0]["packages"]["devbox-harness"])

    def test_sdk_interruption_writes_interrupted_terminal(self):
        from langgraph.types import interrupt

        @tool
        def pause_tool() -> str:
            """Pause for a controlled test response."""
            return interrupt("approval required")

        class InterruptModel(ProbeModel):
            def response(self, messages):
                result = super().response(messages)
                if result.tool_calls:
                    result.tool_calls = [
                        {
                            "name": "pause_tool",
                            "args": {},
                            "id": "pause",
                            "type": "tool_call",
                        }
                    ]
                return result

        with self.session(
            InterruptModel(), tools=[pause_tool], in_memory=True
        ) as session:
            session.run("PARENT")
        terminal = self.records()[-1]
        self.assertEqual(terminal["event"], "invocation_interrupted")
        self.assertTrue(math.isfinite(terminal["write_ms_before_terminal"]))
        self.assertGreaterEqual(terminal["write_ms_before_terminal"], 0)

    def test_tool_error_status_is_not_mistaken_for_success(self):
        from deepagents import create_deep_agent
        from langchain_core.tools import ToolException

        from harness.deepagents.stream_metrics import invoke_with_metrics

        @tool
        def failing_tool() -> str:
            """Return a controlled tool failure."""
            raise ToolException("private-tool-error-marker")

        failing_tool.handle_tool_error = True

        class ToolModel(ProbeModel):
            def response(self, messages):
                result = super().response(messages)
                if result.tool_calls:
                    result.tool_calls = [
                        {
                            "name": "failing_tool",
                            "args": {},
                            "id": "failure",
                            "type": "tool_call",
                        }
                    ]
                return result

        graph = create_deep_agent(model=ToolModel(), tools=[failing_tool])
        invoke_with_metrics(
            graph,
            {"messages": [{"role": "user", "content": "PARENT"}]},
            {},
            thread_id="tool-probe",
            directory=self.events,
        )
        records = self.records()
        results = [r for r in records if r["event"] == "tool_finished"]
        self.assertEqual([r["status"] for r in results], ["error"])
        self.assertEqual(results[0]["error_message"], "private-tool-error-marker")
        self.assertFalse(results[0]["error_message_truncated"])
        self.assertNotIn("private-prompt-marker", json.dumps(records))
        self.assertNotIn("private-output-marker", json.dumps(records))

    def test_tool_error_adapter_uses_only_safe_structured_error_text(self):
        from langgraph.types import Command

        from harness.deepagents.stream_metrics import _metric_event

        base = {"namespace": ["child"], "timestamp": 123}
        command = Command(
            update={
                "messages": [
                    ToolMessage(
                        content="structured tool error",
                        tool_call_id="tool-1",
                        status="error",
                    )
                ]
            }
        )
        finished = _metric_event({
            "method": "tools",
            "params": {
                **base,
                "data": {
                    "event": "tool-finished",
                    "tool_call_id": "tool-1",
                    "output": command,
                },
            },
        })
        self.assertEqual(finished["status"], "error")
        self.assertEqual(finished["error_message"], "structured tool error")
        self.assertNotIn("output", finished)

        failed = _metric_event({
            "method": "tools",
            "params": {
                **base,
                "data": {
                    "event": "tool-error",
                    "tool_call_id": "tool-2",
                    "code": "ToolException",
                    "message": "tool exception text",
                },
            },
        })
        self.assertEqual(failed["error_type"], "ToolException")
        self.assertIsNone(failed["error_message"])
        self.assertFalse(failed["error_message_truncated"])

    def test_records_are_visible_before_invocation_finishes(self):
        events = self.events
        testcase = self

        class VisibilityModel(ProbeModel):
            def _stream(self, messages, **kwargs):
                # The third model call runs after the parent + child finished.
                if any(isinstance(m, ToolMessage) for m in messages):
                    lines = next(events.glob("*.jsonl")).read_text().splitlines()
                    saved = [json.loads(line) for line in lines]
                    testcase.assertEqual(
                        sum(r["event"] == "model_finished" for r in saved), 2
                    )
                    testcase.assertFalse(
                        any(r["event"] == "invocation_finished" for r in saved)
                    )
                yield from super()._stream(messages, **kwargs)

        with self.session(VisibilityModel()) as session:
            session.run("PARENT")


if __name__ == "__main__":
    unittest.main()
