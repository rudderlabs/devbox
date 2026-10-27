"""Unit + smoke tests for the inbox event-loop daemon."""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import harness.git as git_module
import harness.handlers.assignment as assignment_module
from harness import daemon as daemon_module
from harness.daemon import (
    DaemonState,
    acquire_flock,
    process_one_inbox_file,
    run_daemon,
)
from harness.events import (
    RETRYABLE_ASSIGNMENT_ERROR_EVENT_FIELD,
    RoundEvents,
    _scan_max_seq,
)
from harness.handlers import _common as common_module


class TestScanMaxSeq(unittest.TestCase):
    """events._scan_max_seq — seq recovery from the events.jsonl tail."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.events = self.dir / "events.jsonl"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_missing_file_seq_zero(self) -> None:
        self.assertEqual(_scan_max_seq(self.events), 0)

    def test_empty_file_seq_zero(self) -> None:
        self.events.write_text("", encoding="utf-8")
        self.assertEqual(_scan_max_seq(self.events), 0)

    def test_multiple_events_returns_max(self) -> None:
        lines = [
            json.dumps({"seq": 1, "type": "a"}),
            json.dumps({"seq": 2, "type": "b"}),
            json.dumps({"seq": 3, "type": "c"}),
        ]
        self.events.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.assertEqual(_scan_max_seq(self.events), 3)

    def test_torn_last_line_tolerated(self) -> None:
        good = json.dumps({"seq": 5, "type": "a"})
        self.events.write_text(good + '\n{"seq": 6, "ty', encoding="utf-8")
        self.assertEqual(_scan_max_seq(self.events), 5)

    def test_out_of_order_seqs_returns_max(self) -> None:
        lines = [
            json.dumps({"seq": 7, "type": "a"}),
            json.dumps({"seq": 2, "type": "b"}),
        ]
        self.events.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.assertEqual(_scan_max_seq(self.events), 7)

    def test_non_object_json_lines_tolerated(self) -> None:
        # A torn line truncating to valid non-object JSON is valid JSON but not
        # a dict — .get() on it would raise AttributeError.
        self.events.write_text(
            '{"seq": 4, "type": "a"}\n42\nnull\n"x"\n[1]\n', encoding="utf-8"
        )
        self.assertEqual(_scan_max_seq(self.events), 4)


class TestDaemonStateAppendEvent(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.events = self.dir / "events.jsonl"
        self.processed = self.dir / ".processed"
        self.processed.mkdir()
        self.error = self.processed.parent / ".error"
        self.events_lock = self.dir / "events.lock"
        self.state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_append_writes_seq_monotonic_lines(self) -> None:
        self.state.append_event({"type": "agent_action", "inbox_id": "x"})
        self.state.append_event({"type": "completed", "inbox_id": "x"})
        lines = self.events.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        e0 = json.loads(lines[0])
        e1 = json.loads(lines[1])
        self.assertEqual(e0["seq"], 1)
        self.assertEqual(e1["seq"], 2)
        self.assertEqual(e0["type"], "agent_action")
        self.assertIn("ts", e0)

    def test_append_continues_seq_after_restart(self) -> None:
        self.state.append_event({"type": "a", "inbox_id": "x"})
        self.state.append_event({"type": "b", "inbox_id": "x"})
        # Simulate daemon restart: new DaemonState recovers seq from tail.
        restarted = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )
        restarted.append_event({"type": "c", "inbox_id": "x"})
        lines = self.events.read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(lines[-1])["seq"], 3)


class TestDaemonStateHasEventFor(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.events = self.dir / "events.jsonl"
        self.processed = self.dir / ".processed"
        self.processed.mkdir()
        self.error = self.processed.parent / ".error"
        self.events_lock = self.dir / "events.lock"
        self.state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_false_when_no_file(self) -> None:
        self.assertFalse(self.state.has_event_for(inbox_id="x", type_="completed"))

    def test_true_after_matching_append(self) -> None:
        self.state.append_event({
            "type": "completed",
            "inbox_id": "abc",
        })
        self.assertTrue(self.state.has_event_for(inbox_id="abc", type_="completed"))

    def test_false_on_type_mismatch(self) -> None:
        self.state.append_event({"type": "agent_action", "inbox_id": "abc"})
        self.assertFalse(self.state.has_event_for(inbox_id="abc", type_="completed"))

    def test_false_on_inbox_id_mismatch(self) -> None:
        self.state.append_event({
            "type": "completed",
            "inbox_id": "abc",
        })
        self.assertFalse(self.state.has_event_for(inbox_id="other", type_="completed"))


class TestAcquireFlock(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.lock = Path(self._tmp.name) / "inbox.lock"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_first_acquire_succeeds(self) -> None:
        fd = acquire_flock(self.lock)
        self.assertIsNotNone(fd)
        assert fd is not None
        os.close(fd)

    def test_second_acquire_blocked_while_held(self) -> None:
        fd1 = acquire_flock(self.lock)
        self.assertIsNotNone(fd1)
        fd2 = acquire_flock(self.lock)
        self.assertIsNone(fd2)
        assert fd1 is not None
        os.close(fd1)

    def test_reacquire_after_release(self) -> None:
        fd1 = acquire_flock(self.lock)
        assert fd1 is not None
        os.close(fd1)  # release
        fd2 = acquire_flock(self.lock)
        self.assertIsNotNone(fd2)
        assert fd2 is not None
        os.close(fd2)


class TestProcessOneInboxFile(unittest.TestCase):
    """Smoke-test process_one_inbox_file / process_assignment with stubbed stages."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.inbox = self.dir / "inbox"
        self.inbox.mkdir()
        self.processed = self.inbox / ".processed"
        self.processed.mkdir()
        self.error = self.processed.parent / ".error"
        self.events_lock = self.dir / "events.lock"
        self.events = self.dir / "events.jsonl"
        self.state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_inbox(self, entry: dict) -> Path:
        f = self.inbox / f"{entry['id']}.json"
        f.write_text(json.dumps(entry), encoding="utf-8")
        return f

    def _events(self) -> list[dict]:
        if not self.events.exists():
            return []
        return [
            json.loads(line)
            for line in self.events.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def _run_full_assignment(self, source: str) -> Path:
        """Run one assignment through every stage (stubbed); assert stage wiring."""
        entry = {
            "id": "inbox-1",
            "kind": "assignment",
            "source": source,
            "payload": {
                "title": "Do the thing",
                "description": "details",
                "task_key": "ABC-1",
                "target_id": "sess-1",
            },
        }
        f = self._write_inbox(entry)

        plan_data = {"repos": [{"name": "repo-a", "path": "/tmp/repo-a"}]}
        impl_data = {"repos": []}
        commit_repos = [
            {
                "name": "repo-a",
                "pr_url": "https://example/pr/1",
                "pr_status": "opened",
                "branch": "devbox/ABC-1-x",
                "commit_sha": "abc123",
            }
        ]

        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan\nbody", encoding="utf-8")
        plan_json = self.dir / "plan.json"
        order: list[str] = []

        def _review_side_effect(*_args, **_kwargs):
            order.append("review")
            return {}, impl_data

        def _distill_side_effect(*_args, **_kwargs):
            order.append("distill")

        def _commit_side_effect(*_args, **_kwargs):
            order.append("commit")
            return "completed", commit_repos

        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ) as mock_plan,
            patch.object(
                assignment_module,
                "_run_implementation_stage",
                return_value=impl_data,
            ) as mock_impl,
            patch.object(
                assignment_module,
                "run_self_review_loop",
                side_effect=_review_side_effect,
            ) as mock_review,
            patch.object(
                assignment_module,
                "_repo_names_with_implementation_changes",
                return_value=["repo-a"],
            ),
            patch.object(
                assignment_module,
                "run_distillation_stage",
                side_effect=_distill_side_effect,
            ) as mock_distill,
            patch.object(
                assignment_module,
                "run_commit_stage",
                side_effect=_commit_side_effect,
            ),
            patch.object(assignment_module, "PLAN_JSON", plan_json),
            patch.object(assignment_module, "PLAN_MD", plan_md),
        ):
            process_one_inbox_file(f, self.state)

        for stage_mock in (mock_plan, mock_impl, mock_review, mock_distill):
            round_events = stage_mock.call_args.kwargs["events"]
            self.assertIsInstance(round_events, RoundEvents)
            self.assertEqual(round_events.inbox_id, "inbox-1")
            self.assertEqual(round_events.target_id, "sess-1")
            self.assertNotIn("target_id", stage_mock.call_args.kwargs)
        self.assertEqual(mock_plan.call_args.args[1], "ABC-1")
        self.assertEqual(mock_impl.call_args.args[0], "ABC-1")
        self.assertEqual(order, ["review", "distill", "commit"])
        return f

    def test_linear_assignment_emits_ordered_events(self) -> None:
        f = self._run_full_assignment("linear")
        types = [e["type"] for e in self._events()]
        self.assertEqual(
            types,
            [
                "agent_action",  # Planning
                "agent_thought",  # plan.md
                "agent_action",  # Implementing
                "agent_action",  # Reviewing
                "agent_action",  # Distilling
                "agent_action",  # Committing
                "pr_opened",
                "agent_response",  # completion message
                "completed",  # bare terminal marker
            ],
        )
        actions = [e.get("body") for e in self._events() if e["type"] == "agent_action"]
        self.assertEqual(
            actions,
            [
                "Entered planning mode",
                "Entered implementation mode",
                "Reviewing",
                "Distilling",
                "Committing",
            ],
        )
        events = self._events()
        # The completion message rides on agent_response; the generic CP
        # forwarder relays it.
        response = events[-2]
        self.assertEqual(response["type"], "agent_response")
        self.assertIsInstance(response["body"], str)
        self.assertTrue(response["body"])
        self.assertIn("Task completed", response["body"])
        # completed is a bare terminal marker: status only, no body/error.
        marker = events[-1]
        self.assertEqual(marker["type"], "completed")
        self.assertEqual(marker["status"], "completed")
        self.assertNotIn("body", marker)
        self.assertNotIn("error", marker)
        # File moved to .processed/.
        self.assertFalse(f.exists())
        self.assertTrue((self.processed / f.name).exists())
        self.assertFalse((self.error / f.name).exists())

    def test_api_assignment_emits_same_events_as_linear(self) -> None:
        def _project(events: list[dict]) -> list[dict]:
            keys = ("type", "inbox_id", "target_id", "body")
            return [{k: e[k] for k in keys if k in e} for e in events]

        self._run_full_assignment("linear")
        linear = _project(self._events())
        # Fresh state so the second run is not skipped as already completed.
        self.events.unlink()
        self.state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )
        self._run_full_assignment("api")
        api = _project(self._events())

        self.assertEqual(len(api), 9)
        self.assertEqual(api, linear)
        self.assertEqual(
            [e["type"] for e in api],
            [
                "agent_action",  # Planning
                "agent_thought",  # plan.md
                "agent_action",  # Implementing
                "agent_action",  # Reviewing
                "agent_action",  # Distilling
                "agent_action",  # Committing
                "pr_opened",
                "agent_response",
                "completed",
            ],
        )
        self.assertEqual(
            [e.get("body") for e in api if e["type"] == "agent_action"],
            [
                "Entered planning mode",
                "Entered implementation mode",
                "Reviewing",
                "Distilling",
                "Committing",
            ],
        )

    def test_assignment_distillation_filters_to_non_knowledge_dirty_repos(
        self,
    ) -> None:
        entry = {
            "id": "inbox-filter-distill",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "Implement only one repo",
                "description": "repo-b was discovery only",
                "task_key": "ABC-1",
                "target_id": "sess-1",
            },
        }
        f = self._write_inbox(entry)

        workspace = self.dir / "workspace"
        for name in ("repo-a", "repo-b", "repo-c"):
            (workspace / name).mkdir(parents=True)
        plan_data = {
            "repos": [
                {
                    "name": "repo-a",
                    "path": "/legacy/repo-a",
                    "goal": "implement",
                    "components": [{"name": "api", "path": "services/api"}],
                },
                {
                    "name": "repo-b",
                    "path": "/legacy/repo-b",
                    "goal": "discover",
                    "components": [{"name": "worker", "path": "workers/job"}],
                },
                {"name": "repo-c", "path": "/legacy/repo-c", "goal": "unchanged"},
                {"name": "repo-missing", "path": "/legacy/repo-missing"},
                {"name": "", "path": "/legacy/empty"},
                "not-a-repo-entry",
            ],
            "planning_notes": "preserve me",
            "extra": {"nested": True},
        }
        original_plan = json.loads(json.dumps(plan_data))
        impl_data = {"repos": []}
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan\nbody", encoding="utf-8")
        plan_json = self.dir / "plan.json"
        impl_json = self.dir / "implementation.json"
        review_json = self.dir / "review.json"
        distillation_json = self.dir / "distillation.json"

        def dirty_paths(repo_path: Path) -> list[str]:
            by_repo = {
                "repo-a": ["src/app.py", ".agents/knowledge/patterns.md"],
                "repo-b": [".agents/knowledge/patterns.md"],
                "repo-c": [],
            }
            return by_repo[repo_path.name]

        with (
            patch.object(assignment_module, "WORKSPACE", workspace),
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ),
            patch.object(
                assignment_module, "_run_implementation_stage", return_value=impl_data
            ),
            patch.object(
                assignment_module, "run_self_review_loop", return_value=({}, impl_data)
            ),
            patch.object(assignment_module, "git_dirty_paths", side_effect=dirty_paths),
            # The malformed plan entries are for the distillation filter; a
            # real plan is validated before implementation looks at its names.
            patch("harness.implementation.implementation_started", return_value=False),
            patch.object(assignment_module, "run_distillation_stage") as distill,
            patch.object(
                assignment_module, "run_commit_stage", return_value=("completed", [])
            ) as commit,
            patch.object(assignment_module, "PLAN_MD", plan_md),
            patch.object(assignment_module, "PLAN_JSON", plan_json),
            patch.object(assignment_module, "IMPLEMENTATION_JSON", impl_json),
            patch.object(assignment_module, "REVIEW_JSON", review_json),
            patch.object(assignment_module, "DISTILLATION_JSON", distillation_json),
        ):
            process_one_inbox_file(f, self.state)

        distill.assert_called_once()
        self.assertEqual(distill.call_args.kwargs["inbox_id"], "inbox-filter-distill")
        distill_plan = distill.call_args.args[3]
        self.assertEqual(distill_plan["planning_notes"], "preserve me")
        self.assertEqual(distill_plan["extra"], {"nested": True})
        self.assertEqual(len(distill_plan["repos"]), 1)
        self.assertEqual(
            distill_plan["repos"][0],
            {
                "name": "repo-a",
                "path": "/legacy/repo-a",
                "goal": "implement",
                "components": [{"name": "api", "path": "services/api"}],
            },
        )
        self.assertEqual(plan_data, original_plan)
        commit.assert_called_once()

    def _run_assignment_with_distillation_artifact(
        self, artifact_inbox_id: str
    ) -> tuple[MagicMock, Path]:
        entry = {
            "id": "inbox-resume-distill",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "Resume after distillation",
                "description": "d",
                "task_key": "ENG-1",
                "target_id": "sess-1",
            },
        }
        f = self._write_inbox(entry)
        workspace = self.dir / "workspace"
        (workspace / "repo-a").mkdir(parents=True)
        plan_data = {"repos": [{"name": "repo-a", "path": "/legacy/repo-a"}]}
        impl_data = {"repos": []}
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan\nbody", encoding="utf-8")
        distillation_json = self.dir / "distillation.json"
        distillation_json.write_text(
            json.dumps({"stage": "distillation", "inbox_id": artifact_inbox_id}),
            encoding="utf-8",
        )

        with (
            patch.object(assignment_module, "WORKSPACE", workspace),
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ),
            patch.object(
                assignment_module, "_run_implementation_stage", return_value=impl_data
            ),
            patch.object(
                assignment_module, "run_self_review_loop", return_value=({}, impl_data)
            ),
            patch.object(
                assignment_module, "git_dirty_paths", return_value=["src/app.py"]
            ),
            patch("harness.implementation.implementation_started", return_value=False),
            patch.object(assignment_module, "run_distillation_stage") as distill,
            patch.object(
                assignment_module, "run_commit_stage", return_value=("completed", [])
            ) as commit,
            patch.object(assignment_module, "PLAN_MD", plan_md),
            patch.object(assignment_module, "PLAN_JSON", self.dir / "plan.json"),
            patch.object(
                assignment_module, "IMPLEMENTATION_JSON", self.dir / "impl.json"
            ),
            patch.object(assignment_module, "REVIEW_JSON", self.dir / "review.json"),
            patch.object(assignment_module, "DISTILLATION_JSON", distillation_json),
        ):
            process_one_inbox_file(f, self.state)

        commit.assert_called_once()
        return distill, distillation_json

    def test_assignment_resume_reuses_distillation_artifact_for_same_inbox(
        self,
    ) -> None:
        distill, distillation_json = self._run_assignment_with_distillation_artifact(
            "inbox-resume-distill"
        )

        distill.assert_not_called()
        self.assertTrue(distillation_json.exists())

    def test_assignment_reruns_distillation_for_artifact_from_other_inbox(
        self,
    ) -> None:
        distill, distillation_json = self._run_assignment_with_distillation_artifact(
            "inbox-previous-task"
        )

        distill.assert_called_once()
        self.assertEqual(distill.call_args.kwargs["inbox_id"], "inbox-resume-distill")
        self.assertFalse(distillation_json.exists())

    def test_assignment_skips_distillation_when_only_knowledge_paths_dirty(
        self,
    ) -> None:
        entry = {
            "id": "inbox-skip-distill",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "No implementation changes",
                "task_key": "ABC-1",
                "target_id": "sess-1",
            },
        }
        f = self._write_inbox(entry)

        workspace = self.dir / "workspace-skip"
        for name in ("repo-a", "repo-b"):
            (workspace / name).mkdir(parents=True)
        plan_data = {
            "repos": [
                {"name": "repo-a", "path": "/legacy/repo-a"},
                {
                    "name": "repo-b",
                    "path": "/legacy/repo-b",
                    "components": [{"name": "api", "path": "services/api"}],
                },
                {"name": "repo-missing", "path": "/legacy/repo-missing"},
            ]
        }
        impl_data = {"repos": []}
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan\nbody", encoding="utf-8")
        plan_json = self.dir / "plan.json"
        impl_json = self.dir / "implementation.json"
        review_json = self.dir / "review.json"
        distillation_json = self.dir / "distillation.json"

        def dirty_paths(repo_path: Path) -> list[str]:
            by_repo = {
                "repo-a": [],
                "repo-b": [
                    ".agents/knowledge/patterns.md",
                    "services/api/.agents/knowledge/feedback.md",
                ],
            }
            return by_repo[repo_path.name]

        with (
            patch.object(assignment_module, "WORKSPACE", workspace),
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ),
            patch.object(
                assignment_module, "_run_implementation_stage", return_value=impl_data
            ),
            patch.object(
                assignment_module, "run_self_review_loop", return_value=({}, impl_data)
            ),
            patch.object(assignment_module, "git_dirty_paths", side_effect=dirty_paths),
            patch.object(assignment_module, "run_distillation_stage") as distill,
            patch.object(
                assignment_module, "run_commit_stage", return_value=("completed", [])
            ) as commit,
            patch.object(assignment_module, "PLAN_MD", plan_md),
            patch.object(assignment_module, "PLAN_JSON", plan_json),
            patch.object(assignment_module, "IMPLEMENTATION_JSON", impl_json),
            patch.object(assignment_module, "REVIEW_JSON", review_json),
            patch.object(assignment_module, "DISTILLATION_JSON", distillation_json),
        ):
            process_one_inbox_file(f, self.state)

        distill.assert_not_called()
        commit.assert_called_once()
        actions = [e.get("body") for e in self._events() if e["type"] == "agent_action"]
        self.assertNotIn("Distilling", actions)

    def test_restart_does_not_reemit_late_stage_announcements(self) -> None:
        # A mid-pipeline restart re-enters process_assignment (no `completed`
        # event yet). The Reviewing/Distilling/Committing announcements must not
        # be re-posted to the user — they are guarded on already-emitted bodies.
        entry = {
            "id": "inbox-1",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "Do the thing",
                "description": "details",
                "task_key": "ABC-1",
                "target_id": "sess-1",
            },
        }
        f = self._write_inbox(entry)

        # Simulate the prior (crashed) attempt having already announced all three.
        for body in ("Reviewing", "Distilling", "Committing"):
            self.state.append_event({
                "type": "agent_action",
                "inbox_id": "inbox-1",
                "target_id": "sess-1",
                "body": body,
            })

        plan_data = {"repos": [{"name": "repo-a", "path": "/tmp/repo-a"}]}
        impl_data = {"repos": []}
        commit_repos = [
            {
                "name": "repo-a",
                "pr_url": "https://example/pr/1",
                "pr_status": "opened",
                "branch": "devbox/ABC-1-x",
                "commit_sha": "abc123",
            }
        ]
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan\nbody", encoding="utf-8")

        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ),
            patch.object(
                assignment_module, "_run_implementation_stage", return_value=impl_data
            ),
            patch.object(
                assignment_module, "run_self_review_loop", return_value=({}, impl_data)
            ),
            patch.object(assignment_module, "run_distillation_stage"),
            patch.object(
                assignment_module,
                "run_commit_stage",
                return_value=("completed", commit_repos),
            ),
            patch.object(assignment_module, "PLAN_MD", plan_md),
        ):
            process_one_inbox_file(f, self.state)

        actions = [e.get("body") for e in self._events() if e["type"] == "agent_action"]
        for body in ("Reviewing", "Distilling", "Committing"):
            self.assertEqual(
                actions.count(body), 1, f"{body} should not be re-emitted on restart"
            )

    def test_no_action_path(self) -> None:
        entry = {
            "id": "inbox-2",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "Nothing to do",
                "task_key": "ABC-2",
                "target_id": "sess-2",
            },
        }
        f = self._write_inbox(entry)

        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module,
                "_run_planning_stage",
                return_value={"repos": []},
            ),
        ):
            process_one_inbox_file(f, self.state)

        events = self._events()
        # No-action message rides on agent_response; marker is bare.
        self.assertEqual(events[-2]["type"], "agent_response")
        self.assertIn("No action needed", events[-2]["body"])
        self.assertEqual(events[-1]["type"], "completed")
        self.assertEqual(events[-1]["status"], "no_action")
        self.assertNotIn("body", events[-1])
        self.assertNotIn("error", events[-1])

    def test_stage_exception_emits_error_and_exits_for_assignment_retry(self) -> None:
        entry = {
            "id": "inbox-3",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "Boom",
                "task_key": "ABC-3",
                "target_id": "sess-3",
            },
        }
        f = self._write_inbox(entry)

        with (
            patch(
                "harness.daemon.process_assignment",
                side_effect=RuntimeError("planning blew up"),
            ),
            self.assertRaises(SystemExit) as ctx,
        ):
            process_one_inbox_file(f, self.state)

        self.assertEqual(ctx.exception.code, 1)
        events = self._events()
        self.assertEqual(len(events), 1)
        # Assignment failure emits only agent_error; no completed marker, because
        # CP must leave the inbox row retryable when the daemon exits non-zero.
        self.assertEqual(events[0]["type"], "agent_error")
        self.assertIn("planning blew up", events[0]["body"])
        self.assertIs(events[0][RETRYABLE_ASSIGNMENT_ERROR_EVENT_FIELD], True)
        # CP's validateHarnessEvent drops any agent_error missing target_id;
        # the round-failure emit must carry it so the body reaches the user.
        self.assertEqual(events[0]["target_id"], "sess-3")
        # The inbox file stays pending for the restarted daemon to re-read.
        self.assertTrue(f.exists())
        self.assertFalse((self.error / f.name).exists())
        self.assertFalse((self.processed / f.name).exists())

    def test_comment_round_failure_emits_agent_error_not_response(self) -> None:
        # Round-failure messages ride on agent_error, not agent_response — CP
        # routes agent_error through emitError on the Linear session
        # (structured error block) rather than as a normal targeted reply.
        # Lines up with the assignment-stage terminal-failure path.
        entry = {
            "id": "inbox-cf",
            "kind": "comment",
            "source": "linear",
            "payload": {
                "target_id": "sess-cf",
                "body": "please review",
                "task_key": "ABC-CF",
            },
        }
        f = self._write_inbox(entry)

        with patch(
            "harness.daemon.process_comment",
            side_effect=RuntimeError("comment dispatch blew up"),
        ):
            process_one_inbox_file(f, self.state)

        events = self._events()
        # Failure body must ride on agent_error with target_id, terminal is bare.
        self.assertEqual(events[-2]["type"], "agent_error")
        self.assertEqual(events[-2]["target_id"], "sess-cf")
        self.assertIn("comment dispatch blew up", events[-2]["body"])
        self.assertEqual(events[-1]["type"], "completed")
        self.assertNotIn("body", events[-1])
        # File routes to .error/, not .processed/.
        self.assertFalse(f.exists())
        self.assertTrue((self.error / f.name).exists())

    def test_review_round_failure_emits_agent_error_and_archives(self) -> None:
        entry = {
            "id": "inbox-rf",
            "kind": "review",
            "source": "github",
            "payload": {
                "review_body": {"target_id": "sess-rf"},
                "comments": [],
            },
        }
        f = self._write_inbox(entry)

        with patch(
            "harness.daemon.process_user_review",
            side_effect=RuntimeError("review dispatch blew up"),
        ):
            process_one_inbox_file(f, self.state)

        events = self._events()
        self.assertEqual(events[-2]["type"], "agent_error")
        self.assertEqual(events[-2]["target_id"], "sess-rf")
        self.assertIn("review dispatch blew up", events[-2]["body"])
        self.assertEqual(events[-1]["type"], "completed")
        self.assertFalse(f.exists())
        self.assertTrue((self.error / f.name).exists())
        self.assertFalse((self.processed / f.name).exists())

    def test_unsupported_kind_exits_the_daemon(self) -> None:
        # An unexpected kind is unrecoverable (daemon image skewed behind CP):
        # the daemon logs and exits. CP's sandbox-liveness reaper fails the
        # task. No events emitted; the file is left in place (not archived).
        entry = {
            "id": "inbox-4",
            "kind": "totally-unknown-kind",
            "source": "github",
            "payload": {},
        }
        f = self._write_inbox(entry)
        with self.assertRaises(SystemExit) as ctx:
            process_one_inbox_file(f, self.state)
        self.assertEqual(ctx.exception.code, 1)
        self.assertEqual(self._events(), [])
        self.assertTrue(f.exists())

    def test_duplicate_assignment_skipped(self) -> None:
        entry = {
            "id": "inbox-5",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "Once",
                "task_key": "ABC-5",
                "target_id": "sess-5",
            },
        }
        f = self._write_inbox(entry)

        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module,
                "_run_planning_stage",
                return_value={"repos": []},
            ),
        ):
            process_one_inbox_file(f, self.state)

        completed_first = sum(1 for e in self._events() if e["type"] == "completed")
        self.assertEqual(completed_first, 1)

        # Restore the inbox file and reprocess — has_event_for must skip it.
        f.write_text(json.dumps(entry), encoding="utf-8")
        with patch.object(
            assignment_module,
            "_run_planning_stage",
            side_effect=AssertionError("should not re-run"),
        ):
            process_one_inbox_file(f, self.state)

        completed_after = sum(1 for e in self._events() if e["type"] == "completed")
        self.assertEqual(completed_after, 1)
        self.assertFalse(f.exists())
        self.assertTrue((self.processed / f.name).exists())
        self.assertFalse((self.error / f.name).exists())

    def test_system_exit_during_dispatch_leaves_inbox_file_for_resume(self) -> None:
        entry = {
            "id": "inbox-exit",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "Interrupted",
                "task_key": "ABC-EXIT",
                "target_id": "sess-exit",
            },
        }
        f = self._write_inbox(entry)

        with (
            patch(
                "harness.daemon.process_assignment",
                side_effect=SystemExit(0),
            ),
            self.assertRaises(SystemExit) as ctx,
        ):
            process_one_inbox_file(f, self.state)

        self.assertEqual(ctx.exception.code, 0)
        self.assertTrue(f.exists())
        self.assertFalse((self.processed / f.name).exists())
        self.assertFalse((self.error / f.name).exists())
        self.assertEqual(self._events(), [])

    def test_keyboard_interrupt_during_dispatch_leaves_inbox_file_for_resume(
        self,
    ) -> None:
        entry = {
            "id": "inbox-keyboard",
            "kind": "comment",
            "source": "linear",
            "payload": {
                "body": "Interrupted",
                "task_key": "ABC-KEY",
                "target_id": "sess-key",
            },
        }
        f = self._write_inbox(entry)

        with (
            patch(
                "harness.daemon.process_comment",
                side_effect=KeyboardInterrupt(),
            ),
            self.assertRaises(KeyboardInterrupt),
        ):
            process_one_inbox_file(f, self.state)

        self.assertTrue(f.exists())
        self.assertFalse((self.processed / f.name).exists())
        self.assertFalse((self.error / f.name).exists())
        self.assertEqual(self._events(), [])

    def test_malformed_json_inbox_file_archived_not_crashed(self) -> None:
        f = self.inbox / "bad.json"
        f.write_text("{not valid json", encoding="utf-8")
        # Must not raise — a bad file crashing the loop would CrashLoopBackOff.
        process_one_inbox_file(f, self.state)
        self.assertFalse(f.exists())
        # Malformed → routed to .error/, not .processed/.
        self.assertTrue((self.error / "bad.json").exists())
        self.assertFalse((self.processed / "bad.json").exists())
        self.assertEqual(self._events(), [])

    def test_inbox_file_missing_required_keys_archived_not_crashed(self) -> None:
        f = self.inbox / "nokeys.json"
        f.write_text(json.dumps({"payload": {}}), encoding="utf-8")  # no id / kind
        process_one_inbox_file(f, self.state)
        self.assertFalse(f.exists())
        self.assertTrue((self.error / "nokeys.json").exists())
        self.assertFalse((self.processed / "nokeys.json").exists())
        self.assertEqual(self._events(), [])

    def test_github_source_skips_agent_emits(self) -> None:
        entry = {
            "id": "inbox-6",
            "kind": "assignment",
            "source": "github",
            "payload": {
                "title": "GH task",
                "target_id": "sess-gh-6",
                "task_key": "ABC-6",
            },
        }
        f = self._write_inbox(entry)

        plan_data = {"repos": [{"name": "r", "path": "/tmp/r"}]}
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan", encoding="utf-8")
        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ),
            patch.object(
                assignment_module,
                "_run_implementation_stage",
                return_value={"repos": []},
            ),
            patch.object(
                assignment_module,
                "run_self_review_loop",
                return_value=({}, {"repos": []}),
            ),
            patch.object(assignment_module, "run_distillation_stage"),
            patch.object(
                assignment_module,
                "run_commit_stage",
                return_value=("completed", []),
            ),
            patch.object(assignment_module, "PLAN_MD", plan_md),
        ):
            process_one_inbox_file(f, self.state)

        types = [e["type"] for e in self._events()]
        # GH-source: no agent_action / agent_thought emits. The completion
        # message (agent_response) and bare marker (completed) are
        # emitted unconditionally — CP's forwarder decides per source.
        self.assertEqual(types, ["agent_response", "completed"])

    def test_assignment_reads_task_key(self) -> None:
        entry = {
            "id": "inbox-tk",
            "kind": "assignment",
            "source": "api",
            "payload": {
                "title": "API task",
                "target_id": "task-uuid-1",
                "task_key": "DBX-API-42",
                "task_id": "task-uuid-1",
            },
        }
        f = self._write_inbox(entry)
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan", encoding="utf-8")
        with (
            patch.object(assignment_module, "setup_workspace") as mock_setup,
            patch.object(
                assignment_module,
                "_run_planning_stage",
                return_value={"repos": [{"name": "r", "path": "/tmp/r"}]},
            ) as mock_plan,
            patch.object(
                assignment_module,
                "_run_implementation_stage",
                return_value={"repos": []},
            ) as mock_impl,
            patch.object(
                assignment_module,
                "run_self_review_loop",
                return_value=({}, {"repos": []}),
            ),
            patch.object(assignment_module, "run_distillation_stage"),
            patch.object(
                assignment_module, "run_commit_stage", return_value=("completed", [])
            ),
            patch.object(assignment_module, "PLAN_MD", plan_md),
        ):
            process_one_inbox_file(f, self.state)

        self.assertEqual(mock_setup.call_args.args[0], "DBX-API-42")
        self.assertEqual(mock_plan.call_args.args[1], "DBX-API-42")
        self.assertEqual(mock_impl.call_args.args[0], "DBX-API-42")
        self.assertTrue((self.processed / f.name).exists())


class TestArchiveMoveFailureDoesNotCrashLoop(unittest.TestCase):
    """An FS error from the post-dispatch archive move must not escape."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.inbox = self.dir / "inbox"
        self.inbox.mkdir()
        self.processed = self.inbox / ".processed"
        self.processed.mkdir()
        self.error = self.processed.parent / ".error"
        self.events_lock = self.dir / "events.lock"
        self.events = self.dir / "events.jsonl"
        self.state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_archive_move_oserror_does_not_propagate(self) -> None:
        entry = {
            "id": "inbox-hb1",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "t",
                "target_id": "sess-hb1",
                "task_key": "ABC-HB1",
            },
        }
        f = self.inbox / f"{entry['id']}.json"
        f.write_text(json.dumps(entry), encoding="utf-8")

        with (
            # Stub process_assignment to a no-op so the test reaches the `finally`
            # archive move cheaply, without a real agent run.
            patch.object(
                daemon_module, "process_assignment", lambda entry, state: None
            ),
            patch.object(
                daemon_module.shutil, "move", side_effect=OSError("disk gone")
            ),
        ):
            # Must NOT raise — a propagating OSError would crash run_daemon's
            # loop into CrashLoopBackOff.
            process_one_inbox_file(f, self.state)

    def test_run_daemon_loop_survives_unexpected_error(self) -> None:
        # A file that makes process_one_inbox_file itself raise must not kill
        # the poll loop. We make iterdir raise after one pass to exit the loop.
        inbox = self.dir / "inbox2"
        inbox.mkdir()
        (inbox / "x.json").write_text("{}", encoding="utf-8")
        events = self.dir / "events2.jsonl"
        lock = self.dir / "inbox2.lock"

        calls = {"n": 0}

        def fake_process(file: Path, state: DaemonState) -> None:
            calls["n"] += 1
            raise RuntimeError("boom in processing")

        def fake_sleep(_seconds: float) -> None:
            # Break the loop after the failing file has been seen once.
            if calls["n"] >= 1:
                raise KeyboardInterrupt

        with (
            patch.object(daemon_module, "process_one_inbox_file", fake_process),
            patch.object(daemon_module, "setup_git_signing"),
            patch.object(daemon_module.time, "sleep", fake_sleep),
            self.assertRaises(KeyboardInterrupt),
        ):
            run_daemon(inbox_dir=inbox, events_file=events, lock_file=lock)
        # The loop reached the sleep-after-failure path instead of crashing out
        # with RuntimeError.
        self.assertGreaterEqual(calls["n"], 1)


class TestNonObjectJsonLineTolerated(unittest.TestCase):
    """Valid-but-non-object JSON lines must not raise AttributeError."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.events = self.dir / "events.jsonl"
        self.processed = self.dir / ".processed"
        self.processed.mkdir()
        self.error = self.processed.parent / ".error"
        self.events_lock = self.dir / "events.lock"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_has_event_for_tolerates_non_object_json(self) -> None:
        self.events.write_text(
            '42\n{"inbox_id": "i", "type": "completed"}\nnull\n',
            encoding="utf-8",
        )
        state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )
        self.assertTrue(state.has_event_for(inbox_id="i", type_="completed"))
        self.assertFalse(state.has_event_for(inbox_id="missing", type_="completed"))


class TestAppendAfterTornLine(unittest.TestCase):
    """Appending after a torn last line must keep the file parseable."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.events = self.dir / "events.jsonl"
        self.processed = self.dir / ".processed"
        self.processed.mkdir()
        self.error = self.processed.parent / ".error"
        self.events_lock = self.dir / "events.lock"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_append_after_torn_line_does_not_fuse(self) -> None:
        # Simulate a crash leaving a torn last line with no trailing newline.
        self.events.write_text(
            '{"seq": 1, "type": "a"}\n{"seq": 2, "ty', encoding="utf-8"
        )
        state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )
        state.append_event({"type": "agent_action", "inbox_id": "x"})

        lines = self.events.read_text(encoding="utf-8").splitlines()
        # The torn fragment stays its own line; the new event is isolated and
        # fully parseable (not fused onto the fragment).
        self.assertEqual(lines[-2], '{"seq": 2, "ty')
        new_event = json.loads(lines[-1])
        self.assertEqual(new_event["type"], "agent_action")
        self.assertEqual(new_event["inbox_id"], "x")
        # Every non-torn line remains parseable.
        parseable = 0
        for line in lines:
            try:
                json.loads(line)
                parseable += 1
            except json.JSONDecodeError:
                pass
        self.assertEqual(parseable, 2)  # line 1 + the new event

    def test_append_to_clean_file_does_not_add_blank_line(self) -> None:
        self.events.write_text('{"seq": 1, "type": "a"}\n', encoding="utf-8")
        state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )
        state.append_event({"type": "b", "inbox_id": "x"})
        lines = self.events.read_text(encoding="utf-8").splitlines()
        # No spurious blank line inserted when the file already ended in \n.
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[1])["type"], "b")


class TestInterruptedRoundResumes(unittest.TestCase):
    """Re-delivery after a mid-pipeline crash resumes the pipeline.

    TestAssignmentResumeOnRestart (below) covers the resume scenarios in
    detail; this class keeps a high-level integration check that verifies the
    old 'pr_opened already exists → do not double-emit' guard also works
    correctly through process_one_inbox_file.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.inbox = self.dir / "inbox"
        self.inbox.mkdir()
        self.processed = self.inbox / ".processed"
        self.processed.mkdir()
        self.error = self.processed.parent / ".error"
        self.events_lock = self.dir / "events.lock"
        self.events = self.dir / "events.jsonl"
        self.state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _events(self) -> list[dict]:
        if not self.events.exists():
            return []
        return [
            json.loads(line)
            for line in self.events.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_partial_run_redelivery_resumes_and_does_not_double_pr(self) -> None:
        entry = {
            "id": "inbox-hb4b",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "Task",
                "task_key": "ABC-9",
                "target_id": "sess-9",
            },
        }
        f = self.inbox / f"{entry['id']}.json"
        f.write_text(json.dumps(entry), encoding="utf-8")

        # Simulate a prior interrupted round: a pr_opened event already exists
        # for this inbox_id, but NO completed (the daemon crashed
        # between the two). The inbox file was never archived.
        self.state.append_event({
            "type": "pr_opened",
            "inbox_id": "inbox-hb4b",
            "repo": "repo-a",
            "pr_url": "https://example/pr/1",
            "branch": "devbox/ABC-9-x",
            "commit_sha": "abc",
        })

        plan_data = {"repos": [{"name": "repo-a", "path": "/tmp/repo-a"}]}
        impl_data = {"repos": []}
        commit_repos = [
            {
                "name": "repo-a",
                "pr_url": "https://example/pr/1",
                "pr_status": "opened",
                "branch": "devbox/ABC-9-x",
                "commit_sha": "abc",
            }
        ]
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan")
        plan_json = self.dir / "plan.json"
        impl_json = self.dir / "implementation.json"
        review_json = self.dir / "review.json"
        distillation_json = self.dir / "distillation.json"

        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ),
            patch.object(
                assignment_module, "_run_implementation_stage", return_value=impl_data
            ),
            patch.object(
                assignment_module, "run_self_review_loop", return_value=({}, impl_data)
            ),
            patch.object(assignment_module, "run_distillation_stage"),
            patch.object(
                assignment_module,
                "run_commit_stage",
                return_value=("completed", commit_repos),
            ),
            patch.object(assignment_module, "PLAN_MD", plan_md),
            patch.object(assignment_module, "PLAN_JSON", plan_json),
            patch.object(assignment_module, "IMPLEMENTATION_JSON", impl_json),
            patch.object(assignment_module, "REVIEW_JSON", review_json),
            patch.object(assignment_module, "DISTILLATION_JSON", distillation_json),
        ):
            process_one_inbox_file(f, self.state)

        events = self._events()
        # Exactly one pr_opened (the original, not re-emitted), one completed.
        self.assertEqual(sum(1 for e in events if e["type"] == "pr_opened"), 1)
        completed = [e for e in events if e["type"] == "completed"]
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]["status"], "completed")
        # No agent_error from the old fail-on-interrupt path.
        self.assertEqual(sum(1 for e in events if e["type"] == "agent_error"), 0)
        # File archived so the loop moves on.
        self.assertFalse(f.exists())
        self.assertTrue((self.processed / f.name).exists())


class TestStartupSigningFailureDoesNotCrashDaemon(unittest.TestCase):
    """A raising startup setup_git_signing must not crash run_daemon.

    Even with required=False, setup_git_signing can raise (partial signing env
    vars, missing/empty key file, a failing gpg/git subprocess). An unguarded
    raise escapes run_daemon -> the process exits -> CrashLoopBackOff. The
    startup call must be best-effort: log + swallow, then enter the poll loop.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_run_daemon_enters_loop_when_startup_signing_raises(self) -> None:
        inbox = self.dir / "inbox"
        events = self.dir / "events.jsonl"
        lock = self.dir / "inbox.lock"

        entered_loop = {"yes": False}

        def fake_sleep(_seconds: float) -> None:
            # First sleep call means the empty-inbox poll loop was reached —
            # i.e. setup_git_signing raised but run_daemon did not crash out.
            entered_loop["yes"] = True
            raise KeyboardInterrupt

        with (
            patch.object(
                daemon_module,
                "setup_git_signing",
                side_effect=RuntimeError("partial signing env vars"),
            ),
            patch.object(daemon_module, "_maybe_init_checkpointer"),
            patch.object(daemon_module, "_maybe_configure_deepagents_logging"),
            patch.object(daemon_module.time, "sleep", fake_sleep),
            self.assertRaises(KeyboardInterrupt),
        ):
            run_daemon(inbox_dir=inbox, events_file=events, lock_file=lock)

        self.assertTrue(
            entered_loop["yes"],
            "run_daemon must reach its poll loop even when startup "
            "setup_git_signing raises",
        )


class TestPollIntervalConfig(unittest.TestCase):
    """HARNESS_POLL_INTERVAL_SECONDS override + fallback behavior."""

    def _interval(self, value: str | None) -> float:
        with patch.dict(os.environ, {}, clear=False):
            if value is None:
                os.environ.pop("HARNESS_POLL_INTERVAL_SECONDS", None)
            else:
                os.environ["HARNESS_POLL_INTERVAL_SECONDS"] = value
            return daemon_module._poll_interval_seconds()

    def test_unset_uses_default(self) -> None:
        self.assertEqual(self._interval(None), 1.0)

    def test_valid_override(self) -> None:
        self.assertEqual(self._interval("0.25"), 0.25)
        self.assertEqual(self._interval("5"), 5.0)

    def test_unparseable_falls_back(self) -> None:
        self.assertEqual(self._interval("fast"), 1.0)
        self.assertEqual(self._interval(""), 1.0)

    def test_non_positive_falls_back(self) -> None:
        self.assertEqual(self._interval("0"), 1.0)
        self.assertEqual(self._interval("-3"), 1.0)


class TestFormatCompletionBody(unittest.TestCase):
    """_format_completion_body builds the user-facing completion message."""

    def _format(self, summary_repos, plan_data, impl_data, status):
        return assignment_module._format_completion_body(
            summary_repos, plan_data, impl_data, status
        )

    def test_completed_recap_before_pr_list(self) -> None:
        body = self._format(
            [
                {
                    "name": "repo-a",
                    "pr_url": "https://github.com/o/repo-a/pull/1",
                    "pr_status": "opened",
                }
            ],
            {"repos": [{"name": "repo-a", "goal": "add retry"}]},
            {"repos": [{"name": "repo-a", "summary": "backoff added"}]},
            "completed",
        )
        self.assertIn("Task completed", body)
        # Recap section.
        self.assertIn("_Planned:_ add retry", body)
        self.assertIn("_Done:_ backoff added", body)
        # PR list section.
        self.assertIn("Pull requests", body)
        self.assertIn("https://github.com/o/repo-a/pull/1", body)
        # Recap must appear before the Pull requests section.
        self.assertLess(body.index("_Planned:_"), body.index("Pull requests"))

    def test_partial_failure(self) -> None:
        body = self._format(
            [
                {
                    "name": "repo-ok",
                    "pr_url": "https://github.com/o/repo-ok/pull/1",
                    "pr_status": "opened",
                },
                {
                    "name": "repo-bad",
                    "pr_url": None,
                    "pr_status": "push_failed",
                },
            ],
            {"repos": [{"name": "repo-ok", "goal": "planned ok"}]},
            {"repos": [{"name": "repo-ok", "summary": "did ok"}]},
            "partial_failure",
        )
        self.assertIn("partially completed", body)
        # Recap of the opened repo.
        self.assertIn("_Planned:_ planned ok", body)
        self.assertIn("_Done:_ did ok", body)
        # Failed section.
        self.assertIn("Failed:", body)
        self.assertIn("repo-bad (push failed)", body)
        # PR list of the opened repo.
        self.assertIn("Pull requests", body)
        self.assertIn("https://github.com/o/repo-ok/pull/1", body)

    def test_completed_no_opened_repos(self) -> None:
        body = self._format([], {"repos": []}, {"repos": []}, "completed")
        self.assertIn("No pull requests were opened.", body)

    def test_failed_renders_failure_not_success(self) -> None:
        # status='failed' (every repo failed to open a PR) must NOT render the
        # ✅ completed message — it is a failure, surfaced via agent_error.
        body = self._format(
            [
                {"name": "repo-a", "pr_url": None, "pr_status": "push_failed"},
                {"name": "repo-b", "pr_url": None, "pr_status": "pr_failed"},
            ],
            {"repos": [{"name": "repo-a", "goal": "g"}]},
            {"repos": []},
            "failed",
        )
        self.assertIn("Task failed", body)
        self.assertNotIn("Task completed", body)
        self.assertNotIn("✅", body)
        self.assertIn("Failed:", body)
        self.assertIn("repo-a (push failed)", body)
        self.assertIn("repo-b (pr failed)", body)

    def test_failed_does_not_list_no_changes_as_failed(self) -> None:
        body = self._format(
            [
                {"name": "repo-a", "pr_url": None, "pr_status": "no_changes"},
                {"name": "repo-b", "pr_url": None, "pr_status": "push_failed"},
            ],
            {"repos": []},
            {"repos": []},
            "failed",
        )
        self.assertIn("Task failed", body)
        self.assertIn("repo-b (push failed)", body)
        self.assertNotIn("repo-a (no changes)", body)

    def test_repo_without_summary_dropped_from_recap(self) -> None:
        body = self._format(
            [
                {
                    "name": "repo-a",
                    "pr_url": "https://github.com/o/repo-a/pull/9",
                    "pr_status": "opened",
                }
            ],
            {"repos": []},
            {"repos": []},
            "completed",
        )
        self.assertIn("Task completed", body)
        # No recap lines.
        self.assertNotIn("_Planned:_", body)
        self.assertNotIn("_Done:_", body)
        # Still in the PR list.
        self.assertIn("Pull requests", body)
        self.assertIn("https://github.com/o/repo-a/pull/9", body)


class TestRunCommitStageNoOpClassification(unittest.TestCase):
    def test_no_working_tree_change_is_not_a_failure(self) -> None:
        impl = {"repos": [{"name": "repo-a"}]}
        with (
            patch.object(assignment_module, "GitHubClient"),
            patch.object(
                assignment_module,
                "_commit_and_open_pr",
                side_effect=assignment_module.CommitPublishError(
                    "No working tree changes in /tmp/repo-a",
                    branch="devbox/repo-a",
                ),
            ),
        ):
            status, repos = assignment_module.run_commit_stage(None, "inbox-x", impl)

        self.assertEqual(status, "completed")
        self.assertEqual(
            repos,
            [
                {
                    "name": "repo-a",
                    "pr_url": None,
                    "pr_status": "no_changes",
                    "branch": "devbox/repo-a",
                    "commit_sha": None,
                }
            ],
        )

    def test_real_publish_failure_stays_failed(self) -> None:
        impl = {"repos": [{"name": "repo-a"}]}
        with (
            patch.object(assignment_module, "GitHubClient"),
            patch.object(
                assignment_module,
                "_commit_and_open_pr",
                side_effect=assignment_module.CommitPublishError(
                    "git push failed for /tmp/repo-a: auth denied",
                    branch="devbox/repo-a",
                ),
            ),
        ):
            status, repos = assignment_module.run_commit_stage(None, "inbox-x", impl)

        self.assertEqual(status, "failed")
        self.assertEqual(repos[0]["pr_status"], "push_failed")

    def test_legacy_ready_to_commit_false_still_publishes(self) -> None:
        impl = {"repos": [{"name": "repo-a", "ready_to_commit": False}]}
        with (
            patch.object(assignment_module, "GitHubClient"),
            patch.object(
                assignment_module,
                "_commit_and_open_pr",
                return_value={
                    "pr_url": "https://github.com/o/repo-a/pull/1",
                    "branch": "devbox/repo-a",
                    "commit_sha": "abc123",
                },
            ) as commit,
        ):
            status, repos = assignment_module.run_commit_stage(None, "inbox-x", impl)

        commit.assert_called_once()
        self.assertEqual(status, "completed")
        self.assertEqual(repos[0]["pr_status"], "opened")


class TestSyncTargetReposBeforeEdit(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name)
        self.repo_a = self.workspace / "repo-a"
        self.repo_b = self.workspace / "repo-b"
        for repo in (self.repo_a, self.repo_b):
            (repo / ".git").mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_sync_failure_does_not_raise(self) -> None:
        def fake_parse(path: Path) -> tuple[str, str]:
            if path == self.repo_a:
                return ("acme", "widgets")
            if path == self.repo_b:
                return ("acme", "other-repo")
            raise RuntimeError("unexpected repo")

        with (
            patch.object(git_module, "WORKSPACE", self.workspace),
            patch.object(
                git_module,
                "parse_owner_repo_from_git_remote",
                side_effect=fake_parse,
            ),
            patch.object(
                git_module,
                "sync_current_branch_from_origin",
                side_effect=[RuntimeError("pull failed"), None],
            ) as sync_repo,
            patch("builtins.print") as mocked_print,
        ):
            git_module.sync_target_repos_before_edit([
                "acme/widgets",
                "other-repo",
            ])

        self.assertEqual(sync_repo.call_count, 2)
        mocked_print.assert_called_once()
        self.assertIn("sync failed", mocked_print.call_args.args[0])

    def test_no_matched_repo_still_raises(self) -> None:
        with (
            patch.object(git_module, "WORKSPACE", self.workspace),
            patch.object(
                git_module,
                "parse_owner_repo_from_git_remote",
                return_value=("acme", "unrelated"),
            ),
            self.assertRaises(RuntimeError),
        ):
            git_module.sync_target_repos_before_edit(["widgets"])


class TestFinalizeCommentRoundNoPublish(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.events = self.dir / "events.jsonl"
        self.processed = self.dir / ".processed"
        self.processed.mkdir()
        self.error = self.dir / ".error"
        self.events_lock = self.dir / "events.lock"


class TestCiResultDispatch(unittest.TestCase):
    """ci_result inbox kind is dispatched to process_ci_result."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.inbox = self.dir / "inbox"
        self.inbox.mkdir()
        self.processed = self.inbox / ".processed"
        self.processed.mkdir()
        self.error = self.inbox / ".error"
        self.error.mkdir()
        self.events_lock = self.dir / "events.lock"
        self.events = self.dir / "events.jsonl"
        self.state = DaemonState(
            events_file=self.events,
            events_lock=self.events_lock,
            processed_dir=self.processed,
            error_dir=self.error,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_inbox(self, entry: dict) -> Path:
        f = self.inbox / f"{entry['id']}.json"
        f.write_text(json.dumps(entry), encoding="utf-8")
        return f

    def _events(self) -> list[dict]:
        if not self.events.exists():
            return []
        return [
            json.loads(line)
            for line in self.events.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_finalize_only_backfills_and_completes(self) -> None:
        common_module.fill_missed_replies_and_complete_round(
            self.state,
            "inbox-1",
            ordered_target_ids=["t1"],
        )

        events = self._events()
        self.assertEqual(events[-2]["type"], "agent_response")
        self.assertIn("didn't post a reply", events[-2]["body"])
        self.assertEqual(events[-1]["type"], "completed")

    def test_ci_result_dispatches_to_handler(self) -> None:
        entry = {
            "id": "inbox-ci-d1",
            "kind": "ci_result",
            "source": "github",
            "payload": {
                "target_id": "tgt-ci-d1",
                "workflow_name": "CI",
                "run_url": "https://github.com/owner/repo/actions/runs/99",
                "conclusion": "failure",
            },
        }
        f = self._write_inbox(entry)

        with patch(
            "harness.daemon.process_ci_result",
            lambda entry, state: state.append_event({
                "type": "completed",
                "inbox_id": entry["id"],
            }),
        ):
            process_one_inbox_file(f, self.state)

        events = self._events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "completed")
        self.assertFalse(f.exists())
        self.assertTrue((self.processed / f.name).exists())

    def test_ci_result_round_failure_emits_agent_error(self) -> None:
        entry = {
            "id": "inbox-ci-d2",
            "kind": "ci_result",
            "source": "github",
            "payload": {
                "target_id": "tgt-ci-d2",
                "workflow_name": "CI",
                "run_url": "https://github.com/owner/repo/actions/runs/99",
                "conclusion": "failure",
            },
        }
        f = self._write_inbox(entry)

        with patch(
            "harness.daemon.process_ci_result",
            side_effect=RuntimeError("ci handler blew up"),
        ):
            process_one_inbox_file(f, self.state)

        events = self._events()
        self.assertEqual(events[-2]["type"], "agent_error")
        self.assertEqual(events[-2]["target_id"], "tgt-ci-d2")
        self.assertIn("ci handler blew up", events[-2]["body"])
        self.assertEqual(events[-1]["type"], "completed")
        self.assertFalse(f.exists())
        self.assertTrue((self.error / f.name).exists())


class TestOpenedRepoNames(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.state = DaemonState(
            events_file=self.dir / "events.jsonl",
            events_lock=self.dir / "events.lock",
            processed_dir=self.dir / "p",
            error_dir=self.dir / "e",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_collects_pr_opened_repo_names_for_inbox(self) -> None:
        self.state.append_event({"type": "pr_opened", "inbox_id": "i1", "repo": "a"})
        self.state.append_event({"type": "pr_opened", "inbox_id": "i1", "repo": "b"})
        self.state.append_event({"type": "pr_opened", "inbox_id": "i2", "repo": "c"})
        self.assertEqual(self.state.opened_repo_names(inbox_id="i1"), {"a", "b"})

    def test_empty_when_no_events(self) -> None:
        self.assertEqual(self.state.opened_repo_names(inbox_id="i1"), set())


class TestStageDriverSelfSkip(unittest.TestCase):
    # Minimal plan fixture that satisfies validate_plan.
    _PLAN_DATA: ClassVar[dict] = {
        "stage": "planning",
        "run_id": "run-1",
        "task": "task",
        "status": "completed",
        "repos": [],
        "planning_notes": "",
        "generated_at": "2026-01-01T00:00:00Z",
        "task_key": "ABC-1",
    }

    # Minimal implementation fixture that satisfies validate_implementation.
    _IMPL_DATA: ClassVar[dict] = {
        "stage": "implementation",
        "run_id": "run-1",
        "task": "task",
        "status": "completed",
        "repos": [],
        "generated_at": "2026-01-01T00:00:00Z",
        "task_key": "ABC-1",
    }

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.plan = self.dir / "plan.json"
        self.impl = self.dir / "implementation.json"
        self.review = self.dir / "review.json"
        self.distillation = self.dir / "distillation.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _planning_model(self, **updates):
        from harness.schemas import Plan

        return Plan.model_validate({**self._PLAN_DATA, **updates})

    def test_planning_skips_when_plan_json_present(self) -> None:
        plan_data = self._PLAN_DATA.copy()
        plan_data["inbox_id"] = "inbox-1"
        self.plan.write_text(json.dumps(plan_data), encoding="utf-8")
        with (
            patch.object(assignment_module, "PLAN_JSON", self.plan),
            patch("harness.planning.run_planning") as run_planning,
        ):
            out = assignment_module._run_planning_stage(
                "task",
                "ABC-1",
                "run-1",
                "inbox-1",
                events=None,
            )
        run_planning.assert_not_called()
        self.assertEqual(out, plan_data)

    def test_planning_runs_when_plan_json_absent(self) -> None:
        plan = self._planning_model(planning_notes="deepagents plan")
        with (
            patch.object(assignment_module, "PLAN_JSON", self.plan),
            patch.object(assignment_module, "PLAN_MD", self.dir / "plan.md"),
            patch("harness.planning.run_planning", return_value=plan) as run_planning,
            patch.object(
                assignment_module,
                "timed_stage",
                wraps=assignment_module.timed_stage,
            ) as timed_stage,
        ):
            out = assignment_module._run_planning_stage(
                "task",
                "ABC-1",
                "run-1",
                "inbox-da",
                events=None,
            )

        run_planning.assert_called_once_with(
            task="task",
            task_key="ABC-1",
            run_id="run-1",
            events=None,
        )
        timed_stage.assert_called_once_with(
            assignment_module.Stage.PLANNING, run_id="run-1", task_key="ABC-1"
        )
        self.assertEqual(out["inbox_id"], "inbox-da")
        on_disk = json.loads(self.plan.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["inbox_id"], "inbox-da")
        self.assertIn(
            "deepagents plan", (self.dir / "plan.md").read_text(encoding="utf-8")
        )

    def test_planning_stamps_inbox_id_on_fresh_run(self) -> None:
        plan = self._planning_model()

        with (
            patch.object(assignment_module, "PLAN_JSON", self.plan),
            patch.object(assignment_module, "PLAN_MD", self.dir / "plan.md"),
            patch("harness.planning.run_planning", return_value=plan),
        ):
            assignment_module._run_planning_stage(
                "task",
                "ABC-1",
                "run-1",
                "inbox-42",
                events=None,
            )
        on_disk = json.loads(self.plan.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["inbox_id"], "inbox-42")

    def test_planning_runs_fresh_on_inbox_id_mismatch(self) -> None:
        old_plan_data = self._PLAN_DATA.copy()
        old_plan_data["inbox_id"] = "inbox-old"
        self.plan.write_text(json.dumps(old_plan_data), encoding="utf-8")
        self.impl.write_text("stale implementation", encoding="utf-8")
        self.review.write_text("stale review", encoding="utf-8")
        self.distillation.write_text("stale distillation", encoding="utf-8")

        plan = self._planning_model()

        buf = io.StringIO()
        with (
            patch.object(assignment_module, "PLAN_JSON", self.plan),
            patch.object(assignment_module, "PLAN_MD", self.dir / "plan.md"),
            patch.object(assignment_module, "IMPLEMENTATION_JSON", self.impl),
            patch.object(assignment_module, "REVIEW_JSON", self.review),
            patch.object(assignment_module, "DISTILLATION_JSON", self.distillation),
            patch("harness.planning.run_planning", return_value=plan) as run_planning,
            contextlib.redirect_stderr(buf),
        ):
            out = assignment_module._run_planning_stage(
                "task",
                "ABC-1",
                "run-1",
                "inbox-new",
                events=None,
            )
        run_planning.assert_called_once()
        self.assertEqual(out["inbox_id"], "inbox-new")
        self.assertEqual(
            {k: v for k, v in out.items() if k != "inbox_id"}, self._PLAN_DATA
        )
        captured = buf.getvalue()
        self.assertIn("ignoring stale plan.json", captured)
        self.assertIn("inbox-old", captured)
        self.assertIn("inbox-new", captured)
        self.assertFalse(self.impl.exists())
        self.assertFalse(self.review.exists())
        self.assertFalse(self.distillation.exists())

    def test_planning_reruns_when_unstamped(self) -> None:
        plan_data = self._PLAN_DATA.copy()  # no inbox_id key
        self.plan.write_text(json.dumps(plan_data), encoding="utf-8")

        plan = self._planning_model()

        buf = io.StringIO()
        with (
            patch.object(assignment_module, "PLAN_JSON", self.plan),
            patch.object(assignment_module, "PLAN_MD", self.dir / "plan.md"),
            patch.object(assignment_module, "IMPLEMENTATION_JSON", self.impl),
            patch.object(assignment_module, "REVIEW_JSON", self.review),
            patch.object(assignment_module, "DISTILLATION_JSON", self.distillation),
            patch("harness.planning.run_planning", return_value=plan) as run_planning,
            contextlib.redirect_stderr(buf),
        ):
            out = assignment_module._run_planning_stage(
                "task",
                "ABC-1",
                "run-1",
                "inbox-new",
                events=None,
            )
        run_planning.assert_called_once()
        self.assertEqual(out["inbox_id"], "inbox-new")
        self.assertIn("ignoring stale plan.json", buf.getvalue())

    def test_implementation_stamps_inbox_id_on_fresh_run(self) -> None:
        impl_data = self._IMPL_DATA.copy()

        def fake_stage(*a, **k):
            self.impl.write_text(json.dumps(impl_data), encoding="utf-8")

        with (
            patch.object(assignment_module, "IMPLEMENTATION_JSON", self.impl),
            patch("harness.implementation.run_implementation", side_effect=fake_stage),
        ):
            assignment_module._run_implementation_stage(
                "ABC-1",
                "run-1",
                "inbox-42",
                self._PLAN_DATA.copy(),
                events=None,
            )
        on_disk = json.loads(self.impl.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["inbox_id"], "inbox-42")

    def test_unstamped_implementation_runs_fresh_and_keeps_the_workers_output(
        self,
    ) -> None:
        self.impl.write_text(json.dumps(self._IMPL_DATA.copy()), encoding="utf-8")

        def fake_stage(*a, **k):
            self.impl.write_text(json.dumps(self._IMPL_DATA.copy()), encoding="utf-8")

        with (
            patch.object(assignment_module, "IMPLEMENTATION_JSON", self.impl),
            patch(
                "harness.implementation.run_implementation", side_effect=fake_stage
            ) as run_impl,
        ):
            out = assignment_module._run_implementation_stage(
                "ABC-1",
                "run-1",
                "inbox-42",
                self._PLAN_DATA.copy(),
                events=None,
            )

        run_impl.assert_called_once()
        self.assertEqual(run_impl.call_args.kwargs["inbox_id"], "inbox-42")
        self.assertEqual(run_impl.call_args.kwargs["plan"].run_id, "run-1")
        # The workers' implementation.json is final: no coordinator pass runs
        # after them, so the stage only stamps the inbox id.
        expected = {**self._IMPL_DATA, "inbox_id": "inbox-42"}
        self.assertEqual(out, expected)
        self.assertEqual(json.loads(self.impl.read_text(encoding="utf-8")), expected)

    def test_implementation_runs_fresh_on_inbox_id_mismatch(self) -> None:
        old_impl_data = self._IMPL_DATA.copy()
        old_impl_data["inbox_id"] = "inbox-old"
        self.impl.write_text(json.dumps(old_impl_data), encoding="utf-8")
        self.review.write_text("stale review", encoding="utf-8")
        self.distillation.write_text("stale distillation", encoding="utf-8")

        new_impl_data = self._IMPL_DATA.copy()

        def fake_stage(*a, **k):
            self.impl.write_text(json.dumps(new_impl_data), encoding="utf-8")

        buf = io.StringIO()
        with (
            patch.object(assignment_module, "IMPLEMENTATION_JSON", self.impl),
            patch.object(assignment_module, "REVIEW_JSON", self.review),
            patch.object(assignment_module, "DISTILLATION_JSON", self.distillation),
            patch(
                "harness.implementation.run_implementation", side_effect=fake_stage
            ) as run_impl,
            contextlib.redirect_stderr(buf),
        ):
            out = assignment_module._run_implementation_stage(
                "ABC-1",
                "run-1",
                "inbox-new",
                self._PLAN_DATA.copy(),
                events=None,
            )
        run_impl.assert_called_once()
        self.assertEqual(out["inbox_id"], "inbox-new")
        self.assertEqual(
            {k: v for k, v in out.items() if k != "inbox_id"}, self._IMPL_DATA
        )
        captured = buf.getvalue()
        self.assertIn("ignoring stale implementation.json", captured)
        self.assertIn("inbox-old", captured)
        self.assertIn("inbox-new", captured)
        self.assertFalse(self.review.exists())
        self.assertFalse(self.distillation.exists())


class TestAssignmentResumeOnRestart(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.inbox = self.dir / "inbox"
        self.inbox.mkdir()
        self.processed = self.inbox / ".processed"
        self.processed.mkdir()
        self.error = self.inbox / ".error"
        self.events = self.dir / "events.jsonl"
        self.state = DaemonState(
            events_file=self.events,
            events_lock=self.dir / "events.lock",
            processed_dir=self.processed,
            error_dir=self.error,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _entry(self) -> dict:
        return {
            "id": "inbox-1",
            "kind": "assignment",
            "source": "linear",
            "payload": {
                "title": "T",
                "description": "d",
                "task_key": "ABC-1",
                "target_id": "sess-1",
            },
        }

    def _events(self) -> list[dict]:
        if not self.events.exists():
            return []
        return [
            json.loads(l) for l in self.events.read_text().splitlines() if l.strip()
        ]

    def test_interrupted_round_resumes_and_completes(self) -> None:
        # A prior attempt emitted progress and a retryable daemon error, but no
        # `completed`. The eventual terminal success response must still post.
        self.state.append_event({
            "type": "agent_action",
            "inbox_id": "inbox-1",
            "target_id": "sess-1",
            "body": "Entered planning mode",
        })
        self.state.append_event({
            "type": "agent_error",
            "inbox_id": "inbox-1",
            "target_id": "sess-1",
            "body": "RuntimeError: transient model outage",
            RETRYABLE_ASSIGNMENT_ERROR_EVENT_FIELD: True,
        })
        f = self.inbox / "inbox-1.json"
        f.write_text(json.dumps(self._entry()))

        plan_data = {"repos": [{"name": "r", "path": "/tmp/r"}]}
        impl_data = {"repos": []}
        commit_repos = [
            {
                "name": "r",
                "pr_url": "https://e/pr/1",
                "pr_status": "opened",
                "branch": "b",
                "commit_sha": "s",
            }
        ]
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan")
        plan_json = self.dir / "plan.json"
        impl_json = self.dir / "implementation.json"
        review_json = self.dir / "review.json"
        distillation_json = self.dir / "distillation.json"

        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ),
            patch.object(
                assignment_module, "_run_implementation_stage", return_value=impl_data
            ),
            patch.object(
                assignment_module, "run_self_review_loop", return_value=({}, impl_data)
            ),
            patch.object(assignment_module, "run_distillation_stage"),
            patch.object(
                assignment_module,
                "run_commit_stage",
                return_value=("completed", commit_repos),
            ),
            patch.object(assignment_module, "PLAN_MD", plan_md),
            patch.object(assignment_module, "PLAN_JSON", plan_json),
            patch.object(assignment_module, "IMPLEMENTATION_JSON", impl_json),
            patch.object(assignment_module, "REVIEW_JSON", review_json),
            patch.object(assignment_module, "DISTILLATION_JSON", distillation_json),
        ):
            process_one_inbox_file(f, self.state)

        types = [e["type"] for e in self._events()]
        # Resumed to completion with one retryable error, one success response,
        # and exactly one terminal marker.
        self.assertEqual(types[-1], "completed")
        responses = [e for e in self._events() if e["type"] == "agent_response"]
        self.assertEqual(len(responses), 1)
        self.assertIn("Task completed", responses[0]["body"])
        self.assertEqual(sum(1 for t in types if t == "agent_error"), 1)
        self.assertEqual(
            next(e for e in self._events() if e["type"] == "completed")["status"],
            "completed",
        )
        self.assertEqual(sum(1 for t in types if t == "completed"), 1)

    def test_pr_opened_not_re_emitted_when_already_recorded(self) -> None:
        # Prior attempt already opened the PR for repo "r".
        self.state.append_event({
            "type": "pr_opened",
            "inbox_id": "inbox-1",
            "repo": "r",
            "pr_url": "https://e/pr/1",
        })
        f = self.inbox / "inbox-1.json"
        f.write_text(json.dumps(self._entry()))

        plan_data = {"repos": [{"name": "r", "path": "/tmp/r"}]}
        impl_data = {"repos": []}
        commit_repos = [
            {
                "name": "r",
                "pr_url": "https://e/pr/1",
                "pr_status": "opened",
                "branch": "b",
                "commit_sha": "s",
            }
        ]
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan")

        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ),
            patch.object(
                assignment_module, "_run_implementation_stage", return_value=impl_data
            ),
            patch.object(
                assignment_module, "run_self_review_loop", return_value=({}, impl_data)
            ),
            patch.object(assignment_module, "run_distillation_stage"),
            patch.object(
                assignment_module,
                "run_commit_stage",
                return_value=("completed", commit_repos),
            ),
            patch.object(assignment_module, "PLAN_MD", plan_md),
        ):
            process_one_inbox_file(f, self.state)

        pr_events = [e for e in self._events() if e["type"] == "pr_opened"]
        self.assertEqual(len(pr_events), 1)  # the pre-existing one only

    def test_completed_assignment_still_skipped(self) -> None:
        self.state.append_event({
            "type": "completed",
            "inbox_id": "inbox-1",
            "status": "completed",
        })
        f = self.inbox / "inbox-1.json"
        f.write_text(json.dumps(self._entry()))
        with patch.object(assignment_module, "setup_workspace") as setup:
            process_one_inbox_file(f, self.state)
        setup.assert_not_called()
        self.assertFalse(f.exists())
        self.assertTrue((self.processed / f.name).exists())
        self.assertFalse((self.error / f.name).exists())


class TestMaybeInitCheckpointer(unittest.TestCase):
    """daemon._maybe_init_checkpointer — always-on DeepAgents startup."""

    @patch.dict(os.environ, {}, clear=True)
    @patch("harness.deepagents.checkpointer.init_checkpointer")
    def test_initializes_with_checkpoints_db(self, mock_init: MagicMock) -> None:
        from harness.paths import CHECKPOINTS_DB

        daemon_module._maybe_init_checkpointer()
        mock_init.assert_called_once_with(CHECKPOINTS_DB)

    @patch(
        "harness.deepagents.checkpointer.init_checkpointer",
        side_effect=RuntimeError("boom"),
    )
    def test_failure_propagates(self, mock_init: MagicMock) -> None:
        with self.assertRaises(RuntimeError):
            daemon_module._maybe_init_checkpointer()


class TestMaybeConfigureDeepagentsLogging(unittest.TestCase):
    """daemon._maybe_configure_deepagents_logging — always-on DeepAgents startup."""

    @patch.dict(os.environ, {}, clear=True)
    @patch.object(daemon_module.logging, "getLogger")
    @patch.object(daemon_module.logging, "basicConfig")
    def test_configures_info_logging(
        self, mock_basic_config: MagicMock, mock_get_logger: MagicMock
    ) -> None:
        import logging

        daemon_module._maybe_configure_deepagents_logging()
        mock_basic_config.assert_called_once()
        self.assertEqual(mock_basic_config.call_args.kwargs["level"], logging.INFO)
        # httpx is quieted to WARNING to keep request-line noise out of the log.
        mock_get_logger.assert_called_once_with("httpx")
        mock_get_logger.return_value.setLevel.assert_called_once_with(logging.WARNING)


class TestImplementationAnnouncement(unittest.TestCase):
    """Plan thought + "Entered implementation mode" once per implementation."""

    setUp = TestProcessOneInboxFile.setUp
    tearDown = TestProcessOneInboxFile.tearDown
    _write_inbox = TestProcessOneInboxFile._write_inbox
    _events = TestProcessOneInboxFile._events

    _ENTRY: ClassVar[dict] = {
        "id": "inbox-1",
        "kind": "assignment",
        "source": "linear",
        "payload": {
            "title": "Do the thing",
            "description": "details",
            "task_key": "ABC-1",
            "target_id": "sess-1",
        },
    }

    def _run(self, *, started, impl_effect):
        """Process the entry twice; return the implementation_started mock."""
        plan_md = self.dir / "plan.md"
        plan_md.write_text("# Plan\nbody", encoding="utf-8")
        plan_data = {"repos": [{"name": "repo-a", "path": "/tmp/repo-a"}]}
        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan_data
            ),
            patch.object(
                assignment_module, "_run_implementation_stage", side_effect=impl_effect
            ),
            patch.object(
                assignment_module,
                "run_self_review_loop",
                return_value=({}, {"repos": []}),
            ),
            patch.object(
                assignment_module,
                "_repo_names_with_implementation_changes",
                return_value=[],
            ),
            patch.object(assignment_module, "run_distillation_stage"),
            patch.object(
                assignment_module, "run_commit_stage", return_value=("completed", [])
            ),
            patch.object(assignment_module, "PLAN_JSON", self.dir / "plan.json"),
            patch.object(assignment_module, "PLAN_MD", plan_md),
            patch(
                "harness.implementation.implementation_started", side_effect=started
            ) as impl_started,
        ):
            for _ in range(2):
                f = self._write_inbox(self._ENTRY)
                # A failed stage (dead pod) makes the daemon exit(1); the
                # supervisor then re-queues the same entry.
                with contextlib.suppress(SystemExit):
                    process_one_inbox_file(f, self.state)
        return impl_started

    def _announcements(self) -> tuple[int, int]:
        events = self._events()
        thoughts = [
            e
            for e in events
            if e["type"] == "agent_thought" and e["body"] == "# Plan\nbody"
        ]
        entered = [
            e
            for e in events
            if e["type"] == "agent_action"
            and e["body"] == "Entered implementation mode"
        ]
        return len(thoughts), len(entered)

    def test_announces_plan_once_across_worker_restart(self) -> None:
        impl_started = self._run(
            started=[False, True],
            impl_effect=[RuntimeError("pod died"), {"repos": []}],
        )
        self.assertEqual(impl_started.call_count, 2)
        self.assertEqual(
            impl_started.call_args.kwargs,
            {"inbox_id": "inbox-1", "repo_names": ["repo-a"]},
        )
        self.assertEqual(self._announcements(), (1, 1))


if __name__ == "__main__":
    unittest.main()
