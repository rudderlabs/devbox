"""
GitHub REST client and git introspection helpers.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from harness.cmd_runner import run_cmd, run_cmd_with_display_argv
from harness.env_flags import bool_env, knowledge_dir_relative_path
from harness.paths import WORKSPACE
from harness.plan_utils import (
    knowledge_subpaths_for_component_paths,
    knowledge_subpaths_for_repo,
    repo_checkout_path,
)
from harness.schemas import PlanRepo

# ── GitHub REST client ───────────────────────────────────────────────────────
# Used for repo metadata lookups, branch collision checks, and PR creation.
# In-sandbox: the token is a placeholder that iron-proxy swaps at egress.


class GitHubApiError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, response_body: str) -> None:
        super().__init__(f"GitHub {method} {path} -> {status}: {response_body[:400]}")
        self.method = method
        self.path = path
        self.status = status
        self.response_body = response_body


class CommitPublishError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        branch: str | None = None,
        commit_sha: str | None = None,
    ) -> None:
        super().__init__(message)
        self.branch = branch
        self.commit_sha = commit_sha


class GitHubClient:
    def __init__(
        self,
        *,
        token: str | None = None,
        api_url: str | None = None,
        api_version: str | None = None,
    ) -> None:
        self._token = (
            token
            or os.environ.get("GITHUB_TOKEN")
            or os.environ.get("GITHUB_PROXY_TOKEN", "proxy-github-dummy-token")
        )
        self._api_url = (
            api_url or os.environ.get("GITHUB_API_URL", "https://api.github.com")
        ).rstrip("/")
        self._api_version = api_version or os.environ.get(
            "GITHUB_API_VERSION", "2026-03-10"
        )
        # TLS trust is the system store only. Callers that need an extra CA
        # (e.g. an egress proxy's MITM cert) must install it system-wide before
        # the harness runs — the image's bootstrap script already does this
        # for the iron-proxy CA in the sandbox image.
        self._ssl_ctx = ssl.create_default_context()

    def _request(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
        *,
        expected: tuple[int, ...] = (200, 201),
    ) -> dict[str, Any]:
        url = f"{self._api_url}{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"token {self._token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", self._api_version)
        if data is not None:
            req.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(req, context=self._ssl_ctx) as resp:
                status = resp.status
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            raise GitHubApiError(method, path, e.code, raw) from e

        if status not in expected:
            raise GitHubApiError(method, path, status, raw)
        return json.loads(raw) if raw else {}

    def _request_text(
        self,
        method: str,
        path: str,
        *,
        expected: tuple[int, ...] = (200,),
    ) -> str:
        url = f"{self._api_url}{path}"
        req = urllib.request.Request(url, method=method)
        req.add_header("Authorization", f"token {self._token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", self._api_version)
        try:
            with urllib.request.urlopen(req, context=self._ssl_ctx) as resp:
                status = resp.status
                raw = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            raise GitHubApiError(method, path, e.code, raw) from e
        if status not in expected:
            raise GitHubApiError(method, path, status, raw)
        return raw

    def _request_log_download(self, path: str) -> str:
        """Download plain text from a GitHub endpoint that 302s to blob storage.

        Job log downloads always redirect to a pre-signed Azure URL.
        ``urlopen`` forwards the GitHub ``Authorization`` header on cross-host
        redirects, which the blob store rejects as an invalid signature (403
        XML). So we expect exactly a ``302`` with a ``Location`` header, then
        fetch that signed URL in a second, unauthenticated request. Anything
        else is treated as an error.
        """
        method = "GET"
        location = self._resolve_log_redirect(method, path)
        return self._download_unauthenticated(method, path, location)

    def _resolve_log_redirect(self, method: str, path: str) -> str:
        """Issue the authenticated request and return the redirect target.

        Redirects are disabled so the ``302`` surfaces here instead of being
        auto-followed (which would leak the ``Authorization`` header). A
        non-302 response, or a 302 without ``Location``, is an error.
        """
        url = f"{self._api_url}{path}"
        req = urllib.request.Request(url, method=method)
        req.add_header("Authorization", f"token {self._token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", self._api_version)

        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        https_handler = urllib.request.HTTPSHandler(context=self._ssl_ctx)
        opener = urllib.request.build_opener(_NoRedirect, https_handler)
        try:
            with opener.open(req, timeout=120) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                raise GitHubApiError(method, path, resp.status, raw)
        except urllib.error.HTTPError as e:
            if e.code != 302:
                raw = e.read().decode("utf-8", errors="replace")
                raise GitHubApiError(method, path, e.code, raw) from e

            location = e.headers.get("Location") or e.headers.get("location")
            if not location:
                raise GitHubApiError(
                    method, path, e.code, "redirect missing Location header"
                ) from e
            return location

    def _download_unauthenticated(self, method: str, path: str, url: str) -> str:
        """Fetch the pre-signed blob URL without any GitHub credentials."""
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, context=self._ssl_ctx, timeout=120) as dl:
                return dl.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise GitHubApiError(method, path, e.code, body) from e

    # ── repo / branch ────────────────────────────────────────────────────
    def get_default_branch(self, owner: str, repo: str) -> str:
        r = self._request("GET", f"/repos/{owner}/{repo}")
        return str(r["default_branch"])

    def get_ref_sha(self, owner: str, repo: str, ref: str) -> str | None:
        enc = urllib.parse.quote(ref, safe="")
        try:
            r = self._request("GET", f"/repos/{owner}/{repo}/git/ref/{enc}")
            return str(r["object"]["sha"])
        except GitHubApiError as e:
            if e.status == 404:
                return None
            raise

    # ── PR ───────────────────────────────────────────────────────────────
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
        r = self._request(
            "POST",
            f"/repos/{owner}/{repo}/pulls",
            {"title": title, "body": body, "head": head, "base": base, "draft": draft},
        )
        url = r.get("html_url")
        if not url:
            raise RuntimeError(f"PR creation response missing html_url: {r}")
        return str(url)

    def find_open_pr_by_head(self, owner: str, repo: str, branch: str) -> str | None:
        """Return the html_url of the open PR whose head is `branch`, or None.

        Used on restart to reuse a PR a prior attempt already opened instead of
        creating a duplicate.
        """
        head = urllib.parse.quote(f"{owner}:{branch}", safe="")
        raw = self._request_text(
            "GET", f"/repos/{owner}/{repo}/pulls?head={head}&state=open"
        )
        data = json.loads(raw) if raw else []
        if isinstance(data, list) and data:
            url = data[0].get("html_url")
            return str(url) if url else None
        return None

    def get_pull_request(self, owner: str, repo: str, pr_number: int) -> dict[str, Any]:
        return self._request("GET", f"/repos/{owner}/{repo}/pulls/{pr_number}")

    def update_pull_request(
        self,
        owner: str,
        repo: str,
        pr_number: int,
        *,
        title: str | None = None,
        body: str | None = None,
    ) -> dict[str, Any]:
        """PATCH a PR's metadata. Only non-None fields are sent."""
        fields: dict[str, Any] = {}
        if title is not None:
            fields["title"] = title
        if body is not None:
            fields["body"] = body
        if not fields:
            raise ValueError("update_pull_request requires at least one field to set")
        return self._request(
            "PATCH", f"/repos/{owner}/{repo}/pulls/{pr_number}", fields
        )

    def _request_paginated_list(self, path: str) -> list[dict[str, Any]]:
        """Fetch every page for a GitHub list endpoint.

        Uses the same authenticated request path as the rest of this client so
        sandbox token replacement continues to work through iron-proxy. GitHub
        list endpoints return an empty list when a page is past the end; a short
        page is also terminal.
        """
        items: list[dict[str, Any]] = []
        per_page = 100
        page = 1
        separator = "&" if "?" in path else "?"
        while True:
            raw = self._request_text(
                "GET", f"{path}{separator}per_page={per_page}&page={page}"
            )
            data = json.loads(raw) if raw else []
            if not isinstance(data, list):
                raise TypeError(f"GitHub list endpoint returned non-list for {path}")
            items.extend(data)
            if len(data) < per_page:
                return items
            page += 1

    def list_issue_comments(
        self, owner: str, repo: str, issue_number: int
    ) -> list[dict[str, Any]]:
        """List all issue comments on a PR's conversation tab."""
        return self._request_paginated_list(
            f"/repos/{owner}/{repo}/issues/{issue_number}/comments"
        )

    def list_pull_request_review_comments(
        self, owner: str, repo: str, pr_number: int
    ) -> list[dict[str, Any]]:
        """List all pull-request review comments, including inline comments."""
        return self._request_paginated_list(
            f"/repos/{owner}/{repo}/pulls/{pr_number}/comments"
        )

    def list_pull_request_reviews(
        self, owner: str, repo: str, pr_number: int
    ) -> list[dict[str, Any]]:
        """List all submitted reviews on a PR (the review *summary* bodies).

        A review's summary body lives here, not in the comment streams; each
        carries ``id`` (its own sequence, distinct from review-comment ids),
        ``user``, ``body``, ``state``, and ``submitted_at``.
        """
        return self._request_paginated_list(
            f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews"
        )

    def list_org_members(self, org: str) -> list[dict[str, Any]]:
        """List all members of a GitHub org (needs ``read:org`` on the token).

        Each member carries a numeric ``id`` — immutable and never re-issued by
        GitHub, so a rename cannot grant a stranger trust. An empty result is a
        legitimate failure signal (scope-deficient token or wrong org name).
        """
        return self._request_paginated_list(f"/orgs/{org}/members")

    def get_user(self, login: str) -> dict[str, Any]:
        """Fetch a GitHub user by login; the numeric ``id`` is immutable.

        Used to resolve a configured trusted login to an id that survives renames.
        """
        return self._request("GET", f"/users/{urllib.parse.quote(login, safe='')}")

    # ── GitHub Actions ───────────────────────────────────────────────────
    def get_workflow_run_jobs(
        self, owner: str, repo: str, run_id: int
    ) -> list[dict[str, Any]]:
        r = self._request(
            "GET", f"/repos/{owner}/{repo}/actions/runs/{run_id}/jobs?per_page=100"
        )
        return r.get("jobs", [])

    def get_job_logs(self, owner: str, repo: str, job_id: int) -> str:
        return self._request_log_download(
            f"/repos/{owner}/{repo}/actions/jobs/{job_id}/logs"
        )

    def rerun_failed_jobs(self, owner: str, repo: str, run_id: int) -> dict[str, Any]:
        """Re-run only the failed jobs of a workflow run.

        GitHub returns 201 with an empty body; `_request` maps that to `{}`.
        """
        return self._request(
            "POST",
            f"/repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs",
            expected=(201,),
        )


# ── Git helpers ──────────────────────────────────────────────────────────────


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


_PR_URL_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<number>\d+)(?:/|$)"
)


def parse_pr_url(url: str) -> tuple[str, str, int] | None:
    """Parse a GitHub PR URL into (owner, repo, number), or None if it doesn't
    match. Tolerates a trailing slash or path segment (e.g. /files, /commits)."""
    m = _PR_URL_RE.match(url)
    if not m:
        return None
    return m.group("owner"), m.group("repo"), int(m.group("number"))


def parse_owner_repo_from_git_remote(repo_path: Path) -> tuple[str, str]:
    r = run_cmd(
        ["git", "-C", str(repo_path), "config", "--get", "remote.origin.url"],
        check=False,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"No git remote.origin.url in {repo_path}")
    url = r.stdout.strip()
    m = _GITHUB_REMOTE_RE.match(url)
    if not m:
        raise RuntimeError(f"Unsupported GitHub remote URL: {url}")
    return m.group("owner"), m.group("repo")


def _git_head_sha(repo_path: Path) -> str:
    r = run_cmd(["git", "-C", str(repo_path), "rev-parse", "HEAD"], check=True)
    return r.stdout.strip()


def _git_current_branch(repo_path: Path) -> str:
    r = run_cmd(
        ["git", "-C", str(repo_path), "symbolic-ref", "--quiet", "--short", "HEAD"],
        check=False,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"Detached HEAD in {repo_path}")
    return r.stdout.strip()


def _git_local_branch_exists(repo_path: Path, branch_name: str) -> bool:
    r = run_cmd(
        [
            "git",
            "-C",
            str(repo_path),
            "show-ref",
            "--verify",
            "--quiet",
            f"refs/heads/{branch_name}",
        ],
        check=False,
    )
    if r.returncode in (0, 1):
        return r.returncode == 0
    raise RuntimeError(
        f"Unable to determine whether local branch {branch_name} exists in {repo_path}"
    )


def _git_has_staged_changes(repo_path: Path) -> bool:
    r = run_cmd(
        ["git", "-C", str(repo_path), "diff", "--cached", "--quiet", "--exit-code"],
        check=False,
    )
    if r.returncode in (0, 1):
        return r.returncode == 1
    raise RuntimeError(f"Unable to inspect staged changes in {repo_path}")


def sync_current_branch_from_origin(repo_path: Path) -> str:
    """Sync the current local branch with origin.

    One network fetch of the branch into FETCH_HEAD, then a local-only
    `merge --ff-only`. This is exactly what `git pull --ff-only origin <branch>`
    does internally, minus pull's redundant second fetch — halving the network
    round-trips per repo, which matters when sync_all_repos_from_origin fans
    this out across every checkout. `--ff-only` keeps implicit merge/rebase off;
    `--no-tags` skips tag negotiation a fast-forward sync never needs.
    """
    branch = _git_current_branch(repo_path)
    try:
        run_cmd(
            ["git", "-C", str(repo_path), "fetch", "--no-tags", "origin", branch],
            check=True,
        )
        run_cmd(
            ["git", "-C", str(repo_path), "merge", "--ff-only", "FETCH_HEAD"],
            check=True,
        )
    except subprocess.CalledProcessError as e:
        detail = e.stderr.strip() or e.stdout.strip() or str(e)
        raise RuntimeError(
            f"sync with origin failed for {repo_path} on branch {branch}: {detail}"
        ) from e
    return branch


def commit_one_repo(
    repo: Path,
    *,
    client: GitHubClient,
    branch_name: str,
    commit_message: str,
) -> dict[str, str]:
    """Publish worktree changes as a native git commit on `branch_name`.

    Idempotent across restarts: if `branch_name` already exists on the remote,
    a prior attempt's commit+push completed (commit is atomic, push is
    all-or-nothing), so its SHA is reused and the local git work is skipped. If
    the branch exists only locally (crash after commit, before push), the
    existing branch is checked out and pushed.
    """
    owner, name = parse_owner_repo_from_git_remote(repo)
    try:
        current_branch = _git_current_branch(repo)
    except RuntimeError as e:
        raise CommitPublishError(str(e)) from e
    # Refuse to branch off someone else's harness branch — but resuming onto our
    # own deterministic target branch is legitimate.
    if current_branch.startswith("devbox/") and current_branch != branch_name:
        raise CommitPublishError(
            f"Refusing to create {branch_name} from existing harness branch {current_branch}",
            branch=current_branch,
        )

    dry_run_publish = bool_env("HARNESS_DRY_RUN_PUBLISH")
    if dry_run_publish:
        # Local dry-runs exercise branch creation, commit, S3 evidence hosting,
        # and PR-body assembly without requiring GitHub API credentials.
        pr_base = current_branch
        existing_remote = None
    else:
        # Base for any PR we may open: a non-harness current branch that exists on
        # the remote, else the default branch. (After a resume the working tree may
        # already be on our harness branch, so we cannot derive base from it.)
        if (
            not current_branch.startswith("devbox/")
            and client.get_ref_sha(owner, name, f"heads/{current_branch}") is not None
        ):
            pr_base = current_branch
        else:
            pr_base = client.get_default_branch(owner, name)

        existing_remote = client.get_ref_sha(owner, name, f"heads/{branch_name}")
    if existing_remote is not None:
        # Already published by a prior attempt — reuse, skip all git work.
        return {"commit_sha": existing_remote, "branch": branch_name, "base": pr_base}

    if _git_local_branch_exists(repo, branch_name):
        # Resuming onto a branch a prior attempt created. It may have crashed
        # after `checkout -b` but before committing, leaving the real changes
        # uncommitted — stage and commit them so we never push an empty branch.
        try:
            run_cmd(["git", "-C", str(repo), "checkout", branch_name], check=True)
        except subprocess.CalledProcessError as e:
            detail = e.stderr.strip() or e.stdout.strip() or str(e)
            raise CommitPublishError(
                f"git checkout failed for {repo}: {detail}", branch=branch_name
            ) from e
        try:
            run_cmd(["git", "-C", str(repo), "add", "-A"], check=True)
        except subprocess.CalledProcessError as e:
            detail = e.stderr.strip() or e.stdout.strip() or str(e)
            raise CommitPublishError(
                f"git staging failed for {repo}: {detail}", branch=branch_name
            ) from e
        if _git_has_staged_changes(repo):
            try:
                run_cmd(
                    ["git", "-C", str(repo), "commit", "-m", commit_message],
                    check=True,
                )
            except subprocess.CalledProcessError as e:
                detail = e.stderr.strip() or e.stdout.strip() or str(e)
                raise CommitPublishError(
                    f"git commit failed for {repo}: {detail}", branch=branch_name
                ) from e
    else:
        try:
            run_cmd(["git", "-C", str(repo), "checkout", "-b", branch_name], check=True)
            run_cmd(["git", "-C", str(repo), "add", "-A"], check=True)
        except subprocess.CalledProcessError as e:
            detail = e.stderr.strip() or e.stdout.strip() or str(e)
            raise CommitPublishError(
                f"git staging failed for {repo}: {detail}",
                branch=branch_name,
            ) from e

        if not _git_has_staged_changes(repo):
            raise CommitPublishError(
                f"No working tree changes in {repo}", branch=branch_name
            )

        try:
            run_cmd(
                ["git", "-C", str(repo), "commit", "-m", commit_message],
                check=True,
            )
        except subprocess.CalledProcessError as e:
            detail = e.stderr.strip() or e.stdout.strip() or str(e)
            raise CommitPublishError(
                f"git commit failed for {repo}: {detail}",
                branch=branch_name,
            ) from e

    commit_sha = _git_head_sha(repo)

    # Dry-run publish: commit locally but skip the push (no remote write). The
    # branch + commit still exist locally so the caller's PR-body assembly runs.
    if dry_run_publish:
        print(f"DRY-RUN: skipping git push of {branch_name} for {repo}")
        return {"commit_sha": commit_sha, "branch": branch_name, "base": pr_base}

    push = run_cmd(
        ["git", "-C", str(repo), "push", "-u", "origin", branch_name],
        check=False,
    )
    if push.returncode != 0:
        raise CommitPublishError(
            f"git push failed for {repo}: {push.stderr.strip() or push.stdout.strip()}",
            branch=branch_name,
            commit_sha=commit_sha,
        )
    return {"commit_sha": commit_sha, "branch": branch_name, "base": pr_base}


def has_working_tree_changes(repo: Path) -> bool:
    """True if `repo` has uncommitted working-tree changes (porcelain non-empty)."""
    r = run_cmd(["git", "-C", str(repo), "status", "--porcelain"], check=True)
    return bool(r.stdout.strip())


def git_head(repo_path: Path) -> str:
    """Return the current HEAD SHA for a checkout."""
    return _git_head_sha(repo_path)


def git_dirty_paths(repo_path: Path) -> list[str]:
    """Return dirty paths from `git status --porcelain`, normalized for renames."""
    r = run_cmd(
        ["git", "-C", str(repo_path), "status", "--porcelain", "--untracked-files=all"],
        check=True,
    )
    paths: list[str] = []
    for line in r.stdout.splitlines():
        if not line:
            continue
        path = line[3:] if len(line) > 3 else ""
        if " -> " in path:
            path = path.rsplit(" -> ", 1)[-1]
        if path:
            paths.append(path)
    return sorted(paths)


def _is_path_under_prefix(path_parts: tuple[str, ...], prefix: Path) -> bool:
    prefix_parts = prefix.parts
    return (
        len(path_parts) > len(prefix_parts)
        and path_parts[: len(prefix_parts)] == prefix_parts
    )


def _knowledge_subpaths_for_plan_repo_mapping(
    plan_repo: Mapping[str, Any], *, workspace: Path | None = None
) -> list[str]:
    """``knowledge_subpaths_for_repo`` for an unvalidated plan repo mapping."""
    name = plan_repo.get("name")
    components = plan_repo.get("components")
    if not isinstance(name, str) or not isinstance(components, list):
        return []
    component_paths = [
        component.get("path")
        for component in components
        if isinstance(component, Mapping) and isinstance(component.get("path"), str)
    ]
    try:
        return knowledge_subpaths_for_component_paths(
            name, component_paths, workspace=workspace or WORKSPACE
        )
    except ValueError:
        return []


def knowledge_path_prefixes(
    plan_repo: PlanRepo | Mapping[str, Any] | None = None,
    *,
    workspace: Path | None = None,
) -> tuple[Path, ...]:
    """Return allowed repo-relative prefixes for configured knowledge files."""
    knowledge_dir = knowledge_dir_relative_path()
    prefixes = [knowledge_dir]
    if isinstance(plan_repo, PlanRepo):
        subpaths = knowledge_subpaths_for_repo(
            plan_repo, workspace=workspace or WORKSPACE
        )
    elif isinstance(plan_repo, Mapping):
        subpaths = _knowledge_subpaths_for_plan_repo_mapping(
            plan_repo, workspace=workspace or WORKSPACE
        )
    else:
        subpaths = []
    prefixes.extend(Path(subpath) / knowledge_dir for subpath in subpaths)
    return tuple(dict.fromkeys(prefixes))


def is_knowledge_path(
    path: str,
    *,
    plan_repo: PlanRepo | Mapping[str, Any] | None = None,
    workspace: Path | None = None,
) -> bool:
    """True when a git path is under an allowed knowledge directory prefix."""
    path_parts = Path(path).parts
    return any(
        _is_path_under_prefix(path_parts, prefix)
        for prefix in knowledge_path_prefixes(plan_repo, workspace=workspace)
    )


def is_stray_knowledge_path(
    path: str,
    *,
    plan_repo: PlanRepo | Mapping[str, Any] | None = None,
    workspace: Path | None = None,
) -> bool:
    """True for a Markdown file in a knowledge directory outside the allowed scopes.

    Allowed scopes are the repository root and the plan's components (see
    ``is_knowledge_path``); a knowledge file anywhere else is stray.
    """
    path_obj = Path(path)
    if path_obj.suffix != ".md" or is_knowledge_path(
        path, plan_repo=plan_repo, workspace=workspace
    ):
        return False
    path_parts = path_obj.parts
    knowledge_parts = knowledge_dir_relative_path().parts
    return any(
        path_parts[i : i + len(knowledge_parts)] == knowledge_parts
        for i in range(len(path_parts) - len(knowledge_parts))
    )


def discard_paths(repo_path: Path, paths: Sequence[str]) -> None:
    """Drop working-tree changes to *paths*: restore tracked files, delete new ones."""
    for path in paths:
        in_head = run_cmd(
            ["git", "-C", str(repo_path), "cat-file", "-e", f"HEAD:{path}"],
            check=False,
        )
        if in_head.returncode == 0:
            run_cmd(
                ["git", "-C", str(repo_path), "checkout", "HEAD", "--", path],
                check=True,
            )
            continue
        run_cmd(
            [
                "git",
                "-C",
                str(repo_path),
                "rm",
                "--cached",
                "--quiet",
                "--ignore-unmatch",
                "--",
                path,
            ],
            check=True,
        )
        (repo_path / path).unlink(missing_ok=True)


def unique_repo_names(
    repo_names: Iterable[Any], *, workspace: Path | None = None
) -> list[str]:
    """Normalize bare checkout names while preserving first-seen ordering."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in repo_names:
        if not isinstance(raw, str):
            continue
        name = raw.strip()
        if not name or name in seen:
            continue
        try:
            repo_checkout_path(name, workspace=workspace or WORKSPACE)
        except ValueError:
            continue
        out.append(name)
        seen.add(name)
    return out


def repo_names_matching_slugs(
    repo_slugs: Sequence[str], *, workspace: Path | None = None
) -> list[str]:
    """Find local checkout names whose GitHub remote matches a repo slug."""
    normalized_slugs = {
        s.strip().lower().removesuffix(".git")
        for s in repo_slugs
        if isinstance(s, str) and s.strip()
    }
    if not normalized_slugs:
        return []

    root = workspace or WORKSPACE
    matched: list[str] = []
    for child in sorted(root.iterdir()) if root.is_dir() else []:
        if not (child / ".git").exists():
            continue
        try:
            owner, repo = parse_owner_repo_from_git_remote(child)
        except RuntimeError:
            continue
        full = f"{owner}/{repo}".lower().removesuffix(".git")
        if (
            repo.lower().removesuffix(".git") in normalized_slugs
            or full in normalized_slugs
        ):
            matched.append(child.name)
    return unique_repo_names(matched, workspace=root)


def candidate_repo_names(
    repo_slugs: Sequence[str],
    fallback_repo_names: Iterable[Any],
    *,
    workspace: Path | None = None,
) -> list[str]:
    """Return repo candidates from slugs, falling back to planned repo names."""
    matched = repo_names_matching_slugs(repo_slugs, workspace=workspace)
    if matched:
        return matched
    if repo_slugs:
        print(
            "candidate_repo_names: no local checkout matched repo slugs "
            f"({', '.join(str(s) for s in repo_slugs)}); returning no candidates"
        )
        return []
    return unique_repo_names(fallback_repo_names, workspace=workspace)


def candidate_repo_heads(
    repo_names: Iterable[Any], *, workspace: Path | None = None
) -> dict[str, str]:
    """Return current HEADs for existing local git checkouts."""
    root = workspace or WORKSPACE
    heads: dict[str, str] = {}
    for name in unique_repo_names(repo_names, workspace=root):
        repo_path = repo_checkout_path(name, workspace=root)
        if not repo_path.is_dir() or not (repo_path / ".git").exists():
            continue
        heads[name] = git_head(repo_path)
    return heads


def changed_repo_names_since(
    before_heads: Mapping[str, str], *, workspace: Path | None = None
) -> list[str]:
    """Return repo names whose HEAD moved since an earlier snapshot."""
    root = workspace or WORKSPACE
    changed: list[str] = []
    for name, before in before_heads.items():
        repo_path = repo_checkout_path(name, workspace=root)
        if not repo_path.is_dir() or not (repo_path / ".git").exists():
            continue
        if git_head(repo_path) != before:
            changed.append(name)
    return changed


def sync_target_repos_before_edit(
    repo_slugs: Sequence[str], *, workspace: Path | None = None
) -> None:
    """Sync only task-scoped repositories before edit/resume work starts."""
    normalized = {
        s.strip().lower().removesuffix(".git")
        for s in repo_slugs
        if isinstance(s, str) and s.strip()
    }
    if not normalized:
        return

    root = workspace or WORKSPACE
    matched: list[Path] = []
    for child in sorted(root.iterdir()) if root.is_dir() else []:
        if not (child / ".git").exists():
            continue
        try:
            owner, repo = parse_owner_repo_from_git_remote(child)
        except RuntimeError as exc:
            print(
                f"sync_target_repos_before_edit: skipping {child} "
                f"({type(exc).__name__}: {exc})"
            )
            continue
        full = f"{owner}/{repo}".lower().removesuffix(".git")
        if repo.lower().removesuffix(".git") in normalized or full in normalized:
            matched.append(child)

    if not matched:
        raise RuntimeError(
            "Could not map task-scoped repository identifiers to local checkouts: "
            + ", ".join(sorted(normalized))
        )

    for repo in matched:
        try:
            sync_current_branch_from_origin(repo)
        except RuntimeError as exc:
            print(
                f"sync_target_repos_before_edit: sync failed for {repo} "
                f"({type(exc).__name__}: {exc})"
            )


def discover_dirty_repos() -> list[Path]:
    """Every git checkout directly under WORKSPACE with a dirty working tree.

    Sorted for deterministic ordering. The comment/review finalize path walks
    this — a dirty tree is the trigger to commit; the branch then classifies
    follow-up-commit vs new-PR.
    """
    if not WORKSPACE.is_dir():
        return []
    children = [c for c in sorted(WORKSPACE.iterdir()) if (c / ".git").exists()]
    if not children:
        return []

    def check(child: Path) -> Path | None:
        # A broken / unusual checkout must not abort discovery of the others —
        # `git status` exiting non-zero on one directory just means "skip it".
        try:
            return child if has_working_tree_changes(child) else None
        except Exception as exc:
            print(
                f"discover_dirty_repos: skipping {child} ({type(exc).__name__}: {exc})",
                file=sys.stderr,
            )
            return None

    with ThreadPoolExecutor(max_workers=min(20, len(children))) as ex:
        return [r for r in ex.map(check, children) if r is not None]


def sync_all_repos_from_origin(workspace: Path) -> list[Path]:
    """Fast-forward every git checkout directly under *workspace* to origin.

    Called during assignment setup so a sandbox booted from a periodic snapshot
    (the attached repos are re-snapshotted only every ~30 min) plans and
    implements against current origin state rather than the snapshot — a change
    pushed minutes before the task lands is otherwise invisible until the next
    snapshot. Best-effort per repo: a fetch/pull failure on one checkout
    (network blip, diverged local history, detached HEAD) is logged and skipped
    — running on slightly-stale code beats failing the task over a transient
    sync error.

    Takes *workspace* explicitly rather than reading the module constant so the
    caller's (reloaded, test-controlled) WORKSPACE is honoured and unit tests
    never walk the real /workspace.

    Returns the checkouts that synced cleanly. Mirrors discover_dirty_repos'
    WORKSPACE walk + parallel fan-out (separate working trees, so concurrent
    fetch/pull is safe).
    """
    if not workspace.is_dir():
        return []
    children = [c for c in sorted(workspace.iterdir()) if (c / ".git").exists()]
    if not children:
        return []

    def sync(child: Path) -> Path | None:
        try:
            sync_current_branch_from_origin(child)
            return child
        except Exception as exc:
            print(
                f"sync_all_repos_from_origin: skipping {child} "
                f"({type(exc).__name__}: {exc})",
                file=sys.stderr,
            )
            return None

    with ThreadPoolExecutor(max_workers=min(20, len(children))) as ex:
        return [r for r in ex.map(sync, children) if r is not None]


def update_existing_branch(repo: Path, *, commit_message: str) -> dict[str, str]:
    """Commit + push to the existing harness branch — the comment-round path.

    Pre-conditions: HEAD is already a `devbox/` branch and the working tree is
    dirty (the caller checked via has_working_tree_changes). No branch-create,
    no PR-create, no collision checks. Returns {commit_sha, branch}. Raises
    CommitPublishError on a non-harness HEAD, a clean tree, or a push failure.
    """
    branch = _git_current_branch(repo)
    if not branch.startswith("devbox/"):
        raise CommitPublishError(
            f"Expected harness branch in {repo}, got {branch}",
            branch=branch,
        )
    run_cmd(["git", "-C", str(repo), "add", "-A"], check=True)
    if not _git_has_staged_changes(repo):
        raise CommitPublishError(f"No working tree changes in {repo}", branch=branch)

    try:
        run_cmd(["git", "-C", str(repo), "commit", "-m", commit_message], check=True)
    except subprocess.CalledProcessError as e:
        detail = e.stderr.strip() or e.stdout.strip() or str(e)
        raise CommitPublishError(
            f"git commit failed for {repo}: {detail}",
            branch=branch,
        ) from e

    commit_sha = _git_head_sha(repo)

    push = run_cmd(["git", "-C", str(repo), "push"], check=False)
    if push.returncode != 0:
        raise CommitPublishError(
            f"git push failed for {repo}: {push.stderr.strip() or push.stdout.strip()}",
            branch=branch,
            commit_sha=commit_sha,
        )

    return {"commit_sha": commit_sha, "branch": branch}


def push_clean_commit_if_ahead(
    repo_path: Path, *, commit_message: str
) -> dict[str, str] | None:
    """Push an already-created local knowledge commit on a harness branch.

    This supports retrying a round after distillation committed knowledge locally
    but failed before the push. To avoid pushing arbitrary local work, the branch
    must be ahead of its upstream only by commits whose subject matches
    ``commit_message``.
    """
    branch = _git_current_branch(repo_path)
    if not branch.startswith("devbox/"):
        return None
    upstream = run_cmd(
        [
            "git",
            "-C",
            str(repo_path),
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ],
        check=False,
    )
    if upstream.returncode != 0 or not upstream.stdout.strip():
        return None

    upstream_ref = upstream.stdout.strip()
    count = run_cmd(
        ["git", "-C", str(repo_path), "rev-list", "--count", f"{upstream_ref}..HEAD"],
        check=True,
    )
    try:
        ahead = int(count.stdout.strip())
    except ValueError:
        return None
    if ahead <= 0:
        return None

    subjects = run_cmd(
        ["git", "-C", str(repo_path), "log", "--format=%s", f"{upstream_ref}..HEAD"],
        check=True,
    )
    if any(subject != commit_message for subject in subjects.stdout.splitlines()):
        return None

    commit_sha = git_head(repo_path)
    push = run_cmd(["git", "-C", str(repo_path), "push"], check=False)
    if push.returncode != 0:
        raise CommitPublishError(
            f"git push failed for {repo_path}: "
            f"{push.stderr.strip() or push.stdout.strip()}",
            branch=branch,
            commit_sha=commit_sha,
        )
    return {"commit_sha": commit_sha, "branch": branch}


# ── GPG / git signing ─────────────────────────────────────────────────────────

GIT_SIGNER_NAME_ENV = "HARNESS_GIT_SIGNER_NAME"
GIT_SIGNER_EMAIL_ENV = "HARNESS_GIT_SIGNER_EMAIL"
GPG_PRIVATE_KEY_FILE_ENV = "HARNESS_GPG_PRIVATE_KEY_FILE"
GPG_KEY_ID_ENV = "HARNESS_GPG_KEY_ID"

_git_signing_inputs_cache: (
    tuple[str | None, str | None, str | None, str | None] | None
) = None
_git_signing_key_cache: str | None = None


def _secret_key_fingerprints(raw: str) -> list[str]:
    fingerprints: list[str] = []
    want_primary_fpr = False
    for line in raw.splitlines():
        fields = line.split(":")
        if not fields:
            continue
        record_type = fields[0]
        if record_type == "sec":
            want_primary_fpr = True
            continue
        if record_type in {"ssb", "sec#"}:
            want_primary_fpr = False
            continue
        if record_type == "fpr" and want_primary_fpr and len(fields) > 9:
            fingerprints.append(fields[9])
            want_primary_fpr = False
    return fingerprints


def _resolve_signing_key_fingerprint(configured: str | None) -> str:
    argv = ["gpg", "--batch", "--list-secret-keys", "--with-colons"]
    display_argv = list(argv)
    if configured:
        argv.append(configured)
        display_argv.append("<gpg-key-id>")
    result = run_cmd_with_display_argv(argv, display_argv=display_argv, check=False)
    if result.returncode != 0:
        if configured:
            raise RuntimeError(
                f"{GPG_KEY_ID_ENV}={configured!r} is not present in the local keyring"
            )
        raise RuntimeError("No secret GPG keys available in the local keyring")

    fingerprints = _secret_key_fingerprints(result.stdout)
    if configured:
        if not fingerprints:
            raise RuntimeError(
                f"{GPG_KEY_ID_ENV}={configured!r} did not resolve to a primary secret key"
            )
        return fingerprints[0]

    if not fingerprints:
        raise RuntimeError("No primary secret GPG keys available after import")
    if len(fingerprints) > 1:
        raise RuntimeError(
            f"Multiple secret GPG keys are available; set {GPG_KEY_ID_ENV} explicitly"
        )
    return fingerprints[0]


def _git_signing_inputs() -> tuple[str | None, str | None, str | None, str | None]:
    return (
        os.environ.get(GIT_SIGNER_NAME_ENV),
        os.environ.get(GIT_SIGNER_EMAIL_ENV),
        os.environ.get(GPG_PRIVATE_KEY_FILE_ENV),
        os.environ.get(GPG_KEY_ID_ENV),
    )


def _git_signing_required_error() -> RuntimeError:
    return RuntimeError(
        "Harness-managed git signing expected "
        f"{GIT_SIGNER_NAME_ENV}, {GIT_SIGNER_EMAIL_ENV}, and "
        f"{GPG_PRIVATE_KEY_FILE_ENV}"
    )


def setup_git_signing(*, required: bool) -> str | None:
    global _git_signing_inputs_cache, _git_signing_key_cache

    signer_name, signer_email, key_file, configured_key_id = _git_signing_inputs()

    present = [bool(signer_name), bool(signer_email), bool(key_file)]
    if any(present) and not all(present):
        raise RuntimeError(
            f"{GIT_SIGNER_NAME_ENV}, {GIT_SIGNER_EMAIL_ENV}, and "
            f"{GPG_PRIVATE_KEY_FILE_ENV} must be set together"
        )

    current_inputs = (signer_name, signer_email, key_file, configured_key_id)
    if _git_signing_inputs_cache == current_inputs:
        if required and _git_signing_key_cache is None:
            raise _git_signing_required_error()
        return _git_signing_key_cache

    if not any(present):
        if required:
            raise _git_signing_required_error()
        _git_signing_inputs_cache = current_inputs
        _git_signing_key_cache = None
        return None

    assert signer_name is not None
    assert signer_email is not None
    assert key_file is not None

    key_path = Path(key_file)
    if not key_path.is_file():
        raise FileNotFoundError(f"GPG private key file not found: {key_path}")
    if key_path.stat().st_size == 0:
        raise RuntimeError(f"GPG private key file is empty: {key_path}")

    gnupg_home = Path.home() / ".gnupg"
    gnupg_home.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(gnupg_home, 0o700)

    # Key material stays out of the command log: the display argv names the
    # argument instead of printing the key file path or the fingerprint.
    run_cmd_with_display_argv(
        ["gpg", "--batch", "--import", str(key_path)],
        display_argv=["gpg", "--batch", "--import", "<gpg-private-key-file>"],
        check=True,
    )
    signing_key = _resolve_signing_key_fingerprint(configured_key_id)

    git_global = ["git", "config", "--global"]
    run_cmd([*git_global, "user.name", signer_name], check=True)
    run_cmd([*git_global, "user.email", signer_email], check=True)
    run_cmd([*git_global, "gpg.program", "gpg"], check=True)
    run_cmd_with_display_argv(
        [*git_global, "user.signingkey", signing_key],
        display_argv=[*git_global, "user.signingkey", "<signing-key>"],
        check=True,
    )
    run_cmd([*git_global, "commit.gpgsign", "true"], check=True)
    run_cmd([*git_global, "tag.gpgsign", "true"], check=True)
    _git_signing_inputs_cache = current_inputs
    _git_signing_key_cache = signing_key
    return signing_key


def changed_files(repo_path: Path) -> list[str]:
    result = subprocess.run(
        ["git", "status", "--porcelain=v1"],
        cwd=repo_path,
        check=True,
        text=True,
        capture_output=True,
    )
    files: list[str] = []
    for line in result.stdout.splitlines():
        if not line:
            continue
        path = line[3:]
        if " -> " in path:
            path = path.rsplit(" -> ", 1)[1]
        files.append(path)
    return sorted(dict.fromkeys(files))


def refresh_changed_files(impl_data: dict[str, Any]) -> dict[str, Any]:
    """Recompute every repo's `changed_files` from git (best effort per repo)."""
    new = json.loads(json.dumps(impl_data))
    for entry in new.get("repos") or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            continue
        try:
            entry["changed_files"] = changed_files(
                repo_checkout_path(entry["name"], workspace=WORKSPACE)
            )
        except Exception as exc:  # keep the stale list rather than crash
            print(
                f"warning: could not refresh changed_files for "
                f"{entry['name']!r}: {type(exc).__name__}: {exc}"
            )
    return new


# ── working-tree fingerprint ────────────────────────────────────────────────


def _tracked_diff(repo_path: Path) -> str:
    """The combined staged + unstaged diff for tracked files (empty on error)."""
    r = run_cmd(["git", "-C", str(repo_path), "diff", "HEAD"], check=False)
    if r.returncode != 0:
        # Fall back to the index-only diff if HEAD is unusable (e.g. no commits).
        r = run_cmd(["git", "-C", str(repo_path), "diff"], check=False)
    return r.stdout if r.returncode == 0 else ""


def _untracked_files(repo_path: Path) -> list[str]:
    """Paths of untracked, non-ignored files, sorted for determinism."""
    r = run_cmd(
        ["git", "-C", str(repo_path), "ls-files", "--others", "--exclude-standard"],
        check=False,
    )
    if r.returncode != 0:
        return []
    return sorted(p for p in r.stdout.splitlines() if p.strip())


def working_tree_fingerprint(repo_paths: Sequence[Path]) -> str:
    """A stable hash of the uncommitted change across *repo_paths*.

    Keyed on each repo's tracked diff against HEAD and the content of its
    untracked non-ignored files — NOT the git SHA, because the edits it must
    tell apart happen before commit, so HEAD is constant across them.
    Deterministic across runs: repos and untracked files are processed in
    sorted order.
    """
    h = hashlib.sha256()
    for repo_path in sorted(repo_paths, key=lambda p: str(p)):
        h.update(b"\x00repo\x00")
        h.update(str(repo_path).encode("utf-8"))
        h.update(b"\x00diff\x00")
        h.update(_tracked_diff(repo_path).encode("utf-8", errors="replace"))
        for rel in _untracked_files(repo_path):
            h.update(b"\x00untracked\x00")
            h.update(rel.encode("utf-8"))
            try:
                h.update(b"\x00")
                h.update((repo_path / rel).read_bytes())
            except OSError:
                # Unreadable (race, permission) — fold in just the path so the
                # fingerprint still shifts if the file set changes.
                h.update(b"\x00<unreadable>")
    return h.hexdigest()
