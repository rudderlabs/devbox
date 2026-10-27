"""ToolExclusionMiddleware: hides tools from the model and refuses their calls."""

from __future__ import annotations

import asyncio
import unittest
from typing import Any

from deepagents.middleware._utils import append_to_system_message
from deepagents.middleware.subagents import TASK_SYSTEM_PROMPT
from langchain.agents.middleware.types import ModelRequest, ToolCallRequest
from langchain_core.messages import SystemMessage, ToolMessage
from langchain_core.tools import tool

from harness.deepagents.middleware.tool_exclusion import ToolExclusionMiddleware


@tool
def task(description: str) -> str:
    """Delegate."""
    return description


@tool
def read_file(path: str) -> str:
    """Read."""
    return path


def _model_request() -> ModelRequest:
    return ModelRequest(
        model=None,  # type: ignore[arg-type]
        messages=[],
        tools=[task, read_file, {"name": "task", "description": "dict form"}],
    )


def _tool_request(name: str) -> ToolCallRequest:
    return ToolCallRequest(
        tool_call={"name": name, "args": {}, "id": "call-9", "type": "tool_call"},
        tool=None,
        state={},
        runtime=None,  # type: ignore[arg-type]
    )


class TestToolExclusionMiddleware(unittest.TestCase):
    def setUp(self) -> None:
        self.middleware = ToolExclusionMiddleware(excluded=frozenset({"task"}))

    def test_wrap_model_call_filters_excluded_tools(self) -> None:
        seen: list[Any] = []

        def handler(request: ModelRequest) -> str:
            seen.append(request.tools)
            return "response"

        self.assertEqual(
            self.middleware.wrap_model_call(_model_request(), handler), "response"
        )
        self.assertEqual(seen, [[read_file]])

    def test_awrap_model_call_filters_excluded_tools(self) -> None:
        seen: list[Any] = []

        async def handler(request: ModelRequest) -> str:
            seen.append(request.tools)
            return "response"

        result = asyncio.run(
            self.middleware.awrap_model_call(_model_request(), handler)
        )
        self.assertEqual(result, "response")
        self.assertEqual(seen, [[read_file]])

    def test_excluded_call_returns_error_message_without_running(self) -> None:
        def handler(request: ToolCallRequest) -> Any:
            raise AssertionError("an excluded tool must not run")

        result = self.middleware.wrap_tool_call(_tool_request("task"), handler)
        self.assertEqual(
            result,
            ToolMessage(
                content="task is not available to this agent.",
                name="task",
                tool_call_id="call-9",
                status="error",
            ),
        )

    def test_async_excluded_call_returns_error_message_without_running(self) -> None:
        async def handler(request: ToolCallRequest) -> Any:
            raise AssertionError("an excluded tool must not run")

        result = asyncio.run(
            self.middleware.awrap_tool_call(_tool_request("task"), handler)
        )
        self.assertEqual(
            result,
            ToolMessage(
                content="task is not available to this agent.",
                name="task",
                tool_call_id="call-9",
                status="error",
            ),
        )

    def test_other_calls_pass_through(self) -> None:
        sentinel = ToolMessage(content="ok", tool_call_id="call-9")
        calls: list[ToolCallRequest] = []

        def handler(request: ToolCallRequest) -> ToolMessage:
            calls.append(request)
            return sentinel

        request = _tool_request("read_file")
        self.assertIs(self.middleware.wrap_tool_call(request, handler), sentinel)
        self.assertEqual(calls, [request])

        async def ahandler(request: ToolCallRequest) -> ToolMessage:
            return sentinel

        self.assertIs(
            asyncio.run(self.middleware.awrap_tool_call(request, ahandler)),
            sentinel,
        )


def _system_message_with_task() -> SystemMessage:
    message = append_to_system_message(
        SystemMessage(content="Base role."), TASK_SYSTEM_PROMPT
    )
    return append_to_system_message(message, "Trailing section.")


class TestSystemMessageTaskSection(unittest.TestCase):
    def _seen(
        self, middleware: ToolExclusionMiddleware, system_message: Any
    ) -> list[Any]:
        seen: list[Any] = []

        def handler(request: ModelRequest) -> str:
            seen.append(request.system_message)
            return "response"

        request = ModelRequest(
            model=None,  # type: ignore[arg-type]
            messages=[],
            tools=[],
            system_message=system_message,
        )
        middleware.wrap_model_call(request, handler)
        return seen

    def test_task_block_removed_and_others_kept(self) -> None:
        middleware = ToolExclusionMiddleware(excluded=frozenset({"task"}))
        [message] = self._seen(middleware, _system_message_with_task())
        self.assertEqual(
            message.content_blocks,
            [
                {"type": "text", "text": "Base role."},
                {"type": "text", "text": "\n\nTrailing section."},
            ],
        )

    def test_async_task_block_removed(self) -> None:
        middleware = ToolExclusionMiddleware(excluded=frozenset({"task"}))
        seen: list[Any] = []

        async def handler(request: ModelRequest) -> str:
            seen.append(request.system_message)
            return "response"

        request = ModelRequest(
            model=None,  # type: ignore[arg-type]
            messages=[],
            tools=[],
            system_message=_system_message_with_task(),
        )
        asyncio.run(middleware.awrap_model_call(request, handler))
        self.assertEqual(
            seen[0].content_blocks,
            [
                {"type": "text", "text": "Base role."},
                {"type": "text", "text": "\n\nTrailing section."},
            ],
        )

    def test_unchanged_when_task_not_excluded(self) -> None:
        middleware = ToolExclusionMiddleware(excluded=frozenset({"other"}))
        original = _system_message_with_task()
        [message] = self._seen(middleware, original)
        self.assertIs(message, original)

    def test_unchanged_without_task_block_or_message(self) -> None:
        middleware = ToolExclusionMiddleware(excluded=frozenset({"task"}))
        plain = SystemMessage(content="Just a role.")
        self.assertEqual(self._seen(middleware, plain), [plain])
        self.assertEqual(self._seen(middleware, None), [None])


if __name__ == "__main__":
    unittest.main()
