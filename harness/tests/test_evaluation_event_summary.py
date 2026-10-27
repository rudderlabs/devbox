import json
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
    sdk_record,
    summarize,
    terminal_record,
)


def first(items, **match):
    return next(
        item
        for item in items
        if all(item[key] == value for key, value in match.items())
    )


def gaps_of(result, kind):
    return [gap for gap in result["evidence_gaps"] if gap["kind"] == kind]


class InvocationAccountingTests(unittest.TestCase):
    def test_nested_sdk_fixture_preserves_accounting(self):
        content = SDK_FIXTURE.read_bytes()
        inbox_id = json.loads(content.split(b"\n", 1)[0])["inbox_id"]
        result = summarize_events([EvidenceFile(SDK_PATH, content)], inbox_id)

        self.assertEqual(
            result["summary"]["usage"],
            {"input_tokens": 40, "output_tokens": 4, "total_tokens": 44},
        )
        self.assertEqual(
            result["summary"]["models"],
            {"started": 3, "finished": 3, "unfinished": 0, "missing_usage": 0},
        )
        invocation = result["invocations"][0]
        self.assertEqual(
            result["summary"]["invocations"],
            {"finished": 1, "failed": 0, "interrupted": 0, "unknown": 0},
        )
        self.assertEqual(
            result["summary"]["usage_by_thread"],
            [
                {
                    "thread_id": "fixture-thread",
                    "usage": {
                        "input_tokens": 40,
                        "output_tokens": 4,
                        "total_tokens": 44,
                    },
                }
            ],
        )
        self.assertEqual(invocation["root_usage"]["total_tokens"], 22)
        self.assertEqual(invocation["nested_usage"]["total_tokens"], 22)
        self.assertEqual(invocation["elapsed_ms"], 33.853)
        self.assertEqual(invocation["write_ms_before_terminal"], 11.071)
        self.assertEqual(invocation["source"]["terminal"]["seq"], 12)
        self.assertEqual(result["failures"], [])
        self.assertEqual(invocation["subgraphs"][0]["status"], "started")
        self.assertEqual(
            invocation["subgraphs"][0]["cause"],
            {"namespace": [], "tool_call_id": "probe-task"},
        )
        self.assertEqual(invocation["subgraphs"][1]["status"], "completed")
        self.assertIsNone(invocation["subgraphs"][1]["cause"])
        self.assertEqual(
            [item["namespace"] for item in invocation["namespaces"]],
            [["tools:d845cd4d-232f-6b8e-fc7f-cd7276f1bd26"], []],
        )
        included = result["evidence"]["included"][0]
        self.assertEqual(
            included["sha256"],
            "c3d9390e28eb10a0f8527696d6613c84040a50fb0cae398a096e07761ffa3e24",
        )
        self.assertEqual(included["version"], 1)
        self.assertEqual(included["stream_version"], "v3")
        self.assertEqual(included["packages"]["deepagents"], "0.6.10")

    def test_incomplete_evidence_keeps_observed_usage(self):
        original = fixture_records()
        missing = summarize(original[:-1])
        invocation = missing["invocations"][0]
        self.assertEqual(missing["summary"]["usage"]["total_tokens"], 44)
        self.assertEqual(invocation["outcome"], "unknown")
        self.assertIsNone(invocation["elapsed_ms"])
        (missing_gap,) = gaps_of(missing, "missing_terminal")
        self.assertEqual(missing_gap["invocation_id"], original[0]["invocation_id"])
        self.assertEqual(missing_gap["started_at"], original[0]["ts"])
        self.assertIsNone(missing_gap["ended_at"])
        self.assertEqual(missing_gap["invocation_outcome"], "unknown")

        for tail in (b"{", b"\xe2\x82"):
            with self.subTest(tail=tail):
                truncated = summarize_events(
                    [EvidenceFile(SDK_PATH, jsonl(original) + tail)], INBOX_ID
                )
                self.assertEqual(truncated["invocations"][0]["outcome"], "finished")
                self.assertEqual(truncated["invocations"][0]["integrity"], "incomplete")
                (gap,) = gaps_of(truncated, "truncated_tail")
                self.assertEqual(gap["invocation_id"], original[0]["invocation_id"])
                self.assertIsNone(gap["started_at"])
                self.assertIsNone(gap["ended_at"])
                self.assertEqual(gap["invocation_outcome"], "finished")

        interrupted = summarize(fixture_with(-1, event="invocation_interrupted"))
        self.assertEqual(interrupted["invocations"][0]["outcome"], "interrupted")
        self.assertEqual(
            interrupted["summary"]["invocations"],
            {"finished": 0, "failed": 0, "interrupted": 1, "unknown": 0},
        )

    def test_null_zero_and_unfinished_usage_remain_distinct(self):
        original = fixture_records()
        result = summarize(fixture_with(6, usage=None))
        self.assertEqual(result["summary"]["usage"]["total_tokens"], 22)
        self.assertEqual(result["summary"]["models"]["missing_usage"], 1)
        (gap,) = gaps_of(result, "missing_usage")
        self.assertEqual(gap["namespace"], original[6]["namespace"])
        self.assertEqual(gap["model_run_id"], original[6]["model_run_id"])
        self.assertEqual(gap["model"], "probe")
        self.assertEqual(gap["provider"], "test")
        self.assertEqual(gap["started_at"], original[5]["ts"])
        self.assertEqual(gap["ended_at"], original[6]["ts"])

        unfinished = summarize(resequence(original[:6] + original[7:]))
        self.assertEqual(unfinished["summary"]["models"]["unfinished"], 1)
        (gap,) = gaps_of(unfinished, "unfinished_model")
        self.assertEqual(gap["model_run_id"], original[5]["model_run_id"])
        self.assertEqual(gap["started_at"], original[5]["ts"])
        self.assertIsNone(gap["ended_at"])
        self.assertEqual(gap["invocation_outcome"], "finished")

        zero = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        self.assertEqual(
            summarize(fixture_with(2, usage=zero))["summary"]["usage"],
            {"input_tokens": 30, "output_tokens": 3, "total_tokens": 33},
        )
        with self.assertRaisesRegex(ValueError, "nonnegative safe integer"):
            summarize(fixture_with(2, usage=zero | {"input_tokens": 0.0}))

    def test_failed_invocation_retains_usage_and_context(self):
        records = fixture_with(
            -1,
            event="invocation_failed",
            error_type="RuntimeError",
            error_message="stream stopped",
            error_message_truncated=False,
        )
        result = summarize(records)
        failure = first(result["failures"], kind="invocation_failed")
        self.assertEqual(result["invocations"][0]["outcome"], "failed")
        self.assertEqual(result["invocations"][0]["usage"]["total_tokens"], 44)
        self.assertEqual(failure["invocation_id"], records[0]["invocation_id"])
        self.assertEqual(failure["thread_id"], "fixture-thread")
        self.assertEqual(failure["ts"], records[-1]["ts"])
        self.assertEqual(failure["error_type"], "RuntimeError")
        self.assertEqual(failure["error_message"], "stream stopped")
        self.assertFalse(failure["error_message_truncated"])
        self.assertEqual(
            failure["context"],
            {
                "models": {
                    "started": 3,
                    "finished": 3,
                    "unfinished": 0,
                    "missing_usage": 0,
                },
                "tools": {
                    "started": 1,
                    "success": 1,
                    "handled_error": 0,
                    "exceptions": 0,
                    "status_unavailable": 0,
                    "unfinished": 0,
                },
                "usage": {"input_tokens": 40, "output_tokens": 4, "total_tokens": 44},
            },
        )
        self.assertEqual(failure["sources"], [{"file": SDK_PATH, "seq": 12}])

    def test_empty_detail_map_does_not_create_aggregate_field(self):
        records = fixture_records()
        records[2]["usage"]["input_token_details"] = {}

        result = summarize(records)

        self.assertNotIn("input_token_details", result["summary"]["usage"])
        self.assertNotIn("input_token_details", result["invocations"][0]["usage"])

    def test_detail_maps_and_model_grouping_preserve_json_identity(self):
        records = fixture_records()
        records[1].update(model=None, provider=None)
        records[2].update(model=None, provider=None)
        records[5].update(model="unknown", provider=None)
        records[6].update(
            model="unknown",
            provider=None,
            usage={
                "input_tokens": 20,
                "output_tokens": 2,
                "total_tokens": 22,
                "output_token_details": {"reasoning": 1},
            },
        )
        records[10].update(
            model=None,
            provider=None,
            usage={
                "input_tokens": 10,
                "output_tokens": 1,
                "total_tokens": 11,
                "input_token_details": {"cache_read": 4, "constructor": 2},
            },
        )
        result = summarize(records)
        self.assertEqual(
            result["summary"]["usage"]["input_token_details"],
            {"cache_read": 4, "constructor": 2},
        )
        groups = {
            (item["provider"], item["model"]): item["usage"]
            for item in result["summary"]["usage_by_model"]
        }
        self.assertEqual(groups[(None, None)]["total_tokens"], 11)
        self.assertEqual(groups[(None, "unknown")]["total_tokens"], 22)
        self.assertEqual(groups[("test", "probe")]["total_tokens"], 11)

    def test_unavailable_inventory_does_not_invent_zeroes(self):
        excluded = summarize(fixture_for_inbox("other-inbox"))
        self.assertEqual(
            excluded["summary"],
            {
                "availability": "unavailable",
                "invocations": None,
                "models": None,
                "tools": None,
                "usage": None,
                "usage_by_model": [],
                "usage_by_thread": [],
            },
        )
        self.assertEqual(excluded["evidence"]["excluded"][0]["inbox_id"], "other-inbox")

        empty = summarize_events([EvidenceFile("empty.jsonl", b"")], INBOX_ID)
        partial = summarize_events(
            [EvidenceFile("partial.jsonl", b"\xe2\x82")], INBOX_ID
        )
        self.assertEqual(empty["evidence_gaps"][0]["kind"], "empty_file")
        self.assertEqual(partial["evidence_gaps"][0]["kind"], "unassigned_file")


class FailureAttributionTests(unittest.TestCase):
    def test_tool_outcomes_and_failures_remain_distinct(self):
        def finished(seq, call_id, status, message=None):
            return sdk_record(
                seq,
                "tool_finished",
                tool_call_id=call_id,
                status=status,
                error_message=message,
                error_message_truncated=False,
            )

        records = [
            fixture_records()[0],
            sdk_record(2, "tool_started", tool_call_id="ok", tool_name="read"),
            finished(3, "ok", "success"),
            sdk_record(4, "tool_started", tool_call_id="handled", tool_name="lookup"),
            finished(5, "handled", "error", "missing item"),
            sdk_record(6, "tool_started", tool_call_id="exception", tool_name="shell"),
            sdk_record(
                7,
                "tool_failed",
                tool_call_id="exception",
                error_type="RuntimeError",
                error_message="command exploded",
                error_message_truncated=False,
            ),
            sdk_record(8, "tool_started", tool_call_id="unknown", tool_name=None),
            finished(9, "unknown", None),
            sdk_record(
                10, "tool_started", tool_call_id="unfinished", tool_name="write"
            ),
            sdk_record(
                11,
                "subgraph_lifecycle",
                namespace=["child"],
                status="failed",
                graph_name="worker",
                cause_tool_call_id="handled",
            ),
            terminal_record(12),
        ]
        result = summarize(records)
        self.assertEqual(
            result["summary"]["tools"],
            {
                "started": 5,
                "success": 1,
                "handled_error": 1,
                "exceptions": 1,
                "status_unavailable": 1,
                "unfinished": 1,
            },
        )
        self.assertEqual(
            {item["kind"] for item in result["failures"]},
            {"handled_tool_error", "tool_exception", "subgraph_failed"},
        )
        self.assertEqual(len(result["failures"]), 3)
        handled = first(result["failures"], kind="handled_tool_error")
        self.assertEqual(handled["namespace"], [])
        self.assertEqual(handled["tool_call_id"], "handled")
        self.assertEqual(handled["tool_name"], "lookup")
        self.assertEqual(handled["ts"], "2026-09-21T18:00:00.005Z")
        self.assertIsNone(handled["error_type"])
        self.assertEqual(handled["error_message"], "missing item")
        self.assertFalse(handled["error_message_truncated"])
        self.assertIsNone(handled["context"])
        self.assertEqual(
            handled["sources"],
            [{"file": SDK_PATH, "seq": 4}, {"file": SDK_PATH, "seq": 5}],
        )
        exception = first(result["failures"], kind="tool_exception")
        self.assertEqual(exception["tool_call_id"], "exception")
        self.assertEqual(exception["tool_name"], "shell")
        self.assertEqual(exception["error_type"], "RuntimeError")
        self.assertEqual(exception["error_message"], "command exploded")
        self.assertEqual(
            exception["sources"],
            [{"file": SDK_PATH, "seq": 6}, {"file": SDK_PATH, "seq": 7}],
        )
        subgraph = first(result["failures"], kind="subgraph_failed")
        self.assertEqual(subgraph["namespace"], ["child"])
        self.assertEqual(subgraph["tool_call_id"], "handled")
        self.assertEqual(subgraph["tool_name"], "lookup")
        self.assertEqual(
            subgraph["cause"], {"namespace": [], "tool_call_id": "handled"}
        )
        self.assertIsNone(subgraph["context"])
        self.assertEqual(subgraph["sources"], [{"file": SDK_PATH, "seq": 11}])
        self.assertTrue(gaps_of(result, "unfinished_tool"))

    def test_subgraph_cause_requires_exactly_one_strict_ancestor(self):
        def lifecycle(seq, namespace, status, cause):
            return sdk_record(
                seq,
                "subgraph_lifecycle",
                minute=1,
                namespace=namespace,
                status=status,
                graph_name=None,
                cause_tool_call_id=cause,
            )

        records = [
            fixture_records()[0],
            sdk_record(
                2, "tool_started", minute=1, tool_call_id="shared", tool_name="root"
            ),
            sdk_record(
                3,
                "tool_started",
                minute=1,
                namespace=["parent"],
                tool_call_id="shared",
                tool_name="parent",
            ),
            lifecycle(4, ["parent", "child"], "failed", "shared"),
            lifecycle(5, ["other"], "completed", "missing"),
            terminal_record(6, minute=1),
        ]
        result = summarize(records)
        self.assertIsNone(result["invocations"][0]["subgraphs"][0]["cause"])
        self.assertIsNone(result["invocations"][0]["subgraphs"][1]["cause"])
        self.assertEqual(len(gaps_of(result, "unresolved_attribution")), 2)
        gap = first(
            gaps_of(result, "unresolved_attribution"), namespace=["parent", "child"]
        )
        self.assertEqual(gap["tool_call_id"], "shared")
        self.assertIsNone(gap["started_at"])
        self.assertEqual(gap["ended_at"], "2026-09-21T18:01:00.004Z")
        self.assertEqual(gap["sources"], [{"file": SDK_PATH, "seq": 4}])

    def test_empty_cause_ids_and_lifecycle_gap_endpoints(self):
        def lifecycle(seq, namespace, status):
            return sdk_record(
                seq,
                "subgraph_lifecycle",
                minute=2,
                namespace=namespace,
                status=status,
                graph_name=None,
                cause_tool_call_id="",
            )

        records = [
            fixture_records()[0],
            sdk_record(
                2,
                "tool_started",
                minute=2,
                namespace=["branch"],
                tool_call_id="",
                tool_name="empty-id-tool",
            ),
            lifecycle(3, ["branch", "child"], "started"),
            lifecycle(4, ["orphan"], "started"),
            lifecycle(5, ["terminal-only"], "failed"),
            terminal_record(6, minute=2),
        ]

        result = summarize(records)

        self.assertEqual(
            result["invocations"][0]["subgraphs"][0]["cause"],
            {"namespace": ["branch"], "tool_call_id": ""},
        )
        gaps = gaps_of(result, "unresolved_attribution")
        self.assertEqual(len(gaps), 2)
        by_namespace = {tuple(gap["namespace"]): gap for gap in gaps}
        self.assertEqual(by_namespace[("orphan",)]["tool_call_id"], "")
        self.assertEqual(
            by_namespace[("orphan",)]["started_at"], "2026-09-21T18:02:00.004Z"
        )
        self.assertIsNone(by_namespace[("orphan",)]["ended_at"])
        self.assertEqual(by_namespace[("terminal-only",)]["tool_call_id"], "")
        self.assertIsNone(by_namespace[("terminal-only",)]["started_at"])
        self.assertEqual(
            by_namespace[("terminal-only",)]["ended_at"],
            "2026-09-21T18:02:00.005Z",
        )


if __name__ == "__main__":
    unittest.main()
