"""Unit tests for the structured-event logger (stdlib-only, no network)."""

from __future__ import annotations

import io
import json
import logging
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from harness import obs


class TestLogEvent(unittest.TestCase):
    def _reset_logger(self) -> None:
        logger = logging.getLogger("harness.events")
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()

    def tearDown(self) -> None:
        self._reset_logger()

    def _capture(self, fn) -> tuple[list[dict], list[dict], Path]:
        """Run *fn* and return stdout/file lines parsed as JSON."""
        # Drop any handler so `_logger()` re-attaches one bound to the
        # redirected stdout for this test.
        self._reset_logger()

        with tempfile.TemporaryDirectory() as tmp:
            harness_dir = Path(tmp) / ".harness"
            buf = io.StringIO()
            with patch.object(obs, "HARNESS_DIR", harness_dir), redirect_stdout(buf):
                fn()
            stdout_records = [
                json.loads(line) for line in buf.getvalue().splitlines() if line.strip()
            ]
            events_log = harness_dir / "harness-events.log"
            file_records = [
                json.loads(line)
                for line in events_log.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            return stdout_records, file_records, events_log

    def test_emits_single_json_line_with_fields(self) -> None:
        stdout_records, file_records, _events_log = self._capture(
            lambda: obs.log_event(
                "harness.stage_duration",
                harness_stage="planning",
                duration_ms=265344.0,
                outcome="ok",
            )
        )
        self.assertEqual(len(stdout_records), 1)
        self.assertEqual(file_records, stdout_records)
        rec = stdout_records[0]
        # Base shape mirrors the sandbox's existing log lines.
        self.assertEqual(rec["level"], "info")
        self.assertEqual(rec["msg"], "harness.stage_duration")
        self.assertTrue(rec["ts"].endswith("Z"))
        # Caller fields are spread at top level for `| json` parsing.
        self.assertEqual(rec["event"], "harness.stage_duration")
        self.assertEqual(rec["harness_stage"], "planning")
        self.assertEqual(rec["duration_ms"], 265344.0)
        self.assertEqual(rec["outcome"], "ok")

    def test_never_raises_on_unserializable_field(self) -> None:
        # `default=str` keeps a non-JSON value from blowing up emission.
        stdout_records, file_records, _events_log = self._capture(
            lambda: obs.log_event("e", obj=object())
        )
        self.assertEqual(len(stdout_records), 1)
        self.assertEqual(file_records, stdout_records)
        self.assertIn("object at 0x", stdout_records[0]["obj"])

    def test_repeated_calls_do_not_duplicate_stdout_or_file_handlers(self) -> None:
        def emit_twice() -> None:
            obs.log_event("first")
            obs.log_event("second")

        stdout_records, file_records, _events_log = self._capture(emit_twice)

        self.assertEqual(
            [record["event"] for record in stdout_records], ["first", "second"]
        )
        self.assertEqual(file_records, stdout_records)


if __name__ == "__main__":
    unittest.main()
