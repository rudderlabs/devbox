"""Tests for the system-prompt middleware base."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, SystemMessage

from harness.deepagents.middleware.system_prompt import SystemPromptMiddleware


class _Tool(SystemPromptMiddleware):
    def __init__(self, text: str | None) -> None:
        self.system_prompt = text
        self.tools = []


def _request(system: str = "base") -> ModelRequest:
    return ModelRequest(
        model=MagicMock(),
        messages=[],
        system_message=SystemMessage(content=system),
        tools=[],
        tool_choice=None,
        response_format=None,
        state={"messages": []},
        runtime=MagicMock(),
    )


def _capture(seen: list[ModelRequest]):
    def handler(req: ModelRequest) -> ModelResponse:
        seen.append(req)
        return ModelResponse(result=[AIMessage(content="ok")])

    return handler


class TestSystemPromptMiddleware(unittest.TestCase):
    def test_appends_system_prompt_after_base(self) -> None:
        seen: list[ModelRequest] = []
        _Tool("<a>tool</a>").wrap_model_call(_request("base"), _capture(seen))
        text = seen[0].system_message.text
        self.assertTrue(text.startswith("base"))
        self.assertIn("<a>tool</a>", text)

    def test_none_appends_nothing(self) -> None:
        seen: list[ModelRequest] = []
        original = _request("base")
        _Tool(None).wrap_model_call(original, _capture(seen))
        self.assertIs(seen[0], original)
        self.assertEqual(seen[0].system_message.text, "base")

    def test_async_hook_matches_sync(self) -> None:
        seen: list[ModelRequest] = []

        async def handler(req: ModelRequest) -> ModelResponse:
            seen.append(req)
            return ModelResponse(result=[AIMessage(content="ok")])

        asyncio.run(_Tool("<a/>").awrap_model_call(_request(), handler))
        self.assertIn("<a/>", seen[0].system_message.text)

    def test_async_none_appends_nothing(self) -> None:
        seen: list[ModelRequest] = []
        original = _request("base")

        async def handler(req: ModelRequest) -> ModelResponse:
            seen.append(req)
            return ModelResponse(result=[AIMessage(content="ok")])

        asyncio.run(_Tool(None).awrap_model_call(original, handler))
        self.assertIs(seen[0], original)


if __name__ == "__main__":
    unittest.main()
