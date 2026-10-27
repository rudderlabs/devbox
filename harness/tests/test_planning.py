"""Tests for the DeepAgents planning orchestrator."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.deepagents.model import ModelChoice, ModelStage
from harness.events import RoundEvents
from harness.schemas import (
    OrientationOutput,
    Plan,
    PlanRepo,
    PlanReviewOutput,
    RepoPlanOutput,
)
from tests.progress_support import assert_agent_wired, round_events


def _repo_output(goal: str, *, notes: str = "") -> RepoPlanOutput:
    return RepoPlanOutput(
        goal=goal,
        planned_files_or_areas=["src"],
        implementation_steps=["edit"],
        validation_steps=["test"],
        risks=["risk"],
        planning_notes=notes,
        cross_repo_assumptions=["contract stays compatible"],
    )


def _plan_model(*, repo_name: str = "repo-a") -> Plan:
    return Plan(
        stage="planning",
        run_id="run-1",
        task="do work",
        task_key="ABC-1",
        status="completed",
        repos=[
            PlanRepo(
                name=repo_name,
                path=f"/workspace/{repo_name}",
                goal="change repo",
                planned_files_or_areas=["src/settings.py"],
                implementation_steps=["edit settings"],
                validation_steps=["test settings"],
                risks=["risk"],
                components=[{"name": "api", "path": "services/api"}],
            )
        ],
        planning_notes="notes",
        generated_at="2026-07-10T00:00:00Z",
    )


class TestClassifyRepos(unittest.TestCase):
    def test_workspace_repo_names_lists_only_git_checkouts(self) -> None:
        from harness import planning

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "repo-b" / ".git").mkdir(parents=True)
            (workspace / "repo-a").mkdir()
            (workspace / "repo-a" / ".git").write_text("gitdir: elsewhere")
            (workspace / "not-a-repo").mkdir()

            self.assertEqual(
                planning._workspace_repo_names(workspace=workspace),
                ["repo-a", "repo-b"],
            )

    @patch("harness.planning.build_model")
    def test_classify_repos_uses_orientation_defaults_and_structured_output(
        self, build_model: MagicMock
    ) -> None:
        from harness import planning

        structured = MagicMock()
        structured.invoke.return_value = {
            "repos": [{"name": "repo-a", "confidence": "high"}],
        }
        model = MagicMock()
        model.with_structured_output.return_value = structured
        build_model.return_value = model

        with patch(
            "harness.planning.resolve_model",
            return_value=ModelChoice("orient-model", "low"),
        ) as resolve:
            output = planning.classify_repos(
                task="do work",
                task_key="ABC-1",
                available_repos=["repo-a", "repo-b"],
            )

        resolve.assert_called_once_with(ModelStage.ORIENTATION)

        build_model.assert_called_once_with(
            model="orient-model", reasoning_effort="low"
        )
        model.with_structured_output.assert_called_once_with(
            OrientationOutput,
            method="json_schema",
            strict=True,
        )
        prompt = structured.invoke.call_args.args[0]
        self.assertIn(
            '<available_repositories>["repo-a", "repo-b"]</available_repositories>',
            prompt,
        )
        self.assertIn(
            "Select repository names only from the available repositories", prompt
        )
        self.assertEqual(output.repos[0].name, "repo-a")

    @patch("harness.deepagents.retry.time.sleep")
    @patch("harness.planning.build_model")
    def test_full_orientation_retries_stream_drop(
        self, _build_model: MagicMock, sleep: MagicMock
    ) -> None:
        """A mid-stream disconnect on the orientation agent is retried instead
        of terminating the daemon."""
        import httpx

        from harness import planning

        agent = MagicMock()
        agent.run.side_effect = [
            httpx.RemoteProtocolError("peer closed connection"),
            {"repos": [{"name": "repo-a", "confidence": "high"}]},
        ]
        agent.has_prior_state = False
        with (
            patch("harness.planning.OrientationAgent") as orientation_agent,
            patch.object(planning, "WORKSPACE", Path("/workspace")),
        ):
            orientation_agent.return_value = agent
            output = planning._run_full_orientation(
                task="do work",
                task_key="ABC-1",
                run_id="run-1",
                events=None,
            )

        self.assertEqual(output.repos[0].name, "repo-a")
        self.assertEqual(agent.run.call_count, 2)
        self.assertEqual(agent.close.call_count, 2)
        sleep.assert_called_once()

    @patch("harness.deepagents.retry.time.sleep")
    @patch("harness.planning.build_model")
    def test_full_orientation_agent_receives_round_events_client(
        self, _build_model: MagicMock, _sleep: MagicMock
    ) -> None:
        from harness import planning

        agent = MagicMock()
        agent.run.return_value = {"repos": [{"name": "repo-a", "confidence": "high"}]}
        agent.has_prior_state = False
        with (
            patch("harness.planning.OrientationAgent") as orientation_agent,
            round_events() as events,
        ):
            orientation_agent.return_value = agent
            planning._run_full_orientation(
                task="do work",
                task_key="ABC-1",
                run_id="run-1",
                events=events,
            )
            assert_agent_wired(self, orientation_agent, events)

    @patch("harness.planning._run_full_orientation")
    @patch("harness.planning.classify_repos")
    @patch("harness.planning._workspace_repo_names")
    def test_orientation_thoughts_reach_the_event_log_without_env(
        self,
        workspace_repo_names: MagicMock,
        classify_repos: MagicMock,
        run_full_orientation: MagicMock,
    ) -> None:
        import os

        from harness import planning
        from harness.events import RoundEvents, iter_events

        workspace_repo_names.return_value = ["repo-a"]
        classify_repos.return_value = OrientationOutput(
            repos=[{"name": "repo-a", "confidence": "high"}]
        )
        with tempfile.TemporaryDirectory() as tmp:
            events_file = Path(tmp) / "events.jsonl"
            events = RoundEvents(
                events_file=events_file,
                events_lock=Path(tmp) / "events.lock",
                inbox_id="inbox-1",
                target_id="t-1",
            )
            with (
                patch.dict(os.environ, {}, clear=True),
                patch.object(
                    planning, "classifier_skip_orientation_enabled", return_value=True
                ),
            ):
                planning._orientation_for_task(
                    task="do work",
                    task_key="ABC-1",
                    run_id="run-1",
                    events=events,
                )
            logged = list(iter_events(events_file))

        run_full_orientation.assert_not_called()
        self.assertEqual(
            [e["type"] for e in logged], ["agent_thought", "agent_thought"]
        )
        self.assertEqual({e["target_id"] for e in logged}, {"t-1"})
        self.assertEqual({e["inbox_id"] for e in logged}, {"inbox-1"})
        self.assertIn("Skipped full orientation", logged[1]["body"])

    @patch("harness.planning._run_full_orientation")
    @patch("harness.planning.classify_repos")
    @patch("harness.planning._workspace_repo_names")
    def test_orientation_decision_runs_full_orientation_by_default_without_classifier(
        self,
        workspace_repo_names: MagicMock,
        classify_repos: MagicMock,
        run_full_orientation: MagicMock,
    ) -> None:
        events = MagicMock(spec=RoundEvents)
        from harness import planning

        orientation = OrientationOutput(
            repos=[
                {"name": "repo-b", "confidence": "high"},
                {"name": "repo-a", "confidence": "high"},
            ]
        )
        run_full_orientation.return_value = orientation

        result = planning._orientation_for_task(
            task="do work",
            task_key="ABC-1",
            run_id="run-1",
            events=events,
        )

        self.assertIs(result, orientation)
        workspace_repo_names.assert_not_called()
        classify_repos.assert_not_called()
        run_full_orientation.assert_called_once_with(
            task="do work",
            task_key="ABC-1",
            run_id="run-1",
            events=events,
        )
        self.assertEqual(
            [call.args[0] for call in events.thought.call_args_list],
            [
                "Running full orientation.",
                (
                    "Completed full orientation; identified repositories: "
                    "repo-a, repo-b."
                ),
            ],
        )

    @patch("harness.planning._run_full_orientation")
    @patch("harness.planning.classify_repos")
    @patch("harness.planning._workspace_repo_names")
    def test_orientation_decision_reports_classification_skip_and_repositories(
        self,
        workspace_repo_names: MagicMock,
        classify_repos: MagicMock,
        run_full_orientation: MagicMock,
    ) -> None:
        events = MagicMock(spec=RoundEvents)
        from harness import planning

        classification = OrientationOutput(
            repos=[
                {"name": "repo-b", "confidence": "high"},
                {"name": "repo-a", "confidence": "high"},
            ]
        )
        workspace_repo_names.return_value = ["repo-a", "repo-b"]
        classify_repos.return_value = classification

        with patch.object(
            planning, "classifier_skip_orientation_enabled", return_value=True
        ):
            result = planning._orientation_for_task(
                task="do work",
                task_key="ABC-1",
                run_id="run-1",
                events=events,
            )

        self.assertIs(result, classification)
        classify_repos.assert_called_once_with(
            task="do work",
            task_key="ABC-1",
            available_repos=["repo-a", "repo-b"],
        )
        run_full_orientation.assert_not_called()
        self.assertEqual(
            [call.args[0] for call in events.thought.call_args_list],
            [
                (
                    "Checking the task with the repository classifier to decide whether "
                    "full orientation is needed."
                ),
                (
                    "Skipped full orientation because the classifier "
                    "identified high-confidence repositories: repo-a, repo-b."
                ),
            ],
        )

    @patch("harness.planning._run_full_orientation")
    @patch("harness.planning.classify_repos")
    @patch("harness.planning._workspace_repo_names")
    def test_orientation_decision_reports_full_orientation_and_repositories(
        self,
        workspace_repo_names: MagicMock,
        classify_repos: MagicMock,
        run_full_orientation: MagicMock,
    ) -> None:
        events = MagicMock(spec=RoundEvents)
        from harness import planning

        workspace_repo_names.return_value = ["repo-a", "repo-b"]
        classify_repos.return_value = OrientationOutput(
            repos=[{"name": "repo-a", "confidence": "medium"}]
        )
        orientation = OrientationOutput(
            repos=[
                {"name": "repo-b", "confidence": "high"},
                {"name": "repo-a", "confidence": "high"},
            ]
        )
        run_full_orientation.return_value = orientation

        with patch.object(
            planning, "classifier_skip_orientation_enabled", return_value=True
        ):
            result = planning._orientation_for_task(
                task="do work",
                task_key="ABC-1",
                run_id="run-1",
                events=events,
            )

        self.assertIs(result, orientation)
        run_full_orientation.assert_called_once_with(
            task="do work",
            task_key="ABC-1",
            run_id="run-1",
            events=events,
        )
        self.assertEqual(
            [call.args[0] for call in events.thought.call_args_list],
            [
                (
                    "Checking the task with the repository classifier to decide whether "
                    "full orientation is needed."
                ),
                "Running full orientation.",
                (
                    "Completed full orientation; identified repositories: "
                    "repo-a, repo-b."
                ),
            ],
        )

    @patch("harness.planning._run_full_orientation")
    @patch("harness.planning.classify_repos")
    @patch("harness.planning._workspace_repo_names")
    def test_unknown_high_confidence_repo_falls_back_to_full_orientation(
        self,
        workspace_repo_names: MagicMock,
        classify_repos: MagicMock,
        run_full_orientation: MagicMock,
    ) -> None:
        events = MagicMock(spec=RoundEvents)
        from harness import planning

        workspace_repo_names.return_value = ["widgets", "gadgets"]
        classify_repos.return_value = OrientationOutput(
            repos=[
                {"name": "harness", "confidence": "high"},
                {"name": "gadgets", "confidence": "high"},
            ]
        )
        orientation = OrientationOutput(
            repos=[
                {"name": "widgets", "confidence": "high"},
                {"name": "gadgets", "confidence": "high"},
            ]
        )
        run_full_orientation.return_value = orientation

        with patch.object(
            planning, "classifier_skip_orientation_enabled", return_value=True
        ):
            result = planning._orientation_for_task(
                task="do work",
                task_key="ABC-1",
                run_id="run-1",
                events=events,
            )

        self.assertIs(result, orientation)
        run_full_orientation.assert_called_once_with(
            task="do work",
            task_key="ABC-1",
            run_id="run-1",
            events=events,
        )
        self.assertEqual(
            events.thought.call_args_list[1].args[0],
            "Running full orientation.",
        )


class TestOrientationAgentPrompt(unittest.TestCase):
    def test_prompt_is_read_only(self) -> None:
        from harness.deepagents.agents.orientation import ORIENTATION_SYSTEM_PROMPT

        self.assertIn("Do not edit files", ORIENTATION_SYSTEM_PROMPT)
        self.assertNotIn("drift", ORIENTATION_SYSTEM_PROMPT.lower())
        self.assertNotIn("knowledge graph", ORIENTATION_SYSTEM_PROMPT.lower())


class TestRunPlanning(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name)
        (self.workspace / "repo-a" / ".git").mkdir(parents=True)
        (self.workspace / "repo-b" / ".git").mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_knowledge_subpaths_sanitizes_model_supplied_components(self) -> None:
        from harness import planning

        absolute_inside = self.workspace / "repo-a" / "libs" / "core"
        orientation = OrientationOutput(
            repos=[
                {
                    "name": "repo-a",
                    "confidence": "high",
                    "components": [
                        {"name": "api", "path": "services/api"},
                        {"name": "dup", "path": "services/api"},
                        {"name": "parent", "path": "../repo-b"},
                        {"name": "outside", "path": "/tmp/outside"},
                        {"name": "root", "path": "."},
                        {"name": "absolute-inside", "path": str(absolute_inside)},
                    ],
                }
            ],
        )

        with patch.object(planning, "WORKSPACE", self.workspace):
            oriented = planning._normalize_oriented_repos(orientation)[0]
            self.assertEqual(
                planning._knowledge_subpaths(oriented), ["libs/core", "services/api"]
            )

    def test_canonical_repo_plan_deduplicates_review_lenses(self) -> None:
        """The strict schema constrains lens values, not uniqueness; the
        canonical plan must dedupe (order-preserving) so the plan validator
        never sees a duplicate."""
        from harness import planning

        oriented = planning.OrientedRepo(
            name="repo-a", confidence="high", components=[]
        )
        output = RepoPlanOutput(
            goal="g",
            additional_review_lenses=["security", "bug-hunter", "security"],
        )
        plan = planning._canonical_repo_plan(
            oriented_repo=oriented,
            repo_path=self.workspace / "repo-a",
            output=output,
        )
        self.assertEqual(plan.additional_review_lenses, ["security", "bug-hunter"])

    @patch("harness.deepagents.retry.time.sleep")
    def test_repo_revision_retry_resends_prompt_without_checkpoint_progress(
        self, _sleep: MagicMock
    ) -> None:
        import httpx

        from harness import planning

        class Agent:
            has_prior_state = True

            def __init__(self) -> None:
                self.marker = "initial-plan"
                self.run = MagicMock(
                    side_effect=[
                        httpx.RemoteProtocolError("peer closed connection"),
                        _repo_output("revised repo a"),
                    ]
                )
                self.resume_from_restart = MagicMock(return_value="stale plan")
                self.close = MagicMock()

            @property
            def progress_marker(self) -> str:
                return self.marker

            def repair_dangling_tool_calls(self) -> None:
                self.marker = "repaired-initial-plan"

        agent = Agent()

        output = planning._run_repo_prompt_with_retries(
            agent=agent,
            prompt="revision prompt",
            repo_name="repo-a",
            max_retries=1,
        )

        self.assertEqual(output.goal, "revised repo a")
        self.assertEqual(
            [call.args for call in agent.run.call_args_list],
            [("revision prompt",), ("revision prompt",)],
        )
        agent.resume_from_restart.assert_not_called()
        agent.close.assert_not_called()

    def test_canonical_repo_plan_deduplicates_component_names_and_paths(self) -> None:
        from harness import planning

        oriented = planning.OrientedRepo(
            name="repo-a",
            confidence="high",
            components=[
                {"name": "api", "path": "services/api"},
                {"name": "core", "path": "libs/core"},
            ],
        )
        output = RepoPlanOutput(
            goal="change repo a",
            components=[
                {"name": "api", "path": "services/new-api"},
                {"name": "duplicate-core-path", "path": "libs/core"},
                {"name": "worker", "path": "services/worker"},
            ],
        )

        plan = planning._canonical_repo_plan(
            oriented_repo=oriented,
            repo_path=self.workspace / "repo-a",
            output=output,
        )

        self.assertEqual(
            [(component.name, component.path) for component in plan.components],
            [
                ("api", "services/api"),
                ("core", "libs/core"),
                ("worker", "services/worker"),
            ],
        )

        from harness.handlers import assignment

        with patch.object(assignment, "WORKSPACE", self.workspace):
            assignment.validate_plan({
                "stage": "planning",
                "run_id": "run-1",
                "task": "do work",
                "status": "completed",
                "repos": [plan.model_dump(mode="json")],
                "planning_notes": "",
                "generated_at": "2026-07-10T00:00:00Z",
                "task_key": "ABC-1",
            })

    @patch("harness.planning.build_model")
    @patch("harness.planning.PlanReviewAgent")
    @patch("harness.planning.PlanningAgent")
    def test_run_planning_approved_plan_builds_only_planning_models(
        self,
        planning_agent: MagicMock,
        review_agent: MagicMock,
        build_model: MagicMock,
    ) -> None:
        from harness import planning

        (self.workspace / "acme-webapp" / ".git").mkdir(parents=True)
        session = MagicMock()
        session.run.return_value = _repo_output("change webapp billing")
        planning_agent.return_value = session
        reviewer = review_agent.return_value
        reviewer.has_prior_state = False
        reviewer.run.return_value = PlanReviewOutput(status="approved")
        orientation = OrientationOutput(
            repos=[{"name": "acme-webapp", "confidence": "high"}],
        )

        with (
            patch.object(planning, "WORKSPACE", self.workspace),
            patch.object(planning, "_run_full_orientation", return_value=orientation),
            patch.object(
                planning, "PLAN_REVIEW_JSON", self.workspace / "plan-review.json"
            ),
            patch.dict(
                "os.environ",
                {
                    "HARNESS_PLANNING_MODEL": "planning-model",
                    "HARNESS_PLAN_REVIEW_MODEL": "plan-review-model",
                },
            ),
        ):
            result = planning.run_planning(
                task="change webapp billing",
                task_key="ABC-1",
                run_id="run-wire-1",
                events=None,
            )

        plan_data = result.model_dump(mode="json", exclude_none=True)
        self.assertEqual(
            sorted(plan_data),
            [
                "generated_at",
                "planning_notes",
                "repos",
                "run_id",
                "stage",
                "status",
                "task",
                "task_key",
            ],
        )
        built = [c.kwargs["model"] for c in build_model.call_args_list]
        self.assertEqual(sorted(built), ["plan-review-model", "planning-model"])

    @patch("harness.planning.build_model")
    @patch("harness.planning.PlanReviewAgent")
    @patch("harness.planning.PlanningAgent")
    def test_high_confidence_classification_skips_full_orientation_and_returns_plan(
        self,
        planning_agent: MagicMock,
        review_agent: MagicMock,
        build_model: MagicMock,
    ) -> None:
        from harness import planning

        session = MagicMock()
        session.run.return_value = _repo_output("change repo a", notes="repo note")
        planning_agent.return_value = session
        reviewer = review_agent.return_value
        reviewer.has_prior_state = False
        reviewer.run.return_value = PlanReviewOutput(
            status="approved", review_notes="ok"
        )
        orientation = OrientationOutput(
            repos=[
                {
                    "name": "repo-a",
                    "confidence": "high",
                    "components": [{"name": "api", "path": "services/api"}],
                }
            ],
            orientation_notes="classified from task",
            cross_repo_assumptions=["shared API"],
        )

        with (
            patch.object(planning, "WORKSPACE", self.workspace),
            patch.object(
                planning, "classifier_skip_orientation_enabled", return_value=True
            ),
            patch.object(planning, "classify_repos", return_value=orientation),
            patch.object(planning, "_run_full_orientation") as full_orientation,
        ):
            result = planning.run_planning(
                task="do work",
                task_key="ABC-1",
                run_id="run-1",
                events=None,
            )

        full_orientation.assert_not_called()
        self.assertEqual(result.stage, "planning")
        self.assertEqual(result.repos[0].name, "repo-a")
        self.assertEqual(
            result.repos[0].path, str((self.workspace / "repo-a").resolve())
        )
        self.assertEqual(result.repos[0].components[0].path, "services/api")
        self.assertIn("classified from task", result.planning_notes)
        self.assertIn("shared API", result.planning_notes)
        self.assertIn("repo note", result.planning_notes)
        self.assertIn("ok", result.planning_notes)
        planning_agent.assert_called_once()
        self.assertEqual(
            planning_agent.call_args.kwargs["knowledge_subpaths"], ["services/api"]
        )
        self.assertNotIn("middleware", planning_agent.call_args.kwargs)
        session.close.assert_called_once()
        self.assertEqual(build_model.call_count, 2)  # planning + review models

    @patch("harness.deepagents.retry.time.sleep")
    @patch("harness.planning.build_model")
    @patch("harness.planning.PlanReviewAgent")
    @patch("harness.planning.PlanningAgent")
    def test_plan_review_retries_stream_drop(
        self,
        planning_agent: MagicMock,
        review_agent: MagicMock,
        _build_model: MagicMock,
        sleep: MagicMock,
    ) -> None:
        """The plan-review call retries a transient error like the per-repo
        planning workers do, instead of failing the planning stage."""
        import httpx

        from harness import planning

        session = MagicMock()
        session.run.return_value = _repo_output("change repo a")
        planning_agent.return_value = session
        reviewer = review_agent.return_value
        reviewer.has_prior_state = False
        reviewer.run.side_effect = [
            httpx.RemoteProtocolError("peer closed connection"),
            PlanReviewOutput(status="approved"),
        ]
        orientation = OrientationOutput(
            repos=[{"name": "repo-a", "confidence": "high"}],
        )

        with (
            patch.object(planning, "WORKSPACE", self.workspace),
            patch.object(planning, "_run_full_orientation", return_value=orientation),
        ):
            result = planning.run_planning(
                task="do work",
                task_key="ABC-1",
                run_id="run-1",
                events=None,
            )

        self.assertEqual(result.repos[0].name, "repo-a")
        self.assertEqual(reviewer.run.call_count, 2)
        sleep.assert_called_once()

    @patch("harness.planning.build_model")
    @patch("harness.planning.PlanReviewAgent")
    @patch("harness.planning.PlanningAgent")
    def test_revision_updates_existing_repo_adds_valid_repo_and_records_invalid_repo(
        self,
        planning_agent: MagicMock,
        review_agent: MagicMock,
        _build_model: MagicMock,
    ) -> None:
        from harness import planning

        repo_a = MagicMock()
        repo_a.run.side_effect = [
            _repo_output("initial repo a"),
            _repo_output("revised repo a", notes="fixed gap"),
        ]
        repo_b = MagicMock()
        repo_b.run.return_value = _repo_output("add repo b")
        planning_agent.side_effect = [repo_a, repo_b]
        reviewer = review_agent.return_value
        reviewer.has_prior_state = False
        reviewer.run.return_value = PlanReviewOutput(
            status="needs_revision",
            review_notes="missing contract coverage",
            issues=[
                {"repo": "repo-a", "summary": "tighten repo a plan"},
                {"repo": "repo-b", "summary": "repo b owns the interface"},
                {"repo": "owner/repo-c", "summary": "invalid repo name"},
            ],
        )
        orientation = OrientationOutput(
            repos=[{"name": "repo-a", "confidence": "high"}],
            orientation_notes="task spans the planning boundary",
            cross_repo_assumptions=["repo-a and repo-b share a contract"],
        )

        with (
            patch.object(planning, "WORKSPACE", self.workspace),
            patch.object(planning, "_run_full_orientation", return_value=orientation),
        ):
            result = planning.run_planning(
                task="do work",
                task_key="ABC-1",
                run_id="run-2",
                events=None,
            )

        self.assertEqual([repo.name for repo in result.repos], ["repo-a", "repo-b"])
        goals = {repo.name: repo.goal for repo in result.repos}
        self.assertEqual(goals["repo-a"], "revised repo a")
        self.assertEqual(goals["repo-b"], "add repo b")
        self.assertIn("missing contract coverage", result.planning_notes)
        self.assertIn("owner/repo-c", result.planning_notes)
        self.assertEqual(review_agent.return_value.run.call_count, 1)
        repo_b_prompt = repo_b.run.call_args.args[0]
        self.assertIn("<task>do work</task>", repo_b_prompt)
        self.assertIn("repo-b", repo_b_prompt)
        self.assertIn("task spans the planning boundary", repo_b_prompt)
        self.assertIn("repo-a and repo-b share a contract", repo_b_prompt)
        self.assertIn("repo b owns the interface", repo_b_prompt)
        repo_a.close.assert_called_once()
        repo_b.close.assert_called_once()

    @patch("harness.planning.build_model")
    @patch("harness.planning.PlanReviewAgent")
    @patch("harness.planning.PlanningAgent")
    def test_planning_and_review_agents_receive_events_client_and_target(
        self,
        planning_agent: MagicMock,
        review_agent: MagicMock,
        _build_model: MagicMock,
    ) -> None:
        from harness import planning

        repo_a = MagicMock()
        repo_a.run.return_value = _repo_output("repo a")
        repo_b = MagicMock()
        repo_b.run.return_value = _repo_output("repo b")
        planning_agent.side_effect = [repo_a, repo_b]
        reviewer = review_agent.return_value
        reviewer.has_prior_state = False
        reviewer.run.return_value = PlanReviewOutput(
            status="needs_revision",
            review_notes="repo b is missing",
            issues=[{"repo": "repo-b", "summary": "repo b owns the interface"}],
        )
        orientation = OrientationOutput(
            repos=[{"name": "repo-a", "confidence": "high"}],
        )

        with (
            patch.object(planning, "WORKSPACE", self.workspace),
            patch.object(planning, "_run_full_orientation", return_value=orientation),
            round_events() as events,
        ):
            planning.run_planning(
                task="do work",
                task_key="ABC-1",
                run_id="run-wired",
                events=events,
            )
            # Both PlanningAgent sites (initial repo, repo added by review).
            self.assertEqual(planning_agent.call_count, 2)
            assert_agent_wired(self, planning_agent, events)
            assert_agent_wired(self, review_agent, events)

    @patch("harness.planning.build_model")
    @patch("harness.planning.PlanReviewAgent")
    @patch("harness.planning.PlanningAgent")
    def test_approved_review_is_persisted_and_reported_as_thought(
        self,
        planning_agent: MagicMock,
        review_agent: MagicMock,
        _build_model: MagicMock,
    ) -> None:
        from harness import planning

        events = MagicMock(spec=RoundEvents)

        session = MagicMock()
        session.run.return_value = _repo_output("change repo a")
        planning_agent.return_value = session
        reviewer = review_agent.return_value
        reviewer.has_prior_state = False
        reviewer.run.return_value = PlanReviewOutput(
            status="approved", review_notes="solid contract coverage"
        )
        orientation = OrientationOutput(
            repos=[{"name": "repo-a", "confidence": "high"}],
        )
        review_path = self.workspace / "plan-review.json"

        with (
            patch.object(planning, "WORKSPACE", self.workspace),
            patch.object(planning, "_run_full_orientation", return_value=orientation),
            patch.object(planning, "PLAN_REVIEW_JSON", review_path),
        ):
            planning.run_planning(
                task="do work",
                task_key="ABC-1",
                run_id="run-review-1",
                events=events,
            )

        data = json.loads(review_path.read_text(encoding="utf-8"))
        self.assertEqual(data["status"], "approved")
        self.assertEqual(data["review_notes"], "solid contract coverage")
        self.assertEqual(data["run_id"], "run-review-1")
        self.assertIn("generated_at", data)
        bodies = [call.args[0] for call in events.thought.call_args_list]
        self.assertTrue(
            any(
                "approved" in body and "solid contract coverage" in body
                for body in bodies
            ),
            f"no approval thought in {bodies!r}",
        )

    @patch("harness.planning.build_model")
    @patch("harness.planning.PlanReviewAgent")
    @patch("harness.planning.PlanningAgent")
    def test_revision_review_persists_issues_and_reports_findings_thought(
        self,
        planning_agent: MagicMock,
        review_agent: MagicMock,
        _build_model: MagicMock,
    ) -> None:
        from harness import planning

        events = MagicMock(spec=RoundEvents)

        session = MagicMock()
        session.run.side_effect = [
            _repo_output("initial repo a"),
            _repo_output("revised repo a"),
        ]
        planning_agent.return_value = session
        reviewer = review_agent.return_value
        reviewer.has_prior_state = False
        reviewer.run.return_value = PlanReviewOutput(
            status="needs_revision",
            review_notes="contract mismatch",
            issues=[
                {"repo": "repo-a", "summary": "tighten repo a plan"},
                {"summary": "unscoped schema concern"},
            ],
        )
        orientation = OrientationOutput(
            repos=[{"name": "repo-a", "confidence": "high"}],
        )
        review_path = self.workspace / "plan-review.json"

        with (
            patch.object(planning, "WORKSPACE", self.workspace),
            patch.object(planning, "_run_full_orientation", return_value=orientation),
            patch.object(planning, "PLAN_REVIEW_JSON", review_path),
        ):
            planning.run_planning(
                task="do work",
                task_key="ABC-1",
                run_id="run-review-2",
                events=events,
            )

        data = json.loads(review_path.read_text(encoding="utf-8"))
        self.assertEqual(data["status"], "needs_revision")
        self.assertEqual(
            [issue["summary"] for issue in data["issues"]],
            ["tighten repo a plan", "unscoped schema concern"],
        )
        bodies = [call.args[0] for call in events.thought.call_args_list]
        findings = [body for body in bodies if "2 issue(s)" in body]
        self.assertEqual(len(findings), 1, f"no findings thought in {bodies!r}")
        self.assertIn("repo-a: tighten repo a plan", findings[0])
        self.assertIn("unscoped: unscoped schema concern", findings[0])
        self.assertIn("contract mismatch", findings[0])

    @patch("harness.planning.build_model")
    @patch("harness.planning.PlanReviewAgent")
    @patch("harness.planning.PlanningAgent")
    def test_review_artifact_write_failure_does_not_fail_planning(
        self,
        planning_agent: MagicMock,
        review_agent: MagicMock,
        _build_model: MagicMock,
    ) -> None:
        from harness import planning

        session = MagicMock()
        session.run.return_value = _repo_output("change repo a")
        planning_agent.return_value = session
        reviewer = review_agent.return_value
        reviewer.has_prior_state = False
        reviewer.run.return_value = PlanReviewOutput(status="approved")
        orientation = OrientationOutput(
            repos=[{"name": "repo-a", "confidence": "high"}],
        )

        with (
            patch.object(planning, "WORKSPACE", self.workspace),
            patch.object(planning, "_run_full_orientation", return_value=orientation),
            patch.object(planning, "write_json", side_effect=OSError("disk full")),
        ):
            result = planning.run_planning(
                task="do work",
                task_key="ABC-1",
                run_id="run-review-3",
                events=None,
            )

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.repos[0].goal, "change repo a")

    def test_missing_oriented_workspace_repo_fails_clearly(self) -> None:
        from harness import planning

        orientation = OrientationOutput(
            repos=[{"name": "missing-repo", "confidence": "high"}],
        )
        with (
            patch.object(planning, "WORKSPACE", self.workspace),
            patch.object(planning, "_run_full_orientation", return_value=orientation),
            self.assertRaises(FileNotFoundError) as ctx,
        ):
            planning.run_planning(
                task="do work",
                task_key="ABC-1",
                run_id="run-3",
                events=None,
            )
        self.assertIn("missing-repo", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
