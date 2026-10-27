"""Tests for the multi-writer event log and in-process round-event appends."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.emit import append_agent_thought
from harness.events import (
    RoundEvents,
    _scan_max_seq,
    append_event,
    iter_events,
)
from harness.handlers._common import _covered_target_ids


class TestAppendEvent(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.events = self.dir / "events.jsonl"
        self.lock = self.dir / "events.lock"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_append_assigns_monotonic_seq(self) -> None:
        s1 = append_event(self.events, self.lock, {"type": "a", "inbox_id": "x"})
        s2 = append_event(self.events, self.lock, {"type": "b", "inbox_id": "x"})
        s3 = append_event(self.events, self.lock, {"type": "c", "inbox_id": "x"})
        self.assertEqual([s1, s2, s3], [1, 2, 3])
        lines = self.events.read_text(encoding="utf-8").splitlines()
        self.assertEqual([json.loads(line)["seq"] for line in lines], [1, 2, 3])
        # Every line carries a ts.
        for line in lines:
            self.assertIn("ts", json.loads(line))

    def test_seq_continues_from_file_tail(self) -> None:
        # Simulate a prior writer: pre-seed the file, then append — seq derives
        # from the tail, not an in-memory counter.
        self.events.write_text(
            json.dumps({"seq": 9, "type": "old"}) + "\n", encoding="utf-8"
        )
        self.assertEqual(
            append_event(self.events, self.lock, {"type": "new", "inbox_id": "x"}), 10
        )

    def test_append_after_torn_line_does_not_fuse(self) -> None:
        self.events.write_text(
            json.dumps({"seq": 1, "type": "a"}) + '\n{"seq": 2, "ty',
            encoding="utf-8",
        )
        append_event(self.events, self.lock, {"type": "b", "inbox_id": "x"})
        lines = self.events.read_text(encoding="utf-8").splitlines()
        # Torn fragment stays its own line; the new event is isolated + parseable.
        self.assertEqual(lines[-2], '{"seq": 2, "ty')
        self.assertEqual(json.loads(lines[-1])["type"], "b")
        # seq derives from the only intact prior line (1) → 2.
        self.assertEqual(json.loads(lines[-1])["seq"], 2)

    def test_scan_max_seq_empty(self) -> None:
        self.assertEqual(_scan_max_seq(self.events), 0)


class TestAppendAgentThought(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.events = self.dir / "events.jsonl"
        self.lock = self.dir / "events.lock"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _round_env(self, target_ids: str = ",t1,,t2") -> dict[str, str]:
        return {
            "DEVBOX_EVENTS_FILE": str(self.events),
            "DEVBOX_EVENTS_LOCK": str(self.lock),
            "DEVBOX_INBOX_ID": "inbox-1",
            "DEVBOX_TARGET_IDS": target_ids,
        }

    def _events(self) -> list[dict]:
        if not self.events.exists():
            return []
        return [
            json.loads(line)
            for line in self.events.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_uses_first_non_empty_target_id(self) -> None:
        with patch.dict("os.environ", self._round_env(), clear=True):
            seq = append_agent_thought("memory recorded")

        self.assertEqual(seq, 1)
        events = self._events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "agent_thought")
        self.assertEqual(events[0]["inbox_id"], "inbox-1")
        self.assertEqual(events[0]["target_id"], "t1")
        self.assertEqual(events[0]["body"], "memory recorded")

    def test_skips_when_round_env_missing(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(append_agent_thought("memory recorded"))

        self.assertEqual(self._events(), [])

    def test_skips_when_no_target_id_available(self) -> None:
        with patch.dict("os.environ", self._round_env(",,"), clear=True):
            self.assertIsNone(append_agent_thought("memory recorded"))

        self.assertEqual(self._events(), [])

    def test_append_failure_is_best_effort(self) -> None:
        with (
            patch.dict("os.environ", self._round_env(), clear=True),
            patch("harness.emit.append_event", side_effect=OSError("locked")) as append,
        ):
            self.assertIsNone(append_agent_thought("memory recorded"))

        append.assert_called_once()
        self.assertEqual(self._events(), [])


class TestCoveredTargetIds(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.events = Path(self._tmp.name) / "events.jsonl"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_collects_only_matching_inbox_responses(self) -> None:
        self.events.write_text(
            "\n".join([
                json.dumps({
                    "type": "agent_response",
                    "inbox_id": "i1",
                    "target_id": "a",
                }),
                json.dumps({
                    "type": "agent_response",
                    "inbox_id": "i1",
                    "target_id": "b",
                }),
                json.dumps({
                    "type": "agent_response",
                    "inbox_id": "other",
                    "target_id": "z",
                }),
                json.dumps({"type": "agent_thought", "inbox_id": "i1", "body": "x"}),
            ])
            + "\n",
            encoding="utf-8",
        )
        self.assertEqual(_covered_target_ids(self.events, "i1"), {"a", "b"})

    def test_missing_file_empty_set(self) -> None:
        self.assertEqual(_covered_target_ids(self.events, "i1"), set())

    def test_agent_error_also_counts_as_covered(self) -> None:
        # Failure paths emit agent_error rather than agent_response — those
        # targets must be considered "covered" so fill_missed_replies_and_complete_round's
        # backfill loop does not post a duplicate "did not post a reply"
        # agent_response on top of the agent_error.
        self.events.write_text(
            "\n".join([
                json.dumps({
                    "type": "agent_error",
                    "inbox_id": "i1",
                    "target_id": "a",
                    "body": "couldn't land changes",
                }),
                json.dumps({
                    "type": "agent_response",
                    "inbox_id": "i1",
                    "target_id": "b",
                }),
            ])
            + "\n",
            encoding="utf-8",
        )
        self.assertEqual(_covered_target_ids(self.events, "i1"), {"a", "b"})


class TestRoundEvents(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.events_file = Path(self._tmp.name) / "events.jsonl"
        self.events_lock = Path(self._tmp.name) / "events.lock"
        self.events = RoundEvents(
            events_file=self.events_file,
            events_lock=self.events_lock,
            inbox_id="inbox-1",
            target_id="t-1",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _events(self) -> list[dict]:
        return list(iter_events(self.events_file))

    def _payloads(self) -> list[dict]:
        return [
            {k: v for k, v in event.items() if k not in ("seq", "ts")}
            for event in self._events()
        ]

    def test_exposes_bound_ids(self) -> None:
        self.assertEqual(self.events.inbox_id, "inbox-1")
        self.assertEqual(self.events.target_id, "t-1")

    def test_publish_writes_round_payload(self) -> None:
        seq = self.events.publish(
            "agent_action", body="Running tests", identifier="r/a"
        )
        self.assertEqual(seq, 1)
        event = self._events()[0]
        self.assertEqual(
            list(event),
            ["seq", "ts", "type", "inbox_id", "target_id", "body", "identifier"],
        )
        self.assertEqual(
            self._payloads()[0],
            {
                "type": "agent_action",
                "inbox_id": "inbox-1",
                "target_id": "t-1",
                "body": "Running tests",
                "identifier": "r/a",
            },
        )

    def test_publish_honors_target_override(self) -> None:
        self.events.publish("agent_response", body="to other", target_id="t-2")
        self.events.publish("agent_response", body="to bound")
        self.assertEqual(
            [(p["target_id"], p["body"]) for p in self._payloads()],
            [("t-2", "to other"), ("t-1", "to bound")],
        )

    def test_publish_seqs_increase_and_interleave_with_append_event(self) -> None:
        self.assertEqual(self.events.thought("one"), 1)
        append_event(self.events_file, self.events_lock, {"type": "x"})
        self.assertEqual(self.events.publish("agent_response", body="two"), 3)

    def test_thought_posts_to_bound_target(self) -> None:
        self.assertEqual(self.events.thought("thinking"), 1)
        self.assertEqual(
            self._payloads(),
            [
                {
                    "type": "agent_thought",
                    "inbox_id": "inbox-1",
                    "target_id": "t-1",
                    "body": "thinking",
                }
            ],
        )

    def test_publish_raises_on_failure_and_thought_swallows(self) -> None:
        with patch("harness.events.append_event", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                self.events.publish("agent_response", body="x")
            self.assertIsNone(self.events.thought("x"))

    def test_thought_never_raises(self) -> None:
        with patch("harness.events.append_event", side_effect=RuntimeError("anything")):
            self.assertIsNone(self.events.thought("x"))
        self.assertEqual(self._events(), [])

    def test_publish_rejects_empty_target_override(self) -> None:
        with self.assertRaises(ValueError):
            self.events.publish("agent_thought", body="x", target_id="")
        self.assertEqual(self._events(), [])

    def test_publish_rejects_reserved_field_names(self) -> None:
        # `target_id` and `body` are named parameters: Python already rejects
        # them as duplicates, so only the other reserved keys reach **fields.
        for key in ("type", "inbox_id", "seq", "ts"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.events.publish("agent_response", body="x", **{key: "evil"})
        self.assertEqual(self._events(), [])

    def test_inbox_id_is_required(self) -> None:
        with self.assertRaises(ValueError):
            RoundEvents(
                events_file=self.events_file,
                events_lock=self.events_lock,
                inbox_id="",
                target_id="t-1",
            )

    def test_target_id_is_required(self) -> None:
        with self.assertRaises(ValueError):
            RoundEvents(
                events_file=self.events_file,
                events_lock=self.events_lock,
                inbox_id="inbox-1",
                target_id="",
            )

    def test_daemon_state_builds_round_client(self) -> None:
        from harness.daemon import DaemonState

        state = DaemonState(
            events_file=self.events_file,
            events_lock=self.events_lock,
            processed_dir=Path(self._tmp.name) / "p",
            error_dir=Path(self._tmp.name) / "e",
        )
        events = state.round_events("inbox-9", "t-9")
        self.assertEqual(events.target_id, "t-9")
        events.thought("hello")
        event = self._events()[0]
        self.assertEqual(event["inbox_id"], "inbox-9")
        self.assertEqual(event["target_id"], "t-9")


if __name__ == "__main__":
    unittest.main()
