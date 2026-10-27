"""Tests for the reply tool middleware."""

from __future__ import annotations

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
from harness.deepagents.middleware.reply import (
    REPLY_INSTRUCTIONS,
    ReplyMiddleware,
    ReplyTarget,
)
from harness.deepagents.middleware.system_prompt import EMIT_VOICE_RULES
from harness.events import RoundEvents, iter_events
from tests.schema_support import assert_strict_compatible

# The client's bound target matches none of the reply targets, so every
# assertion on a reply's target_id proves the target was passed explicitly.
ROUND_TARGET = "round-target"
ONE = [ReplyTarget("c-1", "the comment")]
TWO = [
    ReplyTarget("rev", "review summary"),
    ReplyTarget("c-2", "inline comment on src/x.ts:42"),
]


class TestReplyMiddleware(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.events_file = root / "events.jsonl"
        self.events = RoundEvents(
            events_file=self.events_file,
            events_lock=root / "events.lock",
            inbox_id="in-1",
            target_id=ROUND_TARGET,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _tool(self, targets=ONE):
        return ReplyMiddleware(events=self.events, targets=targets).tools[0]

    def _schema(self, tool) -> dict:
        return tool.tool_call_schema.model_json_schema()

    def _events(self) -> list[dict]:
        return list(iter_events(self.events_file))

    def test_single_target_has_no_target_field(self) -> None:
        self.assertEqual(sorted(self._schema(self._tool())["properties"]), ["body"])

    def test_several_targets_expose_required_enum_with_descriptions(self) -> None:
        schema = self._schema(self._tool(TWO))
        self.assertEqual(schema["properties"]["target"]["enum"], ["rev", "c-2"])
        self.assertIn("target", schema["required"])
        self.assertIn(
            "inline comment on src/x.ts:42",
            schema["properties"]["target"]["description"],
        )

    def test_reply_posts_agent_response_to_single_target(self) -> None:
        result = self._tool().invoke({
            "body": "Fixed in https://github.com/o/r/commit/abc."
        })
        event = self._events()[0]
        self.assertEqual(
            (event["type"], event["inbox_id"], event["target_id"]),
            ("agent_response", "in-1", "c-1"),
        )
        self.assertEqual(event["body"], "Fixed in https://github.com/o/r/commit/abc.")
        self.assertIn("reply posted to c-1", result)

    def test_body_is_posted_verbatim(self) -> None:
        self._tool().invoke({"body": "literal \\n stays"})
        self.assertEqual(self._events()[0]["body"], "literal \\n stays")

    def test_reply_routes_to_chosen_target(self) -> None:
        self._tool(TWO).invoke({"body": "Done.", "target": "c-2"})
        self.assertEqual(self._events()[0]["target_id"], "c-2")

    def test_reply_ignores_client_bound_target(self) -> None:
        # A follow-up round's items are separate threads: each reply must carry
        # its own target, never the client's bound target.
        self.assertNotIn(ROUND_TARGET, {target.id for target in ONE + TWO})
        self._tool().invoke({"body": "Only item."})
        tool = self._tool(TWO)
        tool.invoke({"body": "Review.", "target": "rev"})
        tool.invoke({"body": "Inline.", "target": "c-2"})
        self.assertEqual(
            [(event["target_id"], event["body"]) for event in self._events()],
            [("c-1", "Only item."), ("rev", "Review."), ("c-2", "Inline.")],
        )

    def test_invalid_target_is_a_tool_error(self) -> None:
        tool = self._tool(TWO)
        bad = tool.run({"body": "x", "target": "nope"}, tool_call_id="a")
        self.assertEqual(bad.status, "error")
        self.assertEqual(self._events(), [])

    def test_blank_body_is_a_validation_error_and_publishes_nothing(self) -> None:
        message = self._tool().run({"body": "   "}, tool_call_id="b")
        self.assertEqual(message.status, "error")
        self.assertEqual(message.content, "invalid arguments: body: must not be blank")
        self.assertEqual(self._events(), [])

    def test_body_with_surrounding_whitespace_is_posted_unchanged(self) -> None:
        self._tool().invoke({"body": "  hi\n"})
        self.assertEqual(self._events()[0]["body"], "  hi\n")

    def test_schemas_are_strict_compatible(self) -> None:
        for tool in (
            self._tool(TWO),
            self._tool(ONE),
        ):
            assert_strict_compatible(self, tool)

    def test_publish_failure_is_a_tool_error(self) -> None:
        with patch("harness.events.append_event", side_effect=OSError("disk")):
            message = self._tool().run({"body": "x"}, tool_call_id="c")
        self.assertEqual(message.status, "error")

    def test_empty_targets_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ReplyMiddleware(events=self.events, targets=[])

    def test_instructions_are_policy_only(self) -> None:
        for expected in ("exactly once", "commit", "say why"):
            self.assertIn(expected, REPLY_INSTRUCTIONS)
        for absent in ("heredoc", "emit-event", "--body"):
            self.assertNotIn(absent, REPLY_INSTRUCTIONS)

    def test_voice_rules_live_inside_reply_section(self) -> None:
        start = REPLY_INSTRUCTIONS.index("<replies>")
        end = REPLY_INSTRUCTIONS.index("</replies>")
        section = REPLY_INSTRUCTIONS[start:end]
        self.assertIn("`reply`", section)
        self.assertIn("one bot's answer on their comment or review", section)
        self.assertIn(EMIT_VOICE_RULES, section)
        self.assertNotIn("single_bot_voice", REPLY_INSTRUCTIONS)

    def test_real_reply_and_progress_chain_scope_voice_per_section(self) -> None:
        reply = ReplyMiddleware(events=self.events, targets=ONE)
        progress = ProgressEmitMiddleware(events=self.events)
        seen: dict[str, ModelRequest] = {}

        def handler(request: ModelRequest) -> ModelResponse:
            seen["request"] = request
            return ModelResponse(result=[AIMessage(content="ok")])

        request = ModelRequest(
            model=object(), messages=[], system_message=SystemMessage(content="base")
        )
        reply.wrap_model_call(
            request, lambda req: progress.wrap_model_call(req, handler)
        )

        text = seen["request"].system_message.text
        self.assertIn(REPLY_INSTRUCTIONS, text)
        self.assertIn(PROGRESS_INSTRUCTIONS, text)
        self.assertNotIn("single_bot_voice", text)
        outside = text
        for tag in ("replies", "progress_updates"):
            start = outside.index(f"<{tag}>")
            end = outside.index(f"</{tag}>") + len(f"</{tag}>")
            self.assertEqual(outside[start:end].count(EMIT_VOICE_RULES), 1)
            outside = outside[:start] + outside[end:]
        self.assertNotIn(EMIT_VOICE_RULES, outside)
