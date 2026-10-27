import unittest

from tests.evaluation_support import (
    LEDGER,
    CaptureTestCase,
    set_manifest_terminal,
    write_ledger,
)


def gap_kinds(execution):
    return [gap["kind"] for gap in execution["evidence_gaps"]]


class ExecutionSummaryTests(CaptureTestCase):
    def test_assignment_selection_terminal_status_and_timestamp_semantics(self):
        records = [
            {
                "seq": 1,
                "ts": "2026-09-20T23:00:00Z",
                "type": "agent_action",
                "inbox_id": "other",
            },
            {
                "seq": 2,
                "ts": "2026-09-21T02:00:00+02:00",
                "type": "agent_action",
                "inbox_id": "fixture-inbox",
            },
            {
                "seq": 3,
                "ts": "2026-09-20T22:00:01-02:00",
                "type": "completed",
                "inbox_id": "other",
                "status": "failed",
            },
            {
                "seq": 4,
                "ts": "2026-09-20T22:00:10-02:00",
                "type": "completed",
                "inbox_id": "fixture-inbox",
                "status": "partial_failure",
            },
        ]
        write_ledger(self.capture_dir, records)
        execution = self.report()["execution"]
        self.assertEqual(execution["status"], "partial_failure")
        self.assertEqual(execution["first_event"]["seq"], 2)
        self.assertEqual(execution["terminal"]["seq"], 4)
        self.assertEqual(execution["elapsed_ms"], 10_000)

        set_manifest_terminal(self.capture_dir, records[-1] | {"seq": 99})
        self.assert_rejected("terminal")

    def test_status_gaps_negative_duration_partial_tail_and_millisecond_precision(self):
        variants = {
            "no-status": [
                LEDGER[0],
                {key: value for key, value in LEDGER[1].items() if key != "status"},
            ],
            "negative": [LEDGER[0], LEDGER[1] | {"ts": "2026-09-20T23:59:59Z"}],
            "precision": [
                LEDGER[0] | {"ts": "2026-09-21T00:00:00.000900Z"},
                LEDGER[1] | {"ts": "2026-09-21T00:00:00.001100Z"},
            ],
        }
        for name, records in variants.items():
            with self.subTest(name=name):
                capture_dir = self.new_capture()
                write_ledger(capture_dir, records)
                execution = self.report(capture_dir)["execution"]
                if name == "no-status":
                    self.assertIsNone(execution["status"])
                    self.assertIn("missing_status", gap_kinds(execution))
                elif name == "negative":
                    self.assertIsNone(execution["elapsed_ms"])
                    self.assertIn("negative_duration", gap_kinds(execution))
                else:
                    self.assertEqual(execution["elapsed_ms"], 1)

        write_ledger(self.capture_dir, LEDGER, tail=b'{"partial":')
        execution = self.report()["execution"]
        self.assertEqual(execution["status"], "completed")
        self.assertIn("truncated_tail", gap_kinds(execution))

    def test_ledger_sequences_reject_integral_floats(self):
        write_ledger(self.capture_dir, [LEDGER[0] | {"seq": 1.0}, LEDGER[1]])
        self.assert_rejected("safe integer")

    def test_recovered_errors_keep_retryability_and_bounded_bodies(self):
        long_body = f"provider unavailable: {'😀' * 1200}"
        records = [
            {
                "seq": 1,
                "ts": "2026-09-21T00:00:00Z",
                "type": "agent_error",
                "inbox_id": "fixture-inbox",
                "body": long_body,
                "retryable_assignment_failure": True,
            },
            {
                "seq": 2,
                "ts": "2026-09-21T00:00:01Z",
                "type": "agent_error",
                "inbox_id": "fixture-inbox",
                "body": "Authorization: Bearer bearer-value",
                "retryable_assignment_failure": False,
            },
            {
                "seq": 3,
                "ts": "2026-09-21T00:00:02Z",
                "type": "agent_error",
                "inbox_id": "fixture-inbox",
            },
            LEDGER[1] | {"seq": 4},
        ]
        write_ledger(self.capture_dir, records)
        execution = self.report()["execution"]
        observations = execution["error_observations"]
        self.assertEqual(
            [item["retryable"] for item in observations], [True, False, None]
        )
        # The sandbox holds no credentials, so bodies are bounded, not redacted.
        self.assertEqual(observations[1]["body"], "Authorization: Bearer bearer-value")
        self.assertFalse(observations[1]["body_truncated"])
        self.assertTrue(observations[0]["body_truncated"])
        self.assertEqual(len(observations[0]["body"]), 1000)
        self.assertTrue(long_body.startswith(observations[0]["body"]))
        self.assertIsNone(observations[2]["body"])
        self.assertEqual(execution["status"], "completed")


if __name__ == "__main__":
    unittest.main()
