"""Unit tests for the task identity and live-channel helpers in handlers._common."""

from __future__ import annotations

import unittest

from harness.handlers._common import is_live_channel, require_task_key


class TestRequireTaskKey(unittest.TestCase):
    def test_reads_task_key(self) -> None:
        self.assertEqual(
            require_task_key({"task_key": "DBX-API-42"}, "p"), "DBX-API-42"
        )

    def test_missing_task_key_raises(self) -> None:
        with self.assertRaises(ValueError) as cm:
            require_task_key({}, "comment payload")
        self.assertEqual(str(cm.exception), "comment payload: missing key 'task_key'")

    def test_non_string_task_key_raises(self) -> None:
        with self.assertRaises(TypeError) as cm:
            require_task_key({"task_key": 42}, "comment payload")
        self.assertEqual(
            str(cm.exception), "comment payload: 'task_key' must be string"
        )


if __name__ == "__main__":
    unittest.main()


class TestIsLiveChannel(unittest.TestCase):
    def test_gating(self) -> None:
        cases = {"linear": True, "api": True, "github": False, "slack": False}
        self.assertEqual({s: is_live_channel(s) for s in cases}, cases)
