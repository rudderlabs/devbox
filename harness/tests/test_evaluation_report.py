import contextlib
import copy
import io
import json
import unittest
from pathlib import Path

from harness.evaluation.report import generate_report, main
from tests.evaluation_support import (
    LEDGER,
    LEDGER_PATH,
    METADATA,
    SDK_FIXTURE,
    SDK_PATH,
    CaptureTestCase,
    edit_json_input,
    jsonl,
    replace_archive,
)


class BuildReportTests(CaptureTestCase):
    def test_saved_capture_report(self):
        path = generate_report(self.capture_dir, self.root / "output", METADATA)
        report = json.loads(path.read_text())
        self.assertEqual(path, self.root / "output/report.json")
        self.assertEqual(report["version"], 1)
        self.assertNotIn("reporter", report["provenance"])
        evaluator = report["provenance"]["evaluator"]
        self.assertEqual(evaluator["image"], METADATA["image"])
        self.assertIsNone(evaluator["source"])
        self.assertEqual(evaluator["package"], "devbox-harness")
        self.assertEqual(report["execution"]["elapsed_ms"], 10_000)
        self.assertEqual(report["deepagents"]["summary"]["usage"]["total_tokens"], 44)
        self.assertEqual(report["provenance"]["deepagents_files"][0]["path"], SDK_PATH)

    def test_explicit_null_streaming_flag_is_invalid(self):
        edit_json_input(
            self.capture_dir,
            "run.json",
            lambda run: run["environment"].update(
                HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING=None
            ),
        )
        self.assert_rejected("streaming flag")

    def test_missing_assignment_or_sdk_evidence_stays_unknown(self):
        without_ledger = self.new_capture()
        replace_archive(
            without_ledger, [{"name": SDK_PATH, "content": SDK_FIXTURE.read_bytes()}]
        )
        execution = self.report(without_ledger)["execution"]
        self.assertIsNone(execution["first_event"])
        self.assertIsNone(execution["terminal"])
        self.assertIn(
            "missing_ledger", [gap["kind"] for gap in execution["evidence_gaps"]]
        )

        replace_archive(
            self.capture_dir, [{"name": LEDGER_PATH, "content": jsonl(LEDGER)}]
        )
        summary = self.report()["deepagents"]["summary"]
        self.assertEqual(summary["availability"], "unavailable")
        self.assertIsNone(summary["usage"])

    def test_execution_metadata_validation_and_source_provenance(self):
        metadata = copy.deepcopy(METADATA)
        metadata["source"] = {"commit": "c" * 40, "sha256": "d" * 64}
        evaluator = self.report(metadata=metadata)["provenance"]["evaluator"]
        self.assertEqual(evaluator["source"], metadata["source"])

        invalid = [
            {},
            {
                "image": {"reference": " ", "id": "sha256:" + "a" * 64},
                "source": None,
            },
            {"image": {"reference": "x", "id": "a" * 64}, "source": None},
            {"image": METADATA["image"], "source": {}},
            {
                "image": METADATA["image"],
                "source": {"commit": "C" * 40, "sha256": "d" * 64},
            },
            {"image": METADATA["image"], "source": None, "version": "caller"},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.assert_rejected("", metadata=value)


class GenerateReportTests(CaptureTestCase):
    def run_cli(self, metadata_path: Path, stream: str = "stdout"):
        captured = io.StringIO()
        redirect = (
            contextlib.redirect_stdout
            if stream == "stdout"
            else contextlib.redirect_stderr
        )
        with redirect(captured):
            code = main([
                "--capture-dir",
                str(self.capture_dir),
                "--output-dir",
                str(self.root / "output"),
                "--execution-metadata",
                str(metadata_path),
            ])
        return code, captured.getvalue()

    def test_atomic_output_replacement(self):
        output_dir = self.root / "output"
        output_dir.mkdir()
        output = output_dir / "report.json"
        output.write_text("old report\n")
        generate_report(self.capture_dir, output_dir, METADATA)
        self.assertEqual(json.loads(output.read_text())["version"], 1)

        output.write_text("original report\n")
        replace_archive(self.capture_dir, [{"name": SDK_PATH, "type": "symlink"}])
        with self.assertRaises(ValueError):
            generate_report(self.capture_dir, output_dir, METADATA)
        self.assertEqual(output.read_text(), "original report\n")

    def test_cli_prints_report_path_or_bounded_error(self):
        metadata_path = self.root / "execution.json"
        metadata_path.write_text(json.dumps(METADATA))
        code, stdout = self.run_cli(metadata_path)
        self.assertEqual(code, 0)
        self.assertEqual(Path(stdout.strip()), self.root / "output/report.json")

        (self.root / "output/report.json").unlink()
        metadata_path.write_text(json.dumps({"image": {"reference": "", "id": "bad"}}))
        code, stderr = self.run_cli(metadata_path, stream="stderr")
        self.assertNotEqual(code, 0)
        self.assertFalse((self.root / "output/report.json").exists())
        self.assertLessEqual(len(stderr), 600)


if __name__ == "__main__":
    unittest.main()
