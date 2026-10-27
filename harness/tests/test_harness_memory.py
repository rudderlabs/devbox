"""Tests for harness memory CLI and append format."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_harness_with_workspace(workspace: Path, module_name: str):
    env = {
        "WORKSPACE": str(workspace),
    }
    with patch.dict(os.environ, env, clear=False):
        for mod_name in (
            "harness.paths",
            "harness.util",
            "harness.memory",
            "harness.distillation",
            "harness.cli",
        ):
            sys.modules.pop(mod_name, None)
        path = REPO_ROOT / "src" / "harness" / "cli.py"
        spec = importlib.util.spec_from_file_location(module_name, path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = mod
        spec.loader.exec_module(mod)
        return mod


class TestHarnessMemory(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        (self.ws / ".harness").mkdir(parents=True)
        self.events_file = self.ws / ".harness" / "events.jsonl"
        self.events_lock = self.ws / ".harness" / "events.lock"
        (self.ws / ".harness" / "session.json").write_text(
            '{"task_key": "ABC-1234"}', encoding="utf-8"
        )
        self.h = _load_harness_with_workspace(self.ws, "harness_memory")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _memory_file(self, stage: str = "inspection") -> Path:
        return self.ws / ".harness" / "memory" / "config-backend" / f"{stage}.md"

    def _run_memory(self, args: list[str], text: str = "default memory text") -> int:
        with patch("sys.stdin", io.StringIO(text)):
            return self.h.main(args)

    def _event_env(self, target_ids: str = ",target-1,target-2") -> dict[str, str]:
        return {
            "DEVBOX_EVENTS_FILE": str(self.events_file),
            "DEVBOX_EVENTS_LOCK": str(self.events_lock),
            "DEVBOX_INBOX_ID": "inbox-1",
            "DEVBOX_TARGET_IDS": target_ids,
        }

    def _events(self) -> list[dict]:
        if not self.events_file.exists():
            return []
        return [
            json.loads(line)
            for line in self.events_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_single_note_has_expected_header_and_entry_shape(self) -> None:
        with patch(
            "sys.stdin",
            io.StringIO("Validator lives under internal/validators/source."),
        ):
            rc = self.h.main([
                "memory",
                "--add",
                "note",
                "--stage",
                "inspection",
                "--repo",
                "config-backend",
            ])
        self.assertEqual(rc, 0)

        body = self._memory_file().read_text(encoding="utf-8")
        self.assertEqual(body.count("# Memory — config-backend · inspection"), 1)
        self.assertEqual(
            body.count(
                "> Append-only. Each entry must be self-contained — the distillation"
            ),
            1,
        )
        self.assertEqual(
            len(re.findall(r"^### note  \[\d{2}:\d{2}:\d{2}\]$", body, re.MULTILINE)),
            1,
        )

    def test_two_appends_do_not_duplicate_header_and_separator_count_matches(
        self,
    ) -> None:
        args = [
            "memory",
            "--add",
            "note",
            "--stage",
            "inspection",
            "--repo",
            "config-backend",
        ]
        self.assertEqual(self._run_memory(args, "First durable note."), 0)
        self.assertEqual(self._run_memory(args, "Second durable note."), 0)

        body = self._memory_file().read_text(encoding="utf-8")
        self.assertEqual(body.count("# Memory"), 1)
        self.assertEqual(len(re.findall(r"^### ", body, re.MULTILINE)), 2)
        self.assertEqual(body.count("---"), 3)

    def test_decision_with_and_without_context(self) -> None:
        with_context_rc = self._run_memory(
            [
                "memory",
                "--add",
                "decision",
                "--stage",
                "inspection",
                "--repo",
                "config-backend",
                "--context",
                "v1 and v2 handlers both depend on these rules.",
            ],
            "Keep validators in shared package.",
        )
        self.assertEqual(with_context_rc, 0)
        body = self._memory_file().read_text(encoding="utf-8")
        self.assertIn("**Why:** v1 and v2 handlers both depend on these rules.", body)

        without_context_rc = self._run_memory(
            [
                "memory",
                "--add",
                "decision",
                "--stage",
                "inspection",
                "--repo",
                "config-backend",
            ],
            "Dispatch validators via type-tag map.",
        )
        self.assertEqual(without_context_rc, 0)
        body2 = self._memory_file().read_text(encoding="utf-8")
        self.assertEqual(body2.count("**Why:**"), 1)

    def test_feedback_allows_context_and_review_stage(self) -> None:
        rc = self._run_memory(
            [
                "memory",
                "--add",
                "feedback",
                "--stage",
                "review",
                "--repo",
                "config-backend",
                "--context",
                "reviewer wants this preserved",
            ],
            "Keep the config shape explicit.",
        )
        self.assertEqual(rc, 0)
        body = self._memory_file("review").read_text(encoding="utf-8")
        self.assertIn("### feedback", body)
        self.assertIn("**Why:** reviewer wants this preserved", body)

    def test_rejects_context_for_non_decision(self) -> None:
        rc = self._run_memory(
            [
                "memory",
                "--add",
                "note",
                "--stage",
                "inspection",
                "--repo",
                "config-backend",
                "--context",
                "invalid",
            ],
            "A note.",
        )
        self.assertNotEqual(rc, 0)

    def test_rejects_stage_with_path_separator(self) -> None:
        rc = self._run_memory(
            [
                "memory",
                "--add",
                "note",
                "--stage",
                "foo/bar",
                "--repo",
                "config-backend",
            ],
            "Bad stage.",
        )
        self.assertNotEqual(rc, 0)
        self.assertFalse((self.ws / ".harness" / "memory").exists())

    def test_main_memory_returns_exit_code(self) -> None:
        rc = self._run_memory(
            [
                "memory",
                "--add",
                "note",
                "--stage",
                "inspection",
                "--repo",
                "config-backend",
            ],
            "Check return code path.",
        )
        self.assertEqual(rc, 0)

    def test_text_stdin_writes_verbatim_multiline_content(self) -> None:
        body = (
            'line one with "quotes", `backticks`, $(echo nope), and colons: yes\n'
            "line two keeps trailing spaces   \n"
            "line three"
        )
        with patch("sys.stdin", io.StringIO(body)):
            rc = self.h.main([
                "memory",
                "--add",
                "note",
                "--stage",
                "inspection",
                "--repo",
                "config-backend",
            ])
        self.assertEqual(rc, 0)

        written = self._memory_file().read_text(encoding="utf-8")
        self.assertIn(
            'line one with "quotes", `backticks`, $(echo nope), and colons: yes',
            written,
        )
        self.assertIn("line two keeps trailing spaces", written)
        self.assertIn("line three", written)

    def test_rejects_unknown_legacy_text_flags(self) -> None:
        rc = self.h.main([
            "memory",
            "--add",
            "note",
            "--stage",
            "inspection",
            "--repo",
            "config-backend",
            "--text",
            "inline",
        ])
        self.assertNotEqual(rc, 0)

    def test_append_memory_entry_supports_component_scoped_files(self) -> None:
        memory = sys.modules["harness.memory"]

        path = memory.append_memory_entry(
            entry_type="note",
            stage="implementation",
            repo="config-backend",
            component="services/api",
            text="Component-scoped memory uses the same entry format.",
            context=None,
        )

        self.assertEqual(
            path,
            (
                self.ws
                / ".harness"
                / "memory"
                / "config-backend"
                / "services"
                / "api"
                / "implementation.md"
            ).resolve(),
        )
        body = path.read_text(encoding="utf-8")
        self.assertIn("# Memory — config-backend · implementation", body)
        self.assertIn("### note", body)

    def test_append_memory_entry_rejects_unsafe_component_paths(self) -> None:
        memory = sys.modules["harness.memory"]
        unsafe_values = ["", "   ", "../outside", "/absolute", "services\\api"]

        for value in unsafe_values:
            with self.subTest(component=value), self.assertRaises(ValueError):
                memory.append_memory_entry(
                    entry_type="note",
                    stage="implementation",
                    repo="config-backend",
                    component=value,
                    text="Unsafe component should not write.",
                    context=None,
                )

        self.assertFalse((self.ws / ".harness" / "memory").exists())

    def _cli(self, args: list[str], text: str) -> int:
        memory = sys.modules["harness.memory"]
        with patch("sys.stdin", io.StringIO(text)):
            return memory.memory_main(args)

    def test_memory_cli_emits_exact_decision_heartbeat(self) -> None:
        with patch.dict("os.environ", self._event_env(), clear=True):
            rc = self._cli(
                [
                    "--add",
                    "decision",
                    "--stage",
                    "Implementation Stage",
                    "--repo",
                    "Config Backend",
                    "--context",
                    "Reviewer asked for a visible progress heartbeat.",
                ],
                "Keep the retry budget at 2.\nDo not normalize this text.\n",
            )

        self.assertEqual(rc, 0)
        events = self._events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "agent_thought")
        self.assertEqual(events[0]["inbox_id"], "inbox-1")
        self.assertEqual(events[0]["target_id"], "target-1")
        self.assertEqual(
            events[0]["body"],
            "🧭 **decision** `Implementation Stage` `Config Backend`\n"
            "\n"
            "Keep the retry budget at 2.\nDo not normalize this text.\n"
            "\n"
            "\n"
            "**Why:** Reviewer asked for a visible progress heartbeat.",
        )

    def test_memory_heartbeat_body_includes_component_tag_when_passed(self) -> None:
        memory = sys.modules["harness.memory"]

        self.assertEqual(
            memory.memory_heartbeat_body(
                entry_type="note",
                stage="implementation",
                repo="config-backend",
                component="services/api",
                text="API component owns route registration.",
                context=None,
            ),
            "📝 **note** `implementation` `config-backend` `services/api`\n"
            "\n"
            "API component owns route registration.",
        )

    def test_memory_cli_heartbeat_omits_component_tag_and_why_for_pattern(
        self,
    ) -> None:
        with patch.dict("os.environ", self._event_env(), clear=True):
            self._cli(
                [
                    "--add",
                    "pattern",
                    "--stage",
                    "implementation",
                    "--repo",
                    "config-backend",
                ],
                "Retries wrap outbound calls in a shared helper.",
            )

        body = self._events()[0]["body"]
        self.assertEqual(
            body,
            "🧩 **pattern** `implementation` `config-backend`\n"
            "\n"
            "Retries wrap outbound calls in a shared helper.",
        )
        self.assertNotIn("**Why:**", body)

    def test_memory_heartbeat_body_includes_why_only_for_decision_and_feedback(
        self,
    ) -> None:
        memory = sys.modules["harness.memory"]

        feedback = memory.memory_heartbeat_body(
            entry_type="feedback",
            stage="review",
            repo="config-backend",
            text="Keep the config shape explicit.",
            context="reviewer wants this preserved",
            component=None,
        )
        note = memory.memory_heartbeat_body(
            entry_type="note",
            stage="review",
            repo="config-backend",
            text="Keep the config shape explicit.",
            context="ignored context",
            component=None,
        )

        self.assertIn("🧑 **feedback** `review` `config-backend`", feedback)
        self.assertIn("**Why:** reviewer wants this preserved", feedback)
        self.assertIn("📝 **note** `review` `config-backend`", note)
        self.assertNotIn("**Why:**", note)
        self.assertIn(
            "🧠 **future-type**",
            memory.memory_heartbeat_body(
                entry_type="future-type",
                stage="review",
                repo="config-backend",
                text="Fallback emoji stays safe.",
                context=None,
                component=None,
            ),
        )

    def test_memory_cli_missing_event_env_is_non_blocking(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            rc = self._cli(
                [
                    "--add",
                    "note",
                    "--stage",
                    "implementation",
                    "--repo",
                    "config-backend",
                ],
                "Memory still succeeds without round event env.",
            )

        self.assertEqual(rc, 0)
        self.assertTrue(self._memory_file("implementation").is_file())
        self.assertEqual(self._events(), [])

    def test_memory_cli_event_append_failure_is_non_blocking(self) -> None:
        with (
            patch.dict("os.environ", self._event_env(), clear=True),
            patch("harness.emit.append_event", side_effect=OSError("locked")),
        ):
            rc = self._cli(
                [
                    "--add",
                    "note",
                    "--stage",
                    "implementation",
                    "--repo",
                    "config-backend",
                ],
                "Memory still succeeds when heartbeat append fails.",
            )

        self.assertEqual(rc, 0)
        self.assertTrue(self._memory_file("implementation").is_file())
        self.assertEqual(self._events(), [])

    def test_append_memory_entry_validation_failure_does_not_emit_heartbeat(
        self,
    ) -> None:
        memory = sys.modules["harness.memory"]

        with (
            patch.dict("os.environ", self._event_env(), clear=True),
            patch("harness.emit.append_agent_thought") as append_agent_thought,
            self.assertRaises(ValueError),
        ):
            memory.append_memory_entry(
                entry_type="decision",
                stage="implementation",
                repo="config-backend",
                text="   ",
                context="No memory file should be written.",
            )

        append_agent_thought.assert_not_called()
        self.assertEqual(self._events(), [])

    def test_append_memory_entry_never_posts_heartbeat(self) -> None:
        memory = sys.modules["harness.memory"]

        with (
            patch.dict("os.environ", self._event_env(), clear=False),
            patch("harness.emit.append_agent_thought") as thought,
        ):
            memory.append_memory_entry(
                entry_type="note",
                stage="implementation",
                repo="r",
                text="t",
                context=None,
            )
        thought.assert_not_called()

    def test_memory_store_appends_without_heartbeat(self) -> None:
        memory = sys.modules["harness.memory"]

        frozen = MagicMock(wraps=datetime)
        frozen.now.return_value = datetime(2026, 10, 6, 9, 14, 3, tzinfo=UTC)
        with (
            patch("harness.emit.append_agent_thought") as thought,
            patch.object(memory, "iso_now", return_value="2026-10-06T09:14:03Z"),
            patch.object(memory, "datetime", frozen),
        ):
            path = memory.MemoryStore().append(
                entry_type="decision",
                stage="review",
                repo="r",
                text="Chose X.",
                context="Because Y.",
                component=None,
            )
        self.assertEqual(
            path.read_text(encoding="utf-8"),
            "# Memory — r · review\n"
            "\n"
            "**Task key:** ABC-1234\n"
            "**Created:** 2026-10-06T09:14:03Z\n"
            "\n"
            "> Append-only. Each entry must be self-contained — the distillation\n"
            "> subagent does NOT read source code to expand context. Be explicit.\n"
            "\n"
            "---\n"
            "### decision  [09:14:03]\n"
            "\n"
            "Chose X.\n"
            "\n"
            "**Why:** Because Y.\n"
            "\n"
            "---\n",
        )
        thought.assert_not_called()

    def test_memory_cli_emits_heartbeat_when_round_event_env_is_present(
        self,
    ) -> None:
        args = [
            "memory",
            "--add",
            "note",
            "--stage",
            "inspection",
            "--repo",
            "config-backend",
        ]

        with patch.dict(
            "os.environ", self._event_env(",target-a,target-b"), clear=True
        ):
            rc = self._run_memory(args, "CLI memory text.")

        self.assertEqual(rc, 0)
        events = self._events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["target_id"], "target-a")
        self.assertEqual(
            events[0]["body"],
            "📝 **note** `inspection` `config-backend`\n\nCLI memory text.",
        )


if __name__ == "__main__":
    unittest.main()
