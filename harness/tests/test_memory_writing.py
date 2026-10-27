"""Tests for DeepAgents memory-writing tool middleware."""

from __future__ import annotations

import importlib
import json
import re
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, SystemMessage

from harness.deepagents.middleware.memory_writing import (
    MEMORY_INSTRUCTIONS,
    MemoryWritingMiddleware,
    RepoScope,
)
from harness.events import RoundEvents
from harness.memory import memory_heartbeat_body
from tests.schema_support import assert_strict_compatible


class TestMemoryWritingTool(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        self.memory_dir = self.ws / ".harness" / "memory"
        self.events_file = self.ws / ".harness" / "events.jsonl"
        self.events_lock = self.ws / ".harness" / "events.lock"
        self.session_json = self.ws / ".harness" / "session.json"
        self.session_json.parent.mkdir(parents=True)
        self.session_json.write_text('{"task_key": "ABC-102"}', encoding="utf-8")
        self.memory_patcher = patch("harness.memory.MEMORY_DIR", self.memory_dir)
        self.session_patcher = patch("harness.memory.SESSION_JSON", self.session_json)
        self.memory_patcher.start()
        self.session_patcher.start()

    def tearDown(self) -> None:
        self.session_patcher.stop()
        self.memory_patcher.stop()
        self._tmp.cleanup()

    def _store(self):
        # Resolve at call time: other test modules swap ``harness.memory`` in
        # ``sys.modules``, and the patched paths live on the current module.
        return importlib.import_module("harness.memory").MemoryStore()

    def _round_events(self) -> RoundEvents:
        return RoundEvents(
            events_file=self.events_file,
            events_lock=self.events_lock,
            inbox_id="inbox-1",
            target_id="t-1",
        )

    def _middleware(self, repos=None, events=None):
        return MemoryWritingMiddleware(
            store=self._store(),
            stage="implementation",
            repos=repos
            or [
                RepoScope(
                    "repo-a",
                    ("./services/api/", "libs/core", "../outside"),
                )
            ],
            events=events,
        )

    def _events(self) -> list[dict]:
        if not self.events_file.exists():
            return []
        return [
            json.loads(line)
            for line in self.events_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_record_memory_writes_repo_wide_entry_with_cli_format(self) -> None:
        tool = self._middleware().tools[0]

        result = tool.invoke({
            "type": "decision",
            "text": "Use the shared retry helper for outbound API calls.",
            "context": "The helper centralizes jitter and timeout behavior.",
        })

        self.assertIn("memory recorded (repo-wide)", result)
        memory_file = self.memory_dir / "repo-a" / "implementation.md"
        body = memory_file.read_text(encoding="utf-8")
        self.assertIn("# Memory — repo-a · implementation", body)
        self.assertIn("**Task key:** ABC-102", body)
        self.assertEqual(
            len(
                re.findall(r"^### decision  \[\d{2}:\d{2}:\d{2}\]$", body, re.MULTILINE)
            ),
            1,
        )
        self.assertIn("Use the shared retry helper", body)
        self.assertIn("**Why:** The helper centralizes jitter", body)

    def test_component_routes_only_when_known_after_normalization(self) -> None:
        tool = self._middleware().tools[0]

        tool.invoke({
            "type": "note",
            "text": "API component owns route registration.",
            "component": "services/api/",
        })
        tool.invoke({
            "type": "note",
            "text": "Core component owns shared value types.",
            "component": "./libs/core",
        })

        self.assertTrue(
            (
                self.memory_dir / "repo-a" / "services" / "api" / "implementation.md"
            ).is_file()
        )
        self.assertTrue(
            (
                self.memory_dir / "repo-a" / "libs" / "core" / "implementation.md"
            ).is_file()
        )
        self.assertFalse((self.memory_dir / "repo-a" / "implementation.md").exists())

    def test_unknown_invalid_and_empty_components_fall_back_repo_wide(self) -> None:
        tool = self._middleware().tools[0]
        cases = [
            "services/worker",
            "/services/api",
            "../services/api",
            "",
            "   ",
            "services\\api",
        ]

        for value in cases:
            with self.subTest(component=value):
                tool.invoke({
                    "type": "note",
                    "text": f"Fallback note for {value!r}.",
                    "component": value,
                })

        body = (self.memory_dir / "repo-a" / "implementation.md").read_text(
            encoding="utf-8"
        )
        self.assertEqual(len(re.findall(r"^### note", body, re.MULTILINE)), len(cases))
        self.assertFalse((self.memory_dir / "repo-a" / "services" / "worker").exists())

    def test_context_dropped_for_non_decision_feedback_types(self) -> None:
        tool = self._middleware().tools[0]

        result = tool.invoke({
            "type": "pattern",
            "text": "Retries wrap outbound calls in a shared helper.",
            "context": "This context does not apply to pattern entries.",
        })

        self.assertIn("memory recorded (repo-wide)", result)
        body = (self.memory_dir / "repo-a" / "implementation.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("### pattern", body)
        self.assertNotIn("**Why:**", body)
        self.assertNotIn("does not apply", body)

    def test_context_retained_for_decision_and_feedback_types(self) -> None:
        for entry_type in ("decision", "feedback"):
            with self.subTest(entry_type=entry_type):
                tool = self._middleware().tools[0]
                tool.invoke({
                    "type": entry_type,
                    "text": f"{entry_type} body text.",
                    "context": f"Rationale for {entry_type}.",
                })

        body = (self.memory_dir / "repo-a" / "implementation.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("**Why:** Rationale for decision.", body)
        self.assertIn("**Why:** Rationale for feedback.", body)

    def test_tool_schema_exposes_only_model_visible_arguments(self) -> None:
        tool = self._middleware().tools[0]

        self.assertEqual(tool.name, "record_memory")
        self.assertEqual(set(tool.args), {"type", "text", "context", "component"})
        for field in tool.args.values():
            self.assertIn("description", field)

    def test_component_description_lists_normalized_subpaths(self) -> None:
        schema = self._middleware().tools[0].tool_call_schema.model_json_schema()
        description = schema["properties"]["component"]["description"]
        self.assertIn("repo-a: services/api, libs/core", description)
        self.assertNotIn("outside", description)

    def test_single_repo_has_no_repo_field(self) -> None:
        schema = self._middleware().tools[0].tool_call_schema.model_json_schema()
        self.assertNotIn("repo", schema["properties"])

    def test_several_repos_expose_required_repo_enum(self) -> None:
        mw = self._middleware(
            repos=[RepoScope("repo-a"), RepoScope("repo-b", ("svc",))]
        )
        schema = mw.tools[0].tool_call_schema.model_json_schema()
        self.assertEqual(schema["properties"]["repo"]["enum"], ["repo-a", "repo-b"])
        self.assertIn("repo", schema["required"])

    def test_repo_choice_routes_entry_and_component_is_checked_per_repo(self) -> None:
        mw = self._middleware(
            repos=[RepoScope("repo-a"), RepoScope("repo-b", ("svc",))]
        )
        memory = importlib.import_module("harness.memory")
        frozen = MagicMock(wraps=datetime)
        frozen.now.return_value = datetime(2026, 10, 6, 9, 14, 3, tzinfo=UTC)
        with (
            patch.object(memory, "iso_now", return_value="2026-10-06T09:14:03Z"),
            patch.object(memory, "datetime", frozen),
        ):
            result = mw.tools[0].invoke({
                "type": "note",
                "text": "Fact.",
                "repo": "repo-b",
                "component": "svc",
            })
        self.assertIn("component svc", result)
        self.assertEqual(
            (self.memory_dir / "repo-b" / "svc" / "implementation.md").read_text(
                encoding="utf-8"
            ),
            "# Memory — repo-b · implementation\n"
            "\n"
            "**Task key:** ABC-102\n"
            "**Created:** 2026-10-06T09:14:03Z\n"
            "\n"
            "> Append-only. Each entry must be self-contained — the distillation\n"
            "> subagent does NOT read source code to expand context. Be explicit.\n"
            "\n"
            "---\n"
            "### note  [09:14:03]\n"
            "\n"
            "Fact.\n"
            "\n"
            "---\n",
        )
        result = mw.tools[0].invoke({
            "type": "note",
            "text": "Fact.",
            "repo": "repo-a",
            "component": "svc",
        })
        self.assertIn("repo-wide", result)

    def test_invalid_repo_is_a_tool_error(self) -> None:
        mw = self._middleware(repos=[RepoScope("repo-a"), RepoScope("repo-b")])
        message = mw.tools[0].run(
            {"type": "note", "text": "x", "repo": "nope"}, tool_call_id="c1"
        )
        self.assertIn("repo", str(message.content))
        self.assertEqual(message.status, "error")

    def test_blank_text_is_a_validation_error_and_writes_nothing(self) -> None:
        message = (
            self
            ._middleware()
            .tools[0]
            .run({"type": "note", "text": "   "}, tool_call_id="c2")
        )
        self.assertEqual(message.status, "error")
        self.assertEqual(message.content, "invalid arguments: text: must not be blank")
        self.assertFalse(self.memory_dir.exists() and any(self.memory_dir.rglob("*.*")))

    def test_schemas_are_strict_compatible(self) -> None:
        assert_strict_compatible(self, self._middleware().tools[0])
        mw = self._middleware(repos=[RepoScope("repo-a"), RepoScope("repo-b")])
        assert_strict_compatible(self, mw.tools[0])

    def test_heartbeat_goes_to_target_in_todays_format_without_label(self) -> None:
        mw = self._middleware(events=self._round_events())
        mw.tools[0].invoke({
            "type": "decision",
            "text": "Chose X.",
            "context": "Because Y.",
        })
        event = self._events()[0]
        self.assertEqual(event["type"], "agent_thought")
        self.assertEqual(event["target_id"], "t-1")
        self.assertNotIn("identifier", event)
        self.assertEqual(
            event["body"],
            memory_heartbeat_body(
                entry_type="decision",
                stage="implementation",
                repo="repo-a",
                text="Chose X.",
                context="Because Y.",
                component=None,
            ),
        )

    def test_heartbeat_includes_matched_component_and_drops_other_context(self) -> None:
        mw = self._middleware(events=self._round_events())
        mw.tools[0].invoke({
            "type": "pattern",
            "text": "Shared helper.",
            "context": "must not be emitted",
            "component": "services/api/",
        })
        body = self._events()[0]["body"]
        self.assertIn("`services/api`", body)
        self.assertNotIn("must not be emitted", body)

    def test_heartbeat_failure_does_not_fail_the_write(self) -> None:
        events = self._round_events()
        mw = self._middleware(events=events)
        with patch("harness.events.append_event", side_effect=OSError("locked")):
            result = mw.tools[0].invoke({"type": "note", "text": "Fact."})
        self.assertIn("memory recorded", result)
        self.assertEqual(self._events(), [])

    def test_no_heartbeat_without_events(self) -> None:
        result = self._middleware().tools[0].invoke({"type": "note", "text": "Fact."})
        self.assertIn("memory recorded", result)
        self.assertEqual(self._events(), [])

    def test_storage_failure_is_a_tool_error_without_heartbeat(self) -> None:
        store = MagicMock()
        store.append.side_effect = PermissionError("memory directory is not writable")
        mw = MemoryWritingMiddleware(
            store=store,
            stage="implementation",
            repos=[RepoScope("repo-a")],
            events=self._round_events(),
        )
        message = mw.tools[0].run(
            {"type": "note", "text": "Durable fact."}, tool_call_id="c4"
        )
        self.assertEqual(message.status, "error")
        self.assertEqual(
            message.content, "PermissionError: memory directory is not writable"
        )
        self.assertEqual(self._events(), [])

    def test_rejected_write_does_not_emit_heartbeat(self) -> None:
        mw = self._middleware(events=self._round_events())
        mw.tools[0].run({"type": "note", "text": "  "}, tool_call_id="c3")
        self.assertEqual(self._events(), [])

    def test_type_field_describes_every_entry_type(self) -> None:
        schema = self._middleware().tools[0].tool_call_schema.model_json_schema()
        description = schema["properties"]["type"]["description"]
        for entry_type in (
            "note",
            "decision",
            "feedback",
            "question",
            "mistake",
            "pattern",
            "concern",
        ):
            self.assertIn(entry_type, description)


class TestMemoryWritingMiddlewareInstructions(unittest.TestCase):
    def test_instructions_are_policy_only(self) -> None:
        self.assertIn("record_memory", MEMORY_INSTRUCTIONS)
        self.assertIn("without reading", MEMORY_INSTRUCTIONS)
        for absent in ("harness memory", "heredoc", "autonomous", "--add"):
            self.assertNotIn(absent, MEMORY_INSTRUCTIONS)

    def _request(self) -> ModelRequest:
        return ModelRequest(
            model=object(),
            messages=[],
            system_message=SystemMessage(content="base prompt"),
        )

    def _build(self, **kwargs) -> MemoryWritingMiddleware:
        return MemoryWritingMiddleware(
            store=MagicMock(),
            stage="implementation",
            repos=[RepoScope("repo-a", ("services/api",))],
            **kwargs,
        )

    def test_instructions_are_appended_by_default_and_tool_is_registered(self) -> None:
        mw = self._build()
        seen: dict[str, ModelRequest] = {}

        def handler(request: ModelRequest) -> ModelResponse:
            seen["request"] = request
            return ModelResponse(result=[AIMessage(content="ok")])

        mw.wrap_model_call(self._request(), handler)

        self.assertEqual([tool.name for tool in mw.tools], ["record_memory"])
        system_text = seen["request"].system_message.text
        self.assertIn("base prompt", system_text)
        self.assertIn(MEMORY_INSTRUCTIONS.strip(), system_text)

    def test_system_prompt_none_suppresses_text_only(self) -> None:
        mw = self._build(system_prompt=None)
        original = self._request()
        seen: dict[str, ModelRequest] = {}

        def handler(request: ModelRequest) -> ModelResponse:
            seen["request"] = request
            return ModelResponse(result=[AIMessage(content="ok")])

        mw.wrap_model_call(original, handler)

        self.assertEqual([tool.name for tool in mw.tools], ["record_memory"])
        self.assertIs(seen["request"], original)


if __name__ == "__main__":
    unittest.main()
