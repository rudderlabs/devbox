"""Unit tests for the ci_result handler, which runs every CI round on DeepAgents."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import harness.handlers.ci_result as ci_result_module
from harness.daemon import DaemonState
from harness.followup import ci_thread_id
from harness.handlers.ci_result import process_ci_result


def _make_state(tmp_dir: Path) -> tuple[DaemonState, Path]:
    events = tmp_dir / "events.jsonl"
    events_lock = tmp_dir / "events.lock"
    processed = tmp_dir / ".processed"
    processed.mkdir(exist_ok=True)
    error = tmp_dir / ".error"
    error.mkdir(exist_ok=True)
    state = DaemonState(
        events_file=events,
        events_lock=events_lock,
        processed_dir=processed,
        error_dir=error,
    )
    return state, events


def _events(events_file: Path) -> list[dict]:
    if not events_file.exists():
        return []
    return [
        json.loads(line)
        for line in events_file.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _make_entry(
    inbox_id: str = "inbox-ci-1",
    target_id: str = "tgt-ci-1",
) -> dict:
    return {
        "id": inbox_id,
        "kind": "ci_result",
        "source": "github",
        "payload": {
            "target_id": target_id,
            "workflow_name": "CI",
            "workflow_path": ".github/workflows/ci.yml",
            "conclusion": "failure",
            "run_url": "https://github.com/acme/acme-server/actions/runs/123456789",
            "head_sha": "abc123def456",
            "head_branch": "devbox/XYZ-1234-fix-abc",
            "task_key": "XYZ-1234",
            "pr": {
                "repo": "acme-server",
                "pr_url": "https://github.com/acme/acme-server/pull/42",
            },
        },
    }


class TestProcessCiResult(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.state, self.events_file = _make_state(self.dir)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_skips_already_completed(self) -> None:
        entry = _make_entry()
        self.state.append_event({
            "type": "completed",
            "inbox_id": "inbox-ci-1",
        })

        with patch.object(
            ci_result_module,
            "fetch_failed_job_logs",
            side_effect=AssertionError("should not be called"),
        ):
            process_ci_result(entry, self.state)

        events = _events(self.events_file)
        completed_count = sum(1 for e in events if e["type"] == "completed")
        self.assertEqual(completed_count, 1)

    def test_fetch_failure_emits_response_and_completes(self) -> None:
        """Catastrophic fetch failure → Branch 1 early exit with agent_response."""
        entry = _make_entry()

        with patch.object(
            ci_result_module,
            "fetch_failed_job_logs",
            side_effect=RuntimeError("API down"),
        ):
            process_ci_result(entry, self.state)

        events = _events(self.events_file)
        responses = [e for e in events if e["type"] == "agent_response"]
        self.assertEqual(len(responses), 1)
        self.assertIn("could not fetch any job logs", responses[0]["body"])
        completed = [e for e in events if e["type"] == "completed"]
        self.assertEqual(len(completed), 1)

    def test_no_failed_jobs_with_errors_includes_errors_in_response(self) -> None:
        """Branch 1: zero logs + per-job errors → response includes error list."""
        entry = _make_entry()

        with patch.object(
            ci_result_module,
            "fetch_failed_job_logs",
            return_value=([], ["failed to fetch logs for job lint (42): 403"]),
        ):
            process_ci_result(entry, self.state)

        events = _events(self.events_file)
        responses = [e for e in events if e["type"] == "agent_response"]
        self.assertEqual(len(responses), 1)
        self.assertIn("failed to fetch logs for job lint", responses[0]["body"])
        self.assertIn("could not fetch any job logs", responses[0]["body"])
        completed = [e for e in events if e["type"] == "completed"]
        self.assertEqual(len(completed), 1)

    def test_no_failed_jobs_direct_response_skips_the_round(self) -> None:
        entry = _make_entry()
        with (
            patch.object(
                ci_result_module,
                "fetch_failed_job_logs",
                return_value=([], ["no failed logs"]),
            ),
            patch.object(ci_result_module, "run_followup_ci") as followup,
        ):
            process_ci_result(entry, self.state)

        followup.assert_not_called()

    def test_restart_of_a_started_round_reads_the_task_key_and_skips_logs(
        self,
    ) -> None:
        entry = _make_entry()
        entry["payload"]["task_key"] = "DBX-API-42"
        entry["payload"]["task_id"] = "task-uuid-1"
        with (
            patch.object(
                ci_result_module, "round_started", return_value=True
            ) as started,
            patch.object(
                ci_result_module,
                "fetch_failed_job_logs",
                side_effect=AssertionError("logs must not be fetched"),
            ),
            patch.object(ci_result_module, "run_followup_ci") as followup,
            patch.object(
                ci_result_module, "fill_missed_replies_and_complete_round"
            ) as complete,
        ):
            process_ci_result(entry, self.state)

        started.assert_called_once_with(
            self.state, "inbox-ci-1", ci_thread_id("DBX-API-42")
        )
        followup.assert_called_once_with(entry, self.state, failed_jobs=[], errors=[])
        complete.assert_called_once_with(
            self.state, "inbox-ci-1", ordered_target_ids=["tgt-ci-1"]
        )


class TestProcessCiResultDeepAgents(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state, self.events_file = _make_state(Path(self._tmp.name))

    def test_with_logs_runs_the_ci_round_then_completes(self) -> None:
        entry = _make_entry()
        jobs = [{"job_name": "test", "job_id": 101, "log_path": "/tmp/logs/test.log"}]
        order: list[str] = []
        with (
            patch.object(
                ci_result_module, "fetch_failed_job_logs", return_value=(jobs, ["e1"])
            ),
            patch.object(
                ci_result_module,
                "run_followup_ci",
                side_effect=lambda *a, **k: order.append("followup"),
            ) as followup,
            patch.object(
                ci_result_module,
                "fill_missed_replies_and_complete_round",
                side_effect=lambda *a, **k: order.append("complete"),
            ) as complete,
        ):
            process_ci_result(entry, self.state)
        followup.assert_called_once_with(
            entry, self.state, failed_jobs=jobs, errors=["e1"]
        )
        complete.assert_called_once_with(
            self.state, "inbox-ci-1", ordered_target_ids=["tgt-ci-1"]
        )
        self.assertEqual(order, ["followup", "complete"])

    def test_without_logs_keeps_the_deterministic_reply(self) -> None:
        entry = _make_entry()
        with (
            patch.object(
                ci_result_module, "fetch_failed_job_logs", return_value=([], ["boom"])
            ),
            patch.object(ci_result_module, "run_followup_ci") as followup,
            patch("harness.events.iso_now", return_value="2026-10-07T00:00:00Z"),
        ):
            process_ci_result(entry, self.state)
        followup.assert_not_called()
        self.assertEqual(
            _events(self.events_file),
            [
                {
                    "seq": 1,
                    "ts": "2026-10-07T00:00:00Z",
                    "type": "agent_response",
                    "inbox_id": "inbox-ci-1",
                    "target_id": "tgt-ci-1",
                    "body": (
                        "⚠ CI failed on **CI** but I could not fetch any job logs "
                        "to diagnose the failure.\n\n"
                        "**Errors encountered:**\n- boom\n\n"
                        "[View the run](https://github.com/acme/acme-server/actions/runs/123456789)"
                    ),
                },
                {
                    "seq": 2,
                    "ts": "2026-10-07T00:00:00Z",
                    "type": "completed",
                    "inbox_id": "inbox-ci-1",
                },
            ],
        )


if __name__ == "__main__":
    unittest.main()
