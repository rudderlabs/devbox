"""Unit tests for deepagents.agents.distillation.DistillationAgent."""

from __future__ import annotations

import functools
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, SystemMessage

from harness.deepagents.agents.distillation import (
    DistillationAgent,
    distillation_system_prompt,
)
from harness.deepagents.file_logging import setup_session_file_logging
from harness.deepagents.middleware.system_prompt import (
    EMIT_VOICE_RULES,
    SystemPromptMiddleware,
)
from harness.deepagents.session import DeepAgentSession
from harness.events import RoundEvents

DEFAULT_PROMPT = distillation_system_prompt(Path(".agents/knowledge"))


def _model() -> MagicMock:
    return MagicMock(spec=BaseChatModel)


class TestConstruction(unittest.TestCase):
    def test_is_deep_agent_session_subclass(self) -> None:
        self.assertTrue(issubclass(DistillationAgent, DeepAgentSession))

    @patch("harness.deepagents.agents.distillation.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_builds_session_with_distillation_preset(
        self, mock_init, mock_knowledge
    ) -> None:
        mock_knowledge.return_value = None
        model = _model()
        mw = [object()]
        repos = [Path("/workspace/repo-a"), Path("/workspace/repo-b")]
        DistillationAgent(
            model=model,
            workspace_dir=Path("/workspace"),
            thread_id="distillation:run-1",
            repo_path=repos[0],
            middleware=mw,
            events=None,
        )
        mock_knowledge.assert_called_once_with([repos[0]])
        mock_init.assert_called_once()
        kwargs = mock_init.call_args.kwargs
        self.assertIs(kwargs["model"], model)
        self.assertEqual(kwargs["workspace_dir"], Path("/workspace"))
        self.assertEqual(kwargs["thread_id"], "distillation:run-1")
        self.assertEqual(kwargs["system_prompt"], DEFAULT_PROMPT)
        self.assertEqual(kwargs["middleware"], mw)
        self.assertNotIn("tools", kwargs)
        self.assertFalse(kwargs["durable"])
        self.assertIsNone(kwargs["response_format"])

    @patch("harness.deepagents.agents.distillation.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_passes_response_format_when_provided(
        self, mock_init, mock_knowledge
    ) -> None:
        mock_knowledge.return_value = None
        response_format = object()
        DistillationAgent(
            model=_model(),
            workspace_dir=Path("/workspace"),
            thread_id="distillation:run-1",
            repo_path=Path("/workspace/repo-a"),
            response_format=response_format,
            events=None,
        )
        self.assertIs(mock_init.call_args.kwargs["response_format"], response_format)

    @patch("harness.deepagents.agents.distillation.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_builds_knowledge_scope_with_component_subpaths(
        self, _mock_init, mock_knowledge
    ) -> None:
        mock_knowledge.return_value = None
        repo = Path("/workspace/mono")
        DistillationAgent(
            model=_model(),
            workspace_dir=Path("/workspace"),
            thread_id="distillation:run-1",
            repo_path=repo,
            knowledge_subpaths=["services/api", "libs/core"],
            events=None,
        )
        mock_knowledge.assert_called_once_with([
            repo,
            repo / "services/api",
            repo / "libs/core",
        ])


class TestKnowledgeWiring(unittest.TestCase):
    @patch("harness.deepagents.agents.distillation.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_knowledge_middleware_prepend_caller_middleware(
        self, mock_init, mock_knowledge
    ) -> None:
        knowledge_mw = object()
        mock_knowledge.return_value = knowledge_mw
        caller_mw = [object()]
        repos = [Path("/workspace/repo-a"), Path("/workspace/repo-b")]
        DistillationAgent(
            model=_model(),
            workspace_dir=Path("/workspace"),
            thread_id="distillation:run-1",
            repo_path=repos[0],
            middleware=caller_mw,
            events=None,
        )
        mock_knowledge.assert_called_once_with([repos[0]])
        self.assertEqual(
            mock_init.call_args.kwargs["middleware"], [knowledge_mw, caller_mw[0]]
        )

    @patch("harness.deepagents.agents.distillation.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_no_builtin_middleware_leaves_caller_middleware_unchanged(
        self, mock_init, mock_knowledge
    ) -> None:
        mock_knowledge.return_value = None
        caller_mw = [object()]
        DistillationAgent(
            model=_model(),
            workspace_dir=Path("/workspace"),
            thread_id="distillation:run-1",
            repo_path=Path("/workspace/repo-a"),
            middleware=caller_mw,
            events=None,
        )
        self.assertEqual(mock_init.call_args.kwargs["middleware"], caller_mw)

    @patch("harness.deepagents.agents.distillation.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_no_middleware_passes_none_when_no_callers(
        self, mock_init, mock_knowledge
    ) -> None:
        mock_knowledge.return_value = None
        DistillationAgent(
            model=_model(),
            workspace_dir=Path("/workspace"),
            thread_id="distillation:run-1",
            repo_path=Path("/workspace/repo-a"),
            events=None,
        )
        self.assertIsNone(mock_init.call_args.kwargs["middleware"])


class TestSystemPrompt(unittest.TestCase):
    @patch("harness.deepagents.agents.distillation.build_knowledge_middleware")
    @patch.object(DeepAgentSession, "__init__", return_value=None)
    def test_env_knowledge_dir_is_used_by_direct_construction(
        self, mock_init, mock_knowledge
    ) -> None:
        mock_knowledge.return_value = None
        with patch.dict(
            os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": ".devbox/knowledge"}, clear=False
        ):
            DistillationAgent(
                model=_model(),
                workspace_dir=Path("/workspace"),
                thread_id="distillation:run-1",
                repo_path=Path("/workspace/repo-a"),
                events=None,
            )

        mock_knowledge.assert_called_once_with([Path("/workspace/repo-a")])
        self.assertIn(
            "repository-root `.devbox/knowledge/*.md`",
            mock_init.call_args.kwargs["system_prompt"],
        )

    def test_prompt_has_distillation_guardrails(self) -> None:
        lowered = DEFAULT_PROMPT.lower()
        self.assertIn("fresh, standalone session", lowered)
        self.assertNotIn("deepagents", lowered)
        self.assertIn("read only the staged memory files", lowered)
        self.assertIn("never read repository source files", lowered)
        self.assertIn("never run tests", lowered)
        self.assertIn("never run", lowered)
        self.assertIn("verification", lowered)
        self.assertIn("feedback.md", lowered)
        self.assertIn("append a new", lowered)
        self.assertIn("only when that task has no section", lowered)
        self.assertIn("merge into the existing `## <task-id>` section", lowered)
        self.assertIn("avoid restating observations already captured there", lowered)
        self.assertIn("other tasks' knowledge content", lowered)
        self.assertIn("choose the destination directory by scope", lowered)
        self.assertIn("specific to a", lowered)
        self.assertIn("component subpath", lowered)
        self.assertIn("repository-root `.agents/knowledge/*.md`", lowered)
        self.assertIn("`feedback` entries promote to `feedback.md`", lowered)
        self.assertIn("ci-fix memory", lowered)
        self.assertIn("promote to `mistakes.md`", lowered)
        self.assertIn("`concern` entries promote to `concerns.md`", lowered)
        self.assertIn("`pattern` entries promote to `patterns.md`", lowered)
        self.assertIn("`decision` and `note` entries route by content", lowered)
        self.assertIn("without creating duplicate\n   same-task sections", lowered)
        self.assertIn("response_summary", lowered)
        self.assertIn("bullet lines for the user", lowered)
        self.assertIn("destination knowledge type", lowered)
        self.assertIn("`patterns`: captured", lowered)
        self.assertNotIn("record_memory", lowered)
        self.assertNotIn("structured result", lowered)
        self.assertNotIn("harness will persist it", lowered)
        self.assertNotIn("distillation.json", lowered)
        self.assertNotIn("subagent", lowered)


class TestDistillationPresetProgress(unittest.TestCase):
    def test_distillation_progress_has_no_worker_label(self) -> None:
        from tests.progress_support import attached_progress

        progress = attached_progress(
            self,
            lambda model, events, tmp: DistillationAgent(
                model=model,
                workspace_dir=tmp,
                thread_id="distillation-progress",
                repo_path=tmp,
                events=events,
            ),
        )
        self.assertIsNone(progress.worker_label)

    def test_voice_rules_only_inside_progress_section(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            events = RoundEvents(
                events_file=tmp / "events.jsonl",
                events_lock=tmp / "events.lock",
                inbox_id="inbox-1",
                target_id="t",
            )
            with (
                patch("harness.deepagents.session.create_deep_agent") as create,
                patch(
                    "harness.deepagents.session.setup_session_file_logging",
                    side_effect=lambda thread_id: setup_session_file_logging(
                        thread_id, tmp / "logs"
                    ),
                ),
            ):
                agent = DistillationAgent(
                    model=_model(),
                    workspace_dir=tmp,
                    thread_id="distillation-voice",
                    repo_path=tmp,
                    events=events,
                )
                try:
                    kwargs = create.call_args.kwargs
                finally:
                    agent.close()

        seen: list[ModelRequest] = []

        def handler(request: ModelRequest) -> ModelResponse:
            seen.append(request)
            return ModelResponse(result=[AIMessage(content="ok")])

        chain = handler
        for mw in reversed(kwargs["middleware"]):
            if isinstance(mw, SystemPromptMiddleware):
                chain = functools.partial(mw.wrap_model_call, handler=chain)
        chain(
            ModelRequest(
                model=object(),
                messages=[],
                system_message=SystemMessage(content=kwargs["system_prompt"]),
            )
        )

        text = seen[0].system_message.text
        self.assertIn(DEFAULT_PROMPT, text)
        self.assertNotIn("single_bot_voice", text)
        start = text.index("<progress_updates>")
        end = text.index("</progress_updates>") + len("</progress_updates>")
        self.assertIn(EMIT_VOICE_RULES, text[start:end])
        outside = text[:start] + text[end:]
        self.assertNotIn(EMIT_VOICE_RULES, outside)
        for rule in EMIT_VOICE_RULES.splitlines():
            if rule.startswith("- "):
                self.assertNotIn(rule, outside)


if __name__ == "__main__":
    unittest.main()
