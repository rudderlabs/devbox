"""Unit tests for deepagents.agents.implementation.ImplementationAgent.

DeepAgentSession construction is patched so no model/LLM/checkpointer is needed.
Tests verify the preset arguments while inherited session behavior is covered by
the DeepAgentSession test module.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from langchain_core.language_models import BaseChatModel

from harness.deepagents.agents.implementation import (
    AUTONOMOUS_DECISIONS_PROMPT,
    IMPLEMENTATION_SYSTEM_PROMPT,
    ImplementationAgent,
)
from harness.deepagents.middleware.memory_writing import (
    MEMORY_INSTRUCTIONS,
    RepoScope,
)
from harness.deepagents.session import DeepAgentSession


def _model() -> MagicMock:
    return MagicMock(spec=BaseChatModel)


class TestConstruction(unittest.TestCase):
    def test_is_deep_agent_session_subclass(self) -> None:
        self.assertTrue(issubclass(ImplementationAgent, DeepAgentSession))

    @patch("harness.deepagents.middleware.repo.MemoryWritingMiddleware")
    @patch("harness.deepagents.middleware.repo.build_skills_middleware")
    @patch("harness.deepagents.middleware.repo.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_builds_session_with_implementation_preset(
        self, mock_init, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        mock_knowledge.return_value = None
        mock_skills.return_value = None
        memory_mw = object()
        mock_memory.return_value = memory_mw
        model = _model()
        mw = [object()]
        ImplementationAgent(
            model=model,
            repo_path=Path("/workspace/my-service"),
            thread_id="t1",
            durable=False,
            middleware=mw,
            events=None,
        )
        mock_init.assert_called_once()
        kwargs = mock_init.call_args.kwargs
        self.assertIs(kwargs["model"], model)
        self.assertEqual(kwargs["workspace_dir"], Path("/workspace/my-service"))
        self.assertEqual(kwargs["thread_id"], "t1")
        self.assertEqual(kwargs["system_prompt"], IMPLEMENTATION_SYSTEM_PROMPT)
        self.assertEqual(kwargs["middleware"], [memory_mw, mw[0]])
        _kw = mock_memory.call_args.kwargs
        self.assertEqual(mock_memory.call_count, 1)
        self.assertEqual(_kw["stage"], "implementation")
        self.assertEqual(_kw["repos"], [RepoScope("my-service", ())])
        self.assertEqual(kwargs["emit_identifier"], "my-service/implementation")
        self.assertFalse(kwargs["durable"])
        self.assertIsNone(kwargs["response_format"])

    @patch("harness.deepagents.middleware.repo.MemoryWritingMiddleware")
    @patch("harness.deepagents.middleware.repo.build_skills_middleware")
    @patch("harness.deepagents.middleware.repo.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_emit_identifier_uses_explicit_repo_and_stage(
        self, mock_init, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        mock_knowledge.return_value = None
        mock_skills.return_value = None
        mock_memory.return_value = object()
        ImplementationAgent(
            model=_model(),
            repo_path=Path("/workspace/checkout-dir"),
            thread_id="t1",
            durable=False,
            repo="repo-slug",
            knowledge_subpaths=["./services/api/", "libs/core"],
            events=None,
        )
        _kw = mock_memory.call_args.kwargs
        self.assertEqual(mock_memory.call_count, 1)
        self.assertEqual(_kw["stage"], "implementation")
        self.assertEqual(
            _kw["repos"],
            [RepoScope("repo-slug", ("./services/api/", "libs/core"))],
        )
        self.assertEqual(
            mock_init.call_args.kwargs["emit_identifier"], "repo-slug/implementation"
        )

    @patch("harness.deepagents.middleware.repo.MemoryWritingMiddleware")
    @patch("harness.deepagents.middleware.repo.build_skills_middleware")
    @patch("harness.deepagents.middleware.repo.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_emit_identifier_uses_custom_stage(
        self, mock_init, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        mock_knowledge.return_value = None
        mock_skills.return_value = None
        mock_memory.return_value = object()
        ImplementationAgent(
            model=_model(),
            repo_path=Path("/workspace/my-service"),
            thread_id="t1",
            durable=False,
            stage="custom-stage",
            events=None,
        )
        self.assertEqual(
            mock_init.call_args.kwargs["emit_identifier"], "my-service/custom-stage"
        )

    @patch("harness.deepagents.middleware.repo.MemoryWritingMiddleware")
    @patch("harness.deepagents.middleware.repo.build_skills_middleware")
    @patch("harness.deepagents.middleware.repo.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_passes_response_format_when_provided(
        self, mock_init, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        mock_knowledge.return_value = None
        mock_skills.return_value = None
        mock_memory.return_value = object()
        response_format = object()
        ImplementationAgent(
            model=_model(),
            repo_path=Path("/workspace/my-service"),
            thread_id="t1",
            durable=False,
            response_format=response_format,
            events=None,
        )
        self.assertIs(mock_init.call_args.kwargs["response_format"], response_format)


class TestKnowledgeWiring(unittest.TestCase):
    @patch("harness.deepagents.middleware.repo.MemoryWritingMiddleware")
    @patch("harness.deepagents.middleware.repo.build_skills_middleware")
    @patch("harness.deepagents.middleware.repo.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_knowledge_and_skills_middleware_prepend_caller_middleware(
        self, mock_init, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        knowledge_mw = object()
        skills_mw = object()
        memory_mw = object()
        mock_knowledge.return_value = knowledge_mw
        mock_skills.return_value = skills_mw
        mock_memory.return_value = memory_mw
        caller_mw = [object()]
        shared_skills = Path("/workspace/shared-skills/skills")
        with patch(
            "harness.deepagents.middleware.repo.SHARED_SKILLS_DIR",
            shared_skills,
        ):
            ImplementationAgent(
                model=_model(),
                repo_path=Path("/workspace/mono"),
                thread_id="t1",
                durable=False,
                middleware=caller_mw,
                knowledge_subpaths=["acme-api"],
                events=None,
            )
        scope_dirs = [
            Path("/workspace/mono"),
            Path("/workspace/mono/acme-api"),
        ]
        mock_knowledge.assert_called_once_with(scope_dirs)
        mock_skills.assert_called_once_with([shared_skills, *scope_dirs])
        _kw = mock_memory.call_args.kwargs
        self.assertEqual(mock_memory.call_count, 1)
        self.assertEqual(_kw["stage"], "implementation")
        self.assertEqual(_kw["repos"], [RepoScope("mono", ("acme-api",))])
        passed = mock_init.call_args.kwargs["middleware"]
        self.assertEqual(passed, [knowledge_mw, skills_mw, memory_mw, caller_mw[0]])
        self.assertEqual(
            mock_init.call_args.kwargs["emit_identifier"], "mono/implementation"
        )

    @patch("harness.deepagents.middleware.repo.MemoryWritingMiddleware")
    @patch("harness.deepagents.middleware.repo.build_skills_middleware")
    @patch("harness.deepagents.middleware.repo.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_no_builtin_middleware_leaves_caller_middleware_unchanged(
        self, mock_init, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        mock_knowledge.return_value = None
        mock_skills.return_value = None
        memory_mw = object()
        mock_memory.return_value = memory_mw
        caller_mw = [object()]
        ImplementationAgent(
            model=_model(),
            repo_path=Path("/r"),
            thread_id="t",
            durable=False,
            middleware=caller_mw,
            events=None,
        )
        self.assertEqual(
            mock_init.call_args.kwargs["middleware"], [memory_mw, caller_mw[0]]
        )

    @patch("harness.deepagents.middleware.repo.MemoryWritingMiddleware")
    @patch("harness.deepagents.middleware.repo.build_skills_middleware")
    @patch("harness.deepagents.middleware.repo.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_skips_none_builders_independently(
        self, mock_init, mock_knowledge, mock_skills, mock_memory
    ) -> None:
        skills_mw = object()
        memory_mw = object()
        mock_knowledge.return_value = None
        mock_skills.return_value = skills_mw
        mock_memory.return_value = memory_mw
        ImplementationAgent(
            model=_model(),
            repo_path=Path("/r"),
            thread_id="t",
            durable=False,
            events=None,
        )
        self.assertEqual(
            mock_init.call_args.kwargs["middleware"], [skills_mw, memory_mw]
        )


class TestSystemPrompt(unittest.TestCase):
    def test_prompt_keeps_discipline_without_read_instruction(self) -> None:
        # Knowledge is now injected deterministically by the memory middleware,
        # so the prompt must NOT tell the agent to read the instruction files.
        lowered = IMPLEMENTATION_SYSTEM_PROMPT.lower()
        self.assertNotIn("agents.md", lowered)
        self.assertNotIn("claude.md", lowered)
        # The implement-then-validate discipline and brief convention remain.
        self.assertIn("validate", lowered)
        self.assertIn("<task>", IMPLEMENTATION_SYSTEM_PROMPT)

    def test_prompt_carries_repository_knowledge_directive(self) -> None:
        # The per-agent policy for acting on repository knowledge (moved off the
        # neutral knowledge middleware) lives in the implementer's own prompt.
        lowered = IMPLEMENTATION_SYSTEM_PROMPT.lower()
        self.assertIn("follow its conventions", lowered)
        self.assertIn("verify against the actual code", lowered)

    def test_prompt_instructs_worker_output_and_publish_boundaries(self) -> None:
        prompt = IMPLEMENTATION_SYSTEM_PROMPT
        lowered = prompt.lower()
        self.assertIn("exercise_hint", prompt)
        self.assertIn("n/a — no runtime surface", prompt)
        self.assertIn("feature_baseline", prompt)
        self.assertIn("n/a — net-new feature", prompt)
        self.assertIn(".github/PULL_REQUEST_TEMPLATE.md", prompt)
        self.assertIn(".github/pull_request_template.md", prompt)
        self.assertIn("docs/pull_request_template.md", prompt)
        self.assertIn("conventional-commit style", lowered)
        self.assertIn("do not push branches", lowered)
        self.assertIn("create pull requests", lowered)
        self.assertIn("perform any publish action", lowered)
        self.assertIn("## ⚠️ Known Issues", prompt)
        self.assertIn("already failing on the baseline", lowered)
        self.assertIn("do not start the repository's own `docker compose`", lowered)


class TestAutonomousDecisionsPrompt(unittest.TestCase):
    def test_autonomous_rule_lives_in_implementation_prompt_only(self) -> None:
        self.assertIn(AUTONOMOUS_DECISIONS_PROMPT, IMPLEMENTATION_SYSTEM_PROMPT)
        self.assertNotIn(AUTONOMOUS_DECISIONS_PROMPT, MEMORY_INSTRUCTIONS)
        self.assertIn("<autonomous_decision_making>", AUTONOMOUS_DECISIONS_PROMPT)


class TestImplementationPresetProgress(unittest.TestCase):
    def _label(self, knowledge_subpaths: tuple[str, ...]) -> str | None:
        from tests.progress_support import attached_progress

        return attached_progress(
            self,
            lambda model, events, tmp: ImplementationAgent(
                model=model,
                repo_path=tmp,
                thread_id=f"implementation-progress-{len(knowledge_subpaths)}",
                durable=False,
                knowledge_subpaths=knowledge_subpaths,
                repo="repo-a",
                events=events,
            ),
        ).worker_label

    def test_progress_worker_label_is_repo_stage_without_components(self) -> None:
        self.assertEqual(self._label(()), "repo-a/implementation")

    def test_progress_worker_label_is_repo_stage_with_components(self) -> None:
        self.assertEqual(self._label(("api", "web")), "repo-a/implementation")


class TestMemoryHeartbeatWiring(unittest.TestCase):
    @patch("harness.deepagents.middleware.repo.build_skills_middleware")
    @patch("harness.deepagents.middleware.repo.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_events_reach_memory_middleware(
        self, mock_init, mock_knowledge, mock_skills
    ) -> None:
        mock_knowledge.return_value = None
        mock_skills.return_value = None
        events = MagicMock()
        ImplementationAgent(
            model=_model(),
            repo_path=Path("/r"),
            thread_id="t",
            durable=False,
            events=events,
        )
        (memory_mw,) = mock_init.call_args.kwargs["middleware"]
        self.assertIs(memory_mw.events, events)


if __name__ == "__main__":
    unittest.main()
