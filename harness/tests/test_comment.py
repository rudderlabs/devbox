"""Unit tests for the comment handler, which runs every round on DeepAgents."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import harness.handlers.comment as comment_module
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


def _comment_entry() -> dict:
    return {
        "id": "inbox-comment-1",
        "kind": "comment",
        "source": "github",
        "payload": {
            "target_id": "c-1",
            "body": "Please tweak the copy.",
            "task_key": "XYZ-1",
            "pr": {"repo": "acme-webapp", "pr_url": "https://x/pull/1"},
        },
    }


class TestProcessComment(unittest.TestCase):
    def test_runs_the_followup_round_then_completes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            state = _make_state(Path(td))
            order: list[str] = []
            with (
                patch.object(
                    comment_module,
                    "run_followup_comment",
                    side_effect=lambda entry, st: order.append("followup"),
                ) as followup,
                patch.object(
                    comment_module,
                    "fill_missed_replies_and_complete_round",
                    side_effect=lambda *a, **k: order.append("complete"),
                ) as complete,
            ):
                comment_module.process_comment(_comment_entry(), state)
            followup.assert_called_once_with(_comment_entry(), state)
            complete.assert_called_once_with(
                state, "inbox-comment-1", ordered_target_ids=["c-1"]
            )
            self.assertEqual(order, ["followup", "complete"])

    def test_completed_round_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            state = _make_state(Path(td))
            state.append_event({"type": "completed", "inbox_id": "inbox-comment-1"})
            with (
                patch.object(comment_module, "run_followup_comment") as followup,
                patch.object(
                    comment_module, "fill_missed_replies_and_complete_round"
                ) as complete,
            ):
                comment_module.process_comment(_comment_entry(), state)
            followup.assert_not_called()
            complete.assert_not_called()

    def test_missing_task_key_raises_before_any_event(self) -> None:
        entry = _comment_entry()
        entry["source"] = "linear"
        del entry["payload"]["task_key"]
        with tempfile.TemporaryDirectory() as td:
            state = _make_state(Path(td))
            with (
                patch.object(comment_module, "run_followup_comment") as followup,
                self.assertRaises(ValueError),
            ):
                comment_module.process_comment(entry, state)
            followup.assert_not_called()
            self.assertFalse(state.events_file.exists())


class TestProcessCommentLiveChannel(unittest.TestCase):
    def _actions_for(self, source: str) -> list[dict]:
        entry = _comment_entry()
        entry["source"] = source
        with tempfile.TemporaryDirectory() as td:
            state = _make_state(Path(td))
            with (
                patch.object(comment_module, "run_followup_comment"),
                patch.object(comment_module, "fill_missed_replies_and_complete_round"),
            ):
                comment_module.process_comment(entry, state)
            events_file = Path(td) / "events.jsonl"
            if not events_file.exists():
                return []
            # Drop the daemon-added fields (seq, timestamp); compare the rest whole.
            return [
                {k: e[k] for k in ("type", "inbox_id", "target_id", "body")}
                for e in map(json.loads, events_file.read_text().splitlines())
                if e.get("type") == "agent_action"
            ]

    def test_live_channels_get_working_on_it(self) -> None:
        expected = [
            {
                "type": "agent_action",
                "inbox_id": "inbox-comment-1",
                "target_id": "c-1",
                "body": "Working on it",
            }
        ]
        for source in ("linear", "api"):
            with self.subTest(source=source):
                self.assertEqual(self._actions_for(source), expected)

    def test_github_gets_no_progress_event(self) -> None:
        self.assertEqual(self._actions_for("github"), [])


if __name__ == "__main__":
    unittest.main()
