"""Unit tests for the backend-independent stage timer (no subprocess, no network)."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from harness import obs
from harness.stages import Stage


class TestTimedStage(unittest.TestCase):
    def setUp(self) -> None:
        self._env = patch.dict(os.environ, {"SANDBOX_ID": "sbx-0"})
        self._env.start()
        self.addCleanup(self._env.stop)

    def test_emits_ok_with_identity_fields(self) -> None:
        with (
            patch.object(obs, "log_event") as mock_log,
            obs.timed_stage(Stage.PLANNING, run_id="20260615-abc", task_key="ABC-103"),
        ):
            pass
        mock_log.assert_called_once()
        event_name, fields = mock_log.call_args.args[0], mock_log.call_args.kwargs
        self.assertEqual(event_name, obs.STAGE_DURATION_EVENT)
        self.assertEqual(event_name, "harness.stage_duration")
        self.assertEqual(fields["harness_stage"], "planning")
        self.assertEqual(fields["outcome"], "ok")
        self.assertEqual(fields["harness_run_id"], "20260615-abc")
        self.assertEqual(fields["harness_task_key"], "ABC-103")
        self.assertEqual(fields["harness_sandbox_id"], "sbx-0")
        self.assertGreaterEqual(fields["duration_ms"], 0.0)

    def test_emits_error_and_reraises_on_exception(self) -> None:
        with (
            patch.object(obs, "log_event") as mock_log,
            self.assertRaises(ValueError),
            obs.timed_stage(Stage.IMPLEMENTATION, run_id="r", task_key="t"),
        ):
            raise ValueError("boom")
        mock_log.assert_called_once()
        self.assertEqual(mock_log.call_args.kwargs["outcome"], "error")
        self.assertEqual(mock_log.call_args.kwargs["harness_stage"], "implementation")

    def test_ci_stage_value(self) -> None:
        with (
            patch.object(obs, "log_event") as mock_log,
            obs.timed_stage(Stage.CI, run_id="r", task_key="t"),
        ):
            pass
        self.assertEqual(mock_log.call_args.kwargs["harness_stage"], "ci")


class TestSandboxId(unittest.TestCase):
    def test_prefers_sandbox_id_then_hostname(self) -> None:
        with patch.dict(os.environ, {"SANDBOX_ID": " b ", "HOSTNAME": "c"}):
            self.assertEqual(obs.sandbox_id(), "b")
            os.environ.pop("SANDBOX_ID")
            self.assertEqual(obs.sandbox_id(), "c")

    def test_empty_when_nothing_set(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(obs.sandbox_id(), "")


if __name__ == "__main__":
    unittest.main()
