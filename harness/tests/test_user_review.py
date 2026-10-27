"""Unit tests for the user-review handler, which runs every round on DeepAgents."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import harness.handlers.user_review as user_review_module
from harness.daemon import DaemonState


def _make_state(tmp_dir: Path) -> DaemonState:
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


def _review_entry() -> dict:
    return {
        "id": "inbox-review-1",
        "kind": "review",
        "source": "github",
        "payload": {
            "review_body": {"target_id": "rb-1", "body": "Please fix."},
            "inline_comments": [
                {"target_id": "il-1", "path": "x.py", "line": 3, "body": "nit"}
            ],
            "task_key": "XYZ-1",
            "pr": {"repo": "acme-webapp", "pr_url": "https://x/pull/1"},
        },
    }


class TestProcessUserReview(unittest.TestCase):
    def test_runs_the_followup_round_then_completes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            state = _make_state(Path(td))
            order: list[str] = []
            with (
                patch.object(
                    user_review_module,
                    "run_followup_review",
                    side_effect=lambda entry, st: order.append("followup"),
                ) as followup,
                patch.object(
                    user_review_module,
                    "fill_missed_replies_and_complete_round",
                    side_effect=lambda *a, **k: order.append("complete"),
                ) as complete,
            ):
                user_review_module.process_user_review(_review_entry(), state)
            followup.assert_called_once_with(_review_entry(), state)
            complete.assert_called_once_with(
                state,
                "inbox-review-1",
                ordered_target_ids=["rb-1", "il-1"],
                optional_target_ids={"rb-1"},
            )
            self.assertEqual(order, ["followup", "complete"])

    def test_completed_round_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            state = _make_state(Path(td))
            state.append_event({"type": "completed", "inbox_id": "inbox-review-1"})
            with (
                patch.object(user_review_module, "run_followup_review") as followup,
                patch.object(
                    user_review_module, "fill_missed_replies_and_complete_round"
                ) as complete,
            ):
                user_review_module.process_user_review(_review_entry(), state)
            followup.assert_not_called()
            complete.assert_not_called()

    def test_missing_task_key_raises_before_the_round(self) -> None:
        entry = _review_entry()
        del entry["payload"]["task_key"]
        with tempfile.TemporaryDirectory() as td:
            state = _make_state(Path(td))
            with (
                patch.object(user_review_module, "run_followup_review") as followup,
                self.assertRaises(ValueError),
            ):
                user_review_module.process_user_review(entry, state)
            followup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
