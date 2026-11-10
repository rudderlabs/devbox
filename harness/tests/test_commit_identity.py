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


class TestApplyRepoCommitIdentities(unittest.TestCase):
    """Commits the agent makes itself, from its shell, with no env override."""

    def _workspace(self, td: str) -> tuple[Path, Path, Path]:
        ws = Path(td) / "ws"
        ws.mkdir()
        repos = []
        for name, origin in (
            ("api", f"{BASE}/platform/backend/api.git"),
            ("widgets", "https://github.com/acme/widgets.git"),
        ):
            repo = ws / name
            repo.mkdir()
            for argv in (
                ["git", "init", "-q", "-b", "main"],
                ["git", "remote", "add", "origin", origin],
            ):
                subprocess.run(argv, cwd=repo, check=True, capture_output=True)
            repos.append(repo)
        return ws, repos[0], repos[1]

    def _author(self, repo: Path) -> str:
        """Who a plain `git commit` in `repo` is, as a shell started now sees it."""
        (repo / "f").write_text("x")
        for argv in (["git", "add", "-A"], ["git", "commit", "-q", "-m", "c"]):
            subprocess.run(argv, cwd=repo, check=True, capture_output=True)
        out = subprocess.run(
            ["git", "log", "-1", "--format=%an <%ae> / %cn <%ce>"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )
        return out.stdout.strip()

    def test_gitlab_checkouts_commit_as_the_gitlab_user_and_the_rest_as_before(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as td:
            ws, gitlab_repo, github_repo = self._workspace(td)
            home = Path(td) / "home"
            home.mkdir()
            with mock.patch.dict(os.environ, {**GITLAB_ENV, "HOME": str(home)}):
                applied = git.apply_repo_commit_identities(ws)
                self.assertEqual(applied, [gitlab_repo])
                # The sandbox's identity left the environment for git's config.
                self.assertNotIn("GIT_AUTHOR_NAME", os.environ)
                self.assertNotIn("GIT_COMMITTER_EMAIL", os.environ)
                gitlab_user = "devbox <2-devbox@users.noreply.git.example.com>"
                github_user = "octo[bot] <7+octo[bot]@users.noreply.github.com>"
                self.assertEqual(
                    self._author(gitlab_repo), f"{gitlab_user} / {gitlab_user}"
                )
                self.assertEqual(
                    self._author(github_repo), f"{github_user} / {github_user}"
                )
                # Safe to repeat, as on a daemon restart.
                self.assertEqual(git.apply_repo_commit_identities(ws), [gitlab_repo])

    def test_nothing_changes_without_a_gitlab_identity_or_with_signing(self) -> None:
        for extra in (
            {"HARNESS_GITLAB_GIT_NAME": "", "HARNESS_GITLAB_GIT_EMAIL": ""},
            {"HARNESS_GIT_SIGNER_NAME": "signer"},
        ):
            with tempfile.TemporaryDirectory() as td:
                ws, gitlab_repo, _github_repo = self._workspace(td)
                home = Path(td) / "home"
                home.mkdir()
                env = {**GITLAB_ENV, "HOME": str(home), **extra}
                with (
                    mock.patch.dict(os.environ, env),
                    mock.patch.object(
                        git,
                        "_git_signing_inputs",
                        return_value=(
                            extra.get("HARNESS_GIT_SIGNER_NAME"),
                            None,
                            None,
                            None,
                        ),
                    ),
                ):
                    self.assertEqual(git.apply_repo_commit_identities(ws), [])
                    self.assertEqual(os.environ["GIT_AUTHOR_NAME"], "octo[bot]")
                    self.assertFalse((home / ".gitconfig").exists())
                    self.assertEqual(
                        self._author(gitlab_repo).split(" / ")[0],
                        "octo[bot] <7+octo[bot]@users.noreply.github.com>",
                    )


if __name__ == "__main__":
    unittest.main()
