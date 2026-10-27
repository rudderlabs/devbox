"""Unit tests for CI log fetcher (no network)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness import ci_logs
from tests.test_harness_validation import harness  # noqa: F401


class TestParseRunUrl(unittest.TestCase):
    """ci_logs.parse_run_url — extract owner, repo, run_id from run URL."""

    def test_standard_url(self) -> None:
        result = ci_logs.parse_run_url(
            "https://github.com/acme/acme-server/actions/runs/123456789"
        )
        self.assertEqual(result, ("acme", "acme-server", 123456789))

    def test_url_with_trailing_slash(self) -> None:
        result = ci_logs.parse_run_url("https://github.com/org/repo/actions/runs/99/")
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "org")
        self.assertEqual(result[1], "repo")
        self.assertEqual(result[2], 99)

    def test_invalid_url_returns_none(self) -> None:
        self.assertIsNone(ci_logs.parse_run_url("https://example.com/not/github"))
        self.assertIsNone(ci_logs.parse_run_url(""))
        self.assertIsNone(ci_logs.parse_run_url("garbage"))

    def test_url_missing_run_id_returns_none(self) -> None:
        self.assertIsNone(
            ci_logs.parse_run_url("https://github.com/org/repo/actions/runs/")
        )


class TestFetchFailedJobLogs(unittest.TestCase):
    """ci_logs.fetch_failed_job_logs — download failed job logs to disk."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.output_dir = Path(self._tmp.name) / "logs"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_writes_failed_job_logs_to_disk(self) -> None:
        jobs = [
            {"id": 100, "name": "lint", "conclusion": "success"},
            {"id": 101, "name": "test", "conclusion": "failure"},
            {"id": 102, "name": "build", "conclusion": "failure"},
        ]
        mock_client = mock.Mock()
        mock_client.get_workflow_run_jobs.return_value = jobs
        mock_client.get_job_logs.side_effect = lambda _o, _r, jid: (
            f"log output for job {jid}"
        )

        with mock.patch("harness.ci_logs.GitHubClient", return_value=mock_client):
            result, errors = ci_logs.fetch_failed_job_logs(
                "owner", "repo", 99, self.output_dir
            )

        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["job_name"], "test")
        self.assertEqual(result[1]["job_name"], "build")
        self.assertEqual(errors, [])
        for entry in result:
            log_path = Path(entry["log_path"])
            self.assertTrue(log_path.exists())
            self.assertIn("log output for job", log_path.read_text())

    def test_skips_successful_jobs(self) -> None:
        jobs = [
            {"id": 100, "name": "lint", "conclusion": "success"},
            {"id": 101, "name": "test", "conclusion": "success"},
        ]
        mock_client = mock.Mock()
        mock_client.get_workflow_run_jobs.return_value = jobs

        with mock.patch("harness.ci_logs.GitHubClient", return_value=mock_client):
            result, errors = ci_logs.fetch_failed_job_logs(
                "owner", "repo", 99, self.output_dir
            )

        self.assertEqual(result, [])
        self.assertEqual(errors, [])
        mock_client.get_job_logs.assert_not_called()

    def test_continues_on_per_job_fetch_failure(self) -> None:
        jobs = [
            {"id": 101, "name": "test", "conclusion": "failure"},
            {"id": 102, "name": "build", "conclusion": "failure"},
        ]
        mock_client = mock.Mock()
        mock_client.get_workflow_run_jobs.return_value = jobs
        mock_client.get_job_logs.side_effect = [
            RuntimeError("API timeout"),
            "build log output",
        ]

        with mock.patch("harness.ci_logs.GitHubClient", return_value=mock_client):
            result, errors = ci_logs.fetch_failed_job_logs(
                "owner", "repo", 99, self.output_dir
            )

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["job_name"], "build")
        self.assertEqual(len(errors), 1)
        self.assertIn("test", errors[0])

    def test_creates_output_dir_if_missing(self) -> None:
        nested = self.output_dir / "deep" / "nested"
        mock_client = mock.Mock()
        mock_client.get_workflow_run_jobs.return_value = []

        with mock.patch("harness.ci_logs.GitHubClient", return_value=mock_client):
            ci_logs.fetch_failed_job_logs("owner", "repo", 99, nested)

        self.assertTrue(nested.is_dir())

    def test_sanitizes_job_name_in_filename(self) -> None:
        jobs = [
            {"id": 101, "name": "test / ubuntu (3.13)", "conclusion": "failure"},
        ]
        mock_client = mock.Mock()
        mock_client.get_workflow_run_jobs.return_value = jobs
        mock_client.get_job_logs.return_value = "log content"

        with mock.patch("harness.ci_logs.GitHubClient", return_value=mock_client):
            result, errors = ci_logs.fetch_failed_job_logs(
                "owner", "repo", 99, self.output_dir
            )

        self.assertEqual(len(result), 1)
        self.assertEqual(errors, [])
        log_path = Path(result[0]["log_path"])
        self.assertNotIn("/", log_path.name)
        self.assertNotIn(" ", log_path.name)
        self.assertTrue(log_path.exists())


if __name__ == "__main__":
    unittest.main()
