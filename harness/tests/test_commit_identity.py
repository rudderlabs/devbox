"""The commit identity by code host: a repo on the GitLab instance commits as
the GitLab identity the control plane passes; everything else is unchanged."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import git
from harness.cmd_runner import run_cmd

BASE = "https://git.example.com/gitlab"
GITLAB_ENV = {
    "GITLAB_BASE_URL": BASE,
    "HARNESS_GITLAB_GIT_NAME": "devbox",
    "HARNESS_GITLAB_GIT_EMAIL": "2-devbox@users.noreply.git.example.com",
    # The sandbox's own identity: the GitHub user's or App bot's.
    "GIT_AUTHOR_NAME": "octo[bot]",
    "GIT_AUTHOR_EMAIL": "7+octo[bot]@users.noreply.github.com",
    "GIT_COMMITTER_NAME": "octo[bot]",
    "GIT_COMMITTER_EMAIL": "7+octo[bot]@users.noreply.github.com",
}


def _repo(td: str, origin: str) -> Path:
    repo = Path(td) / "repo"
    repo.mkdir()
    for argv in (
        ["git", "init", "-q", "-b", "main"],
        ["git", "remote", "add", "origin", origin],
    ):
        subprocess.run(argv, cwd=repo, check=True, capture_output=True)
    return repo


def _env(extra: dict[str, str] | None = None) -> dict[str, str]:
    keep = {
        k: v for k, v in os.environ.items() if not k.startswith(("HARNESS_", "GIT_"))
    }
    return {**keep, **GITLAB_ENV, **(extra or {})}


class TestCommitIdentityEnv(unittest.TestCase):
    def test_a_gitlab_repo_takes_the_gitlab_identity(self) -> None:
        with (
            tempfile.TemporaryDirectory() as td,
            mock.patch.dict(os.environ, _env(), clear=True),
        ):
            repo = _repo(td, f"{BASE}/platform/backend/api.git")
            self.assertEqual(
                git.commit_identity_env(repo),
                {
                    "GIT_AUTHOR_NAME": "devbox",
                    "GIT_AUTHOR_EMAIL": "2-devbox@users.noreply.git.example.com",
                    "GIT_COMMITTER_NAME": "devbox",
                    "GIT_COMMITTER_EMAIL": "2-devbox@users.noreply.git.example.com",
                },
            )

    def test_a_github_repo_keeps_the_sandbox_identity(self) -> None:
        with (
            tempfile.TemporaryDirectory() as td,
            mock.patch.dict(os.environ, _env(), clear=True),
        ):
            repo = _repo(td, "https://github.com/acme/widgets.git")
            self.assertIsNone(git.commit_identity_env(repo))

    def test_no_override_without_both_name_and_email(self) -> None:
        for missing in ("HARNESS_GITLAB_GIT_NAME", "HARNESS_GITLAB_GIT_EMAIL"):
            with (
                tempfile.TemporaryDirectory() as td,
                mock.patch.dict(os.environ, _env({missing: ""}), clear=True),
            ):
                repo = _repo(td, f"{BASE}/platform/backend/api.git")
                self.assertIsNone(git.commit_identity_env(repo))

    def test_no_override_with_harness_managed_signing(self) -> None:
        # The signer's identity must match the key.
        signing = {
            "HARNESS_GIT_SIGNER_NAME": "Signer",
            "HARNESS_GIT_SIGNER_EMAIL": "s@example.com",
        }
        with (
            tempfile.TemporaryDirectory() as td,
            mock.patch.dict(os.environ, _env(signing), clear=True),
        ):
            repo = _repo(td, f"{BASE}/platform/backend/api.git")
            self.assertIsNone(git.commit_identity_env(repo))

    def test_the_commit_itself_carries_it(self) -> None:
        def authors(repo: Path) -> str:
            out = subprocess.run(
                ["git", "log", "-1", "--format=%an <%ae> | %cn <%ce>"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
            return out.stdout.strip()

        with (
            tempfile.TemporaryDirectory() as td,
            mock.patch.dict(os.environ, _env(), clear=True),
        ):
            for origin, expected in (
                (
                    f"{BASE}/platform/backend/api.git",
                    "devbox <2-devbox@users.noreply.git.example.com>"
                    " | devbox <2-devbox@users.noreply.git.example.com>",
                ),
                (
                    "https://github.com/acme/widgets.git",
                    "octo[bot] <7+octo[bot]@users.noreply.github.com>"
                    " | octo[bot] <7+octo[bot]@users.noreply.github.com>",
                ),
            ):
                sub = tempfile.mkdtemp(dir=td)
                repo = _repo(sub, origin)
                (repo / "f.txt").write_text("x")
                run_cmd(["git", "-C", str(repo), "add", "-A"])
                run_cmd(
                    ["git", "-C", str(repo), "commit", "-q", "-m", "c"],
                    env=git.commit_identity_env(repo),
                )
                self.assertEqual(authors(repo), expected)


if __name__ == "__main__":
    unittest.main()
