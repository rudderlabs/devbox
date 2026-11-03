"""The code-host port: remote parsing, adapter selection and the GitLab
adapter's request shapes (no network: urlopen is faked)."""

from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from typing import Self
from unittest import mock

from harness import codehost, git
from tests.test_harness_validation import (  # noqa: F401  stages harness in sys.modules
    harness,
)

BASE = "https://gitlab.example.com"


class TestGitlabBaseUrl(unittest.TestCase):
    def test_unset_is_none(self) -> None:
        self.assertIsNone(codehost.gitlab_base_url({}))
        self.assertIsNone(codehost.gitlab_base_url({"GITLAB_BASE_URL": "  "}))

    def test_trailing_slash_is_dropped(self) -> None:
        self.assertEqual(
            codehost.gitlab_base_url({"GITLAB_BASE_URL": "https://gl.example.com/"}),
            "https://gl.example.com",
        )

    def test_relative_url_root_is_kept(self) -> None:
        self.assertEqual(
            codehost.gitlab_base_url({
                "GITLAB_BASE_URL": "https://example.com/gitlab/"
            }),
            "https://example.com/gitlab",
        )

    def test_rejects_non_http(self) -> None:
        with self.assertRaises(RuntimeError):
            codehost.gitlab_base_url({"GITLAB_BASE_URL": "gitlab.example.com"})


class TestParseRemoteUrl(unittest.TestCase):
    def test_github_forms(self) -> None:
        for url in (
            "https://github.com/acme/foo",
            "https://github.com/acme/foo.git",
            "https://x-access-token:t@github.com/acme/foo.git",
            "ssh://git@github.com/acme/foo.git",
            "git@github.com:acme/foo.git",
        ):
            with self.subTest(url=url):
                self.assertEqual(
                    codehost.parse_remote_url(url, gitlab_base=BASE),
                    ("github", "acme", "foo"),
                )

    def test_gitlab_https_single_group(self) -> None:
        self.assertEqual(
            codehost.parse_remote_url(f"{BASE}/acme/foo.git", gitlab_base=BASE),
            ("gitlab", "acme", "foo"),
        )

    def test_gitlab_nested_groups_keep_the_namespace_path(self) -> None:
        self.assertEqual(
            codehost.parse_remote_url(
                f"{BASE}/platform/backend/foo.git", gitlab_base=BASE
            ),
            ("gitlab", "platform/backend", "foo"),
        )

    def test_gitlab_ssh_forms(self) -> None:
        for url in (
            "ssh://git@gitlab.example.com/platform/backend/foo.git",
            "git@gitlab.example.com:platform/backend/foo.git",
        ):
            with self.subTest(url=url):
                self.assertEqual(
                    codehost.parse_remote_url(url, gitlab_base=BASE),
                    ("gitlab", "platform/backend", "foo"),
                )

    def test_gitlab_under_a_relative_url_root(self) -> None:
        self.assertEqual(
            codehost.parse_remote_url(
                "https://example.com/gitlab/acme/foo.git",
                gitlab_base="https://example.com/gitlab",
            ),
            ("gitlab", "acme", "foo"),
        )

    def test_other_hosts_are_rejected(self) -> None:
        with self.assertRaises(RuntimeError):
            codehost.parse_remote_url(
                "https://bitbucket.org/acme/foo.git", gitlab_base=BASE
            )

    def test_gitlab_without_base_is_rejected(self) -> None:
        with self.assertRaises(RuntimeError):
            codehost.parse_remote_url(f"{BASE}/acme/foo.git", gitlab_base="")

    def test_gitlab_needs_a_namespace(self) -> None:
        with self.assertRaises(RuntimeError):
            codehost.parse_remote_url(f"{BASE}/foo.git", gitlab_base=BASE)


class TestClientSelection(unittest.TestCase):
    def _with_remote(self, url: str) -> codehost.CodeHost:
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "init", "-q", d], check=True)
            subprocess.run(["git", "-C", d, "remote", "add", "origin", url], check=True)
            return codehost.client_for_repo(Path(d))

    def test_github_remote_gets_the_github_client(self) -> None:
        with mock.patch.dict(os.environ, {"GITLAB_BASE_URL": BASE}):
            self.assertIsInstance(
                self._with_remote("https://github.com/acme/foo.git"), git.GitHubClient
            )

    def test_gitlab_remote_gets_the_gitlab_client(self) -> None:
        with mock.patch.dict(os.environ, {"GITLAB_BASE_URL": BASE}):
            client = self._with_remote(f"{BASE}/platform/backend/foo.git")
        self.assertIsInstance(client, codehost.GitLabClient)
        self.assertEqual(client.base_url, BASE)

    def test_parse_owner_repo_from_git_remote_handles_gitlab(self) -> None:
        with (
            mock.patch.dict(os.environ, {"GITLAB_BASE_URL": BASE}),
            tempfile.TemporaryDirectory() as d,
        ):
            subprocess.run(["git", "init", "-q", d], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    d,
                    "remote",
                    "add",
                    "origin",
                    f"{BASE}/platform/backend/foo.git",
                ],
                check=True,
            )
            self.assertEqual(
                git.parse_owner_repo_from_git_remote(Path(d)),
                ("platform/backend", "foo"),
            )


class _Response(io.BytesIO):
    def __init__(self, status: int, body: object) -> None:
        super().__init__(json.dumps(body).encode("utf-8"))
        self.status = status

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class TestGitLabClient(unittest.TestCase):
    """Each call's method, path and body, with the project path URL-encoded
    as one segment and the merge request iid never confused with its id."""

    def setUp(self) -> None:
        self.client = codehost.GitLabClient(token="t", base_url=f"{BASE}/")
        self.requests: list[tuple[str, str, dict[str, str], object]] = []

    def _urlopen(self, *responses: tuple[int, object]):
        queue = list(responses)

        def fake(req, context=None):
            body = json.loads(req.data) if req.data else None
            self.requests.append((
                req.get_method(),
                req.full_url,
                dict(req.header_items()),
                body,
            ))
            status, payload = queue.pop(0)
            if status >= 400:
                raise urllib.error.HTTPError(
                    req.full_url,
                    status,
                    "err",
                    {},
                    io.BytesIO(json.dumps(payload).encode()),
                )
            return _Response(status, payload)

        return mock.patch("urllib.request.urlopen", side_effect=fake)

    def test_bearer_auth_and_api_prefix(self) -> None:
        with self._urlopen((200, {"default_branch": "main"})):
            self.assertEqual(
                self.client.get_default_branch("platform/backend", "foo"), "main"
            )
        method, url, headers, body = self.requests[0]
        self.assertEqual(method, "GET")
        self.assertEqual(url, f"{BASE}/api/v4/projects/platform%2Fbackend%2Ffoo")
        self.assertEqual(headers["Authorization"], "Bearer t")
        self.assertIsNone(body)

    def test_placeholder_token_by_default(self) -> None:
        with mock.patch.dict(os.environ, {"GITLAB_BASE_URL": BASE}, clear=False):
            os.environ.pop("GITLAB_TOKEN", None)
            os.environ.pop("GITLAB_PROXY_TOKEN", None)
            client = codehost.GitLabClient()
        with self._urlopen((200, {"default_branch": "main"})):
            client.get_default_branch("acme", "foo")
        self.assertEqual(
            self.requests[0][2]["Authorization"],
            f"Bearer {codehost.GITLAB_PROXY_TOKEN_PLACEHOLDER}",
        )

    def test_get_ref_sha_translates_heads_prefix(self) -> None:
        with self._urlopen((200, {"name": "release/1.x", "commit": {"id": "abc"}})):
            self.assertEqual(
                self.client.get_ref_sha("acme", "foo", "heads/release/1.x"), "abc"
            )
        self.assertEqual(
            self.requests[0][1],
            f"{BASE}/api/v4/projects/acme%2Ffoo/repository/branches/release%2F1.x",
        )

    def test_get_ref_sha_missing_branch_is_none(self) -> None:
        with self._urlopen((404, {"message": "404 Branch Not Found"})):
            self.assertIsNone(self.client.get_ref_sha("acme", "foo", "heads/nope"))

    def test_get_ref_sha_other_errors_raise(self) -> None:
        with (
            self._urlopen((500, {"message": "boom"})),
            self.assertRaises(codehost.GitLabApiError),
        ):
            self.client.get_ref_sha("acme", "foo", "heads/x")

    def test_find_open_pr_by_head_filters_on_source_branch(self) -> None:
        with self._urlopen((
            200,
            [{"iid": 7, "id": 9001, "web_url": f"{BASE}/acme/foo/-/merge_requests/7"}],
        )):
            self.assertEqual(
                self.client.find_open_pr_by_head("acme", "foo", "devbox/t-1"),
                f"{BASE}/acme/foo/-/merge_requests/7",
            )
        self.assertEqual(
            self.requests[0][1],
            f"{BASE}/api/v4/projects/acme%2Ffoo/merge_requests?source_branch=devbox%2Ft-1&state=opened",
        )

    def test_find_open_pr_by_head_none_when_empty(self) -> None:
        with self._urlopen((200, [])):
            self.assertIsNone(self.client.find_open_pr_by_head("acme", "foo", "b"))

    def test_create_pr_is_a_draft_merge_request(self) -> None:
        with self._urlopen((
            201,
            {"iid": 3, "id": 77, "web_url": f"{BASE}/acme/foo/-/merge_requests/3"},
        )):
            url = self.client.create_pr(
                "acme",
                "foo",
                title="Add thing",
                body="why",
                head="devbox/t-1",
                base="main",
            )
        self.assertEqual(url, f"{BASE}/acme/foo/-/merge_requests/3")
        method, path, _headers, body = self.requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, f"{BASE}/api/v4/projects/acme%2Ffoo/merge_requests")
        self.assertEqual(
            body,
            {
                "source_branch": "devbox/t-1",
                "target_branch": "main",
                "title": "Draft: Add thing",
                "description": "why",
            },
        )

    def test_create_pr_without_draft_keeps_the_title(self) -> None:
        with self._urlopen((201, {"web_url": "u"})):
            self.client.create_pr(
                "acme",
                "foo",
                title="Add thing",
                body="",
                head="h",
                base="b",
                draft=False,
            )
        self.assertEqual(self.requests[0][3]["title"], "Add thing")

    def test_create_pr_without_web_url_fails(self) -> None:
        with self._urlopen((201, {"id": 1})), self.assertRaises(RuntimeError):
            self.client.create_pr("acme", "foo", title="t", body="", head="h", base="b")

    def test_requires_a_base_url(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GITLAB_BASE_URL", None)
            with self.assertRaises(RuntimeError):
                codehost.GitLabClient(token="t")


if __name__ == "__main__":
    unittest.main()
