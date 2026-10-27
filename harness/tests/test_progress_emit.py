"""Tests for DeepAgents progress-emitting tool middleware."""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, SystemMessage

from harness.deepagents.middleware.progress_emit import (
    PROGRESS_INSTRUCTIONS,
    ProgressEmitMiddleware,
)
from harness.deepagents.middleware.system_prompt import EMIT_VOICE_RULES
from harness.events import RoundEvents
from tests.schema_support import assert_strict_compatible


class _EventsMixin:
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        self.events_file = self.ws / ".harness" / "events.jsonl"
        self.events_lock = self.ws / ".harness" / "events.lock"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _middleware(
        self,
        label: str | None = None,
        system_prompt: str | None = PROGRESS_INSTRUCTIONS,
    ) -> ProgressEmitMiddleware:
        events = RoundEvents(
            events_file=self.events_file,
            events_lock=self.events_lock,
            inbox_id="inbox-1",
            target_id="target-1",
        )
        return ProgressEmitMiddleware(
            events=events,
            worker_label=label,
            system_prompt=system_prompt,
        )

    def _events(self) -> list[dict]:
        if not self.events_file.exists():
            return []
        return [
            json.loads(line)
            for line in self.events_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]


class TestProgressEmitTool(_EventsMixin, unittest.TestCase):
    def test_emit_progress_appends_kind_mapped_event_with_label(self) -> None:
        tool = self._middleware("repo-a/api").tools[0]
        with patch.dict("os.environ", {}, clear=True):
            result = tool.invoke({"kind": "thought", "body": "Inspecting failure"})
        self.assertEqual(result, "progress emitted (agent_thought): seq 1")
        event = self._events()[0]
        self.assertEqual(
            (
                event["type"],
                event["inbox_id"],
                event["target_id"],
                event["identifier"],
                event["body"],
            ),
            (
                "agent_thought",
                "inbox-1",
                "target-1",
                "repo-a/api",
                "`repo-a/api` Inspecting failure",
            ),
        )

    def test_emit_progress_maps_action_without_label(self) -> None:
        tool = self._middleware().tools[0]

        with patch.dict("os.environ", {}, clear=True):
            result = tool.invoke({"kind": "action", "body": "Running tests"})

        self.assertEqual(result, "progress emitted (agent_action): seq 1")
        event = self._events()[0]
        self.assertEqual(event["type"], "agent_action")
        self.assertEqual(event["body"], "Running tests")
        self.assertNotIn("identifier", event)

    def test_emit_progress_failure_is_a_plain_result(self) -> None:
        tool = self._middleware().tools[0]
        with patch("harness.events.append_event", side_effect=OSError("disk")):
            result = tool.invoke({"kind": "action", "body": "Running tests"})
        self.assertEqual(result, "progress not posted: OSError: disk")
        self.assertEqual(self._events(), [])

    def test_label_is_trimmed_and_empty_label_is_omitted(self) -> None:
        mw = self._middleware("   ")
        self.assertIsNone(mw.worker_label)
        self.assertEqual(self._middleware("  repo-a ").worker_label, "repo-a")

        mw.tools[0].invoke({"kind": "thought", "body": "Working"})

        event = self._events()[0]
        self.assertEqual(event["body"], "Working")
        self.assertNotIn("identifier", event)

    def test_tool_schema_exposes_only_model_visible_arguments(self) -> None:
        tool = self._middleware("repo-a").tools[0]

        self.assertEqual(tool.name, "emit_progress")
        self.assertEqual(set(tool.args), {"kind", "body"})
        for field in tool.args.values():
            self.assertIn("description", field)
        self.assertNotIn("identifier", tool.args)

    def test_kind_description_gives_guidance_for_each_kind(self) -> None:
        tool = self._middleware("repo-a").tools[0]

        self.assertEqual(
            tool.args["kind"]["description"],
            "thought: a short first-person sentence about the work and its "
            'status. action: a short activity label of about three words, such as "Running tests".',
        )

    def test_schema_is_strict_compatible(self) -> None:
        assert_strict_compatible(self, self._middleware("repo-a").tools[0])


class TestProgressEmitMiddlewarePrompt(_EventsMixin, unittest.TestCase):
    def test_progress_instructions_contract(self) -> None:
        self.assertIn("emit_progress", PROGRESS_INSTRUCTIONS)
        self.assertIn(
            "same response as your next real tool call", PROGRESS_INSTRUCTIONS
        )
        self.assertIn("Don't repeat those announcements", PROGRESS_INSTRUCTIONS)
        self.assertIn("don't prefix your updates", PROGRESS_INSTRUCTIONS)
        self.assertNotIn("heredoc", PROGRESS_INSTRUCTIONS)

    def _request(self, base: str = "base prompt") -> ModelRequest:
        return ModelRequest(
            model=object(),
            messages=[],
            system_message=SystemMessage(content=base),
        )

    def test_prompt_is_appended_by_default_and_tool_is_registered(self) -> None:
        mw = self._middleware("repo-a")
        seen: dict[str, ModelRequest] = {}

        def handler(request: ModelRequest) -> ModelResponse:
            seen["request"] = request
            return ModelResponse(result=[AIMessage(content="ok")])

        mw.wrap_model_call(self._request(), handler)

        self.assertEqual([tool.name for tool in mw.tools], ["emit_progress"])
        self.assertEqual(mw.worker_label, "repo-a")
        system_text = seen["request"].system_message.text
        self.assertIn("base prompt", system_text)
        self.assertIn(PROGRESS_INSTRUCTIONS.strip(), system_text)

    def test_voice_rules_live_inside_progress_section(self) -> None:
        mw = self._middleware()
        seen: dict[str, ModelRequest] = {}

        def handler(request: ModelRequest) -> ModelResponse:
            seen["request"] = request
            return ModelResponse(result=[AIMessage(content="ok")])

        mw.wrap_model_call(self._request("base"), handler)

        system_text = seen["request"].system_message.text
        self.assertTrue(system_text.startswith("base"))
        start = system_text.index("<progress_updates>")
        end = system_text.index("</progress_updates>")
        section = system_text[start:end]
        self.assertIn("`emit_progress`", section)
        self.assertIn("Each update is shown to the user live", section)
        self.assertIn(EMIT_VOICE_RULES, section)
        self.assertEqual(system_text.count(EMIT_VOICE_RULES), 1)
        self.assertNotIn("single_bot_voice", system_text)

    def test_system_prompt_none_suppresses_prompt_only(self) -> None:
        mw = self._middleware("repo-a", system_prompt=None)
        original = self._request()
        seen: dict[str, ModelRequest] = {}

        def handler(request: ModelRequest) -> ModelResponse:
            seen["request"] = request
            return ModelResponse(result=[AIMessage(content="ok")])

        mw.wrap_model_call(original, handler)

        self.assertEqual([tool.name for tool in mw.tools], ["emit_progress"])
        self.assertIs(seen["request"], original)
        self.assertEqual(seen["request"].system_message.text, "base prompt")

    def test_async_prompt_is_appended_by_default(self) -> None:
        mw = self._middleware("repo-a")
        seen: dict[str, ModelRequest] = {}

        async def handler(request: ModelRequest) -> ModelResponse:
            seen["request"] = request
            return ModelResponse(result=[AIMessage(content="ok")])

        asyncio.run(mw.awrap_model_call(self._request(), handler))

        system_text = seen["request"].system_message.text
        self.assertIn("base prompt", system_text)
        self.assertIn(PROGRESS_INSTRUCTIONS.strip(), system_text)


if __name__ == "__main__":
    unittest.main()
