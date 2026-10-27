"""Tests for DeepAgents planning preset wiring."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from langchain.agents.structured_output import ProviderStrategy

from harness.deepagents.middleware.logging import LoggingMiddleware
from harness.schemas import (
    OrientationOutput,
    PlanReviewOutput,
    RepoPlanOutput,
)


class TestPlanningAgentPresets(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.repo = self.workspace / "repo-a"
        self.repo.mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    @patch("harness.deepagents.agents.orientation.build_skills_middleware")
    @patch(
        "harness.deepagents.agents.orientation.DeepAgentSession.__init__",
        return_value=None,
    )
    def test_orientation_agent_uses_shared_skills_and_caller_middleware(
        self, init: MagicMock, skills: MagicMock
    ) -> None:
        from harness.deepagents.agents import orientation

        skills.return_value = "skills-mw"
        logging = LoggingMiddleware()

        orientation.OrientationAgent(
            model=MagicMock(),
            workspace_dir=self.workspace,
            thread_id="t",
            middleware=[logging],
            events=None,
        )

        self.assertEqual(init.call_args.kwargs["workspace_dir"], self.workspace)
        self.assertFalse(init.call_args.kwargs["durable"])
        self.assertFalse(init.call_args.kwargs["in_memory"])
        response_format = init.call_args.kwargs["response_format"]
        self.assertIsInstance(response_format, ProviderStrategy)
        self.assertIs(response_format.schema, OrientationOutput)
        self.assertTrue(response_format.schema_spec.strict)
        self.assertEqual(init.call_args.kwargs["middleware"], ["skills-mw", logging])
        skills.assert_called_once_with([orientation.SHARED_SKILLS_DIR])

    @patch("harness.deepagents.agents.orientation.build_skills_middleware")
    @patch(
        "harness.deepagents.agents.orientation.DeepAgentSession.__init__",
        return_value=None,
    )
    def test_orientation_agent_preserves_caller_middleware_without_skills(
        self, init: MagicMock, skills: MagicMock
    ) -> None:
        from harness.deepagents.agents.orientation import OrientationAgent

        skills.return_value = None
        logging = LoggingMiddleware()

        OrientationAgent(
            model=MagicMock(),
            workspace_dir=self.workspace,
            thread_id="t",
            middleware=[logging],
            events=None,
        )

        self.assertEqual(init.call_args.kwargs["middleware"], [logging])

    @patch("harness.deepagents.agents.orientation.build_skills_middleware")
    @patch(
        "harness.deepagents.agents.orientation.DeepAgentSession.__init__",
        return_value=None,
    )
    def test_orientation_agent_uses_no_middleware_when_no_skills_or_callers(
        self, init: MagicMock, skills: MagicMock
    ) -> None:
        from harness.deepagents.agents.orientation import OrientationAgent

        skills.return_value = None

        OrientationAgent(
            model=MagicMock(), workspace_dir=self.workspace, thread_id="t", events=None
        )

        self.assertIsNone(init.call_args.kwargs["middleware"])

    @patch("harness.deepagents.agents.planning.build_skills_middleware")
    @patch("harness.deepagents.agents.planning.build_knowledge_middleware")
    @patch(
        "harness.deepagents.agents.planning.DeepAgentSession.__init__",
        return_value=None,
    )
    def test_planning_agent_uses_knowledge_skills_and_in_memory_checkpointer(
        self,
        init: MagicMock,
        knowledge: MagicMock,
        skills: MagicMock,
    ) -> None:
        from harness.deepagents.agents.planning import PlanningAgent

        knowledge.return_value = "knowledge-mw"
        skills.return_value = "skills-mw"
        logging = LoggingMiddleware()

        PlanningAgent(
            model=MagicMock(),
            repo_path=self.repo,
            thread_id="t",
            knowledge_subpaths=["component"],
            middleware=[logging],
            events=None,
        )

        self.assertEqual(init.call_args.kwargs["workspace_dir"], self.repo)
        self.assertFalse(init.call_args.kwargs["durable"])
        self.assertTrue(init.call_args.kwargs["in_memory"])
        response_format = init.call_args.kwargs["response_format"]
        self.assertIsInstance(response_format, ProviderStrategy)
        self.assertIs(response_format.schema, RepoPlanOutput)
        self.assertTrue(response_format.schema_spec.strict)
        self.assertEqual(
            init.call_args.kwargs["middleware"], ["knowledge-mw", "skills-mw", logging]
        )
        knowledge.assert_called_once_with([self.repo, self.repo / "component"])
        self.assertNotIn("memory", repr(init.call_args.kwargs["middleware"]).lower())
        self.assertEqual(init.call_args.kwargs["emit_identifier"], "repo-a/planning")

    @patch(
        "harness.deepagents.agents.planning.build_skills_middleware", return_value=None
    )
    @patch(
        "harness.deepagents.agents.planning.DeepAgentSession.__init__",
        return_value=None,
    )
    def test_planning_agent_fails_fast_for_invalid_custom_knowledge_dir(
        self, _init: MagicMock, _skills: MagicMock
    ) -> None:
        from harness.deepagents.agents.planning import PlanningAgent

        with (
            patch.dict(os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": "/tmp/knowledge"}),
            self.assertRaisesRegex(ValueError, "HARNESS_REPO_KNOWLEDGE_DIR"),
        ):
            PlanningAgent(
                model=MagicMock(),
                repo_path=self.repo,
                thread_id="t",
                events=None,
            )

    @patch(
        "harness.deepagents.agents.plan_review.DeepAgentSession.__init__",
        return_value=None,
    )
    def test_plan_review_agent_is_workspace_rooted_and_non_durable(
        self, init: MagicMock
    ) -> None:
        from harness.deepagents.agents.plan_review import PlanReviewAgent

        PlanReviewAgent(
            model=MagicMock(), workspace_dir=self.workspace, thread_id="t", events=None
        )

        self.assertEqual(init.call_args.kwargs["workspace_dir"], self.workspace)
        self.assertFalse(init.call_args.kwargs["durable"])
        self.assertFalse(init.call_args.kwargs["in_memory"])
        response_format = init.call_args.kwargs["response_format"]
        self.assertIsInstance(response_format, ProviderStrategy)
        self.assertIs(response_format.schema, PlanReviewOutput)
        self.assertTrue(response_format.schema_spec.strict)
        self.assertNotIn("middleware", init.call_args.kwargs)


class TestPlanningPresetProgress(unittest.TestCase):
    """Snapshot of the progress each planning preset attaches."""

    def test_orientation_progress_has_no_worker_label(self) -> None:
        from harness.deepagents.agents.orientation import OrientationAgent
        from tests.progress_support import attached_progress

        progress = attached_progress(
            self,
            lambda model, events, tmp: OrientationAgent(
                model=model,
                workspace_dir=tmp,
                thread_id="orientation-progress",
                events=events,
            ),
        )
        self.assertIsNone(progress.worker_label)

    def test_planning_progress_worker_label_is_repo_planning(self) -> None:
        from harness.deepagents.agents.planning import PlanningAgent
        from tests.progress_support import attached_progress

        repo_paths: list[Path] = []

        def build(model, events, tmp):
            repo_paths.append(tmp)
            return PlanningAgent(
                model=model,
                repo_path=tmp,
                thread_id="planning-progress",
                events=events,
            )

        progress = attached_progress(self, build)
        self.assertEqual(progress.worker_label, f"{repo_paths[0].name}/planning")

    def test_plan_review_progress_has_no_worker_label(self) -> None:
        from harness.deepagents.agents.plan_review import PlanReviewAgent
        from tests.progress_support import attached_progress

        progress = attached_progress(
            self,
            lambda model, events, tmp: PlanReviewAgent(
                model=model,
                workspace_dir=tmp,
                thread_id="plan-review-progress",
                events=events,
            ),
        )
        self.assertIsNone(progress.worker_label)


if __name__ == "__main__":
    unittest.main()
