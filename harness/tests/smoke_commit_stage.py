"""Local smoke test for run_commit_stage. Not a unit test — hits real GitHub.

Usage:
    export GITHUB_TOKEN=ghp_...
    # Optional: set these to let the harness import/configure signing.
    export HARNESS_GIT_SIGNER_NAME="Sandbox Signing Bot"
    export HARNESS_GIT_SIGNER_EMAIL="sandbox-signer@company.com"
    export HARNESS_GPG_PRIVATE_KEY_FILE=/absolute/path/to/private.asc
    export SMOKE_REPO_PATH=/absolute/path/to/a/scratch/repo/clone
    python3 tests/smoke_commit_stage.py

The repo at SMOKE_REPO_PATH must:
  - be a git checkout of a GitHub repo you can push to,
  - already have working HTTPS git auth for `git push`,
  - already have usable local git author/signing config if you do not set the harness signing env vars,
  - have at least one uncommitted change in its worktree.
"""

from __future__ import annotations

import os
import sys


def _load_harness():
    from harness import cli

    return cli


def main() -> int:
    repo_path = os.environ.get("SMOKE_REPO_PATH")
    if not repo_path:
        print(
            "set SMOKE_REPO_PATH to a git checkout with uncommitted changes",
            file=sys.stderr,
        )
        return 2
    if not os.environ.get("GITHUB_TOKEN"):
        print("set GITHUB_TOKEN to a PAT with repo scope", file=sys.stderr)
        return 2

    _load_harness()  # ensures the harness package CLI module is importable
    from harness.git import setup_git_signing
    from harness.handlers.assignment import run_commit_stage

    setup_git_signing(required=False)

    impl = {
        "stage": "implementation",
        "run_id": "smoke-1",
        "task": "harness smoke",
        "status": "completed",
        "generated_at": "2026-04-22T00:00:00Z",
        "repos": [
            {
                "name": "smoke",
                "path": repo_path,
                "changed_files": [],
                "summary": "harness local smoke",
                "commit_message": "test: harness local smoke",
                "pr_title": "Harness local smoke test",
                "pr_body": "Local test of the native git commit flow.",
            }
        ],
    }

    status, repos = run_commit_stage(None, "smoke-inbox-id", impl)
    print(f"status: {status}")
    for r in repos or []:
        print(f"  {r['name']}: {r['pr_status']} {r.get('pr_url') or ''}")
    return 0 if status in ("completed", "no_action", "partial_failure") else 1


if __name__ == "__main__":
    raise SystemExit(main())
