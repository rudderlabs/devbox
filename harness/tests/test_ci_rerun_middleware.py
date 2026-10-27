"""Tests for the rerun_failed_ci_jobs tool middleware."""

from __future__ import annotations

import http.client
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.deepagents.middleware.ci_rerun import CiRerunMiddleware, WorkflowRunRef
from harness.git import GitHubApiError
from tests.schema_support import assert_strict_compatible

RUN = WorkflowRunRef("acme", "acme-server", 99)


class TestCiRerunMiddleware(unittest.TestCase):
    def setUp(self) -> None:
        self.github = mock.Mock()
        self.mw = CiRerunMiddleware(github=self.github, run=RUN)

    def test_tool_takes_no_arguments_and_has_no_instructions(self) -> None:
        tool = self.mw.tools[0]
        self.assertEqual(tool.name, "rerun_failed_ci_jobs")
        self.assertEqual(
            tool.tool_call_schema.model_json_schema().get("properties", {}), {}
        )
        self.assertIsNone(self.mw.system_prompt)

    def test_schema_is_strict_compatible(self) -> None:
        assert_strict_compatible(self, self.mw.tools[0])

    def test_reruns_configured_run(self) -> None:
        result = self.mw.tools[0].invoke({})
        self.github.rerun_failed_jobs.assert_called_once_with("acme", "acme-server", 99)
        self.assertEqual(result, "re-queued failed jobs for run acme/acme-server#99")

    def test_github_error_is_a_tool_error(self) -> None:
        self.github.rerun_failed_jobs.side_effect = GitHubApiError(
            "POST", "/r", 409, "busy"
        )
        message = self.mw.tools[0].run({}, tool_call_id="c")
        self.assertEqual(message.status, "error")
        self.assertIn("409", str(message.content))

    def test_network_error_is_a_tool_error(self) -> None:
        self.github.rerun_failed_jobs.side_effect = urllib.error.URLError("unreachable")
        message = self.mw.tools[0].run({}, tool_call_id="d")
        self.assertEqual(message.status, "error")
        self.assertIn("URLError", str(message.content))

    def test_truncated_response_is_a_tool_error(self) -> None:
        self.github.rerun_failed_jobs.side_effect = http.client.IncompleteRead(
            b"{}", 18
        )
        message = self.mw.tools[0].run({}, tool_call_id="g")
        self.assertEqual(message.status, "error")
        self.assertEqual(
            message.content,
            "IncompleteRead: IncompleteRead(2 bytes read, 18 more expected)",
        )

    def test_non_json_response_is_a_tool_error(self) -> None:
        self.github.rerun_failed_jobs.side_effect = json.JSONDecodeError(
            "Expecting value", "<html>", 0
        )
        message = self.mw.tools[0].run({}, tool_call_id="e")
        self.assertEqual(message.status, "error")
        self.assertEqual(
            message.content,
            "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
        )
