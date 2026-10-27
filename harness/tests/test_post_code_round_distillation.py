"""Tests for post-code-round distillation/publish helpers."""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import harness.distillation as distillation_module
import harness.git as git_module
from harness.daemon import DaemonState
from harness.events import RoundEvents
from tests.progress_support import round_events


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        text=True,
        capture_output=True,
    )
    return result.stdout.strip()


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True)
    _git(path, "init")
    _git(path, "config", "user.email", "harness@example.com")
    _git(path, "config", "user.name", "Harness")
    _git(path, "remote", "add", "origin", "https://github.com/acme/repo-a.git")
    (path / "README.md").write_text("# repo-a\n", encoding="utf-8")
    (path / ".agents" / "knowledge").mkdir(parents=True)
    (path / ".agents" / "knowledge" / "patterns.md").write_text(
        "# Patterns\n", encoding="utf-8"
    )
    _git(path, "add", "-A")
    _git(path, "commit", "-m", "initial")
    _git(path, "checkout", "-b", "devbox/ABC-101-work")


def _plan(repo_paths: dict[str, Path]) -> dict[str, object]:
    return {
        "stage": "planning",
        "run_id": "run-1",
        "task": "task",
        "task_key": "ABC-101",
        "status": "completed",
        "repos": [
            {
                "name": name,
                "path": str(path),
                "goal": "g",
                "planned_files_or_areas": [],
                "implementation_steps": [],
                "validation_steps": [],
                "risks": [],
            }
            for name, path in repo_paths.items()
        ],
        "planning_notes": "notes",
        "generated_at": "2026-01-01T00:00:00Z",
    }


def _state(tmp_dir: Path) -> DaemonState:
    processed = tmp_dir / ".processed"
    processed.mkdir(exist_ok=True)
    error = tmp_dir / ".error"
    error.mkdir(exist_ok=True)
    return DaemonState(
        events_file=tmp_dir / "events.jsonl",
        events_lock=tmp_dir / "events.lock",
        processed_dir=processed,
        error_dir=error,
    )


class TestPostCodeRoundDistillation(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        self.harness_dir = self.ws / ".harness"
        self.harness_dir.mkdir()
        self.repo = self.ws / "repo-a"
        _init_repo(self.repo)
        self.plan_json = self.harness_dir / "plan.json"
        self.session_json = self.harness_dir / "session.json"
        self.plan_json.write_text(
            json.dumps(_plan({"repo-a": self.repo, "repo-b": self.ws / "repo-b"})),
            encoding="utf-8",
        )
        self.session_json.write_text(
            json.dumps({
                "run_id": "run-1",
                "task": "task",
                "task_key": "ABC-101",
            }),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    @contextlib.contextmanager
    def _patched_paths(self):
        with (
            patch.object(distillation_module, "WORKSPACE", self.ws),
            patch.object(distillation_module, "PLAN_JSON", self.plan_json),
            patch.object(distillation_module, "SESSION_JSON", self.session_json),
            patch.object(
                distillation_module,
                "DISTILLATION_JSON",
                self.harness_dir / "distillation.json",
            ),
            patch.object(git_module, "WORKSPACE", self.ws),
        ):
            yield

    def test_disabled_distillation_preserves_sync_and_skips_distill_side_effects(
        self,
    ) -> None:
        state = _state(self.harness_dir)
        with (
            self._patched_paths(),
            patch.dict(
                os.environ, {"HARNESS_DISTILLATION_ENABLED": "false"}, clear=False
            ),
            patch.object(distillation_module, "sync_target_repos_before_edit") as sync,
            patch.object(
                distillation_module, "distill_and_publish_changed_repo_knowledge"
            ) as distill,
            distillation_module.post_code_round_distillation(
                state=state,
                inbox_id="inbox-disabled",
                repo_slugs=["acme/repo-a"],
                run_id="run-followup",
                task_key="ENG-2882",
                target_id="target-1",
            ),
        ):
            pass

        sync.assert_called_once_with(["acme/repo-a"])
        distill.assert_not_called()
        self.assertEqual(state.action_bodies(inbox_id="inbox-disabled"), set())

    def test_custom_knowledge_path_is_publishable_and_other_changes_are_not(
        self,
    ) -> None:
        plan_repo = {
            "name": "repo-a",
            "path": str(self.repo),
            "goal": "g",
            "components": [{"name": "api", "path": "services/api"}],
        }
        with patch.dict(
            os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": ".devbox/knowledge"}, clear=False
        ):
            self.assertTrue(
                git_module.is_knowledge_path(".devbox/knowledge/patterns.md")
            )
            self.assertFalse(
                git_module.is_knowledge_path(
                    "services/api/.devbox/knowledge/patterns.md"
                )
            )
            self.assertTrue(
                git_module.is_knowledge_path(
                    "services/api/.devbox/knowledge/patterns.md",
                    plan_repo=plan_repo,
                    workspace=self.ws,
                )
            )
            self.assertFalse(
                git_module.is_knowledge_path("src/.devbox/knowledge/payload.py")
            )
            self.assertFalse(
                git_module.is_knowledge_path("src/.agents/knowledge/payload.py")
            )
            self.assertFalse(git_module.is_knowledge_path("src/knowledge/patterns.md"))
            self.assertFalse(
                git_module.is_knowledge_path(".agents/knowledge/patterns.md")
            )

    def test_single_part_knowledge_path_must_be_repo_root_prefix(self) -> None:
        with patch.dict(
            os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": "knowledge"}, clear=False
        ):
            self.assertTrue(git_module.is_knowledge_path("knowledge/patterns.md"))
            self.assertFalse(git_module.is_knowledge_path("src/knowledge/model.py"))
            self.assertFalse(git_module.is_knowledge_path("docs/knowledge/patterns.md"))

    def test_stray_knowledge_path_is_markdown_in_an_unlisted_knowledge_dir(
        self,
    ) -> None:
        plan_repo = {
            "name": "repo-a",
            "path": str(self.repo),
            "components": [{"name": "api", "path": "services/api"}],
        }

        def stray(path: str) -> bool:
            return git_module.is_stray_knowledge_path(
                path, plan_repo=plan_repo, workspace=self.ws
            )

        self.assertTrue(stray("libs/shared/.agents/knowledge/patterns.md"))
        self.assertTrue(stray("libs/shared/.agents/knowledge/nested/patterns.md"))
        self.assertFalse(stray(".agents/knowledge/patterns.md"))
        self.assertFalse(stray("services/api/.agents/knowledge/patterns.md"))
        self.assertFalse(stray("libs/shared/.agents/knowledge/payload.py"))
        self.assertFalse(stray("libs/shared/knowledge/patterns.md"))
        self.assertFalse(stray("libs/shared/.agents/knowledge.md"))

    def _distill_writing(self, writes: dict[str, str]):
        def fake_distill(*_args, **_kwargs):
            for rel, text in writes.items():
                path = self.repo / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")

        return patch.object(
            distillation_module, "run_distillation_stage", side_effect=fake_distill
        )

    def test_stray_knowledge_is_discarded_and_the_rest_published(self) -> None:
        tracked_stray = self.repo / "libs/shared/.agents/knowledge/old.md"
        tracked_stray.parent.mkdir(parents=True)
        tracked_stray.write_text("# Old\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "shared knowledge")

        with (
            self._patched_paths(),
            self._distill_writing({
                ".agents/knowledge/patterns.md": "# Patterns\n- Fact.\n",
                "libs/shared/.agents/knowledge/old.md": "# Old\n- Stray.\n",
                "libs/shared/.agents/knowledge/new.md": "# New\n",
            }),
            patch.object(
                distillation_module,
                "update_existing_branch",
                return_value={"commit_sha": "abc", "branch": "harness/ENG-2882-work"},
            ) as publish,
        ):
            distillation_module.distill_and_publish_changed_repo_knowledge(
                "run-followup", "ENG-2882", ["repo-a"], events=None
            )

        publish.assert_called_once()
        self.assertEqual(
            git_module.git_dirty_paths(self.repo), [".agents/knowledge/patterns.md"]
        )
        self.assertEqual(tracked_stray.read_text(encoding="utf-8"), "# Old\n")
        self.assertFalse((self.repo / "libs/shared/.agents/knowledge/new.md").exists())

    def test_only_stray_knowledge_publishes_nothing(self) -> None:
        with (
            self._patched_paths(),
            self._distill_writing({"libs/shared/.agents/knowledge/new.md": "# New\n"}),
            patch.object(distillation_module, "update_existing_branch") as publish,
        ):
            distillation_module.distill_and_publish_changed_repo_knowledge(
                "run-followup", "ENG-2882", ["repo-a"], events=None
            )

        publish.assert_not_called()
        self.assertEqual(git_module.git_dirty_paths(self.repo), [])

    def test_non_markdown_in_unlisted_knowledge_dir_still_fails(self) -> None:
        with (
            self._patched_paths(),
            self._distill_writing({
                "libs/shared/.agents/knowledge/run.py": "print('x')\n"
            }),
            patch.object(distillation_module, "update_existing_branch") as publish,
            self.assertRaisesRegex(RuntimeError, "non-knowledge changes"),
        ):
            distillation_module.distill_and_publish_changed_repo_knowledge(
                "run-followup", "ENG-2882", ["repo-a"], events=None
            )

        publish.assert_not_called()

    def test_filters_plan_to_changed_repos_and_publishes_knowledge_delta(self) -> None:
        seen_repos: list[list[str]] = []

        def fake_distill(_run_id, _task, _ticket, plan_data, **_kwargs):
            repos = [repo["name"] for repo in plan_data["repos"]]
            seen_repos.append(repos)
            (self.repo / ".agents" / "knowledge" / "patterns.md").write_text(
                "# Patterns\n\n## ABC-101\n- Durable fact.\n",
                encoding="utf-8",
            )
            (self.harness_dir / "distillation.json").write_text(
                json.dumps({
                    "stage": "distillation",
                    "run_id": "run-followup",
                    "task": "task",
                    "task_key": "ABC-101",
                    "generated_at": "2026-01-01T00:00:00Z",
                    "repos": [
                        {
                            "repo": "repo-a",
                            "memory_files_read": ["decision.md"],
                            "promoted_count": 1,
                            "dropped_count": 0,
                            "knowledge_files_updated": ["patterns.md"],
                            "response_summary": "- `patterns`: Captured durable fact.",
                        }
                    ],
                }),
                encoding="utf-8",
            )

        with (
            self._patched_paths(),
            patch.object(
                distillation_module,
                "run_distillation_stage",
                side_effect=fake_distill,
            ) as distill,
            patch.object(
                distillation_module,
                "update_existing_branch",
                return_value={"commit_sha": "abc", "branch": "devbox/ABC-101-work"},
            ) as publish,
        ):
            result = distillation_module.distill_and_publish_changed_repo_knowledge(
                "run-followup",
                "ABC-101",
                ["repo-a"],
                events=None,
            )

        distill.assert_called_once()
        publish.assert_called_once_with(
            self.repo.resolve(),
            commit_message="chore: distill ABC-101 harness memory",
        )
        self.assertEqual(seen_repos, [["repo-a"]])
        self.assertTrue(result.knowledge_changed)
        self.assertEqual(result.distilled_repo_names, ["repo-a"])
        self.assertEqual(result.knowledge_published[0]["name"], "repo-a")
        self.assertEqual(
            result.response_summary,
            "Recorded knowledge from this round:\n- `patterns`: Captured durable fact.",
        )

    def test_forwards_events_client_to_distillation_stage(self) -> None:
        with (
            self._patched_paths(),
            patch.object(distillation_module, "run_distillation_stage") as distill,
            round_events() as events,
        ):
            distillation_module.distill_and_publish_changed_repo_knowledge(
                "run-followup",
                "ABC-101",
                ["repo-a"],
                events=events,
            )
            distill.assert_called_once()
            self.assertIs(distill.call_args.kwargs["events"], events)
            self.assertNotIn("target_id", distill.call_args.kwargs)

    def test_dirty_worktree_repo_is_skipped_not_fatal(self) -> None:
        (self.repo / "README.md").write_text("# dirty\n", encoding="utf-8")

        with (
            self._patched_paths(),
            patch.object(distillation_module, "run_distillation_stage") as distill,
            patch.object(distillation_module, "update_existing_branch") as publish,
        ):
            result = distillation_module.distill_and_publish_changed_repo_knowledge(
                "run-followup",
                "ABC-101",
                ["repo-a"],
                events=None,
            )

        distill.assert_not_called()
        publish.assert_not_called()
        self.assertEqual(result.changed_repo_names, ["repo-a"])
        self.assertEqual(result.distilled_repo_names, [])
        self.assertEqual(result.knowledge_published, [])
        self.assertFalse(result.distillation_ran)

    def test_no_knowledge_delta_does_not_publish(self) -> None:
        with (
            self._patched_paths(),
            patch.object(distillation_module, "run_distillation_stage") as distill,
            patch.object(distillation_module, "update_existing_branch") as publish,
        ):
            result = distillation_module.distill_and_publish_changed_repo_knowledge(
                "run-followup",
                "ABC-101",
                ["repo-a"],
                events=None,
            )

        distill.assert_called_once()
        publish.assert_not_called()
        self.assertFalse(result.knowledge_changed)
        self.assertTrue(result.distillation_ran)

    def test_response_summary_from_artifact_aggregates_eligible_repos(self) -> None:
        distillation_json = self.harness_dir / "distillation.json"
        distillation_json.write_text(
            json.dumps({
                "stage": "distillation",
                "run_id": "run-followup",
                "task": "task",
                "task_key": "ABC-101",
                "generated_at": "2026-01-01T00:00:00Z",
                "repos": [
                    {
                        "repo": "repo-a",
                        "memory_files_read": ["decision.md"],
                        "promoted_count": 1,
                        "dropped_count": 0,
                        "knowledge_files_updated": ["patterns.md"],
                        "response_summary": "- `patterns`: Captured retry behavior.",
                    },
                    {"repo": "repo-b", "skipped": "no .agents/knowledge/ bootstrap"},
                    {
                        "repo": "repo-c",
                        "memory_files_read": [],
                        "promoted_count": 0,
                        "dropped_count": 0,
                        "knowledge_files_updated": [],
                        "response_summary": "",
                    },
                    {
                        "repo": "repo-d",
                        "memory_files_read": ["feedback.md"],
                        "promoted_count": 1,
                        "dropped_count": 0,
                        "knowledge_files_updated": ["feedback.md"],
                        "response_summary": "- `feedback`: Captured reviewer guidance.",
                    },
                ],
            }),
            encoding="utf-8",
        )

        with self._patched_paths():
            summary = (
                distillation_module.post_code_round_response_summary_from_artifact()
            )

        self.assertEqual(
            summary,
            "Recorded knowledge from this round:\n"
            "- `patterns`: Captured retry behavior.\n"
            "- `feedback`: Captured reviewer guidance.",
        )

    def test_clean_local_knowledge_commit_is_pushed_on_retry(self) -> None:
        remote = self.ws / "origin.git"
        subprocess.run(["git", "init", "--bare", str(remote)], check=True)
        _git(self.repo, "remote", "set-url", "origin", str(remote))
        _git(self.repo, "push", "-u", "origin", "devbox/ABC-101-work")
        (self.repo / ".agents" / "knowledge" / "patterns.md").write_text(
            "# Patterns\n\n## ABC-101\n- Durable fact.\n",
            encoding="utf-8",
        )
        _git(self.repo, "add", ".agents/knowledge/patterns.md")
        _git(self.repo, "commit", "-m", "chore: distill ABC-101 harness memory")

        with (
            self._patched_paths(),
            patch.object(distillation_module, "run_distillation_stage") as distill,
            patch.object(distillation_module, "update_existing_branch") as publish,
        ):
            result = distillation_module.distill_and_publish_changed_repo_knowledge(
                "run-followup",
                "ABC-101",
                ["repo-a"],
                events=None,
            )

        distill.assert_called_once()
        publish.assert_not_called()
        self.assertTrue(result.knowledge_changed)
        self.assertEqual(result.knowledge_published[0]["name"], "repo-a")
        self.assertEqual(
            _git(remote, "rev-parse", "refs/heads/devbox/ABC-101-work"),
            _git(self.repo, "rev-parse", "HEAD"),
        )

    def test_head_snapshot_and_comparison_detects_code_commit(self) -> None:
        with self._patched_paths():
            before = distillation_module.candidate_repo_heads_for_round(["acme/repo-a"])
            (self.repo / "README.md").write_text("# changed\n", encoding="utf-8")
            _git(self.repo, "add", "README.md")
            _git(self.repo, "commit", "-m", "code change")
            changed = git_module.changed_repo_names_since(before)

        self.assertEqual(before.keys(), {"repo-a"})
        self.assertEqual(changed, ["repo-a"])

    def test_unmatched_repo_slug_returns_no_candidates_and_logs(self) -> None:
        with self._patched_paths(), patch("builtins.print") as mock_print:
            candidates = git_module.candidate_repo_names(
                ["acme/does-not-exist"],
                ["repo-a"],
                workspace=self.ws,
            )

        self.assertEqual(candidates, [])
        self.assertTrue(
            any(
                "no local checkout matched" in str(call.args[0])
                for call in mock_print.call_args_list
                if call.args
            ),
            f"expected diagnostic print, got calls: {mock_print.call_args_list}",
        )

    def test_retryable_snapshot_reuses_pre_round_heads_after_restart(self) -> None:
        state = _state(self.harness_dir)
        with self._patched_paths():
            before = distillation_module.retryable_post_code_round_repo_heads(
                state, "inbox-1", ["acme/repo-a"]
            )
            (self.repo / "README.md").write_text("# changed\n", encoding="utf-8")
            _git(self.repo, "add", "README.md")
            _git(self.repo, "commit", "-m", "code change")
            retry_before = distillation_module.retryable_post_code_round_repo_heads(
                state, "inbox-1", ["acme/repo-a"]
            )
            changed = git_module.changed_repo_names_since(retry_before)

        self.assertEqual(retry_before, before)
        self.assertEqual(changed, ["repo-a"])

    def test_distillation_completion_marker_round_trips(self) -> None:
        state = _state(self.harness_dir)
        self.assertFalse(
            distillation_module.post_code_round_distillation_completed(state, "inbox-1")
        )
        distillation_module.mark_post_code_round_distillation_completed(
            state, "inbox-1", ["repo-a"]
        )
        self.assertTrue(
            distillation_module.post_code_round_distillation_completed(state, "inbox-1")
        )

    def test_context_manager_distills_changed_repos_after_successful_body(self) -> None:
        state = _state(self.harness_dir)
        order: list[str] = []

        with (
            patch.object(
                distillation_module,
                "sync_target_repos_before_edit",
                side_effect=lambda _slugs: order.append("sync"),
            ) as sync,
            patch.object(
                distillation_module,
                "retryable_post_code_round_repo_heads",
                side_effect=lambda *_args: (
                    order.append("snapshot") or {"repo-a": "old"}
                ),
            ) as snapshot,
            patch.object(
                distillation_module,
                "changed_repo_names_since",
                side_effect=lambda _heads: order.append("changed") or ["repo-a"],
            ) as changed,
            patch.object(
                distillation_module,
                "post_code_round_distillation_completed",
                return_value=False,
            ) as completed,
            patch.object(
                distillation_module,
                "distill_and_publish_changed_repo_knowledge",
                side_effect=lambda *_args, **_kwargs: (
                    order.append("distill")
                    or distillation_module.PostCodeRoundDistillationResult(
                        response_summary="Recorded knowledge from this round:\n"
                        "- `patterns`: Captured durable fact.",
                        distillation_ran=True,
                    )
                ),
            ) as distill,
            patch.object(
                distillation_module,
                "mark_post_code_round_distillation_completed",
                side_effect=lambda *_args: order.append("mark"),
            ) as mark,
            distillation_module.post_code_round_distillation(
                state=state,
                inbox_id="inbox-1",
                repo_slugs=["acme/repo-a"],
                run_id="run-followup",
                task_key="ABC-101",
                target_id="target-1",
            ),
        ):
            order.append("body")

        sync.assert_called_once_with(["acme/repo-a"])
        snapshot.assert_called_once_with(state, "inbox-1", ["acme/repo-a"])
        changed.assert_called_once_with({"repo-a": "old"})
        completed.assert_called_once_with(state, "inbox-1")
        distill.assert_called_once()
        self.assertEqual(
            distill.call_args.args, ("run-followup", "ABC-101", ["repo-a"])
        )
        self.assertNotIn("target_id", distill.call_args.kwargs)
        round_events = distill.call_args.kwargs["events"]
        self.assertIsInstance(round_events, RoundEvents)
        self.assertEqual(round_events.inbox_id, "inbox-1")
        self.assertEqual(round_events.target_id, "target-1")
        mark.assert_called_once_with(state, "inbox-1", ["repo-a"])
        events = [
            json.loads(line)
            for line in state.events_file.read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["type"], "agent_response")
        self.assertEqual(events[-1]["target_id"], "target-1")
        self.assertEqual(
            events[-1]["body"],
            "Recorded knowledge from this round:\n- `patterns`: Captured durable fact.",
        )
        self.assertEqual(
            order, ["sync", "snapshot", "body", "changed", "distill", "mark"]
        )

    def test_context_manager_emits_fallback_response_without_summary(self) -> None:
        state = _state(self.harness_dir)
        with (
            patch.object(distillation_module, "sync_target_repos_before_edit"),
            patch.object(
                distillation_module,
                "retryable_post_code_round_repo_heads",
                return_value={"repo-a": "old"},
            ),
            patch.object(
                distillation_module,
                "changed_repo_names_since",
                return_value=["repo-a"],
            ),
            patch.object(
                distillation_module,
                "post_code_round_distillation_completed",
                return_value=False,
            ),
            patch.object(
                distillation_module,
                "distill_and_publish_changed_repo_knowledge",
                return_value=distillation_module.PostCodeRoundDistillationResult(
                    distillation_ran=True
                ),
            ),
            patch.object(
                distillation_module, "mark_post_code_round_distillation_completed"
            ),
            distillation_module.post_code_round_distillation(
                state=state,
                inbox_id="inbox-1",
                repo_slugs=["acme/repo-a"],
                run_id="run-followup",
                task_key="ABC-101",
                target_id="target-1",
            ),
        ):
            pass

        events = [
            json.loads(line)
            for line in state.events_file.read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["type"], "agent_response")
        self.assertEqual(events[-1]["body"], "Knowledge distillation completed")

    def test_context_manager_skips_response_when_distillation_did_not_run(self) -> None:
        state = _state(self.harness_dir)
        with (
            patch.object(distillation_module, "sync_target_repos_before_edit"),
            patch.object(
                distillation_module,
                "retryable_post_code_round_repo_heads",
                return_value={"repo-a": "old"},
            ),
            patch.object(
                distillation_module,
                "changed_repo_names_since",
                return_value=["repo-a"],
            ),
            patch.object(
                distillation_module,
                "post_code_round_distillation_completed",
                return_value=False,
            ),
            patch.object(
                distillation_module,
                "distill_and_publish_changed_repo_knowledge",
                return_value=distillation_module.PostCodeRoundDistillationResult(
                    changed_repo_names=["repo-a"],
                    distillation_ran=False,
                ),
            ) as distill,
            patch.object(
                distillation_module, "mark_post_code_round_distillation_completed"
            ) as mark,
            distillation_module.post_code_round_distillation(
                state=state,
                inbox_id="inbox-1",
                repo_slugs=["acme/repo-a"],
                run_id="run-followup",
                task_key="ABC-101",
                target_id="target-1",
            ),
        ):
            pass

        distill.assert_called_once()
        mark.assert_not_called()
        events = (
            [
                json.loads(line)
                for line in state.events_file.read_text(encoding="utf-8").splitlines()
            ]
            if state.events_file.exists()
            else []
        )
        self.assertNotIn("agent_response", {event["type"] for event in events})

    def test_context_manager_skips_distillation_without_changed_repos(self) -> None:
        state = _state(self.harness_dir)
        with (
            patch.object(distillation_module, "sync_target_repos_before_edit"),
            patch.object(
                distillation_module,
                "retryable_post_code_round_repo_heads",
                return_value={"repo-a": "same"},
            ),
            patch.object(
                distillation_module,
                "changed_repo_names_since",
                return_value=[],
            ),
            patch.object(
                distillation_module, "distill_and_publish_changed_repo_knowledge"
            ) as distill,
            patch.object(
                distillation_module, "mark_post_code_round_distillation_completed"
            ) as mark,
            distillation_module.post_code_round_distillation(
                state=state,
                inbox_id="inbox-1",
                repo_slugs=["acme/repo-a"],
                run_id="run-followup",
                task_key="ABC-101",
                target_id="target-1",
            ),
        ):
            pass

        distill.assert_not_called()
        mark.assert_not_called()

    def test_context_manager_skips_distillation_when_already_completed(self) -> None:
        state = _state(self.harness_dir)
        with (
            patch.object(distillation_module, "sync_target_repos_before_edit"),
            patch.object(
                distillation_module,
                "retryable_post_code_round_repo_heads",
                return_value={"repo-a": "old"},
            ),
            patch.object(
                distillation_module,
                "changed_repo_names_since",
                return_value=["repo-a"],
            ),
            patch.object(
                distillation_module,
                "post_code_round_distillation_completed",
                return_value=True,
            ),
            patch.object(
                distillation_module, "distill_and_publish_changed_repo_knowledge"
            ) as distill,
            patch.object(
                distillation_module, "mark_post_code_round_distillation_completed"
            ) as mark,
            distillation_module.post_code_round_distillation(
                state=state,
                inbox_id="inbox-1",
                repo_slugs=["acme/repo-a"],
                run_id="run-followup",
                task_key="ABC-101",
                target_id="target-1",
            ),
        ):
            pass

        distill.assert_not_called()
        mark.assert_not_called()

    def test_context_manager_skips_post_work_when_body_raises(self) -> None:
        state = _state(self.harness_dir)
        with (
            patch.object(distillation_module, "sync_target_repos_before_edit"),
            patch.object(
                distillation_module,
                "retryable_post_code_round_repo_heads",
                return_value={"repo-a": "old"},
            ),
            patch.object(
                distillation_module,
                "changed_repo_names_since",
            ) as changed,
            patch.object(
                distillation_module, "distill_and_publish_changed_repo_knowledge"
            ) as distill,
            self.assertRaisesRegex(RuntimeError, "agent failed"),
            distillation_module.post_code_round_distillation(
                state=state,
                inbox_id="inbox-1",
                repo_slugs=["acme/repo-a"],
                run_id="run-followup",
                task_key="ABC-101",
                target_id="target-1",
            ),
        ):
            raise RuntimeError("agent failed")

        changed.assert_not_called()
        distill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
