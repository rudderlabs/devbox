"""Tests for the update_pull_request tool middleware."""

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

from harness.deepagents.middleware.pull_request import (
    PullRequestMiddleware,
    PullRequestRef,
)
from harness.git import GitHubApiError
from tests.schema_support import assert_strict_compatible

WEB = PullRequestRef("acme-webapp", "https://github.com/acme/acme-webapp/pull/42")
SRV = PullRequestRef("acme-server", "https://github.com/acme/acme-server/pull/7")


class TestPullRequestMiddleware(unittest.TestCase):
    def setUp(self) -> None:
        self.github = mock.Mock()
        self.github.get_pull_request.return_value = {"title": "old", "body": "old body"}

    def _tool(self, prs=(WEB,)):
        return PullRequestMiddleware(github=self.github, prs=list(prs)).tools[0]

    def _schema(self, tool) -> dict:
        return tool.tool_call_schema.model_json_schema()

    def test_single_pr_has_no_pr_field_and_no_instructions(self) -> None:
        mw = PullRequestMiddleware(github=self.github, prs=[WEB])
        self.assertEqual(
            sorted(self._schema(mw.tools[0])["properties"]), ["body", "title"]
        )
        self.assertIsNone(mw.system_prompt)

    def test_several_prs_expose_repo_enum_with_urls(self) -> None:
        schema = self._schema(self._tool((WEB, SRV)))
        self.assertEqual(
            schema["properties"]["pr"]["enum"], ["acme-webapp", "acme-server"]
        )
        self.assertIn("pull/7", schema["properties"]["pr"]["description"])
        self.assertIn("pr", schema["required"])

    def test_requires_a_field(self) -> None:
        message = self._tool().run({}, tool_call_id="a")
        self.assertEqual(message.status, "error")
        self.github.get_pull_request.assert_not_called()

    def test_requires_a_field_message(self) -> None:
        message = self._tool().run({}, tool_call_id="a")
        self.assertEqual(
            message.content,
            "invalid arguments: arguments: provide a title and/or a body",
        )
        self.github.get_pull_request.assert_not_called()
        self.github.update_pull_request.assert_not_called()

    def test_blank_title_is_a_validation_error_naming_title(self) -> None:
        message = self._tool().run({"title": "   "}, tool_call_id="b")
        self.assertEqual(message.status, "error")
        self.assertEqual(message.content, "invalid arguments: title: must not be blank")
        self.github.get_pull_request.assert_not_called()
        self.github.update_pull_request.assert_not_called()

    def test_schemas_are_strict_compatible(self) -> None:
        assert_strict_compatible(self, self._tool((WEB, SRV)))
        assert_strict_compatible(self, self._tool())

    def test_unchanged_does_not_patch(self) -> None:
        result = self._tool().invoke({"title": "old", "body": "old body"})
        self.assertEqual(result, "unchanged: title='old', body='old body'")
        self.github.update_pull_request.assert_not_called()

    def test_patches_only_changed_fields_on_chosen_pr(self) -> None:
        result = self._tool((WEB, SRV)).invoke({
            "title": "old",
            "body": "new body",
            "pr": "acme-server",
        })
        self.github.get_pull_request.assert_called_once_with("acme", "acme-server", 7)
        self.github.update_pull_request.assert_called_once_with(
            "acme", "acme-server", 7, title=None, body="new body"
        )
        self.assertEqual(result, "updated: body='new body'")

    def test_empty_body_clears_and_null_body_counts_as_empty(self) -> None:
        self._tool().invoke({"body": ""})
        self.github.update_pull_request.assert_called_once_with(
            "acme", "acme-webapp", 42, title=None, body=""
        )
        self.github.reset_mock()
        self.github.get_pull_request.return_value = {"title": "t", "body": None}
        self.assertEqual(self._tool().invoke({"body": ""}), "unchanged: body=''")

    def test_title_is_stripped_and_body_whitespace_preserved(self) -> None:
        self._tool().invoke({"title": "  feat: x  ", "body": "  keep  \n"})
        self.github.update_pull_request.assert_called_once_with(
            "acme", "acme-webapp", 42, title="feat: x", body="  keep  \n"
        )

    def test_github_error_is_a_tool_error(self) -> None:
        self.github.get_pull_request.side_effect = GitHubApiError(
            "GET", "/p", 403, "no"
        )
        message = self._tool().run({"title": "t"}, tool_call_id="c")
        self.assertEqual(message.status, "error")
        self.assertIn("403", str(message.content))

    def test_construction_validates_refs(self) -> None:
        for prs in (
            [],
            [PullRequestRef("r", "https://github.com/o/r/issues/1")],
            [WEB, WEB],
        ):
            with self.assertRaises(ValueError):
                PullRequestMiddleware(github=self.github, prs=prs)

    def test_network_error_is_a_tool_error(self) -> None:
        self.github.get_pull_request.side_effect = urllib.error.URLError("unreachable")
        message = self._tool().run({"title": "t"}, tool_call_id="d")
        self.assertEqual(message.status, "error")
        self.assertIn("URLError", str(message.content))

    def test_invalid_pr_value_is_a_tool_error(self) -> None:
        message = self._tool((WEB, SRV)).run(
            {"title": "t", "pr": "nope"}, tool_call_id="e"
        )
        self.assertEqual(message.status, "error")
        self.github.get_pull_request.assert_not_called()

    def test_non_json_response_is_a_tool_error(self) -> None:
        self.github.get_pull_request.side_effect = json.JSONDecodeError(
            "Expecting value", "<html>", 0
        )
        message = self._tool().run({"title": "t"}, tool_call_id="f")
        self.assertEqual(message.status, "error")
        self.assertEqual(
            message.content,
            "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
        )

    def test_truncated_response_is_a_tool_error(self) -> None:
        self.github.get_pull_request.side_effect = http.client.IncompleteRead(b"{}", 18)
        message = self._tool().run({"title": "t"}, tool_call_id="g")
        self.assertEqual(message.status, "error")
        self.assertEqual(
            message.content,
            "IncompleteRead: IncompleteRead(2 bytes read, 18 more expected)",
        )

    def test_field_descriptions_say_null_not_omit(self) -> None:
        properties = self._schema(self._tool())["properties"]
        self.assertEqual(
            properties["title"]["description"],
            "New PR title, or null to leave it unchanged. Must not be blank; "
            "surrounding whitespace is removed.",
        )
        self.assertEqual(
            properties["body"]["description"],
            "New PR description, used exactly as given. An empty string clears "
            "it; null leaves it unchanged.",
        )
