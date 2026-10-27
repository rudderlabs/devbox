import unittest

from harness.evaluation import EvidenceFile, summarize_events
from tests.evaluation_support import (
    INBOX_ID,
    SDK_FIXTURE,
    SDK_PATH,
    fixture_for_inbox,
    fixture_records,
    fixture_with,
    jsonl,
    resequence,
    summarize,
)


class EventRecordValidationTests(unittest.TestCase):
    def test_rejects_malformed_or_contradictory_complete_evidence(self):
        original = fixture_records()
        variants = {
            "duplicate model finish": resequence(
                original[:3] + [fixture_records()[2]] + original[3:]
            ),
            "model finish without start": resequence(original[:1] + original[2:]),
            "stable identity": fixture_with(2, inbox_id="other"),
            "record sequence": fixture_with(2, seq=99),
            "unsupported event version": fixture_with(0, version=2),
            "usage total": fixture_with(
                2,
                usage={"input_tokens": 10, "output_tokens": 1, "total_tokens": 12},
            ),
            "nonnegative safe integer": fixture_with(
                2,
                usage={"input_tokens": -1, "output_tokens": 1, "total_tokens": 0},
            ),
            "safe integer": fixture_with(
                2,
                usage={"input_tokens": True, "output_tokens": 1, "total_tokens": 2},
            ),
            "safe integer range": fixture_with(
                2,
                usage={
                    "input_tokens": 2**53 - 1,
                    "output_tokens": 1,
                    "total_tokens": 2**53 - 1,
                },
            ),
            "namespace": fixture_with(1, namespace=[False]),
            "UTC timestamp": fixture_with(1, ts="2026-02-31T17:56:36.820175+00:00"),
        }
        for expected, records in variants.items():
            with (
                self.subTest(expected=expected),
                self.assertRaisesRegex(ValueError, expected),
            ):
                summarize(records)

        content = jsonl(original)
        with self.assertRaisesRegex(ValueError, "duplicate file"):
            summarize_events(
                [EvidenceFile(SDK_PATH, content), EvidenceFile(SDK_PATH, content)],
                INBOX_ID,
            )
        with self.assertRaisesRegex(ValueError, "duplicate invocation"):
            summarize_events(
                [
                    EvidenceFile(SDK_PATH, content),
                    EvidenceFile(f"duplicate/{SDK_FIXTURE.name}", content),
                ],
                INBOX_ID,
            )

    def test_selection_validation_and_complete_line_boundaries(self):
        excluded = fixture_for_inbox("other-inbox")
        excluded[0]["version"] = 2
        with self.assertRaisesRegex(ValueError, "unsupported event version"):
            summarize(excluded)

        content = jsonl(fixture_for_inbox("other-inbox")) + b"not-json\n"
        result = summarize_events([EvidenceFile(SDK_PATH, content)], INBOX_ID)
        self.assertEqual(len(result["evidence"]["excluded"]), 1)

        original = fixture_records()
        for tail, expected in ((b"\xff\n", "UTF-8"), (b"{\n", "JSON")):
            with self.subTest(tail=tail), self.assertRaisesRegex(ValueError, expected):
                summarize_events(
                    [EvidenceFile(SDK_PATH, jsonl(original) + tail)], INBOX_ID
                )

        with self.assertRaisesRegex(ValueError, "filename.*invocation_id"):
            summarize(original, SDK_PATH.replace("11111111", "21111111"))

        overflowing = fixture_with(
            2,
            usage={
                "input_tokens": 2**53 - 1,
                "output_tokens": 0,
                "total_tokens": 2**53 - 1,
            },
        )
        overflowing[6]["usage"] = {
            "input_tokens": 1,
            "output_tokens": 0,
            "total_tokens": 1,
        }
        with self.assertRaisesRegex(ValueError, "safe integer range"):
            summarize(overflowing)

    def test_mixed_input_arrays_are_deterministic(self):
        result = summarize_events(
            [
                EvidenceFile("z-partial.jsonl", b"\xe2\x82"),
                EvidenceFile(SDK_PATH, SDK_FIXTURE.read_bytes()),
                EvidenceFile("a-empty.jsonl", b""),
            ],
            INBOX_ID,
        )
        self.assertEqual(
            [
                (gap["kind"], gap["file"])
                for gap in result["evidence_gaps"]
                if gap["kind"] in {"empty_file", "unassigned_file"}
            ],
            [("empty_file", "a-empty.jsonl"), ("unassigned_file", "z-partial.jsonl")],
        )


if __name__ == "__main__":
    unittest.main()
