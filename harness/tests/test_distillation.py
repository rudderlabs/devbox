"""Focused tests for distillation-stage orchestration."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.deepagents.model import ModelChoice, ModelStage
from harness.schemas import DistillationRepo, Plan
from tests.progress_support import assert_agent_wired, round_events


def _load_distillation_with_workspace(workspace: Path):
    """Reload distillation with WORKSPACE pointed at *workspace*."""
    env = {"WORKSPACE": str(workspace)}
    with patch.dict(os.environ, env, clear=False):
        for mod_name in (
            "harness.paths",
            "harness.util",
            "harness.plan_utils",
            "harness.distillation",
            "harness.cli",
        ):
            sys.modules.pop(mod_name, None)
        path = REPO_ROOT / "src" / "harness" / "distillation.py"
        spec = importlib.util.spec_from_file_location("distillation", path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules["distillation"] = mod
        spec.loader.exec_module(mod)
        return mod


class TestDistillationResume(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        self.harness_dir = self.ws / ".harness"
        self.harness_dir.mkdir(parents=True)
        self.repo = self.ws / "repo-a"
        (self.repo / ".agents" / "knowledge").mkdir(parents=True)
        (self.repo / ".agents" / "knowledge" / "bootstrap.md").write_text(
            "# bootstrap\n", encoding="utf-8"
        )
        self.memory_dir = self.harness_dir / "memory" / "repo-a"
        self.memory_dir.mkdir(parents=True)
        (self.memory_dir / "decision.md").write_text("# memory\n", encoding="utf-8")
        self.distillation = _load_distillation_with_workspace(self.ws)
        self.distillation.MEMORY_DIR = self.harness_dir / "memory"
        self.distillation.DISTILLATION_JSON = self.harness_dir / "distillation.json"
        self.distillation.PLAN_JSON = self.harness_dir / "plan.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _plan(self, repos: list[dict[str, object]]) -> Plan:
        normalized_repos: list[dict[str, object]] = []
        for repo in repos:
            normalized_repos.append({
                "goal": "distill",
                "planned_files_or_areas": [],
                "implementation_steps": [],
                "validation_steps": [],
                "risks": [],
                **repo,
            })
        return Plan.model_validate({
            "stage": "planning",
            "run_id": "run-1",
            "task": "task",
            "task_key": "ABC-1",
            "status": "completed",
            "repos": normalized_repos,
            "planning_notes": "notes",
            "generated_at": "2026-06-01T00:00:00Z",
        })

    def test_filter_plan_to_repo_names_public_wrapper_copies_and_filters(self) -> None:
        plan_data = {
            "stage": "planning",
            "repos": [
                {"name": "repo-a", "path": "/wrong/a", "goal": "keep"},
                {"name": "repo-b", "path": "/wrong/b", "goal": "drop"},
                "not-a-repo",
            ],
            "planning_notes": "preserve me",
        }

        filtered = self.distillation.filter_plan_to_repo_names(plan_data, ["repo-a"])

        self.assertEqual(filtered["planning_notes"], "preserve me")
        self.assertEqual(
            filtered["repos"],
            [{"name": "repo-a", "path": "/wrong/a", "goal": "keep"}],
        )
        self.assertEqual(len(plan_data["repos"]), 3)
        self.assertIsNot(filtered, plan_data)
        self.assertIsNot(filtered["repos"][0], plan_data["repos"][0])

    def test_partition_ignores_divergent_legacy_repo_path(self) -> None:
        eligible, skipped = self.distillation._partition_distillation_repos(
            self._plan([{"name": "repo-a", "path": "/wrong/place"}]),
            Path(".agents/knowledge"),
        )

        self.assertEqual(skipped, [])
        self.assertEqual(len(eligible), 1)
        self.assertEqual(eligible[0]["repo"], "repo-a")
        self.assertEqual(eligible[0]["path"], str(self.repo.resolve()))
        self.assertEqual(eligible[0]["memory_files_present"], ["decision.md"])

    def test_all_distillation_memory_files_recurses_under_repo_dirs(self) -> None:
        nested = self.memory_dir / "services" / "api"
        nested.mkdir(parents=True)
        (nested / "implementation.md").write_text("# nested\n", encoding="utf-8")

        self.assertEqual(
            self.distillation._all_distillation_memory_files(),
            ["repo-a/decision.md", "repo-a/services/api/implementation.md"],
        )

    def test_custom_knowledge_directory_supports_component_bootstrap(self) -> None:
        mono = self.ws / "mono"
        knowledge_dir = mono / "services" / "api" / ".devbox" / "knowledge"
        knowledge_dir.mkdir(parents=True)
        (knowledge_dir / "patterns.md").write_text("# patterns\n", encoding="utf-8")
        with patch.dict(
            os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": ".devbox/knowledge"}, clear=False
        ):
            eligible, skipped = self.distillation._partition_distillation_repos(
                self._plan([
                    {
                        "name": "mono",
                        "path": str(mono),
                        "components": [{"name": "api", "path": "services/api"}],
                    }
                ]),
                Path(".devbox/knowledge"),
            )

        self.assertEqual(skipped, [])
        self.assertEqual(eligible[0]["knowledge_dir"], str(mono / ".devbox/knowledge"))
        self.assertEqual(eligible[0]["knowledge_dirs"], [str(knowledge_dir.resolve())])

    def test_partition_omits_root_knowledge_dir_symlinked_outside_repo(self) -> None:
        mono = self.ws / "mono"
        component_knowledge = mono / "services" / "api" / ".agents" / "knowledge"
        component_knowledge.mkdir(parents=True)
        (component_knowledge / "patterns.md").write_text("# p\n", encoding="utf-8")
        outside = self.ws / "outside-knowledge"
        outside.mkdir()
        (outside / "leaked.md").write_text("# leaked\n", encoding="utf-8")
        (mono / ".agents").mkdir()
        (mono / ".agents" / "knowledge").symlink_to(outside, target_is_directory=True)

        eligible, skipped = self.distillation._partition_distillation_repos(
            self._plan([
                {
                    "name": "mono",
                    "path": str(mono),
                    "components": [{"name": "api", "path": "services/api"}],
                }
            ]),
            Path(".agents/knowledge"),
        )

        self.assertEqual(skipped, [])
        self.assertNotIn("knowledge_dir", eligible[0])
        self.assertEqual(
            eligible[0]["knowledge_dirs"], [str(component_knowledge.resolve())]
        )

    def test_early_return_artifacts_record_inbox_id(self) -> None:
        # No eligible repo: repo-b has memory but no knowledge bootstrap.
        repo_b = self.ws / "repo-b"
        repo_b.mkdir()
        (self.distillation.MEMORY_DIR / "repo-b").mkdir()
        (self.distillation.MEMORY_DIR / "repo-b" / "m.md").write_text("# m\n")
        with patch("harness.deepagents.model.build_model") as build_model:
            self.distillation.run_distillation_stage(
                run_id="run-1",
                task="task",
                task_key="ENG-1",
                plan_data=self._plan([{"name": "repo-b", "path": str(repo_b)}]),
                events=None,
                inbox_id="inbox-1",
            )
        build_model.assert_not_called()
        data = json.loads(
            self.distillation.DISTILLATION_JSON.read_text(encoding="utf-8")
        )
        self.assertEqual(data["inbox_id"], "inbox-1")

        # No memory at all.
        shutil.rmtree(self.distillation.MEMORY_DIR)
        with patch("harness.deepagents.model.build_model") as build_model:
            self.distillation.run_distillation_stage(
                run_id="run-1",
                task="task",
                task_key="ENG-1",
                plan_data=self._plan([{"name": "repo-a", "path": str(self.repo)}]),
                events=None,
                inbox_id="inbox-2",
            )
        build_model.assert_not_called()
        data = json.loads(
            self.distillation.DISTILLATION_JSON.read_text(encoding="utf-8")
        )
        self.assertEqual(data["inbox_id"], "inbox-2")

    def test_disabled_distillation_writes_skipped_artifact_without_model(self) -> None:
        with (
            patch.dict(
                os.environ, {"HARNESS_DISTILLATION_ENABLED": "false"}, clear=False
            ),
            patch("harness.deepagents.model.build_model") as build_model,
        ):
            self.distillation.run_distillation_stage(
                run_id="run-1",
                task="task",
                task_key="ENG-1",
                plan_data=self._plan([{"name": "repo-a", "path": str(self.repo)}]),
                events=None,
                inbox_id="inbox-1",
            )

        build_model.assert_not_called()
        data = json.loads(
            self.distillation.DISTILLATION_JSON.read_text(encoding="utf-8")
        )
        self.assertEqual(data["inbox_id"], "inbox-1")
        self.assertEqual(
            data["repos"],
            [
                {
                    "repo": "repo-a",
                    "skipped": "distillation disabled by HARNESS_DISTILLATION_ENABLED",
                }
            ],
        )

    def test_distillation_stage_runs_one_worker_per_eligible_repo(self) -> None:
        repo_b = self.ws / "repo-b"
        repo_b.mkdir()
        memory_b = self.harness_dir / "memory" / "repo-b"
        memory_b.mkdir(parents=True)
        (memory_b / "feedback.md").write_text("# feedback\n", encoding="utf-8")
        (memory_b / "services" / "api").mkdir(parents=True)
        (memory_b / "services" / "api" / "implementation.md").write_text(
            "# component feedback\n", encoding="utf-8"
        )
        plan_data = self._plan([
            {"name": "repo-a", "path": str(self.repo)},
            {"name": "repo-b", "path": str(repo_b)},
        ])
        distillation_json = self.distillation.DISTILLATION_JSON
        session = MagicMock()
        session.run.return_value = DistillationRepo(
            repo="repo-a",
            memory_files_read=["repo-a/decision.md"],
            promoted_count=1,
            dropped_count=0,
            knowledge_files_updated=["repo-a/.agents/knowledge/bootstrap.md"],
            response_summary="- `patterns`: Captured bootstrap guidance.",
        )

        with (
            patch(
                "harness.deepagents.model.resolve_model",
                return_value=ModelChoice("gpt-5.5", "medium"),
            ),
            patch("harness.deepagents.model.build_model"),
            patch(
                "harness.deepagents.agents.distillation.DistillationAgent"
            ) as mock_agent,
            patch.object(self.distillation, "trace_span"),
        ):
            mock_agent.return_value.__enter__.return_value = session
            self.distillation.run_distillation_stage(
                run_id="run-1",
                task="task",
                task_key="ABC-1",
                plan_data=plan_data,
                events=None,
                inbox_id="inbox-1",
            )

        mock_agent.assert_called_once()
        data = json.loads(distillation_json.read_text(encoding="utf-8"))
        self.assertEqual(data["inbox_id"], "inbox-1")
        self.assertEqual([r["repo"] for r in data["repos"]], ["repo-a", "repo-b"])
        self.assertEqual(
            data["repos"][0]["response_summary"],
            "- `patterns`: Captured bootstrap guidance.",
        )
        skipped = data["repos"][1]
        self.assertEqual(skipped["skipped"], "no .agents/knowledge/ bootstrap")
        self.assertEqual(
            skipped["memory_files_present"],
            ["feedback.md", "services/api/implementation.md"],
        )

    def test_distillation_agent_receives_round_events_client(
        self,
    ) -> None:
        plan_data = self._plan([{"name": "repo-a", "path": str(self.repo)}])
        session = MagicMock()
        session.run.return_value = DistillationRepo(
            repo="repo-a",
            memory_files_read=["repo-a/decision.md"],
            promoted_count=1,
            dropped_count=0,
            knowledge_files_updated=[],
        )

        with (
            patch(
                "harness.deepagents.model.resolve_model",
                return_value=ModelChoice("gpt-5.5", "medium"),
            ),
            patch("harness.deepagents.model.build_model"),
            patch(
                "harness.deepagents.agents.distillation.DistillationAgent"
            ) as mock_agent,
            patch.object(self.distillation, "trace_span"),
            round_events() as events,
        ):
            mock_agent.return_value.__enter__.return_value = session
            self.distillation.run_distillation_stage(
                run_id="run-1",
                task="task",
                task_key="ABC-1",
                plan_data=plan_data,
                events=events,
            )
            assert_agent_wired(self, mock_agent, events)

    def _timed_distillation(self):
        from harness import obs

        events: list[dict[str, object]] = []

        def record(event, **fields):
            if event == obs.STAGE_DURATION_EVENT:
                events.append(fields)

        session = MagicMock()
        session.run.return_value = DistillationRepo(
            repo="repo-a",
            memory_files_read=["repo-a/decision.md"],
            promoted_count=0,
            dropped_count=0,
            knowledge_files_updated=[],
        )
        with (
            patch(
                "harness.deepagents.model.resolve_model",
                return_value=ModelChoice("gpt-5.5", "medium"),
            ),
            patch("harness.deepagents.model.build_model"),
            patch(
                "harness.deepagents.agents.distillation.DistillationAgent"
            ) as mock_agent,
            patch.object(self.distillation, "trace_span"),
            patch.object(obs, "log_event", side_effect=record),
        ):
            mock_agent.return_value.__enter__.return_value = session
            self.distillation.run_distillation_stage(
                run_id="run-1",
                task="task",
                task_key="ABC-1",
                plan_data=self._plan([{"name": "repo-a", "path": str(self.repo)}]),
                events=None,
            )
        return events

    def test_distillation_stage_emits_one_timing_event(self) -> None:
        events = self._timed_distillation()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["harness_stage"], "distillation")
        self.assertEqual(events[0]["outcome"], "ok")
        self.assertEqual(events[0]["harness_run_id"], "run-1")
        self.assertEqual(events[0]["harness_task_key"], "ABC-1")

    def test_distillation_without_memory_emits_nothing(self) -> None:
        (self.memory_dir / "decision.md").unlink()
        self.assertEqual(self._timed_distillation(), [])

    def test_partition_uses_component_knowledge_as_monorepo_bootstrap(self) -> None:
        mono = self.ws / "mono"
        knowledge_dir = mono / "services" / "api" / ".agents" / "knowledge"
        knowledge_dir.mkdir(parents=True)
        (knowledge_dir / "patterns.md").write_text("# patterns\n", encoding="utf-8")
        memory_dir = self.harness_dir / "memory" / "mono"
        memory_dir.mkdir(parents=True)
        (memory_dir / "feedback.md").write_text("# feedback\n", encoding="utf-8")
        component_memory = memory_dir / "services" / "api"
        component_memory.mkdir(parents=True)
        (component_memory / "implementation.md").write_text(
            "# component memory\n", encoding="utf-8"
        )

        eligible, skipped = self.distillation._partition_distillation_repos(
            self._plan([
                {
                    "name": "mono",
                    "path": str(mono),
                    "components": [
                        {"name": "api", "path": "services/api"},
                        {"name": "api-again", "path": "services/api"},
                        {"name": "outside", "path": str(self.ws / "outside")},
                    ],
                }
            ]),
            Path(".agents/knowledge"),
        )

        self.assertEqual(skipped, [])
        self.assertEqual(len(eligible), 1)
        self.assertEqual(eligible[0]["repo"], "mono")
        self.assertEqual(eligible[0]["knowledge_subpaths"], ["services/api"])
        self.assertEqual(eligible[0]["knowledge_dirs"], [str(knowledge_dir.resolve())])
        self.assertEqual(
            eligible[0]["memory_files_present"],
            ["feedback.md", "services/api/implementation.md"],
        )

    def test_deepagents_runner_uses_distillation_reasoning_effort(self) -> None:
        model = object()
        session = MagicMock()
        session.run.return_value = DistillationRepo(
            repo="repo-a",
            memory_files_read=["repo-a/feedback.md"],
            promoted_count=1,
            dropped_count=0,
            knowledge_files_updated=["repo-a/.agents/knowledge/patterns.md"],
        )

        with (
            patch(
                "harness.deepagents.model.resolve_model",
                return_value=ModelChoice("gpt-test", "low"),
            ) as mock_resolve,
            patch(
                "harness.deepagents.model.build_model",
                return_value=model,
            ) as mock_build_model,
            patch(
                "harness.deepagents.agents.distillation.DistillationAgent"
            ) as mock_agent,
            patch.object(self.distillation, "trace_span"),
        ):
            mock_agent.return_value.__enter__.return_value = session

            self.distillation.run_distillation_stage(
                run_id="run-1",
                task="task",
                task_key="ABC-1",
                plan_data=self._plan([
                    {
                        "name": "repo-a",
                        "path": "/wrong/place",
                        "components": [{"name": "api", "path": "services/api"}],
                    }
                ]),
                events=None,
            )

        mock_resolve.assert_called_once_with(ModelStage.DISTILLATION)
        mock_build_model.assert_called_once_with(
            model="gpt-test", reasoning_effort="low"
        )
        self.assertIs(mock_agent.call_args.kwargs["model"], model)
        self.assertNotIn("middleware", mock_agent.call_args.kwargs)
        self.assertIs(mock_agent.call_args.kwargs["response_format"], DistillationRepo)
        self.assertEqual(mock_agent.call_args.kwargs["repo_path"], self.repo.resolve())
        self.assertEqual(
            mock_agent.call_args.kwargs["knowledge_subpaths"], ["services/api"]
        )
        session.run.assert_called_once()
        data = json.loads(
            self.distillation.DISTILLATION_JSON.read_text(encoding="utf-8")
        )
        self.assertEqual(data["stage"], "distillation")
        self.assertEqual(data["repos"][0]["repo"], "repo-a")

    def test_deepagents_runner_scopes_knowledge_to_one_repo_per_session(self) -> None:
        repo_b = self.ws / "repo-b"
        (repo_b / ".agents" / "knowledge").mkdir(parents=True)
        (repo_b / ".agents" / "knowledge" / "bootstrap.md").write_text(
            "# bootstrap\n", encoding="utf-8"
        )
        model = object()
        sessions = [MagicMock(), MagicMock()]
        sessions[0].run.return_value = DistillationRepo(
            repo="repo-a",
            memory_files_read=["repo-a/decision.md"],
            promoted_count=1,
            dropped_count=0,
            knowledge_files_updated=["repo-a/.agents/knowledge/patterns.md"],
        )
        sessions[1].run.return_value = DistillationRepo(
            repo="repo-b",
            memory_files_read=[],
            promoted_count=0,
            dropped_count=0,
            knowledge_files_updated=[],
        )

        with (
            patch(
                "harness.deepagents.model.resolve_model",
                return_value=ModelChoice("gpt-test", "low"),
            ),
            patch(
                "harness.deepagents.model.build_model",
                return_value=model,
            ),
            patch(
                "harness.deepagents.agents.distillation.DistillationAgent"
            ) as mock_agent,
            patch.object(self.distillation, "trace_span"),
        ):
            mock_agent.return_value.__enter__.side_effect = sessions

            self.distillation.run_distillation_stage(
                run_id="run-1",
                task="task",
                task_key="ABC-1",
                plan_data=self._plan([
                    {"name": "repo-a", "path": str(self.repo)},
                    {"name": "repo-b", "path": str(repo_b)},
                ]),
                events=None,
            )

        self.assertEqual(mock_agent.call_count, 2)
        repo_paths = [call.kwargs["repo_path"] for call in mock_agent.call_args_list]
        self.assertEqual(repo_paths, [self.repo.resolve(), repo_b.resolve()])
        data = json.loads(
            self.distillation.DISTILLATION_JSON.read_text(encoding="utf-8")
        )
        self.assertEqual([r["repo"] for r in data["repos"]], ["repo-a", "repo-b"])

    def test_deepagents_runner_isolates_per_repo_failure(self) -> None:
        repo_b = self.ws / "repo-b"
        (repo_b / ".agents" / "knowledge").mkdir(parents=True)
        (repo_b / ".agents" / "knowledge" / "bootstrap.md").write_text(
            "# bootstrap\n", encoding="utf-8"
        )
        model = object()
        sessions = [MagicMock(), MagicMock()]
        sessions[0].run.side_effect = RuntimeError("bad gateway: retries exhausted")
        sessions[1].run.return_value = DistillationRepo(
            repo="repo-b",
            memory_files_read=["repo-b/decision.md"],
            promoted_count=2,
            dropped_count=0,
            knowledge_files_updated=["repo-b/.agents/knowledge/patterns.md"],
        )

        with (
            patch(
                "harness.deepagents.model.resolve_model",
                return_value=ModelChoice("gpt-test", "low"),
            ),
            patch(
                "harness.deepagents.model.build_model",
                return_value=model,
            ),
            patch(
                "harness.deepagents.agents.distillation.DistillationAgent"
            ) as mock_agent,
            patch.object(self.distillation, "trace_span"),
        ):
            mock_agent.return_value.__enter__.side_effect = sessions

            self.distillation.run_distillation_stage(
                run_id="run-1",
                task="task",
                task_key="ABC-1",
                plan_data=self._plan([
                    {"name": "repo-a", "path": str(self.repo)},
                    {"name": "repo-b", "path": str(repo_b)},
                ]),
                events=None,
            )

        data = json.loads(
            self.distillation.DISTILLATION_JSON.read_text(encoding="utf-8")
        )
        self.assertEqual([r["repo"] for r in data["repos"]], ["repo-a", "repo-b"])
        repo_a_entry = data["repos"][0]
        self.assertIsNotNone(repo_a_entry.get("error"))
        self.assertIn("bad gateway: retries exhausted", repo_a_entry["error"])
        repo_b_entry = data["repos"][1]
        self.assertIsNone(repo_b_entry.get("error"))
        self.assertEqual(repo_b_entry["promoted_count"], 2)
        sessions[1].run.assert_called_once()


class TestCandidateRepoHeadsForRound(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        self.harness_dir = self.ws / ".harness"
        self.harness_dir.mkdir(parents=True)
        self.distillation = _load_distillation_with_workspace(self.ws)
        self.distillation.PLAN_JSON = self.harness_dir / "plan.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _init_git_repo(self, path: Path) -> None:
        path.mkdir(parents=True)
        for args in (
            ["init"],
            ["config", "user.email", "harness@example.com"],
            ["config", "user.name", "Harness"],
        ):
            subprocess.run(
                ["git", "-C", str(path), *args], check=True, capture_output=True
            )
        (path / "README.md").write_text("# repo\n", encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(path), "add", "-A"], check=True, capture_output=True
        )
        subprocess.run(
            ["git", "-C", str(path), "commit", "-m", "initial"],
            check=True,
            capture_output=True,
        )

    def test_missing_plan_json_returns_empty_and_emits_diagnostic(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            heads = self.distillation.candidate_repo_heads_for_round([])

        self.assertEqual(heads, {})
        output = stderr.getvalue()
        self.assertIn("NO candidate repos", output)
        self.assertIn("distillation will be skipped", output)
        self.assertIn("plan.json is missing or unreadable", output)
        self.assertIn(str(self.distillation.PLAN_JSON), output)
        self.assertIn("repo_slugs=[]", output)

    def test_plan_repo_with_checkout_returns_heads_without_diagnostic(self) -> None:
        self._init_git_repo(self.ws / "repo-a")
        self.distillation.PLAN_JSON.write_text(
            json.dumps({"repos": [{"name": "repo-a"}]}), encoding="utf-8"
        )

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            heads = self.distillation.candidate_repo_heads_for_round([])

        self.assertEqual(list(heads), ["repo-a"])
        self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
