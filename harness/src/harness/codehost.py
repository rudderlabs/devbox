"""The code-host port and its GitLab adapter.

The assignment round talks to the code host through four calls: the default
branch, a branch's sha, "is there already an open change request for this
head", and "open a draft change request". `CodeHost` names that contract;
`git.GitHubClient` (the original client, unchanged) and `GitLabClient` (here)
implement it. The follow-up rounds need more (`FollowUpHost`: read and update
the change request, list its discussion, resolve trust, fetch CI job logs,
re-run failed jobs); both clients implement that too. Everything upstream keeps
the GitHub-shaped vocabulary (`pr_url`, `create_pr`, `owner`/`repo`, GitHub's
comment and job dict shapes): the adapters translate at this edge instead of
renaming what the dispatcher, the handlers and the stored rows already use.

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


class CodeHostApiError(RuntimeError):
    """A non-2xx answer from a code host's API. `git.GitHubApiError` and
    `GitLabApiError` derive from it, so the tool middlewares can catch one
    type whichever host a round is on."""

    def __init__(self, method: str, path: str, status: int, response_body: str) -> None:
        self.method = method
        self.path = path
        self.status = status
        self.response_body = response_body
        super().__init__(f"{method} {path} -> {status}: {response_body}")


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


class FollowUpHost(CodeHost, Protocol):
    """What the follow-up rounds need (see followup.py, discussion_context.py,
    ci_logs.py and the pull_request / ci_rerun middlewares). The dict shapes
    are GitHub's: a comment carries `id`, `user: {id, login}`, `body`,
    `created_at` (an inline one also `path`, `line`); a job carries `id`,
    `name`, `conclusion`; a user `id`, `login`. The GitLab adapter translates
    notes, jobs and users into them."""

    def get_pull_request(
        self, owner: str, repo: str, pr_number: int
    ) -> dict[str, Any]: ...

    def update_pull_request(
        self,
        owner: str,
        repo: str,
        pr_number: int,
        *,
        title: str | None = None,
        body: str | None = None,
    ) -> dict[str, Any]: ...

    def list_issue_comments(
        self, owner: str, repo: str, issue_number: int
    ) -> list[dict[str, Any]]: ...

    def list_pull_request_review_comments(
        self, owner: str, repo: str, pr_number: int
    ) -> list[dict[str, Any]]: ...

    def list_pull_request_reviews(
        self, owner: str, repo: str, pr_number: int
    ) -> list[dict[str, Any]]: ...

    def list_org_members(self, org: str) -> list[dict[str, Any]]: ...

    def get_user(self, login: str) -> dict[str, Any]: ...

    def get_workflow_run_jobs(
        self, owner: str, repo: str, run_id: int
    ) -> list[dict[str, Any]]: ...

    def get_job_logs(self, owner: str, repo: str, job_id: int) -> str: ...

    def rerun_failed_jobs(
        self, owner: str, repo: str, run_id: int
    ) -> dict[str, Any]: ...


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


_GITHUB_PR_URL_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<number>\d+)(?:[/?#]|$)"
)
_GITHUB_RUN_URL_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/actions/runs/(?P<run_id>\d+)"
)


def _gitlab_object_url(
    url: str, object_segment: str, *, gitlab_base: str | None
) -> tuple[str, str, int] | None:
    """(owner, repo, number) of `<base>/<group…>/<project>/-/<object>/<n>`."""
    base = gitlab_base if gitlab_base is not None else gitlab_base_url()
    if not base or not url.startswith(f"{base}/"):
        return None
    rest = url[len(base) :]
    m = re.match(
        rf"^/(?P<path>.+?)/-/{object_segment}/(?P<number>\d+)(?:[/?#]|$)", rest
    )
    if not m:
        return None
    segments = [s for s in m.group("path").split("/") if s]
    if len(segments) < 2 or any(s in (".", "..") for s in segments):
        return None
    return "/".join(segments[:-1]), segments[-1], int(m.group("number"))


def parse_change_request_url(
    url: str, *, gitlab_base: str | None = None
) -> tuple[str, str, str, int] | None:
    """(host kind, owner, repo, number) of a pull request or merge request URL.

    GitHub: `https://github.com/<owner>/<repo>/pull/<n>`. GitLab: the merge
    request's `web_url`, `<base>/<group>[/<subgroup>]/<project>/-/merge_requests/<n>`,
    with `owner` the namespace path. None for anything else.
    """
    m = _GITHUB_PR_URL_RE.match(url)
    if m:
        return "github", m.group("owner"), m.group("repo"), int(m.group("number"))
    found = _gitlab_object_url(url, "merge_requests", gitlab_base=gitlab_base)
    return ("gitlab", *found) if found else None


def parse_run_url(
    url: str, *, gitlab_base: str | None = None
) -> tuple[str, str, str, int] | None:
    """(host kind, owner, repo, run id) of a CI run URL: a GitHub Actions run
    (`…/actions/runs/<id>`) or a GitLab pipeline (`…/-/pipelines/<id>`)."""
    m = _GITHUB_RUN_URL_RE.match(url)
    if m:
        return "github", m.group("owner"), m.group("repo"), int(m.group("run_id"))
    found = _gitlab_object_url(url, "pipelines", gitlab_base=gitlab_base)
    return ("gitlab", *found) if found else None


def client_for_kind(kind: str) -> FollowUpHost:
    if kind == "gitlab":
        return GitLabClient()
    # Imported here: git.py imports this module at load time.
    from harness.git import GitHubClient

    return GitHubClient()


def client_for_change_request_url(url: str) -> FollowUpHost:
    """The adapter for a pull request or merge request URL."""
    parsed = parse_change_request_url(url)
    if parsed is None:
        raise RuntimeError(f"Unsupported change request URL: {url}")
    return client_for_kind(parsed[0])


def client_for_run_url(url: str) -> FollowUpHost:
    """The adapter for a CI run URL."""
    parsed = parse_run_url(url)
    if parsed is None:
        raise RuntimeError(f"Unsupported CI run URL: {url}")
    return client_for_kind(parsed[0])


def remote_origin_url(repo_path: Path) -> str:
    r = run_cmd(
        ["git", "-C", str(repo_path), "config", "--get", "remote.origin.url"],
        check=False,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"No git remote.origin.url in {repo_path}")
    return r.stdout.strip()


def client_for_remote_url(url: str) -> FollowUpHost:
    """The adapter for a remote: GitLab for the configured instance, else
    GitHub. Chosen per repo, so a workspace may mix hosts."""
    kind, _owner, _repo = parse_remote_url(url)
    return client_for_kind(kind)


def client_for_repo(repo_path: Path) -> FollowUpHost:
    return client_for_remote_url(remote_origin_url(repo_path))


# ──── GitLab adapter ───────────────────────────────────────────────────────


class GitLabApiError(CodeHostApiError):
    def __init__(self, method: str, path: str, status: int, response_body: str) -> None:
        super().__init__(method, path, status, response_body)
        self.args = (f"GitLab API {method} {path} -> {status}: {response_body[:400]}",)


class GitLabClient:
    """The GitLab REST v4 adapter behind `CodeHost` and `FollowUpHost`.

    Numbers: the merge request `iid` (per project) is what URLs and every
    `/merge_requests/<n>` path use; the global `id` never leaves this class.
    The URL recorded as `pr_url` is GitLab's own `web_url` for the merge
    request, which the control plane stores verbatim. A "run" is a pipeline
    and a "job" a job; "org members" are a group's members (inherited ones
    included); a review summary stream does not exist on GitLab (approvals
    carry no body), so `list_pull_request_reviews` is always empty.
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

    def _request_text(self, method: str, path: str) -> str:
        """A plain-text answer (a job trace)."""
        url = f"{self._api_url}{path}"
        req = urllib.request.Request(url, method=method)
        req.add_header("Authorization", f"Bearer {self._token}")
        try:
            with urllib.request.urlopen(
                req, context=self._ssl_ctx, timeout=120
            ) as resp:
                status = resp.status
                raw = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            raise GitLabApiError(method, path, e.code, raw) from e
        if status != 200:
            raise GitLabApiError(method, path, status, raw)
        return raw

    def _paginated(self, path: str) -> list[dict[str, Any]]:
        """Every page of a list endpoint; a short page is terminal."""
        items: list[dict[str, Any]] = []
        separator = "&" if "?" in path else "?"
        page = 1
        while True:
            data = self._request("GET", f"{path}{separator}per_page=100&page={page}")
            if not isinstance(data, list):
                raise TypeError(f"GitLab list endpoint returned non-list for {path}")
            items.extend(d for d in data if isinstance(d, dict))
            if len(data) < 100:
                return items
            page += 1

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

    # ── FollowUpHost ─────────────────────────────────────────────────────
    def get_pull_request(self, owner: str, repo: str, pr_number: int) -> dict[str, Any]:
        """The merge request, with `body` mirroring GitLab's `description`."""
        r = self._request("GET", f"{self._mr(owner, repo, pr_number)}")
        if isinstance(r, dict):
            r.setdefault("body", r.get("description") or "")
        return r

    def update_pull_request(
        self,
        owner: str,
        repo: str,
        pr_number: int,
        *,
        title: str | None = None,
        body: str | None = None,
    ) -> dict[str, Any]:
        """PUT the merge request's title and/or description. Only non-None
        fields are sent. A draft keeps its `Draft:` prefix if the new title
        lacks one, so an edit never un-drafts it by accident."""
        fields: dict[str, Any] = {}
        if title is not None:
            fields["title"] = title
        if body is not None:
            fields["description"] = body
        if not fields:
            raise ValueError("update_pull_request requires at least one field to set")
        if "title" in fields and not fields["title"].startswith(GITLAB_DRAFT_PREFIX):
            current = self._request("GET", self._mr(owner, repo, pr_number))
            if isinstance(current, dict) and current.get("draft") is True:
                fields["title"] = f"{GITLAB_DRAFT_PREFIX}{fields['title']}"
        return self._request("PUT", self._mr(owner, repo, pr_number), fields)

    def list_issue_comments(
        self, owner: str, repo: str, issue_number: int
    ) -> list[dict[str, Any]]:
        """The merge request's plain notes (not system notes, not diff notes),
        in GitHub's issue-comment shape."""
        return [
            _github_comment_shape(n)
            for n in self._notes(owner, repo, issue_number)
            if n.get("type") != "DiffNote"
        ]

    def list_pull_request_review_comments(
        self, owner: str, repo: str, pr_number: int
    ) -> list[dict[str, Any]]:
        """The merge request's diff notes, in GitHub's review-comment shape
        (`path` and `line` from the note's position)."""
        out: list[dict[str, Any]] = []
        for n in self._notes(owner, repo, pr_number):
            if n.get("type") != "DiffNote":
                continue
            shaped = _github_comment_shape(n)
            position = n.get("position") if isinstance(n.get("position"), dict) else {}
            path = position.get("new_path") or position.get("old_path")
            line = position.get("new_line") or position.get("old_line")
            if isinstance(path, str) and path:
                shaped["path"] = path
            if isinstance(line, int):
                shaped["line"] = line
            out.append(shaped)
        return out

    def list_pull_request_reviews(
        self, owner: str, repo: str, pr_number: int
    ) -> list[dict[str, Any]]:
        """GitLab has no review summary bodies: approvals carry no text."""
        return []

    def list_org_members(self, org: str) -> list[dict[str, Any]]:
        """Every member of a group (inherited and shared included), as
        `{id, login}`: `/groups/<group>/members/all`."""
        enc = urllib.parse.quote(org, safe="")
        return [
            {"id": m.get("id"), "login": m.get("username")}
            for m in self._paginated(f"/groups/{enc}/members/all")
        ]

    def get_user(self, login: str) -> dict[str, Any]:
        """`{id, login}` for a username; empty when no such user."""
        enc = urllib.parse.quote(login, safe="")
        data = self._request("GET", f"/users?username={enc}")
        first = data[0] if isinstance(data, list) and data else None
        if not isinstance(first, dict):
            return {}
        return {"id": first.get("id"), "login": first.get("username")}

    def get_workflow_run_jobs(
        self, owner: str, repo: str, run_id: int
    ) -> list[dict[str, Any]]:
        """A pipeline's jobs as `{id, name, conclusion}`, GitLab's `failed`
        spelled GitHub's way (`failure`) so ci_logs picks the same ones."""
        jobs = self._paginated(
            f"/projects/{self._project(owner, repo)}/pipelines/{run_id}/jobs"
        )
        return [
            {
                "id": j.get("id"),
                "name": j.get("name"),
                "conclusion": "failure"
                if j.get("status") == "failed"
                else j.get("status"),
                "stage": j.get("stage"),
            }
            for j in jobs
        ]

    def get_job_logs(self, owner: str, repo: str, job_id: int) -> str:
        return self._request_text(
            "GET", f"/projects/{self._project(owner, repo)}/jobs/{job_id}/trace"
        )

    def rerun_failed_jobs(self, owner: str, repo: str, run_id: int) -> dict[str, Any]:
        """Retry the pipeline's failed jobs: `POST /pipelines/<id>/retry`."""
        return self._request(
            "POST", f"/projects/{self._project(owner, repo)}/pipelines/{run_id}/retry"
        )

    # ── helpers ──────────────────────────────────────────────────────────
    def _mr(self, owner: str, repo: str, iid: int) -> str:
        return f"/projects/{self._project(owner, repo)}/merge_requests/{iid}"

    def _notes(self, owner: str, repo: str, iid: int) -> list[dict[str, Any]]:
        return [
            n
            for n in self._paginated(f"{self._mr(owner, repo, iid)}/notes")
            if n.get("system") is not True
        ]


def _github_comment_shape(note: Mapping[str, Any]) -> dict[str, Any]:
    """A GitLab note as the GitHub comment dict discussion_context reads."""
    author = note.get("author") if isinstance(note.get("author"), Mapping) else {}
    return {
        "id": note.get("id"),
        "user": {"id": author.get("id"), "login": author.get("username")},
        "body": note.get("body") or "",
        "created_at": note.get("created_at") or "",
    }
