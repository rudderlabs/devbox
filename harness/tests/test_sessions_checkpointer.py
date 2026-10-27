"""Unit tests for sessions.checkpointer — singleton SQLite checkpointer."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from langgraph.checkpoint.base import empty_checkpoint

from harness.deepagents.checkpointer import (
    _reset_checkpointer,
    checkpoint_exists,
    get_checkpointer,
    init_checkpointer,
    latest_round_tag,
)


class TestInitCheckpointer(unittest.TestCase):
    def setUp(self) -> None:
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        _reset_checkpointer()
        self._tmp.cleanup()

    def test_init_creates_db(self) -> None:
        db_path = self.tmp / "sub" / "checkpoints.db"
        init_checkpointer(db_path)
        self.assertTrue(db_path.exists())

    def test_get_returns_same_instance(self) -> None:
        init_checkpointer(self.tmp / "checkpoints.db")
        a = get_checkpointer()
        b = get_checkpointer()
        self.assertIs(a, b)

    def test_double_init_raises(self) -> None:
        init_checkpointer(self.tmp / "checkpoints.db")
        with self.assertRaises(RuntimeError) as ctx:
            init_checkpointer(self.tmp / "other.db")
        self.assertIn("already initialized", str(ctx.exception))

    def test_get_before_init_raises(self) -> None:
        with self.assertRaises(RuntimeError) as ctx:
            get_checkpointer()
        self.assertIn("init_checkpointer", str(ctx.exception))


class TestCheckpointExists(unittest.TestCase):
    def setUp(self) -> None:
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        _reset_checkpointer()
        self._tmp.cleanup()

    def test_false_without_a_checkpointer(self) -> None:
        self.assertFalse(checkpoint_exists("thread-a"))

    def test_true_only_for_a_seeded_thread(self) -> None:
        init_checkpointer(self.tmp / "checkpoints.db")
        self.assertFalse(checkpoint_exists("thread-a"))
        config = {"configurable": {"thread_id": "thread-a", "checkpoint_ns": ""}}
        get_checkpointer().put(
            config, empty_checkpoint(), {"source": "input", "step": -1}, {}
        )
        self.assertTrue(checkpoint_exists("thread-a"))
        self.assertFalse(checkpoint_exists("thread-b"))


class TestLatestRoundTag(unittest.TestCase):
    def setUp(self) -> None:
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        _reset_checkpointer()
        self._tmp.cleanup()

    @staticmethod
    def _put(thread_id: str, metadata: dict) -> None:
        config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
        get_checkpointer().put(
            config, empty_checkpoint(), {"source": "input", "step": -1, **metadata}, {}
        )

    def test_none_without_a_checkpointer(self) -> None:
        self.assertIsNone(latest_round_tag("thread-a"))

    def test_none_without_a_checkpoint(self) -> None:
        init_checkpointer(self.tmp / "checkpoints.db")
        self.assertIsNone(latest_round_tag("thread-a"))

    def test_none_for_an_untagged_checkpoint(self) -> None:
        init_checkpointer(self.tmp / "checkpoints.db")
        self._put("thread-a", {})
        self.assertIsNone(latest_round_tag("thread-a"))

    def test_the_tag_of_the_thread_s_latest_checkpoint(self) -> None:
        init_checkpointer(self.tmp / "checkpoints.db")
        self._put("thread-a", {"harness_round": "inbox-1"})
        self._put("thread-b", {"harness_round": "inbox-9"})
        self.assertEqual(latest_round_tag("thread-a"), "inbox-1")
        self.assertEqual(latest_round_tag("thread-b"), "inbox-9")
        self.assertIsNone(latest_round_tag("thread-c"))


if __name__ == "__main__":
    unittest.main()
