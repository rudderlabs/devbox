"""The code-host port and its GitLab adapter.

The assignment round talks to the code host through four calls: the default
branch, a branch's sha, "is there already an open change request for this
head", and "open a draft change request". `CodeHost` names that contract;
`git.GitHubClient` (the original client, unchanged) and `GitLabClient` (here)
implement it. Everything upstream of the commit stage keeps the GitHub-shaped
vocabulary (`pr_url`, `create_pr`, `owner`/`repo`): the adapters translate at
this edge instead of renaming what the dispatcher, the handlers and the stored
rows already use.

GitLab terms map as: project == repository, `owner` == the project's namespace
path (a group or nested groups, so it may contain "/"), `repo` == the project
name, a merge request == a pull request, `web_url` == `html_url`. Only one
GitLab instance is supported at a time: the one `GITLAB_BASE_URL` names
(set by the control plane from the chart's `gitlab.baseUrl`). Any other
HTTPS or SSH remote is treated as GitHub, exactly as before.

Auth is the egress proxy's business: the client sends a placeholder bearer
token and iron-proxy swaps in the real group token on the GitLab host, just
as it does for GitHub. `GITLAB_TOKEN` overrides that for runs outside the
proxy.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from harness.cmd_runner import run_cmd

GITLAB_BASE_URL_ENV = "GITLAB_BASE_URL"
GITLAB_PROXY_TOKEN_PLACEHOLDER = "proxy-gitlab-dummy-token"
GITLAB_DRAFT_PREFIX = "Draft: "


class CodeHost(Protocol):
    """What the commit stage needs from a code host (see git.commit_one_repo
    and handlers._common._commit_and_open_pr). `ref` keeps GitHub's
    `heads/<branch>` spelling; adapters translate it."""

    def get_default_branch(self, owner: str, repo: str) -> str: ...

    def get_ref_sha(self, owner: str, repo: str, ref: str) -> str | None: ...

    def create_pr(
        self,
        owner: str,
        repo: str,
        *,
        title: str,
        body: str,
        head: str,
        base: str,
        draft: bool = True,
    ) -> str: ...

    def find_open_pr_by_head(
        self, owner: str, repo: str, branch: str
    ) -> str | None: ...


# ──── Remote URL parsing ───────────────────────────────────────────────────

_GITHUB_REMOTE_RE = re.compile(
    r"""^
    (?:https?://(?:[^@/]+@)?github\.com/
       |ssh://git@github\.com/
       |git@github\.com:
    )
    (?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?
    $""",
    re.VERBOSE,
)


def gitlab_base_url(env: Mapping[str, str] | None = None) -> str | None:
    """The configured GitLab instance, `scheme://host[/prefix]` with no
    trailing slash, or None when GitLab is not configured."""
    raw = (env if env is not None else os.environ).get(GITLAB_BASE_URL_ENV, "")
    raw = raw.strip().rstrip("/")
    if not raw:
        return None
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise RuntimeError(
            f"{GITLAB_BASE_URL_ENV} must be an http(s) URL such as "
            f"https://gitlab.example.com, got {raw!r}"
        )
    return raw


def parse_remote_url(
    url: str, *, gitlab_base: str | None = None
) -> tuple[str, str, str]:
    """(host kind, owner, repo) for a git remote URL.

    `github` for any github.com remote (HTTPS, ssh:// or scp-like). `gitlab`
    for a remote under the configured instance, where `owner` is the namespace
    path (`group` or `group/subgroup`) and `repo` the project name. Raises
    RuntimeError for anything else.
    """
    m = _GITHUB_REMOTE_RE.match(url)
    if m:
        return "github", m.group("owner"), m.group("repo")

    base = gitlab_base if gitlab_base is not None else gitlab_base_url()
    if base:
        parsed = urllib.parse.urlsplit(base)
        host = parsed.netloc
        prefix = parsed.path.rstrip("/")
        path: str | None = None
        https = re.match(
            rf"^https?://(?:[^@/]+@)?{re.escape(host)}{re.escape(prefix)}/(?P<path>.+)$",
            url,
        )
        ssh = re.match(rf"^ssh://git@{re.escape(host)}/(?P<path>.+)$", url)
        scp = re.match(rf"^git@{re.escape(host)}:(?P<path>.+)$", url)
        for cand in (https, ssh, scp):
            if cand:
                path = cand.group("path")
                break
        if path is not None:
            path = path.strip("/")
            path = path.removesuffix(".git")
            segments = [s for s in path.split("/") if s]
            if len(segments) >= 2 and all(s not in (".", "..") for s in segments):
                return "gitlab", "/".join(segments[:-1]), segments[-1]

    hint = (
        f" (GitLab remotes are recognised only under {base})"
        if base
        else " (set GITLAB_BASE_URL to use a GitLab remote)"
    )
    raise RuntimeError(f"Unsupported code-host remote URL: {url}{hint}")


def remote_origin_url(repo_path: Path) -> str:
    r = run_cmd(
        ["git", "-C", str(repo_path), "config", "--get", "remote.origin.url"],
        check=False,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"No git remote.origin.url in {repo_path}")
    return r.stdout.strip()


def client_for_remote_url(url: str) -> CodeHost:
    """The adapter for a remote: GitLab for the configured instance, else
    GitHub. Chosen per repo, so a workspace may mix hosts."""
    kind, _owner, _repo = parse_remote_url(url)
    if kind == "gitlab":
        return GitLabClient()
    # Imported here: git.py imports this module at load time.
    from harness.git import GitHubClient

    return GitHubClient()


def client_for_repo(repo_path: Path) -> CodeHost:
    return client_for_remote_url(remote_origin_url(repo_path))


# ──── GitLab adapter ───────────────────────────────────────────────────────


class GitLabApiError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, response_body: str) -> None:
        self.method = method
        self.path = path
        self.status = status
        self.response_body = response_body
        super().__init__(f"GitLab API {method} {path} -> {status}: {response_body}")


class GitLabClient:
    """The GitLab REST v4 adapter behind `CodeHost`.

    Numbers: the merge request `iid` (per project) is what URLs and every
    `/merge_requests/<n>` path use; the global `id` never leaves this class.
    The URL recorded as `pr_url` is GitLab's own `web_url` for the merge
    request, which the control plane stores verbatim.
    """

    def __init__(
        self,
        *,
        token: str | None = None,
        base_url: str | None = None,
    ) -> None:
        base = base_url.rstrip("/") if base_url else gitlab_base_url()
        if not base:
            raise RuntimeError(
                f"{GITLAB_BASE_URL_ENV} is not set: no GitLab instance to talk to"
            )
        self._base_url = base
        self._api_url = f"{base}/api/v4"
        self._token = (
            token
            or os.environ.get("GITLAB_TOKEN")
            or os.environ.get("GITLAB_PROXY_TOKEN", GITLAB_PROXY_TOKEN_PLACEHOLDER)
        )
        # System trust only, as for GitHub: inside the sandbox the peer is
        # iron-proxy's leaf certificate, whose CA the bootstrap installed.
        self._ssl_ctx = ssl.create_default_context()

    @property
    def base_url(self) -> str:
        return self._base_url

    @staticmethod
    def _project(owner: str, repo: str) -> str:
        # "group/subgroup/project" as one URL-encoded path segment.
        return urllib.parse.quote(f"{owner}/{repo}", safe="")

    def _request(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
        *,
        expected: tuple[int, ...] = (200, 201),
    ) -> Any:
        url = f"{self._api_url}{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method)
        # Bearer rather than PRIVATE-TOKEN: GitLab accepts both for personal,
        # project and group access tokens, and this keeps the proxy's
        # placeholder swap on the one header it already rewrites for GitHub.
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, context=self._ssl_ctx) as resp:
                status = resp.status
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            raise GitLabApiError(method, path, e.code, raw) from e
        if status not in expected:
            raise GitLabApiError(method, path, status, raw)
        return json.loads(raw) if raw else {}

    # ── CodeHost ─────────────────────────────────────────────────────────
    def get_default_branch(self, owner: str, repo: str) -> str:
        r = self._request("GET", f"/projects/{self._project(owner, repo)}")
        return str(r["default_branch"])

    def get_ref_sha(self, owner: str, repo: str, ref: str) -> str | None:
        branch = ref.removeprefix("refs/heads/").removeprefix("heads/")
        enc = urllib.parse.quote(branch, safe="")
        try:
            r = self._request(
                "GET",
                f"/projects/{self._project(owner, repo)}/repository/branches/{enc}",
            )
            return str(r["commit"]["id"])
        except GitLabApiError as e:
            if e.status == 404:
                return None
            raise

    def create_pr(
        self,
        owner: str,
        repo: str,
        *,
        title: str,
        body: str,
        head: str,
        base: str,
        draft: bool = True,
    ) -> str:
        # GitLab has no draft flag on create: the title prefix marks it.
        if draft and not title.startswith(GITLAB_DRAFT_PREFIX):
            title = f"{GITLAB_DRAFT_PREFIX}{title}"
        r = self._request(
            "POST",
            f"/projects/{self._project(owner, repo)}/merge_requests",
            {
                "source_branch": head,
                "target_branch": base,
                "title": title,
                "description": body,
            },
        )
        url = r.get("web_url") if isinstance(r, dict) else None
        if not url:
            raise RuntimeError(f"merge request creation response missing web_url: {r}")
        return str(url)

    def find_open_pr_by_head(self, owner: str, repo: str, branch: str) -> str | None:
        query = urllib.parse.urlencode({"source_branch": branch, "state": "opened"})
        data = self._request(
            "GET", f"/projects/{self._project(owner, repo)}/merge_requests?{query}"
        )
        if isinstance(data, list) and data:
            url = data[0].get("web_url")
            return str(url) if url else None
        return None
