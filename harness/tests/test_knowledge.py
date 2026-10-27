"""Unit tests for deepagents.middleware.knowledge.discover_knowledge_sources."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from deepagents import MemoryMiddleware

from harness.deepagents.middleware.knowledge import (
    REPO_KNOWLEDGE_PROMPT,
    build_knowledge_middleware,
    discover_knowledge_sources,
)


class TestDiscoverKnowledgeSources(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        # Resolve so expectations match the implementation's resolve() output
        # (on macOS the temp dir is a /var -> /private/var symlink).
        self.root = Path(self._tmp.name).resolve()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, rel: str, text: str = "x") -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_root_only_order_agents_claude_then_sorted_knowledge(self) -> None:
        self._write("AGENTS.md")
        self._write("CLAUDE.md")
        self._write(".agents/knowledge/stack.md")
        self._write(".agents/knowledge/architecture.md")

        result = discover_knowledge_sources([self.root])

        self.assertEqual(
            result,
            [
                str(self.root / "AGENTS.md"),
                str(self.root / "CLAUDE.md"),
                str(self.root / ".agents/knowledge/architecture.md"),
                str(self.root / ".agents/knowledge/stack.md"),
            ],
        )

    def test_missing_root_files_are_skipped(self) -> None:
        self._write("AGENTS.md")  # no CLAUDE.md, no .agents/knowledge

        result = discover_knowledge_sources([self.root])

        self.assertEqual(result, [str(self.root / "AGENTS.md")])

    def test_only_md_files_top_level_in_knowledge(self) -> None:
        self._write(".agents/knowledge/patterns.md")
        self._write(".agents/knowledge/notes.txt")
        self._write(".agents/knowledge/nested/deep.md")

        result = discover_knowledge_sources([self.root])

        self.assertEqual(result, [str(self.root / ".agents/knowledge/patterns.md")])

    def test_directories_scanned_in_caller_order(self) -> None:
        self._write("AGENTS.md")
        self._write("acme-api/AGENTS.md")
        self._write("acme-api/.agents/knowledge/conventions.md")
        self._write("acme-core/CLAUDE.md")

        result = discover_knowledge_sources([
            self.root,
            self.root / "acme-api",
            self.root / "acme-core",
        ])

        self.assertEqual(
            result,
            [
                str(self.root / "AGENTS.md"),
                str(self.root / "acme-api/AGENTS.md"),
                str(self.root / "acme-api/.agents/knowledge/conventions.md"),
                str(self.root / "acme-core/CLAUDE.md"),
            ],
        )

    def test_custom_knowledge_directory_applies_to_root_and_components(self) -> None:
        self._write("AGENTS.md")
        self._write(".devbox/knowledge/patterns.md")
        self._write("acme-api/.devbox/knowledge/conventions.md")
        with patch.dict(
            os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": ".devbox/knowledge"}, clear=False
        ):
            result = discover_knowledge_sources([self.root, self.root / "acme-api"])

        self.assertEqual(
            result,
            [
                str(self.root / "AGENTS.md"),
                str(self.root / ".devbox/knowledge/patterns.md"),
                str(self.root / "acme-api/.devbox/knowledge/conventions.md"),
            ],
        )

    def test_knowledge_directory_symlinked_outside_repo_is_ignored(self) -> None:
        outside = self.root.parent / f"{self.root.name}-outside"
        outside.mkdir()
        (outside / "leaked.md").write_text("outside\n")
        self.addCleanup(shutil.rmtree, outside)
        (self.root / "linked-knowledge").symlink_to(outside, target_is_directory=True)
        self._write("AGENTS.md")

        with patch.dict(
            os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": "linked-knowledge"}, clear=False
        ):
            result = discover_knowledge_sources([self.root])

        self.assertEqual(result, [str(self.root / "AGENTS.md")])

    def test_component_knowledge_symlinked_inside_repo_is_followed_once(
        self,
    ) -> None:
        self._write(".agents/knowledge/shared.md")
        (self.root / "acme-api/.agents").mkdir(parents=True)
        (self.root / "acme-api/.agents/knowledge").symlink_to(
            self.root / ".agents/knowledge", target_is_directory=True
        )
        self._write("libs/notes/extra.md")
        (self.root / "acme-core/.agents").mkdir(parents=True)
        (self.root / "acme-core/.agents/knowledge").symlink_to(
            self.root / "libs/notes", target_is_directory=True
        )

        result = discover_knowledge_sources([
            self.root,
            self.root / "acme-api",
            self.root / "acme-core",
        ])

        self.assertEqual(
            result,
            [
                str(self.root / ".agents/knowledge/shared.md"),
                str(self.root / "libs/notes/extra.md"),
            ],
        )

    def test_component_knowledge_symlinked_outside_repo_is_ignored(self) -> None:
        outside = self.root.parent / f"{self.root.name}-outside"
        outside.mkdir()
        (outside / "leaked.md").write_text("outside\n")
        self.addCleanup(shutil.rmtree, outside)
        (self.root / "acme-api/.agents").mkdir(parents=True)
        (self.root / "acme-api/.agents/knowledge").symlink_to(
            outside, target_is_directory=True
        )
        self._write(".agents/knowledge/patterns.md")

        result = discover_knowledge_sources([self.root, self.root / "acme-api"])

        self.assertEqual(result, [str(self.root / ".agents/knowledge/patterns.md")])

    def test_knowledge_directory_symlinked_to_scope_root_is_ignored(self) -> None:
        (self.root / ".agents").mkdir()
        (self.root / ".agents/knowledge").symlink_to(
            self.root, target_is_directory=True
        )
        self._write("AGENTS.md")
        self._write("README.md")

        result = discover_knowledge_sources([self.root])

        self.assertEqual(result, [str(self.root / "AGENTS.md")])

    def test_nonexistent_directory_contributes_nothing(self) -> None:
        self._write("AGENTS.md")

        result = discover_knowledge_sources([self.root, self.root / "does-not-exist"])

        self.assertEqual(result, [str(self.root / "AGENTS.md")])

    def test_returns_empty_when_no_knowledge(self) -> None:
        result = discover_knowledge_sources([self.root])

        self.assertEqual(result, [])

    def test_returns_empty_for_no_directories(self) -> None:
        result = discover_knowledge_sources([])

        self.assertEqual(result, [])

    def test_paths_are_absolute(self) -> None:
        self._write("AGENTS.md")

        result = discover_knowledge_sources([self.root])

        self.assertTrue(all(Path(p).is_absolute() for p in result))


class TestRepoKnowledgePrompt(unittest.TestCase):
    def test_has_agent_memory_slot(self) -> None:
        self.assertIn("{agent_memory}", REPO_KNOWLEDGE_PROMPT)

    def test_omits_self_editing_guidance(self) -> None:
        # Must not carry the default wrapper's learn-and-persist guidance.
        # (The "{agent_memory}" slot legitimately contains "memory", so assert
        # against the specific self-editing phrases instead.)
        lowered = REPO_KNOWLEDGE_PROMPT.lower()
        self.assertNotIn("edit_file", lowered)
        self.assertNotIn("persist", lowered)
        self.assertNotIn("save new knowledge", lowered)

    def test_filters_repository_instructions_for_autonomous_mode(self) -> None:
        prompt = REPO_KNOWLEDGE_PROMPT
        self.assertIn("<autonomous_mode_filtering>", prompt)
        self.assertIn("FOLLOW repository guidance", prompt)
        self.assertIn("naming conventions", prompt)
        self.assertIn("design-system constraints", prompt)
        self.assertIn("quality-gate commands", prompt)
        self.assertIn("anti-patterns", prompt)
        self.assertIn("export rules", prompt)
        self.assertIn("component classification", prompt)
        self.assertIn("IGNORE repository guidance", prompt)
        self.assertIn("ADAPT repository guidance", prompt)
        self.assertIn("AskUserQuestion", prompt)
        self.assertIn("Do not create worktrees", prompt)
        self.assertIn("or switch branches", prompt)
        self.assertIn("your stage permits", prompt)
        self.assertIn("only when your stage allows edits", prompt)
        self.assertIn("checkout is already prepared", prompt)
        self.assertIn("higher-priority stage", prompt)


class TestBuildKnowledgeMiddleware(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, rel: str, text: str = "x") -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_returns_none_when_no_sources(self) -> None:
        self.assertIsNone(build_knowledge_middleware([self.root]))

    def test_returns_none_for_no_directories(self) -> None:
        self.assertIsNone(build_knowledge_middleware([]))

    def test_builds_middleware_with_discovered_sources_and_custom_prompt(self) -> None:
        self._write("AGENTS.md")
        self._write(".agents/knowledge/stack.md")

        mw = build_knowledge_middleware([self.root])

        self.assertIsInstance(mw, MemoryMiddleware)
        self.assertEqual(
            mw.sources,
            [
                str((self.root / "AGENTS.md").resolve()),
                str((self.root / ".agents/knowledge/stack.md").resolve()),
            ],
        )
        self.assertEqual(mw.system_prompt, REPO_KNOWLEDGE_PROMPT)


if __name__ == "__main__":
    unittest.main()
