"""Unit tests for deepagents.middleware.logging.LoggingMiddleware — no LLM calls.

The hooks only read request.messages, response.result, and request.tool_call,
so tests pass duck-typed SimpleNamespace fakes plus real AIMessage/ToolMessage.
"""

from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from langchain.agents.structured_output import StructuredOutputValidationError
from langchain_core.messages import AIMessage, ToolMessage

from harness.deepagents.file_logging import session_log_path, setup_session_file_logging
from harness.deepagents.middleware.logging import LoggingMiddleware

LOGGER = "deepagents.middleware.logging"


class TestLoggerSelection(unittest.TestCase):
    def test_default_uses_module_logger(self) -> None:
        request = types.SimpleNamespace(
            tool_call={"name": "shell", "args": {}, "id": "1"}
        )
        result = ToolMessage(content="ok", tool_call_id="1")

        with patch("harness.deepagents.middleware.logging.log") as fallback:
            mw = LoggingMiddleware()
            mw.wrap_tool_call(request, lambda req: result)

        self.assertIs(mw.logger, fallback)
        fallback.info.assert_called()

    def test_explicit_logger_receives_records_without_using_fallback(self) -> None:
        custom = MagicMock()
        model_request = types.SimpleNamespace(messages=[])
        model_response = types.SimpleNamespace(
            result=[AIMessage(content="done")], structured_response=None
        )
        tool_request = types.SimpleNamespace(
            tool_call={"name": "shell", "args": {}, "id": "1"}
        )
        tool_result = ToolMessage(content="ok", tool_call_id="1")

        def model_boom(req):
            raise ValueError("model failed")

        def tool_boom(req):
            raise RuntimeError("tool failed")

        with patch("harness.deepagents.middleware.logging.log") as fallback:
            mw = LoggingMiddleware(logger=custom)
            mw.wrap_model_call(model_request, lambda req: model_response)
            mw.wrap_tool_call(tool_request, lambda req: tool_result)
            with self.assertRaises(ValueError):
                mw.wrap_model_call(model_request, model_boom)
            with self.assertRaises(RuntimeError):
                mw.wrap_tool_call(tool_request, tool_boom)

        self.assertIs(mw.logger, custom)
        custom.info.assert_called()
        custom.error.assert_called()
        fallback.info.assert_not_called()
        fallback.error.assert_not_called()


class TestWrapModelCall(unittest.TestCase):
    def test_returns_handler_response_and_logs(self) -> None:
        mw = LoggingMiddleware()
        ai = AIMessage(
            content="done",
            tool_calls=[
                {"name": "shell", "args": {"cmd": "ls"}, "id": "1", "type": "tool_call"}
            ],
        )
        response = types.SimpleNamespace(result=[ai], structured_response=None)
        request = types.SimpleNamespace(messages=[AIMessage(content="hi")])

        with self.assertLogs(LOGGER, level="INFO") as cm:
            out = mw.wrap_model_call(request, lambda req: response)

        self.assertIs(out, response)
        joined = "\n".join(cm.output)
        self.assertIn("model call", joined)
        self.assertIn("shell", joined)

    def test_reasoning_summary_logs_without_encrypted_content(self) -> None:
        mw = LoggingMiddleware()
        encrypted_blob = "opaque-encrypted-reasoning-blob"
        ai = AIMessage(
            content=[
                {
                    "type": "reasoning",
                    "id": "rs_123",
                    "summary": [{"type": "summary_text", "text": "Checked the files."}],
                    "encrypted_content": encrypted_blob,
                },
                {"type": "text", "text": "done"},
            ]
        )
        response = types.SimpleNamespace(result=[ai], structured_response=None)
        request = types.SimpleNamespace(messages=[AIMessage(content="hi")])

        with self.assertLogs(LOGGER, level="INFO") as cm:
            out = mw.wrap_model_call(request, lambda req: response)

        self.assertIs(out, response)
        joined = "\n".join(cm.output)
        self.assertIn("reasoning: Checked the files.", joined)
        self.assertNotIn(encrypted_blob, joined)

    def test_anthropic_thinking_logs_without_signature(self) -> None:
        mw = LoggingMiddleware()
        signature = "opaque-thinking-signature"
        ai = AIMessage(
            content=[
                {
                    "type": "thinking",
                    "thinking": "Read main.go.",
                    "signature": signature,
                },
                {"type": "text", "text": "done"},
            ]
        )
        response = types.SimpleNamespace(result=[ai], structured_response=None)
        request = types.SimpleNamespace(messages=[AIMessage(content="hi")])

        with self.assertLogs(LOGGER, level="INFO") as cm:
            mw.wrap_model_call(request, lambda req: response)

        joined = "\n".join(cm.output)
        self.assertIn("reasoning: Read main.go.", joined)
        self.assertNotIn(signature, joined)

    def test_refusal_logs_a_warning_with_the_reply_text(self) -> None:
        mw = LoggingMiddleware()
        ai = AIMessage(
            content=[{"type": "text", "text": "I can't help with that."}],
            response_metadata={"stop_reason": "refusal"},
        )
        response = types.SimpleNamespace(result=[ai], structured_response=None)
        request = types.SimpleNamespace(messages=[AIMessage(content="hi")])

        with self.assertLogs(LOGGER, level="INFO") as cm:
            mw.wrap_model_call(request, lambda req: response)

        warnings = [line for line in cm.output if line.startswith("WARNING")]
        self.assertEqual(len(warnings), 1)
        self.assertIn("model refused: I can't help with that.", warnings[0])

    def test_refusal_without_text_says_so(self) -> None:
        mw = LoggingMiddleware()
        ai = AIMessage(content=[], response_metadata={"stop_reason": "refusal"})
        response = types.SimpleNamespace(result=[ai], structured_response=None)
        request = types.SimpleNamespace(messages=[AIMessage(content="hi")])

        with self.assertLogs(LOGGER, level="WARNING") as cm:
            mw.wrap_model_call(request, lambda req: response)

        self.assertIn("model refused: (no text)", "\n".join(cm.output))

    def test_other_stop_reasons_log_no_warning(self) -> None:
        mw = LoggingMiddleware()
        ai = AIMessage(content="done", response_metadata={"stop_reason": "end_turn"})
        response = types.SimpleNamespace(result=[ai], structured_response=None)
        request = types.SimpleNamespace(messages=[AIMessage(content="hi")])

        with self.assertLogs(LOGGER, level="INFO") as cm:
            mw.wrap_model_call(request, lambda req: response)

        self.assertFalse([line for line in cm.output if line.startswith("WARNING")])

    def test_structured_response_is_logged_as_json(self) -> None:
        from pydantic import BaseModel

        class Verdict(BaseModel):
            status: str
            summary: str

        mw = LoggingMiddleware()
        response = types.SimpleNamespace(
            result=[AIMessage(content="done")],
            structured_response=Verdict(
                status="needs_revision", summary="tighten the contract"
            ),
        )
        request = types.SimpleNamespace(messages=[])

        with self.assertLogs(LOGGER, level="INFO") as cm:
            mw.wrap_model_call(request, lambda req: response)

        joined = "\n".join(cm.output)
        self.assertIn("structured output", joined)
        self.assertIn("tighten the contract", joined)
        self.assertIn("needs_revision", joined)

    def test_non_pydantic_structured_response_is_logged(self) -> None:
        mw = LoggingMiddleware()
        response = types.SimpleNamespace(
            result=[AIMessage(content="done")],
            structured_response={"status": "approved"},
        )
        request = types.SimpleNamespace(messages=[])

        with self.assertLogs(LOGGER, level="INFO") as cm:
            mw.wrap_model_call(request, lambda req: response)

        joined = "\n".join(cm.output)
        self.assertIn("structured output", joined)
        self.assertIn("approved", joined)

    def test_absent_structured_response_logs_no_structured_line(self) -> None:
        mw = LoggingMiddleware()
        response = types.SimpleNamespace(
            result=[AIMessage(content="done")], structured_response=None
        )
        request = types.SimpleNamespace(messages=[])

        with self.assertLogs(LOGGER, level="INFO") as cm:
            mw.wrap_model_call(request, lambda req: response)

        self.assertNotIn("structured output", "\n".join(cm.output))

    def test_model_error_is_logged_and_reraised(self) -> None:
        mw = LoggingMiddleware()
        request = types.SimpleNamespace(messages=[])

        def boom(req):
            raise ValueError("kaboom")

        with (
            self.assertLogs(LOGGER, level="INFO") as cm,
            self.assertRaises(ValueError),
        ):
            mw.wrap_model_call(request, boom)
        self.assertIn("model error", "\n".join(cm.output))

    def test_structured_output_parse_error_logs_raw_response_and_reraises(self) -> None:
        mw = LoggingMiddleware()
        request = types.SimpleNamespace(messages=[])
        err = StructuredOutputValidationError(
            "RepoImplementationOutput",
            ValueError("schema mismatch"),
            AIMessage(content='{"summary": "raw malformed response"}'),
        )

        def boom(req):
            raise err

        with (
            self.assertLogs(LOGGER, level="ERROR") as cm,
            self.assertRaises(StructuredOutputValidationError) as ctx,
        ):
            mw.wrap_model_call(request, boom)

        self.assertIs(ctx.exception, err)
        joined = "\n".join(cm.output)
        self.assertIn("model error", joined)
        self.assertIn("structured output raw response", joined)
        self.assertIn("raw malformed response", joined)


class TestWrapToolCall(unittest.TestCase):
    def test_returns_handler_result_and_logs(self) -> None:
        mw = LoggingMiddleware()
        request = types.SimpleNamespace(
            tool_call={"name": "shell", "args": {"cmd": "pytest"}, "id": "1"}
        )
        result = ToolMessage(content="ok", tool_call_id="1")

        with self.assertLogs(LOGGER, level="INFO") as cm:
            out = mw.wrap_tool_call(request, lambda req: result)

        self.assertIs(out, result)
        joined = "\n".join(cm.output)
        self.assertIn("shell", joined)
        self.assertIn("ok", joined)

    def test_tool_error_is_logged_and_reraised(self) -> None:
        mw = LoggingMiddleware()
        request = types.SimpleNamespace(tool_call={"name": "shell", "args": {}})

        def boom(req):
            raise RuntimeError("tool blew up")

        with (
            self.assertLogs(LOGGER, level="INFO") as cm,
            self.assertRaises(RuntimeError),
        ):
            mw.wrap_tool_call(request, boom)
        self.assertIn("tool shell error", "\n".join(cm.output))


class TestSessionFileLogging(unittest.TestCase):
    def test_safe_filename_replaces_path_chars_and_avoids_collisions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp)
            first = session_log_path("repo/a:b", logs_dir)
            second = session_log_path("repo/a?b", logs_dir)
            empty = session_log_path("", logs_dir)

        self.assertEqual(first.parent, logs_dir)
        self.assertNotIn("/", first.name)
        self.assertNotIn(":", first.name)
        self.assertIn("repo_a_b", first.name)
        self.assertNotEqual(first.name, second.name)
        self.assertTrue(empty.name.startswith("thread-"))

    def test_logging_middleware_info_record_is_written_to_session_log(self) -> None:
        request = types.SimpleNamespace(
            tool_call={"name": "shell", "args": {"cmd": "pytest"}, "id": "1"}
        )
        result = ToolMessage(content="ok", tool_call_id="1")

        with tempfile.TemporaryDirectory() as tmp:
            handle = setup_session_file_logging("thread/with:path", Path(tmp))
            mw = LoggingMiddleware(logger=handle.logger)
            try:
                mw.wrap_tool_call(request, lambda req: result)
                log_path = handle.path
            finally:
                handle.close()
            text = log_path.read_text(encoding="utf-8")

        self.assertIn("→ tool shell", text)
        self.assertIn("← tool shell result: ok", text)

    def test_dotted_thread_id_cannot_create_logger_descendant(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp)
            first = setup_session_file_logging("parent", logs_dir)
            first_component = first.logger.name.removeprefix(f"{LOGGER}.")
            second = setup_session_file_logging(f"{first_component}.child", logs_dir)
            try:
                second.logger.info("second-only")
                first_log_path = first.path
                second_log_path = second.path
            finally:
                first.close()
                second.close()

            first_text = first_log_path.read_text(encoding="utf-8")
            second_text = second_log_path.read_text(encoding="utf-8")

        self.assertNotIn("second-only", first_text)
        self.assertIn("second-only", second_text)


if __name__ == "__main__":
    unittest.main()
