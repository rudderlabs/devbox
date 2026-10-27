"""Unit tests for scripts/seed_inbox.py."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import seed_inbox

RUN_URL = "https://github.com/acme/widgets/actions/runs/123456789"
PR_URL = "https://github.com/acme/widgets/pull/42"
TASK_ID = "0192ab3c-0000-7000-8000-000000000001"


class _FixedTaskId(unittest.TestCase):
    def setUp(self) -> None:
        p = patch.object(seed_inbox, "_default_task_id", return_value=TASK_ID)
        p.start()
        self.addCleanup(p.stop)


def _run_main(argv: list[str]) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = seed_inbox.main(argv)
    return code, stdout.getvalue(), stderr.getvalue()


def _dry_run_entry(output: str) -> dict:
    lines = output.splitlines()
    json_text = "\n".join(lines[1:])
    return json.loads(json_text)


class TestSeedInboxAssignment(_FixedTaskId):
    def test_assignment_preserves_legacy_command_shape(self) -> None:
        code, stdout, stderr = _run_main([
            "assignment",
            "Fix the login bug",
            "--description",
            "Steps: reproduce it",
            "--ticket",
            "ABC-123",
            "--target",
            "session-1",
            "--id",
            "inbox-assignment",
            "--inbox-dir",
            "/tmp/inbox",
            "--dry-run",
        ])

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertIn("[dry-run] would write /tmp/inbox/inbox-assignment.json", stdout)
        self.assertEqual(
            _dry_run_entry(stdout),
            {
                "id": "inbox-assignment",
                "kind": "assignment",
                "source": "linear",
                "payload": {
                    "title": "Fix the login bug",
                    "description": "Steps: reproduce it",
                    "task_key": "ABC-123",
                    "task_id": TASK_ID,
                    "target_id": "session-1",
                },
            },
        )

    def test_assignment_omits_description_when_absent(self) -> None:
        code, stdout, _stderr = _run_main([
            "assignment",
            "Try something",
            "--id",
            "inbox-assignment",
            "--dry-run",
        ])

        self.assertEqual(code, 0)
        payload = _dry_run_entry(stdout)["payload"]
        self.assertEqual(payload["title"], "Try something")
        self.assertNotIn("description", payload)
        self.assertEqual(payload["task_key"], "TEST-1")
        self.assertEqual(payload["task_key"], "TEST-1")
        self.assertEqual(payload["target_id"], "local-session")

    def test_build_entry_accepts_legacy_assignment_namespace(self) -> None:
        args = argparse.Namespace(
            kind="assignment",
            source="linear",
            title="Legacy direct call",
            description=None,
            ticket="ABC-123",
            target="session-1",
        )

        self.assertEqual(
            seed_inbox.build_entry(args, "inbox-legacy"),
            {
                "id": "inbox-legacy",
                "kind": "assignment",
                "source": "linear",
                "payload": {
                    "title": "Legacy direct call",
                    "task_key": "ABC-123",
                    "task_id": TASK_ID,
                    "target_id": "session-1",
                },
            },
        )

    def test_write_uses_final_path_and_no_leftover_temp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            inbox_dir = Path(tmp) / "inbox"
            code, stdout, stderr = _run_main([
                "assignment",
                "Write it",
                "--id",
                "inbox-write",
                "--inbox-dir",
                str(inbox_dir),
            ])

            self.assertEqual(code, 0)
            self.assertEqual(stderr, "")
            self.assertIn("inbox id: inbox-write", stdout)
            target = inbox_dir / "inbox-write.json"
            self.assertTrue(target.exists())
            self.assertFalse((inbox_dir / ".inbox-write.json.tmp").exists())
            self.assertEqual(
                json.loads(target.read_text()),
                {
                    "id": "inbox-write",
                    "kind": "assignment",
                    "source": "linear",
                    "payload": {
                        "title": "Write it",
                        "task_key": "TEST-1",
                        "task_id": TASK_ID,
                        "target_id": "local-session",
                    },
                },
            )


class TestSeedInboxComment(_FixedTaskId):
    def test_comment_payload_with_pr_metadata(self) -> None:
        code, stdout, stderr = _run_main([
            "comment",
            "Please tweak the copy.",
            "--ticket",
            "ABC-124",
            "--target",
            "comment-1",
            "--source",
            "github",
            "--pr-repo",
            "acme/widgets",
            "--pr-url",
            PR_URL,
            "--id",
            "inbox-comment",
            "--dry-run",
        ])

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(
            _dry_run_entry(stdout),
            {
                "id": "inbox-comment",
                "kind": "comment",
                "source": "github",
                "payload": {
                    "target_id": "comment-1",
                    "body": "Please tweak the copy.",
                    "task_key": "ABC-124",
                    "task_id": TASK_ID,
                    "pr": {
                        "repo": "acme/widgets",
                        "pr_url": PR_URL,
                    },
                },
            },
        )

    def test_comment_omits_pr_metadata_when_absent(self) -> None:
        code, stdout, _stderr = _run_main([
            "comment",
            "Linear-only follow-up.",
            "--id",
            "inbox-comment",
            "--dry-run",
        ])

        self.assertEqual(code, 0)
        entry = _dry_run_entry(stdout)
        self.assertEqual(entry["source"], "linear")
        self.assertNotIn("pr", entry["payload"])


class TestSeedInboxReview(_FixedTaskId):
    def test_review_payload_auto_generates_target_ids_and_parses_inlines(self) -> None:
        code, stdout, stderr = _run_main([
            "review",
            "Please address the review.",
            "--ticket",
            "ABC-125",
            "--inline",
            "src/app.py:42:Prefer a clearer name: keep the context",
            "--inline",
            "src/empty_line.py::No line anchor",
            "--inline",
            "src/empty_body.py:7:",
            "--pr-repo",
            "acme/widgets",
            "--pr-url",
            PR_URL,
            "--id",
            "inbox-review",
            "--dry-run",
        ])

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        entry = _dry_run_entry(stdout)
        self.assertEqual(entry["kind"], "review")
        self.assertEqual(entry["source"], "linear")
        self.assertEqual(
            entry["payload"]["review_body"]["body"],
            "Please address the review.",
        )
        self.assertRegex(
            entry["payload"]["review_body"]["target_id"],
            r"^tgt-rb-[0-9a-f]{8}$",
        )
        payload = entry["payload"]
        self.assertEqual(
            {k: payload[k] for k in ("task_key", "task_id")},
            {"task_key": "ABC-125", "task_id": TASK_ID},
        )
        inline_comments = entry["payload"]["inline_comments"]
        self.assertEqual(len(inline_comments), 3)
        for inline in inline_comments:
            self.assertRegex(inline["target_id"], r"^tgt-il-[0-9a-f]{8}$")
        self.assertEqual(
            [
                {key: value for key, value in inline.items() if key != "target_id"}
                for inline in inline_comments
            ],
            [
                {
                    "path": "src/app.py",
                    "line": 42,
                    "body": "Prefer a clearer name: keep the context",
                },
                {"path": "src/empty_line.py", "body": "No line anchor"},
                {"path": "src/empty_body.py", "line": 7, "body": ""},
            ],
        )
        self.assertEqual(
            entry["payload"]["pr"],
            {"repo": "acme/widgets", "pr_url": PR_URL},
        )

    def test_review_ignores_explicit_target_and_omits_pr_metadata(self) -> None:
        code, stdout, _stderr = _run_main([
            "review",
            "Summary only.",
            "--target",
            "review-summary-target",
            "--id",
            "inbox-review",
            "--dry-run",
        ])

        self.assertEqual(code, 0)
        entry = _dry_run_entry(stdout)
        self.assertRegex(
            entry["payload"]["review_body"]["target_id"],
            r"^tgt-rb-[0-9a-f]{8}$",
        )
        self.assertNotEqual(
            entry["payload"]["review_body"]["target_id"],
            "review-summary-target",
        )
        self.assertEqual(entry["payload"]["inline_comments"], [])
        self.assertNotIn("pr", entry["payload"])

    def test_review_rejects_empty_inline_path(self) -> None:
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(stderr):
            seed_inbox.main([
                "review",
                "Summary.",
                "--inline",
                ":42:Missing path",
                "--dry-run",
            ])

        self.assertEqual(cm.exception.code, 2)
        self.assertIn("inline comment path must not be empty", stderr.getvalue())


class TestSeedInboxCiResult(_FixedTaskId):
    def test_ci_result_payload_with_pr_metadata(self) -> None:
        code, stdout, stderr = _run_main([
            "ci_result",
            "--run-url",
            RUN_URL,
            "--workflow-name",
            "Tests",
            "--workflow-path",
            ".github/workflows/tests.yaml",
            "--conclusion",
            "failure",
            "--head-sha",
            "abc123",
            "--head-branch",
            "devbox/ABC-126-fix",
            "--ticket",
            "ABC-126",
            "--target",
            "ci-target",
            "--pr-repo",
            "acme/widgets",
            "--pr-url",
            PR_URL,
            "--id",
            "inbox-ci",
            "--dry-run",
        ])

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(
            _dry_run_entry(stdout),
            {
                "id": "inbox-ci",
                "kind": "ci_result",
                "source": "linear",
                "payload": {
                    "target_id": "ci-target",
                    "workflow_name": "Tests",
                    "conclusion": "failure",
                    "run_url": RUN_URL,
                    "head_sha": "abc123",
                    "head_branch": "devbox/ABC-126-fix",
                    "task_key": "ABC-126",
                    "task_id": TASK_ID,
                    "workflow_path": ".github/workflows/tests.yaml",
                    "pr": {
                        "repo": "acme/widgets",
                        "pr_url": PR_URL,
                    },
                },
            },
        )

    def test_ci_result_requires_run_url(self) -> None:
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(stderr):
            seed_inbox.main(["ci_result", "--dry-run"])

        self.assertEqual(cm.exception.code, 2)
        self.assertIn("--run-url", stderr.getvalue())

    def test_ci_result_rejects_unknown_conclusion(self) -> None:
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(stderr):
            seed_inbox.main([
                "ci_result",
                "--run-url",
                RUN_URL,
                "--conclusion",
                "cancelled",
                "--dry-run",
            ])

        self.assertEqual(cm.exception.code, 2)
        self.assertIn("invalid choice", stderr.getvalue())

    def test_ci_result_omits_optional_metadata_when_absent(self) -> None:
        code, stdout, _stderr = _run_main([
            "ci_result",
            "--run-url",
            RUN_URL,
            "--id",
            "inbox-ci",
            "--dry-run",
        ])

        self.assertEqual(code, 0)
        entry = _dry_run_entry(stdout)
        self.assertEqual(entry["source"], "linear")
        self.assertNotIn("workflow_path", entry["payload"])
        self.assertNotIn("pr", entry["payload"])


class TestSeedInboxSharedValidation(_FixedTaskId):
    def test_pr_metadata_emits_when_either_field_is_supplied(self) -> None:
        code, stdout, stderr = _run_main([
            "comment",
            "Please check this.",
            "--pr-repo",
            "acme/widgets",
            "--dry-run",
        ])

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(
            _dry_run_entry(stdout)["payload"]["pr"],
            {"repo": "acme/widgets", "pr_url": ""},
        )


class TestSeedInboxApiSource(_FixedTaskId):
    def test_api_assignment_carries_task_key_and_task_id(self) -> None:
        code, stdout, stderr = _run_main([
            "assignment",
            "Add a flag",
            "--source",
            "api",
            "--task-key",
            "DBX-API-42",
            "--task-id",
            "0192ab3c-aaaa-7000-8000-000000000042",
            "--target",
            "0192ab3c-aaaa-7000-8000-000000000042",
            "--id",
            "inbox-api",
            "--dry-run",
        ])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(
            _dry_run_entry(stdout),
            {
                "id": "inbox-api",
                "kind": "assignment",
                "source": "api",
                "payload": {
                    "title": "Add a flag",
                    "task_key": "DBX-API-42",
                    "task_id": "0192ab3c-aaaa-7000-8000-000000000042",
                    "target_id": "0192ab3c-aaaa-7000-8000-000000000042",
                },
            },
        )

    def test_api_comment_defaults_task_key_and_task_id(self) -> None:
        code, stdout, _ = _run_main([
            "comment",
            "One more thing",
            "--source",
            "api",
            "--id",
            "inbox-api-c",
            "--dry-run",
        ])
        self.assertEqual(code, 0)
        self.assertEqual(
            _dry_run_entry(stdout),
            {
                "id": "inbox-api-c",
                "kind": "comment",
                "source": "api",
                "payload": {
                    "target_id": "local-session",
                    "body": "One more thing",
                    "task_key": "TEST-1",
                    "task_id": TASK_ID,
                },
            },
        )

    def test_ticket_alias_sets_task_key(self) -> None:
        code, stdout, _ = _run_main([
            "ci_result",
            "--run-url",
            RUN_URL,
            "--ticket",
            "ABC-9",
            "--id",
            "inbox-ci",
            "--dry-run",
        ])
        self.assertEqual(code, 0)
        payload = _dry_run_entry(stdout)["payload"]
        self.assertEqual(
            {k: payload[k] for k in ("task_key", "task_id")},
            {"task_key": "ABC-9", "task_id": TASK_ID},
        )


class TestSeedInboxTaskIdDerivation(unittest.TestCase):
    def _task_id(self, argv: list[str]) -> str:
        _, stdout, _ = _run_main([*argv, "--dry-run"])
        return _dry_run_entry(stdout)["payload"]["task_id"]

    def test_same_task_key_shares_default_task_id_across_kinds(self) -> None:
        assignment = self._task_id(["assignment", "T", "--task-key", "ABC-7"])
        comment = self._task_id(["comment", "C", "--task-key", "ABC-7"])
        ci = self._task_id(["ci_result", "--run-url", RUN_URL, "--task-key", "ABC-7"])
        self.assertEqual(assignment, comment)
        self.assertEqual(assignment, ci)

    def test_different_task_keys_get_different_task_ids(self) -> None:
        a = self._task_id(["comment", "C", "--task-key", "ABC-7"])
        b = self._task_id(["comment", "C", "--task-key", "ABC-8"])
        self.assertNotEqual(a, b)

    def test_explicit_task_id_overrides_derived_default(self) -> None:
        derived = self._task_id(["comment", "C", "--task-key", "ABC-7"])
        explicit = self._task_id([
            "comment",
            "C",
            "--task-key",
            "ABC-7",
            "--task-id",
            TASK_ID,
        ])
        self.assertEqual(explicit, TASK_ID)
        self.assertNotEqual(explicit, derived)


class TestSeedInboxSourceMatrix(unittest.TestCase):
    def _assert_rejected(self, argv: list[str]) -> None:
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(stderr):
            seed_inbox.main([*argv, "--source", "api", "--dry-run"])
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("not valid for kind", stderr.getvalue())

    def test_review_rejects_api_source(self) -> None:
        self._assert_rejected(["review", "Summary."])

    def test_ci_result_rejects_api_source(self) -> None:
        self._assert_rejected(["ci_result", "--run-url", RUN_URL])

    def test_assignment_and_comment_accept_api_source(self) -> None:
        for argv in (["assignment", "T"], ["comment", "C"]):
            code, _, _ = _run_main([*argv, "--source", "api", "--dry-run"])
            self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
