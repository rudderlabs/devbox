import unittest

from harness.evaluation.capture import parse_task
from tests.evaluation_support import (
    CaptureTestCase,
    edit_input,
    edit_json_input,
    edit_manifest,
    set_harness_archive,
    update_input_hash,
)


class ParseTaskTests(unittest.TestCase):
    def test_task_reads_only_version_and_id(self):
        base = """\
version: 1
id: ABC-1
"""
        self.assertEqual(parse_task(base), {"version": 1, "id": "ABC-1"})
        # Authoring fields are the control plane's concern; additive or
        # unconsumed fields never fail the evaluator.
        extended = base + (
            "assignment: {title: 2026-02-30}\n"
            "workspace_file: elsewhere.yaml\n"
            "requirements:\n  - Adds retries\n  - {id: R2, text: Keeps the API}\n"
        )
        self.assertEqual(parse_task(extended), {"version": 1, "id": "ABC-1"})
        with self.assertRaisesRegex(ValueError, "Unsupported task.version 2"):
            parse_task(base.replace("version: 1", "version: 2"))
        with self.assertRaisesRegex(ValueError, "task.version"):
            parse_task("version: 0x1\nid: ABC-1\n")
        with self.assertRaisesRegex(ValueError, "task.version"):
            parse_task("id: ABC-1\n")
        with self.assertRaisesRegex(ValueError, "task.id"):
            parse_task("version: 1\n")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            parse_task(base + "id: ABC-2\n")

    def test_invalid_yaml_keys_raise_value_error(self):
        with self.assertRaisesRegex(ValueError, "YAML"):
            parse_task("? [bad, key]\n: value\n")


class LoadCaptureTests(CaptureTestCase):
    def test_all_saved_input_hashes_and_linked_identities_are_verified(self):
        for name in (
            "run.json",
            "assignment.json",
            "task.yaml",
            "task.md",
            "workspace.yaml",
        ):
            with self.subTest(name=name):
                capture_dir = self.new_capture()
                path = capture_dir.parents[1] / name
                path.write_bytes(path.read_bytes() + b" ")
                self.assert_rejected(f"Input hash mismatch: {name}", capture_dir)

        edit_json_input(
            self.capture_dir, "run.json", lambda run: run.update(id="different-run")
        )
        self.assert_rejected("identities")

    def test_assignment_task_key_must_match_the_task_id(self):
        def task_key_only(assignment):
            assignment["payload"] = {"task_key": "ABC-1", "task_id": "task-uuid-1"}

        edit_json_input(self.capture_dir, "assignment.json", task_key_only)
        self.assertEqual(self.report()["provenance"]["task_id"], "ABC-1")

        edit_json_input(
            self.capture_dir,
            "assignment.json",
            lambda a: a["payload"].update(task_key="ABC-2"),
        )
        self.assert_rejected("identities")

    def test_unconsumed_inputs_are_only_hash_checked(self):
        run_dir = self.capture_dir.parents[1]
        (run_dir / "workspace.yaml").write_text("not: [yaml\n")
        (run_dir / "task.md").write_bytes(b"\xff not utf-8")
        for name in ("workspace.yaml", "task.md"):
            update_input_hash(self.capture_dir, name)
        self.assertEqual(self.report()["provenance"]["task_id"], "ABC-1")

        (run_dir / "workspace.yaml").write_text("changed\n")
        self.assert_rejected("Input hash mismatch")

    def test_integer_inputs_reject_integral_floats(self):
        capture_dir = self.new_capture()
        edit_input(
            capture_dir,
            "task.yaml",
            lambda text: text.replace("version: 1\n", "version: 1.0\n", 1),
        )
        self.assert_rejected("safe integer", capture_dir)

        edit_json_input(
            self.capture_dir, "run.json", lambda run: run.update(version=1.0)
        )
        self.assert_rejected("safe integer")

    def test_unrelated_archive_entries_do_not_break_report_selection(self):
        edit_manifest(
            self.capture_dir, lambda manifest: manifest["archives"].insert(0, {})
        )

        self.assertEqual(self.report()["version"], 1)

    def test_archive_size_and_checksum_are_verified(self):
        for field, value in (("size", 0), ("sha256", "0" * 64)):
            with self.subTest(field=field):
                capture_dir = self.new_capture()
                set_harness_archive(capture_dir, **{field: value})
                self.assert_rejected("size|checksum", capture_dir)


if __name__ == "__main__":
    unittest.main()
