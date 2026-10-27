"""Unit tests for deepagents.middleware.repo.build_repo_middleware."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.deepagents.middleware.memory_writing import (
    MEMORY_INSTRUCTIONS,
    MemoryWritingMiddleware,
    RepoScope,
)
from harness.deepagents.middleware.repo import build_repo_middleware
from harness.paths import SHARED_SKILLS_DIR

_MOD = "harness.deepagents.middleware.repo"


@patch(f"{_MOD}.MemoryWritingMiddleware")
@patch(f"{_MOD}.build_skills_middleware")
@patch(f"{_MOD}.build_knowledge_middleware")
class TestBuildRepoMiddleware(unittest.TestCase):
    def test_orders_knowledge_skills_memory_then_extra(
        self, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        knowledge, skills, memory, extra = object(), object(), object(), object()
        mock_knowledge.return_value = knowledge
        mock_skills.return_value = skills
        mock_memory.return_value = memory
        stack = build_repo_middleware(
            repo_path=Path("/w/mono"),
            repo="mono",
            knowledge_subpaths=("acme-api",),
            memory_stage="implementation",
            extra=[extra],
        )
        self.assertEqual(stack, [knowledge, skills, memory, extra])
        scope_dirs = [Path("/w/mono"), Path("/w/mono/acme-api")]
        mock_knowledge.assert_called_once_with(scope_dirs)
        mock_skills.assert_called_once_with([SHARED_SKILLS_DIR, *scope_dirs])
        kwargs = mock_memory.call_args.kwargs
        self.assertEqual(kwargs["stage"], "implementation")
        self.assertEqual(kwargs["repos"], [RepoScope("mono", ("acme-api",))])

    def test_no_memory_stage_skips_memory_writer(
        self, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        mock_knowledge.return_value = None
        skills = object()
        mock_skills.return_value = skills
        stack = build_repo_middleware(repo_path=Path("/r"), repo="r")
        self.assertEqual(stack, [skills])
        mock_memory.assert_not_called()

    def test_empty_stack_is_none(
        self, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        mock_knowledge.return_value = None
        mock_skills.return_value = None
        self.assertIsNone(build_repo_middleware(repo_path=Path("/r"), repo="r"))
        self.assertIsNone(
            build_repo_middleware(repo_path=Path("/r"), repo="r", extra=[])
        )


class TestConfiguredKnowledgeDir(unittest.TestCase):
    @patch(f"{_MOD}.build_skills_middleware", return_value=None)
    def test_invalid_custom_knowledge_dir_fails_during_repo_middleware_build(
        self, _skills
    ) -> None:
        with (
            patch.dict(os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": "../knowledge"}),
            self.assertRaisesRegex(ValueError, "HARNESS_REPO_KNOWLEDGE_DIR"),
        ):
            build_repo_middleware(repo_path=Path("/r"), repo="r")


class TestMemoryWiring(unittest.TestCase):
    @patch(f"{_MOD}.build_skills_middleware", return_value=None)
    @patch(f"{_MOD}.build_knowledge_middleware", return_value=None)
    def test_memory_middleware_gets_scope_and_events(self, _knowledge, _skills) -> None:
        events = object()
        stack = build_repo_middleware(
            repo_path=Path("/r"),
            repo="r",
            knowledge_subpaths=["svc/api"],
            memory_stage="review-fix",
            events=events,  # type: ignore[arg-type]
        )
        (mw,) = stack
        self.assertIsInstance(mw, MemoryWritingMiddleware)
        self.assertEqual(mw.repos, [RepoScope("r", ("svc/api",))])
        self.assertIs(mw.events, events)
        self.assertEqual(mw.system_prompt, MEMORY_INSTRUCTIONS)

    def test_memory_store_parameter_is_gone(self) -> None:
        with self.assertRaises(TypeError):
            build_repo_middleware(  # type: ignore[call-arg]
                repo_path=Path("/r"), repo="r", memory_stage="s", memory=object()
            )

    @patch(f"{_MOD}.MemoryStore")
    @patch(f"{_MOD}.build_skills_middleware", return_value=None)
    @patch(f"{_MOD}.build_knowledge_middleware", return_value=None)
    def test_memory_middleware_writes_through_a_fresh_store(
        self, _knowledge, _skills, store_cls
    ) -> None:
        (mw,) = build_repo_middleware(
            repo_path=Path("/r"), repo="r", memory_stage="review-fix"
        )
        store_cls.assert_called_once_with()
        self.assertIs(mw.store, store_cls.return_value)


if __name__ == "__main__":
    unittest.main()
