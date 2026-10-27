"""Unit tests for deepagents.session — DeepAgentSession lifecycle.

These tests mock ``create_deep_agent`` so no real model or LLM calls are
needed. They verify construction, registry integration, lifecycle state
transitions, the has_prior_state property, and close/context-manager
behavior. The restart-repair regression tests are the exception: they run the
real deepagents graph and SQLite checkpointer with a scripted model.
"""

from __future__ import annotations

import builtins
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from langgraph.graph import END

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.deepagents.checkpointer import (
    _reset_checkpointer,
    init_checkpointer,
)
from harness.deepagents.registry import SessionConflictError
from harness.deepagents.registry import _reset as _reset_registry


def _make_mock_model() -> MagicMock:
    """Return a mock that passes isinstance checks for BaseChatModel."""
    from langchain_core.language_models import BaseChatModel

    mock = MagicMock(spec=BaseChatModel)
    return mock


def _make_mock_graph(structured_response=None, messages=None):
    """Return a mock compiled graph whose invoke() returns a result dict."""
    graph = MagicMock()
    result = {}
    if structured_response is not None:
        result["structured_response"] = structured_response
    if messages is not None:
        result["messages"] = messages
    else:
        result["messages"] = []
    graph.invoke.return_value = result
    return graph


def _patch_session_file_logging(testcase: unittest.TestCase, logs_dir: Path) -> None:
    """Route DeepAgentSession file logs to the test temp dir."""
    from harness.deepagents.file_logging import setup_session_file_logging

    patcher = patch(
        "harness.deepagents.session.setup_session_file_logging",
        side_effect=lambda thread_id: setup_session_file_logging(thread_id, logs_dir),
    )
    patcher.start()
    testcase.addCleanup(patcher.stop)


def _scrub_harness_env(testcase: unittest.TestCase) -> None:
    """Isolate session auto-injection tests from ambient HARNESS_* env."""

    prefixes = ("HARNESS_", "DEVBOX_")
    saved = {name: os.environ[name] for name in os.environ if name.startswith(prefixes)}
    for name in saved:
        os.environ.pop(name, None)

    def restore() -> None:
        for name in [n for n in os.environ if n.startswith(prefixes)]:
            os.environ.pop(name, None)
        os.environ.update(saved)

    testcase.addCleanup(restore)


class TestConstruction(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        _scrub_harness_env(self)
        _patch_session_file_logging(self, self.tmp / "logs")

    def tearDown(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp.cleanup()

    def _event_env(self) -> dict[str, str]:
        return {
            "DEVBOX_EVENTS_FILE": str(self.tmp / "events.jsonl"),
            "DEVBOX_EVENTS_LOCK": str(self.tmp / "events.lock"),
            "DEVBOX_INBOX_ID": "inbox-1",
            "DEVBOX_TARGET_IDS": "target-1",
        }

    @patch("harness.deepagents.session.create_deep_agent")
    def test_construction_claims_thread_id(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t1",
            workspace_dir=self.workspace,
            durable=False,
        )
        # Second session with same id should fail
        with self.assertRaises(SessionConflictError):
            DeepAgentSession(
                events=None,
                model=_make_mock_model(),
                thread_id="t1",
                workspace_dir=self.workspace,
                durable=False,
            )
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_construction_failure_releases_claim(self, mock_create):
        mock_create.side_effect = RuntimeError("agent creation failed")
        from harness.deepagents.session import DeepAgentSession

        with self.assertRaises(RuntimeError):
            DeepAgentSession(
                events=None,
                model=_make_mock_model(),
                thread_id="t-fail",
                workspace_dir=self.workspace,
                durable=False,
            )
        # thread_id should be released — creating another session with the same id should work
        mock_create.side_effect = None
        mock_create.return_value = _make_mock_graph()
        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-fail",
            workspace_dir=self.workspace,
            durable=False,
        )
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_session_file_log_created_and_closed_with_session(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.file_logging import setup_session_file_logging
        from harness.deepagents.session import DeepAgentSession

        handles = []

        def _setup(thread_id: str):
            handle = setup_session_file_logging(thread_id, self.tmp / "logs")
            handles.append(handle)
            return handle

        with patch(
            "harness.deepagents.session.setup_session_file_logging",
            side_effect=_setup,
        ):
            session = DeepAgentSession(
                events=None,
                model=_make_mock_model(),
                thread_id="t/log:session",
                workspace_dir=self.workspace,
                durable=False,
            )

        handle = handles[0]
        self.assertTrue(handle.path.exists())
        logger = handle.logger
        self.assertIn(handle.handler, logger.handlers)

        session.close()

        self.assertNotIn(handle.handler, logger.handlers)
        self.assertIsNone(handle.handler.stream)

    @patch("harness.deepagents.session.create_deep_agent")
    def test_construction_failure_closes_session_file_log(self, mock_create):
        mock_create.side_effect = RuntimeError("agent creation failed")
        from harness.deepagents.file_logging import setup_session_file_logging
        from harness.deepagents.session import DeepAgentSession

        handles = []

        def _setup(thread_id: str):
            handle = setup_session_file_logging(thread_id, self.tmp / "logs")
            handles.append(handle)
            return handle

        with (
            patch(
                "harness.deepagents.session.setup_session_file_logging",
                side_effect=_setup,
            ),
            self.assertRaises(RuntimeError),
        ):
            DeepAgentSession(
                events=None,
                model=_make_mock_model(),
                thread_id="t-fail-log",
                workspace_dir=self.workspace,
                durable=False,
            )

        handle = handles[0]
        logger = handle.logger
        self.assertNotIn(handle.handler, logger.handlers)
        self.assertIsNone(handle.handler.stream)

    @patch("harness.deepagents.session.create_deep_agent")
    def test_logging_middleware_is_prepended_when_caller_does_not_supply_one(
        self, mock_create
    ):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.middleware.logging import LoggingMiddleware
        from harness.deepagents.session import DeepAgentSession

        caller_middleware = object()
        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-auto-logging",
            workspace_dir=self.workspace,
            middleware=[caller_middleware],
            durable=False,
        )

        middleware = mock_create.call_args.kwargs["middleware"]
        self.assertEqual(len(middleware), 2)
        self.assertIsInstance(middleware[0], LoggingMiddleware)
        self.assertIs(middleware[0].logger, session._file_log_handle.logger)
        self.assertIs(middleware[1], caller_middleware)
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_caller_logging_middleware_is_preserved_without_reconfiguration(
        self, mock_create
    ):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.middleware.logging import LoggingMiddleware
        from harness.deepagents.session import DeepAgentSession

        caller_middleware = object()
        caller_logging = LoggingMiddleware()
        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-caller-logging",
            workspace_dir=self.workspace,
            middleware=[caller_middleware, caller_logging],
            durable=False,
        )

        middleware = mock_create.call_args.kwargs["middleware"]
        self.assertEqual(middleware, [caller_middleware, caller_logging])
        self.assertIs(middleware[1], caller_logging)
        session.close()

    def _round_events(self):
        from harness.events import RoundEvents

        return RoundEvents(
            events_file=self.tmp / "events.jsonl",
            events_lock=self.tmp / "events.lock",
            inbox_id="inbox-1",
            target_id="target-1",
        )

    @patch("harness.deepagents.session.create_deep_agent")
    def test_progress_attached_by_default_from_injected_client(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.middleware.progress_emit import ProgressEmitMiddleware
        from harness.deepagents.session import DeepAgentSession

        events = self._round_events()
        with patch.dict("os.environ", {}, clear=True):
            session = DeepAgentSession(
                model=_make_mock_model(),
                thread_id="t-p",
                workspace_dir=self.workspace,
                durable=False,
                events=events,
                emit_identifier="repo-a/api",
            )
        progress = mock_create.call_args.kwargs["middleware"][-1]
        self.assertIsInstance(progress, ProgressEmitMiddleware)
        self.assertIs(progress.events, events)
        self.assertEqual(progress.worker_label, "repo-a/api")
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_round_env_without_client_attaches_no_progress(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.middleware.progress_emit import ProgressEmitMiddleware
        from harness.deepagents.session import DeepAgentSession

        with patch.dict("os.environ", self._event_env(), clear=True):
            session = DeepAgentSession(
                model=_make_mock_model(),
                thread_id="t-env",
                workspace_dir=self.workspace,
                durable=False,
                events=None,
            )
        middleware = mock_create.call_args.kwargs["middleware"]
        self.assertFalse(any(isinstance(m, ProgressEmitMiddleware) for m in middleware))
        self.assertFalse((self.tmp / "events.jsonl").exists())
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_opt_out_and_missing_events_attach_no_progress(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.middleware.progress_emit import ProgressEmitMiddleware
        from harness.deepagents.session import DeepAgentSession

        for name, kwargs in (
            ("opt-out", {"emit_progress": False, "events": self._round_events()}),
            ("no-events", {"events": None}),
        ):
            session = DeepAgentSession(
                model=_make_mock_model(),
                thread_id=f"t-{name}",
                workspace_dir=self.workspace,
                durable=False,
                **kwargs,
            )
            middleware = mock_create.call_args.kwargs["middleware"]
            self.assertFalse(
                any(isinstance(m, ProgressEmitMiddleware) for m in middleware)
            )
            session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_caller_progress_middleware_suppresses_auto_injection(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.middleware.progress_emit import ProgressEmitMiddleware
        from harness.deepagents.session import DeepAgentSession

        caller_progress = ProgressEmitMiddleware(
            events=self._round_events(), worker_label="caller"
        )
        session = DeepAgentSession(
            model=_make_mock_model(),
            thread_id="t-caller-progress",
            workspace_dir=self.workspace,
            middleware=[caller_progress],
            durable=False,
            events=self._round_events(),
            emit_identifier="auto",
        )
        middleware = mock_create.call_args.kwargs["middleware"]
        self.assertEqual(
            [item for item in middleware if isinstance(item, ProgressEmitMiddleware)],
            [caller_progress],
        )
        session.close()

    def test_events_is_a_required_keyword(self):
        from harness.deepagents.session import DeepAgentSession

        with self.assertRaises(TypeError):
            DeepAgentSession(
                model=_make_mock_model(),
                thread_id="t-req",
                workspace_dir=self.workspace,
                durable=False,
            )

    @patch("harness.deepagents.session.create_deep_agent")
    def test_live_sessions_write_only_to_their_own_log_files(self, mock_create):
        mock_create.side_effect = [_make_mock_graph(), _make_mock_graph()]
        from langchain_core.messages import ToolMessage

        from harness.deepagents.middleware.logging import LoggingMiddleware
        from harness.deepagents.session import DeepAgentSession

        first = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-isolation-one",
            workspace_dir=self.workspace,
            durable=False,
        )
        second = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-isolation-two",
            workspace_dir=self.workspace,
            durable=False,
        )
        first_middleware = mock_create.call_args_list[0].kwargs["middleware"][0]
        second_middleware = mock_create.call_args_list[1].kwargs["middleware"][0]
        self.assertIsInstance(first_middleware, LoggingMiddleware)
        self.assertIsInstance(second_middleware, LoggingMiddleware)

        first_middleware.wrap_tool_call(
            types.SimpleNamespace(
                tool_call={"name": "first-only", "args": {}, "id": "1"}
            ),
            lambda request: ToolMessage(content="first-result", tool_call_id="1"),
        )
        second_middleware.wrap_tool_call(
            types.SimpleNamespace(
                tool_call={"name": "second-only", "args": {}, "id": "2"}
            ),
            lambda request: ToolMessage(content="second-result", tool_call_id="2"),
        )
        first_log_path = first._file_log_handle.path
        second_log_path = second._file_log_handle.path
        first.close()
        second.close()

        first_text = first_log_path.read_text(encoding="utf-8")
        second_text = second_log_path.read_text(encoding="utf-8")
        self.assertIn("first-only", first_text)
        self.assertNotIn("second-only", first_text)
        self.assertIn("second-only", second_text)
        self.assertNotIn("first-only", second_text)

    @patch("harness.deepagents.session.create_deep_agent")
    def test_durable_without_init_raises(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        with self.assertRaises(RuntimeError) as ctx:
            DeepAgentSession(
                events=None,
                model=_make_mock_model(),
                thread_id="t-durable",
                workspace_dir=self.workspace,
                durable=True,
            )
        self.assertIn("init_checkpointer", str(ctx.exception))

    @patch("harness.deepagents.session.create_deep_agent")
    def test_durable_with_init_succeeds(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        init_checkpointer(self.tmp / "cp.db")
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-durable-ok",
            workspace_dir=self.workspace,
            durable=True,
        )
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_in_memory_checkpointer_is_lazy_and_opt_in(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        original_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name == "langgraph.checkpoint.memory":
                raise AssertionError("MemorySaver should not be imported by default")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=guarded_import):
            session = DeepAgentSession(
                events=None,
                model=_make_mock_model(),
                thread_id="t-no-memory-saver",
                workspace_dir=self.workspace,
                durable=False,
            )
        self.assertIsNone(mock_create.call_args.kwargs["checkpointer"])
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_in_memory_checkpointer_uses_memory_saver(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        saver = MagicMock(name="memory-saver")
        with patch("langgraph.checkpoint.memory.MemorySaver", return_value=saver):
            session = DeepAgentSession(
                events=None,
                model=_make_mock_model(),
                thread_id="t-memory-saver",
                workspace_dir=self.workspace,
                durable=False,
                in_memory=True,
            )
        self.assertIs(mock_create.call_args.kwargs["checkpointer"], saver)
        session.close()

    @patch("harness.deepagents.session.LocalShellBackend")
    @patch("harness.deepagents.session.create_deep_agent")
    def test_backend_inherits_env_by_default(self, mock_create, mock_backend):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-inherit-default",
            workspace_dir=self.workspace,
            durable=False,
        )
        mock_backend.assert_called_once()
        self.assertTrue(mock_backend.call_args.kwargs["inherit_env"])
        session.close()

    @patch("harness.deepagents.session.LocalShellBackend")
    @patch("harness.deepagents.session.create_deep_agent")
    def test_backend_inherit_env_overridable(self, mock_create, mock_backend):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-inherit-off",
            workspace_dir=self.workspace,
            durable=False,
            inherit_env=False,
        )
        self.assertFalse(mock_backend.call_args.kwargs["inherit_env"])
        session.close()

    @patch("harness.deepagents.session.LocalShellBackend")
    @patch("harness.deepagents.session.create_deep_agent")
    def test_shell_env_reaches_backend(self, mock_create, mock_backend):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            model=_make_mock_model(),
            thread_id="t-shell",
            workspace_dir=self.workspace,
            durable=False,
            events=None,
            shell_env={"MINI_E2E": "1"},
        )
        self.assertEqual(mock_backend.call_args.kwargs["env"], {"MINI_E2E": "1"})
        self.assertTrue(mock_backend.call_args.kwargs["inherit_env"])
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_raw_response_schema_is_wrapped_in_strict_provider_strategy(
        self, mock_create
    ):
        from langchain.agents.structured_output import ProviderStrategy
        from pydantic import BaseModel

        class FakeOutput(BaseModel):
            value: int

        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-strict-response-format",
            workspace_dir=self.workspace,
            durable=False,
            response_format=FakeOutput,
        )

        response_format = mock_create.call_args.kwargs["response_format"]
        self.assertIsInstance(response_format, ProviderStrategy)
        self.assertIs(response_format.schema, FakeOutput)
        self.assertIs(response_format.schema_spec.strict, True)
        model_kwargs = response_format.to_model_kwargs()["response_format"]
        self.assertTrue(
            model_kwargs.get("strict")
            or model_kwargs.get("json_schema", {}).get("strict")
        )
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_explicit_response_format_strategy_is_preserved(self, mock_create):
        from langchain.agents.structured_output import ProviderStrategy
        from pydantic import BaseModel

        class FakeOutput(BaseModel):
            value: int

        strategy = ProviderStrategy(FakeOutput, strict=False)
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-explicit-response-format-strategy",
            workspace_dir=self.workspace,
            durable=False,
            response_format=strategy,
        )

        self.assertIs(mock_create.call_args.kwargs["response_format"], strategy)
        session.close()


class TestRun(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        _scrub_harness_env(self)
        _patch_session_file_logging(self, self.tmp / "logs")

    def tearDown(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp.cleanup()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_run_returns_messages_when_no_response_format(self, mock_create):
        msgs = [MagicMock()]
        mock_create.return_value = _make_mock_graph(messages=msgs)
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-run",
            workspace_dir=self.workspace,
            durable=False,
        )
        result = session.run("hello")
        self.assertEqual(result, msgs)
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_run_returns_structured_response(self, mock_create):
        from pydantic import BaseModel

        class FakeOutput(BaseModel):
            value: int

        expected = FakeOutput(value=42)
        mock_create.return_value = _make_mock_graph(structured_response=expected)
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-structured",
            workspace_dir=self.workspace,
            durable=False,
            response_format=FakeOutput,
        )
        result = session.run("hello")
        self.assertEqual(result, expected)
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_run_on_closed_session_raises(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-closed",
            workspace_dir=self.workspace,
            durable=False,
        )
        session.close()
        with self.assertRaises(RuntimeError) as ctx:
            session.run("hello")
        self.assertIn("closed", str(ctx.exception).lower())

    @patch("harness.deepagents.session.create_deep_agent")
    def test_run_raises_when_structured_response_missing(self, mock_create):
        from pydantic import BaseModel

        class FakeOutput(BaseModel):
            value: int

        # Graph returns result WITHOUT structured_response key
        graph = MagicMock()
        graph.invoke.return_value = {"messages": []}
        mock_create.return_value = graph
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-missing-sr",
            workspace_dir=self.workspace,
            durable=False,
            response_format=FakeOutput,
        )
        with self.assertRaises(KeyError):
            session.run("hello")
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_run_invokes_with_thread_id(self, mock_create):
        graph = _make_mock_graph()
        mock_create.return_value = graph
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-invoke",
            workspace_dir=self.workspace,
            durable=False,
        )
        session.run("do the thing")
        graph.invoke.assert_called_once()
        call_args = graph.invoke.call_args
        config = call_args[1].get("config") or call_args[0][1]
        self.assertEqual(config["configurable"]["thread_id"], "t-invoke")
        session.close()

    @patch("harness.deepagents.stream_metrics.invoke_with_metrics")
    @patch("harness.deepagents.session.deepagents_event_streaming_enabled")
    @patch("harness.deepagents.session.create_deep_agent")
    def test_run_passes_client_inbox_id_to_stream_metrics(
        self, mock_create, mock_streaming, mock_invoke
    ):
        mock_create.return_value = _make_mock_graph()
        mock_streaming.return_value = True
        mock_invoke.return_value = {"messages": []}
        from harness.deepagents.session import DeepAgentSession
        from harness.events import RoundEvents

        events = RoundEvents(
            events_file=self.tmp / "events.jsonl",
            events_lock=self.tmp / "events.lock",
            inbox_id="inbox-1",
            target_id="target-1",
        )
        session = DeepAgentSession(
            model=_make_mock_model(),
            thread_id="t-metrics-inbox",
            workspace_dir=self.workspace,
            durable=False,
            events=events,
        )
        session.run("do the thing")
        mock_invoke.assert_called_once()
        self.assertEqual(mock_invoke.call_args.kwargs["inbox_id"], "inbox-1")
        session.close()


class TestContextManager(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        _scrub_harness_env(self)
        _patch_session_file_logging(self, self.tmp / "logs")

    def tearDown(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp.cleanup()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_context_manager_releases_on_exit(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        with DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-ctx",
            workspace_dir=self.workspace,
            durable=False,
        ) as session:
            self.assertIsNotNone(session)

        # Should be able to reclaim after exit
        session2 = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-ctx",
            workspace_dir=self.workspace,
            durable=False,
        )
        session2.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_close_is_idempotent(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-idem",
            workspace_dir=self.workspace,
            durable=False,
        )
        session.close()
        session.close()  # should not raise


class TestHasPriorState(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        _scrub_harness_env(self)
        _patch_session_file_logging(self, self.tmp / "logs")

    def tearDown(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp.cleanup()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_fresh_session_has_no_prior_state(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        init_checkpointer(self.tmp / "cp.db")
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-fresh",
            workspace_dir=self.workspace,
            durable=True,
        )
        self.assertFalse(session.has_prior_state)
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_ephemeral_session_has_no_prior_state(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-ephemeral",
            workspace_dir=self.workspace,
            durable=False,
        )
        self.assertFalse(session.has_prior_state)
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_has_prior_state_true_when_checkpoint_exists(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        init_checkpointer(self.tmp / "cp.db")
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-prior",
            workspace_dir=self.workspace,
            durable=True,
        )
        # Mock the checkpointer to return a non-None tuple
        session._checkpointer = MagicMock()
        session._checkpointer.get_tuple.return_value = MagicMock()
        self.assertTrue(session.has_prior_state)
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_progress_marker_uses_session_checkpoint_id_and_metadata(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-progress",
            workspace_dir=self.workspace,
            durable=False,
        )
        checkpoint_tuple = MagicMock(
            checkpoint={"id": "checkpoint-1"},
            metadata={"step": 7},
        )
        session._checkpointer = MagicMock()
        session._checkpointer.get_tuple.return_value = checkpoint_tuple

        marker = session.progress_marker

        self.assertEqual(marker, ("checkpoint-1", repr({"step": 7})))
        session._checkpointer.get_tuple.assert_called_once_with({
            "configurable": {"thread_id": "t-progress"}
        })
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_progress_marker_degrades_to_none(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-missing",
            workspace_dir=self.workspace,
            durable=False,
        )
        session._checkpointer = MagicMock()
        session._checkpointer.get_tuple.side_effect = RuntimeError("not initialised")

        self.assertIsNone(session.progress_marker)
        session.close()


class TestResumeFromRestart(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        _scrub_harness_env(self)
        _patch_session_file_logging(self, self.tmp / "logs")

    def tearDown(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp.cleanup()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_clean_tail_noop_then_runs_restart_nudge(self, mock_create):
        graph = _make_mock_graph(messages=["done"])
        mock_create.return_value = graph
        init_checkpointer(self.tmp / "cp.db")
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-clean-resume",
            workspace_dir=self.workspace,
            durable=True,
        )
        session._checkpointer = MagicMock()
        session._checkpointer.get_tuple.return_value = MagicMock(pending_writes=[])
        graph.get_state.return_value = MagicMock(
            values={"messages": [MagicMock(tool_calls=[])]}
        )

        session.resume_from_restart()

        graph.update_state.assert_not_called()
        self.assertIn(
            "daemon restarted", graph.invoke.call_args.args[0]["messages"][0]["content"]
        )
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_repairs_dangling_ai_tool_calls(self, mock_create):
        graph = _make_mock_graph(messages=["done"])
        mock_create.return_value = graph
        init_checkpointer(self.tmp / "cp.db")
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-repair-resume",
            workspace_dir=self.workspace,
            durable=True,
        )
        ai_message = MagicMock()
        ai_message.tool_calls = [{"id": "call-1"}]
        session._checkpointer = MagicMock()
        session._checkpointer.get_tuple.return_value = MagicMock(
            pending_writes=[("task-1", "messages", "finished")]
        )
        graph.get_state.return_value = MagicMock(values={"messages": [ai_message]})

        session.resume_from_restart()

        flush, repair_call = graph.update_state.call_args_list
        self.assertIsNone(flush.args[1])  # pending writes committed first
        self.assertIs(flush.kwargs["as_node"], END)
        repair = repair_call.args[1]["messages"][0]
        self.assertEqual(repair.tool_call_id, "call-1")
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_repairs_partially_completed_multi_tool_tail(self, mock_create):
        graph = _make_mock_graph(messages=["done"])
        mock_create.return_value = graph
        init_checkpointer(self.tmp / "cp.db")
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-partial-tool-resume",
            workspace_dir=self.workspace,
            durable=True,
        )
        ai_message = MagicMock()
        ai_message.tool_calls = [{"id": "call-1"}, {"id": "call-2"}]
        tool_message = MagicMock()
        tool_message.type = "tool"
        tool_message.tool_call_id = "call-1"
        tool_message.tool_calls = []
        session._checkpointer = MagicMock()
        session._checkpointer.get_tuple.return_value = MagicMock(
            pending_writes=[("task-1", "messages", "finished")]
        )
        graph.get_state.return_value = MagicMock(
            values={"messages": [ai_message, tool_message]}
        )

        session.resume_from_restart()

        flush, repair_call = graph.update_state.call_args_list
        self.assertIsNone(flush.args[1])  # pending writes committed first
        self.assertIs(flush.kwargs["as_node"], END)
        repair = repair_call.args[1]["messages"][0]
        self.assertEqual(repair.tool_call_id, "call-2")
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_resume_returns_structured_response(self, mock_create):
        from pydantic import BaseModel

        class FakeOutput(BaseModel):
            value: int

        expected = FakeOutput(value=7)
        graph = _make_mock_graph(structured_response=expected)
        mock_create.return_value = graph
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-structured-resume",
            workspace_dir=self.workspace,
            durable=False,
            response_format=FakeOutput,
        )
        # Give the session prior state with a clean message tail (no dangling
        # tool calls), so has_prior_state is True and _repair_dangling_tool_calls
        # is a no-op.
        clean_message = MagicMock()
        clean_message.tool_calls = []
        session._checkpointer = MagicMock()
        session._checkpointer.get_tuple.return_value = MagicMock()
        graph.get_state.return_value = MagicMock(values={"messages": [clean_message]})

        self.assertEqual(session.resume_from_restart(), expected)
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_resume_without_prior_state_raises(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-no-prior-state-resume",
            workspace_dir=self.workspace,
            durable=False,
        )

        self.assertFalse(session.has_prior_state)
        with self.assertRaises(RuntimeError):
            session.resume_from_restart()
        session.close()

    @patch("harness.deepagents.session.create_deep_agent")
    def test_session_with_checkpoint_has_prior_state(self, mock_create):
        mock_create.return_value = _make_mock_graph()
        init_checkpointer(self.tmp / "cp.db")
        from harness.deepagents.session import DeepAgentSession

        session = DeepAgentSession(
            events=None,
            model=_make_mock_model(),
            thread_id="t-has-state",
            workspace_dir=self.workspace,
            durable=True,
        )
        # Simulate an existing checkpoint by replacing the checkpointer's get_tuple.
        from unittest.mock import MagicMock

        session._checkpointer = MagicMock()
        session._checkpointer.get_tuple.return_value = object()
        self.assertTrue(session.has_prior_state)
        session.close()


class _PodDied(BaseException):
    """Simulates the daemon dying mid tool call: escapes tool error handling."""


def _scripted_tool_model(
    seen: list[list[Any]],
    *,
    tool_name: str = "record_step",
    tool_args: dict[str, Any] | None = None,
    answer: str = "done",
) -> Any:
    """A model that calls ``tool_name`` once, then answers ``answer``.

    Only inference is replaced; the deepagents graph, its middleware and the
    SQLite checkpointer are real. Every prompt the model receives is appended
    to ``seen``.
    """
    from langchain_core.language_models import BaseChatModel
    from langchain_core.messages import AIMessage, ToolMessage
    from langchain_core.outputs import ChatGeneration, ChatResult

    class ScriptedToolModel(BaseChatModel):
        @property
        def _llm_type(self) -> str:
            return "scripted-tool"

        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            seen.append(list(messages))
            if any(isinstance(m, ToolMessage) for m in messages):
                message = AIMessage(content=answer)
            else:
                message = AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": tool_name,
                            "args": tool_args or {},
                            "id": "call-1",
                            "type": "tool_call",
                        }
                    ],
                )
            return ChatResult(generations=[ChatGeneration(message=message)])

    return ScriptedToolModel()


class TestRestartRepairOnRealCheckpoint(unittest.TestCase):
    """An in-flight tool call interrupted by a restart must reach the model as
    UNKNOWN, not as DeepAgents' "was cancelled" patch."""

    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        _scrub_harness_env(self)
        _patch_session_file_logging(self, self.tmp / "logs")
        init_checkpointer(self.tmp / "cp.db")
        self.seen: list[list[Any]] = []
        self.tool_runs = 0
        self.pod_alive = False

        from langchain_core.tools import tool

        @tool
        def record_step() -> str:
            """Record one step of work."""
            self.tool_runs += 1
            if not self.pod_alive:
                raise _PodDied()
            return "recorded"

        self.record_step = record_step

    def tearDown(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp.cleanup()

    def _session(self) -> Any:
        from harness.deepagents.session import DeepAgentSession

        return DeepAgentSession(
            model=_scripted_tool_model(self.seen),
            thread_id="t-restart-repair",
            workspace_dir=self.workspace,
            tools=[self.record_step],
            durable=True,
            events=None,
        )

    def _crash_mid_tool_call(self) -> None:
        with self._session() as session, self.assertRaises(_PodDied):
            session.run("Do the work.")
        self.pod_alive = True

    def _tool_results_seen_last(self) -> list[Any]:
        return [m for m in self.seen[-1] if m.type == "tool"]

    def test_resume_from_restart_reports_in_flight_call_as_unknown(self):
        self._crash_mid_tool_call()

        with self._session() as session:
            self.assertTrue(session.has_prior_state)
            session.resume_from_restart()

        results = self._tool_results_seen_last()
        self.assertEqual(len(results), 1, results)
        self.assertIn("effect on disk is UNKNOWN", results[0].content)
        self.assertNotIn("cancelled", results[0].content)
        self.assertEqual(results[0].name, "record_step")
        self.assertEqual(self.tool_runs, 1)

    def test_repair_before_new_brief_reports_in_flight_call_as_unknown(self):
        self._crash_mid_tool_call()

        with self._session() as session:
            session.repair_dangling_tool_calls()
            session.run("Do the work.")

        results = self._tool_results_seen_last()
        self.assertEqual(len(results), 1, results)
        self.assertIn("effect on disk is UNKNOWN", results[0].content)
        self.assertNotIn("cancelled", results[0].content)
        self.assertEqual(results[0].name, "record_step")
        self.assertEqual(self.tool_runs, 1)

    def test_repair_keeps_tool_call_before_its_result_when_commit_was_lost(self):
        # The pod dies after the model's tool-call message is saved as a
        # pending write but before its checkpoint is committed.
        with self._session() as session:
            saver = session._checkpointer
            put = saver.put

            def die_on_post_model_commit(config, checkpoint, metadata, versions):
                if checkpoint["versions_seen"].get("model"):
                    raise _PodDied()
                return put(config, checkpoint, metadata, versions)

            with (
                patch.object(saver, "put", side_effect=die_on_post_model_commit),
                self.assertRaises(_PodDied),
            ):
                session.run("Do the work.")
        self.pod_alive = True

        with self._session() as session:
            # Writes on one checkpoint are replayed in task-id order. Give the
            # repair the lowest task id so an uncommitted tool call, if left
            # on the same checkpoint, would deterministically replay after it.
            update_state = session._agent.update_state

            def lowest_task_id(config, values, as_node=None, task_id=None):
                if values is not None:
                    task_id = "00000000-0000-0000-0000-000000000000"
                return update_state(config, values, as_node=as_node, task_id=task_id)

            with patch.object(session._agent, "update_state", lowest_task_id):
                session.resume_from_restart()

        prompt = [m for m in self.seen[-1] if m.type != "system"]
        call_at = next(
            i
            for i, m in enumerate(prompt)
            if any(c["id"] == "call-1" for c in getattr(m, "tool_calls", None) or [])
        )
        result_at = next(
            i
            for i, m in enumerate(prompt)
            if m.type == "tool" and m.tool_call_id == "call-1"
        )
        self.assertLess(call_at, result_at, [(m.type, m.content) for m in prompt])
        self.assertIn("effect on disk is UNKNOWN", prompt[result_at].content)
        # The tool started alongside the background commit; it never re-runs.
        self.assertEqual(self.tool_runs, 1)

    def test_resume_keeps_tool_result_when_post_tools_commit_was_lost(self):
        # The tool succeeded and its ToolMessage is a pending write, but the pod
        # died before the post-tools checkpoint was committed. The result must
        # not be dropped and replaced by DeepAgents' "was cancelled" patch.
        self.pod_alive = True
        with self._session() as session:
            saver = session._checkpointer
            put = saver.put

            def die_on_post_tools_commit(config, checkpoint, metadata, versions):
                if "tools" in checkpoint["versions_seen"]:
                    raise _PodDied()
                return put(config, checkpoint, metadata, versions)

            with (
                patch.object(saver, "put", side_effect=die_on_post_tools_commit),
                self.assertRaises(_PodDied),
            ):
                session.run("Do the work.")

        with self._session() as session:
            session.resume_from_restart()

        results = self._tool_results_seen_last()
        self.assertEqual(len(results), 1, results)
        self.assertEqual(results[0].content, "recorded")
        self.assertNotIn("cancelled", results[0].content)
        self.assertNotIn("UNKNOWN", results[0].content)
        self.assertEqual(self.tool_runs, 1)

    def test_resume_keeps_final_answer_when_post_model_commit_was_lost(self):
        # The final model answer finished but its checkpoint was never
        # committed. The restart nudge always costs one model call, so the
        # observable guarantee is that the nudge prompt still carries the
        # answer instead of silently dropping it.
        self.pod_alive = True
        with self._session() as session:
            saver = session._checkpointer
            put = saver.put

            def die_on_final_commit(config, checkpoint, metadata, versions):
                # Step 4 is the post-tools commit; later commits hold the final
                # model answer and are all lost.
                if metadata["step"] >= 5:
                    raise _PodDied()
                return put(config, checkpoint, metadata, versions)

            with (
                patch.object(saver, "put", side_effect=die_on_final_commit),
                self.assertRaises(_PodDied),
            ):
                session.run("Do the work.")

        with self._session() as session:
            session.resume_from_restart()

        prompt = self.seen[-1]
        self.assertTrue(
            any(m.type == "ai" and m.content == "done" for m in prompt),
            [(m.type, m.content) for m in prompt],
        )
        self.assertEqual(self.tool_runs, 1)


class TestRoundTagOnRealCheckpoint(unittest.TestCase):
    """A run's round tag reaches every checkpoint it writes, repairs included."""

    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        _scrub_harness_env(self)
        _patch_session_file_logging(self, self.tmp / "logs")
        init_checkpointer(self.tmp / "cp.db")
        self.seen: list[list[Any]] = []
        self.pod_alive = False

        from langchain_core.tools import tool

        @tool
        def record_step() -> str:
            """Record one step of work."""
            if not self.pod_alive:
                raise _PodDied()
            return "recorded"

        self.record_step = record_step

    def tearDown(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp.cleanup()

    def _session(self) -> Any:
        from harness.deepagents.session import DeepAgentSession

        return DeepAgentSession(
            model=_scripted_tool_model(self.seen),
            thread_id="t-round-tag",
            workspace_dir=self.workspace,
            tools=[self.record_step],
            durable=True,
            events=None,
        )

    def _tags(self, session: Any) -> list[Any]:
        config = {"configurable": {"thread_id": "t-round-tag"}}
        return [
            saved.metadata.get("harness_round")
            for saved in session._checkpointer.list(config)
        ]

    def test_untagged_thread_has_no_round_tag(self) -> None:
        with self._session() as session:
            self.assertIsNone(session.latest_round_tag)
        self.pod_alive = True
        with self._session() as session:
            session.run("Do the work.")
            self.assertIsNone(session.latest_round_tag)

    def test_run_tags_every_checkpoint_it_writes(self) -> None:
        self.pod_alive = True
        with self._session() as session:
            session.run("Do the work.", round_tag="inbox-1")
            tags = self._tags(session)
            self.assertTrue(tags)
            self.assertEqual(set(tags), {"inbox-1"})
            self.assertEqual(session.latest_round_tag, "inbox-1")

    def test_next_round_replaces_the_latest_tag(self) -> None:
        self.pod_alive = True
        with self._session() as session:
            session.run("Round one.", round_tag="inbox-1")
            session.run("Round two.", round_tag="inbox-2")
            self.assertEqual(session.latest_round_tag, "inbox-2")
            self.assertEqual(set(self._tags(session)), {"inbox-1", "inbox-2"})

    def test_repair_writes_under_the_given_tag(self) -> None:
        with self._session() as session, self.assertRaises(_PodDied):
            session.run("Do the work.", round_tag="inbox-1")
        self.pod_alive = True

        with self._session() as session:
            self.assertEqual(session.latest_round_tag, "inbox-1")
            session.repair_dangling_tool_calls(round_tag="inbox-1")
            self.assertEqual(session.latest_round_tag, "inbox-1")
            messages = session._agent.get_state(session._config()).values["messages"]
            self.assertIn("effect on disk is UNKNOWN", messages[-1].content)

    def test_commit_of_finished_writes_keeps_the_tag(self) -> None:
        # The pod dies after the model's tool-call message is saved as a pending
        # write but before its checkpoint is committed, exercising lost commits.
        with self._session() as session:
            saver = session._checkpointer
            put = saver.put

            def die_on_post_model_commit(config, checkpoint, metadata, versions):
                if checkpoint["versions_seen"].get("model"):
                    raise _PodDied()
                return put(config, checkpoint, metadata, versions)

            with (
                patch.object(saver, "put", side_effect=die_on_post_model_commit),
                self.assertRaises(_PodDied),
            ):
                session.run("Do the work.", round_tag="inbox-1")
        self.pod_alive = True

        with self._session() as session:
            session.repair_dangling_tool_calls(round_tag="inbox-1")
            self.assertEqual(set(self._tags(session)), {"inbox-1"})


_REPAIR_TEXT = (
    "The harness restarted while this tool call was in flight; "
    "its effect on disk is UNKNOWN. Verify the current state "
    "before re-issuing it."
)


class TestFollowupRoundsOnRealCheckpoint(unittest.TestCase):
    """The follow-up runner on a real graph and SQLite checkpointer."""

    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        _scrub_harness_env(self)
        _patch_session_file_logging(self, self.tmp / "logs")
        init_checkpointer(self.tmp / "cp.db")
        (self.tmp / ".processed").mkdir()
        (self.tmp / ".error").mkdir()
        from harness.daemon import DaemonState

        self.state = DaemonState(
            events_file=self.tmp / "events.jsonl",
            events_lock=self.tmp / "events.lock",
            processed_dir=self.tmp / ".processed",
            error_dir=self.tmp / ".error",
        )
        self.seen: list[list[Any]] = []
        self.tool_runs = 0
        self.pod_alive = False

        from langchain_core.tools import tool

        @tool
        def record_step() -> str:
            """Record one step of work."""
            self.tool_runs += 1
            if not self.pod_alive:
                raise _PodDied()
            return "recorded"

        self.record_step = record_step

    def tearDown(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp.cleanup()

    def _build(self) -> Any:
        from harness.deepagents.session import DeepAgentSession

        return DeepAgentSession(
            model=_scripted_tool_model(self.seen),
            thread_id="followup:XYZ-1",
            workspace_dir=self.workspace,
            tools=[self.record_step],
            durable=True,
            events=None,
        )

    def _round(self, inbox_id: str, brief: str) -> None:
        from harness.followup import run_followup_round

        run_followup_round(
            self._build,
            state=self.state,
            inbox_id=inbox_id,
            brief=lambda: brief,
            seed="SEED",
            targets=["c-1"],
            label="followup/XYZ-1",
        )

    def _humans(self) -> list[str]:
        return [m.content for m in self.seen[-1] if m.type == "human"]

    def _nudge(self) -> str:
        from harness.followup import continue_nudge

        return continue_nudge(replied=[], pending=["c-1"], optional=[])

    def test_crash_mid_tool_call_continues_without_resending_the_brief(self) -> None:
        with self.assertRaises(_PodDied):
            self._round("inbox-1", "BRIEF-1")
        self.pod_alive = True
        self._round("inbox-1", "BRIEF-1")

        self.assertEqual(self._humans(), ["SEED\n\nBRIEF-1", self._nudge()])
        self.assertEqual(
            [m.content for m in self.seen[-1] if m.type == "tool"],
            [_REPAIR_TEXT],
        )
        self.assertEqual(self.tool_runs, 1)

    def test_crash_right_after_the_repair_still_continues(self) -> None:
        from harness.deepagents.session import DeepAgentSession

        with self.assertRaises(_PodDied):
            self._round("inbox-1", "BRIEF-1")
        self.pod_alive = True

        real_run = DeepAgentSession.run

        def die_before_model(self_, prompt, *, round_tag=None):
            raise _PodDied()

        with (
            patch.object(DeepAgentSession, "run", die_before_model),
            self.assertRaises(_PodDied),
        ):
            self._round("inbox-1", "BRIEF-1")

        with patch.object(DeepAgentSession, "run", real_run):
            self._round("inbox-1", "BRIEF-1")
        self.assertEqual(self._humans(), ["SEED\n\nBRIEF-1", self._nudge()])
        self.assertEqual(
            [m.content for m in self.seen[-1] if m.type == "tool"],
            [_REPAIR_TEXT],
        )

    def test_second_round_gets_its_brief_and_no_seed(self) -> None:
        self.pod_alive = True
        self._round("inbox-1", "BRIEF-1")
        self._round("inbox-2", "BRIEF-2")
        self.assertEqual(self._humans(), ["SEED\n\nBRIEF-1", "BRIEF-2"])
        with self._build() as session:
            self.assertEqual(session.latest_round_tag, "inbox-2")


if __name__ == "__main__":
    unittest.main()
