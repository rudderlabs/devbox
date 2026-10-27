"""Unit tests for GitHub-related pure helpers (no network)."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import git
from harness.handlers import _common, assignment
from tests.test_harness_validation import (  # noqa: F401  stages harness in sys.modules
    harness,
)


class TestParseOwnerRepoFromGitRemote(unittest.TestCase):
    def _with_remote(self, url: str) -> tuple[str, str]:
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "init", "-q", d], check=True)
            subprocess.run(["git", "-C", d, "remote", "add", "origin", url], check=True)
            return git.parse_owner_repo_from_git_remote(Path(d))

    def test_https_bare(self) -> None:
        self.assertEqual(
            self._with_remote("https://github.com/acme/foo"),
            ("acme", "foo"),
        )

    def test_https_dot_git(self) -> None:
        self.assertEqual(
            self._with_remote("https://github.com/acme/foo.git"),
            ("acme", "foo"),
        )

    def test_ssh_colon(self) -> None:
        self.assertEqual(
            self._with_remote("git@github.com:acme/foo.git"),
            ("acme", "foo"),
        )

    def test_ssh_scheme(self) -> None:
        self.assertEqual(
            self._with_remote("ssh://git@github.com/acme/foo.git"),
            ("acme", "foo"),
        )

    def test_https_with_userinfo(self) -> None:
        # Credentialed URL produced by `insteadOf` rewrites in the sandbox.
        self.assertEqual(
            self._with_remote(
                "https://x-access-token:proxy-github-dummy-token@github.com/acme/foo.git"
            ),
            ("acme", "foo"),
        )

    def test_no_remote_raises(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "init", "-q", d], check=True)
            with self.assertRaises(RuntimeError):
                git.parse_owner_repo_from_git_remote(Path(d))

    def test_unsupported_host_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            self._with_remote("https://gitlab.com/acme/foo.git")


class TestGitHelpers(unittest.TestCase):
    def test_git_local_branch_exists_handles_missing_branch(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "init", "-q", d], check=True)
            self.assertFalse(git._git_local_branch_exists(Path(d), "missing-branch"))

    def test_git_local_branch_exists_handles_present_branch(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "init", "-q", d], check=True)
            subprocess.run(["git", "-C", d, "config", "user.email", "t@t"], check=True)
            subprocess.run(["git", "-C", d, "config", "user.name", "t"], check=True)
            Path(d, "seed.txt").write_text("seed\n")
            subprocess.run(["git", "-C", d, "add", "-A"], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    d,
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-q",
                    "-m",
                    "seed",
                ],
                check=True,
            )
            subprocess.run(
                ["git", "-C", d, "checkout", "-q", "-b", "feature/test"], check=True
            )
            self.assertTrue(git._git_local_branch_exists(Path(d), "feature/test"))

    def test_sync_current_branch_from_origin_clean_tree_uses_ff_only(self) -> None:
        repo = Path("/tmp/repo")
        with (
            mock.patch.object(git, "_git_current_branch", return_value="main"),
            mock.patch.object(git, "run_cmd", return_value=mock.Mock()) as run_cmd,
        ):
            branch = git.sync_current_branch_from_origin(repo)
        self.assertEqual(branch, "main")
        self.assertEqual(
            run_cmd.call_args_list,
            [
                mock.call(
                    ["git", "-C", str(repo), "fetch", "--no-tags", "origin", "main"],
                    check=True,
                ),
                mock.call(
                    ["git", "-C", str(repo), "merge", "--ff-only", "FETCH_HEAD"],
                    check=True,
                ),
            ],
        )

    def test_sync_current_branch_from_origin_non_main_branch_uses_ff_only(self) -> None:
        repo = Path("/tmp/repo")
        with (
            mock.patch.object(git, "_git_current_branch", return_value="devbox/x"),
            mock.patch.object(git, "run_cmd", return_value=mock.Mock()) as run_cmd,
        ):
            branch = git.sync_current_branch_from_origin(repo)
        self.assertEqual(branch, "devbox/x")
        self.assertEqual(
            run_cmd.call_args_list,
            [
                mock.call(
                    [
                        "git",
                        "-C",
                        str(repo),
                        "fetch",
                        "--no-tags",
                        "origin",
                        "devbox/x",
                    ],
                    check=True,
                ),
                mock.call(
                    ["git", "-C", str(repo), "merge", "--ff-only", "FETCH_HEAD"],
                    check=True,
                ),
            ],
        )


class TestGitHubClientPagination(unittest.TestCase):
    def test_list_issue_comments_fetches_all_pages(self) -> None:
        client = git.GitHubClient(token="t")
        pages = [
            json_page([{"id": i} for i in range(100)]),
            json_page([{"id": 100}]),
        ]
        with mock.patch.object(client, "_request_text", side_effect=pages) as request:
            comments = client.list_issue_comments("acme", "widgets", 7)

        self.assertEqual(len(comments), 101)
        self.assertEqual(
            [call.args[1] for call in request.call_args_list],
            [
                "/repos/acme/widgets/issues/7/comments?per_page=100&page=1",
                "/repos/acme/widgets/issues/7/comments?per_page=100&page=2",
            ],
        )

    def test_list_pull_request_review_comments_fetches_all_pages(self) -> None:
        client = git.GitHubClient(token="t")
        pages = [
            json_page([{"id": i} for i in range(100)]),
            json_page([]),
        ]
        with mock.patch.object(client, "_request_text", side_effect=pages) as request:
            comments = client.list_pull_request_review_comments("acme", "widgets", 7)

        self.assertEqual(len(comments), 100)
        self.assertEqual(
            [call.args[1] for call in request.call_args_list],
            [
                "/repos/acme/widgets/pulls/7/comments?per_page=100&page=1",
                "/repos/acme/widgets/pulls/7/comments?per_page=100&page=2",
            ],
        )


def json_page(items: list[dict[str, int]]) -> str:
    return json.dumps(items)


class TestSyncAllReposFromOrigin(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _mk_repo(self, name: str) -> Path:
        repo = self.ws / name
        (repo / ".git").mkdir(parents=True)
        return repo

    def test_syncs_each_git_child_and_returns_clean(self) -> None:
        repo_a = self._mk_repo("repo-a")
        repo_b = self._mk_repo("repo-b")
        (self.ws / "not-a-repo").mkdir()  # no .git — not a checkout, skipped
        with mock.patch.object(
            git, "sync_current_branch_from_origin", return_value="main"
        ) as sync_repo:
            synced = git.sync_all_repos_from_origin(self.ws)
        self.assertEqual(synced, [repo_a, repo_b])
        self.assertEqual(
            sorted(c.args[0] for c in sync_repo.call_args_list),
            [repo_a, repo_b],
        )

    def test_failure_on_one_repo_is_skipped_not_raised(self) -> None:
        repo_a = self._mk_repo("repo-a")
        repo_b = self._mk_repo("repo-b")

        def fake_sync(path: Path) -> str:
            if path == repo_a:
                raise RuntimeError("pull failed")
            return "main"

        with (
            mock.patch.object(
                git, "sync_current_branch_from_origin", side_effect=fake_sync
            ),
            mock.patch("builtins.print"),
        ):
            synced = git.sync_all_repos_from_origin(self.ws)
        self.assertEqual(synced, [repo_b])

    def test_missing_workspace_returns_empty(self) -> None:
        self.assertEqual(git.sync_all_repos_from_origin(self.ws / "nope"), [])

    def test_no_git_children_returns_empty(self) -> None:
        (self.ws / "plain-dir").mkdir()
        with mock.patch.object(git, "sync_current_branch_from_origin") as sync_repo:
            self.assertEqual(git.sync_all_repos_from_origin(self.ws), [])
        sync_repo.assert_not_called()


class TestCommitFlowWithoutHarnessSigning(unittest.TestCase):
    def test_setup_git_signing_allows_missing_env_when_optional(self) -> None:
        git._git_signing_inputs_cache = None
        git._git_signing_key_cache = None

        with mock.patch.dict(
            os.environ,
            {
                "HARNESS_GIT_SIGNER_NAME": "",
                "HARNESS_GIT_SIGNER_EMAIL": "",
                "HARNESS_GPG_PRIVATE_KEY_FILE": "",
                "HARNESS_GPG_KEY_ID": "",
            },
            clear=False,
        ):
            self.assertIsNone(git.setup_git_signing(required=False))

    def test_run_commit_stage_does_not_require_harness_signing(self) -> None:
        git._git_signing_inputs_cache = None
        git._git_signing_key_cache = None

        with tempfile.TemporaryDirectory() as workspace:
            repo_path = Path(workspace) / "sandbox"
            repo_path.mkdir()
            impl = {
                "stage": "implementation",
                "run_id": "run-1",
                "task": "task",
                "status": "completed",
                "generated_at": "2026-04-23T00:00:00Z",
                "repos": [
                    {
                        "name": "sandbox",
                        "path": str(repo_path),
                        "changed_files": [],
                        "summary": "summary",
                        "commit_message": "test: commit",
                        "pr_title": "Harness commit",
                        "pr_body": "body",
                    }
                ],
            }
            client = mock.Mock(spec=git.GitHubClient)
            client.create_pr.return_value = "https://example.test/pr/1"
            client.find_open_pr_by_head.return_value = None

            with (
                mock.patch.object(_common, "WORKSPACE", Path(workspace)),
                mock.patch.object(assignment, "GitHubClient", return_value=client),
                mock.patch.object(
                    _common,
                    "parse_owner_repo_from_git_remote",
                    return_value=("acme", "sandbox"),
                ),
                mock.patch.object(
                    _common,
                    "commit_one_repo",
                    return_value={
                        "commit_sha": "deadbeef",
                        "branch": "devbox/harness-commit",
                        "base": "main",
                    },
                ) as commit_one_repo,
                mock.patch.object(
                    assignment,
                    "setup_git_signing",
                    side_effect=AssertionError(
                        "run_commit_stage should not set up git signing"
                    ),
                ),
            ):
                status, repos = assignment.run_commit_stage(None, "test-inbox-id", impl)

        self.assertEqual(status, "completed")
        self.assertEqual(
            repos,
            [
                {
                    "name": "sandbox",
                    "pr_url": "https://example.test/pr/1",
                    "pr_status": "opened",
                    "branch": "devbox/harness-commit",
                    "commit_sha": "deadbeef",
                }
            ],
        )
        commit_one_repo.assert_called_once()

    def test_skip_commit_env_opens_no_pr(self) -> None:
        impl = {
            "stage": "implementation",
            "run_id": "run-1",
            "task": "task",
            "status": "completed",
            "generated_at": "2026-04-23T00:00:00Z",
            "repos": [
                {
                    "name": "sandbox",
                    "path": "/tmp/does-not-matter",
                    "changed_files": [],
                    "summary": "summary",
                    "commit_message": "test: commit",
                    "pr_title": "Harness commit",
                    "pr_body": "body",
                }
            ],
        }

        # GitHubClient must never be constructed when the stage is skipped.
        with (
            mock.patch.dict(os.environ, {"HARNESS_SKIP_COMMIT": "1"}, clear=False),
            mock.patch.object(
                assignment,
                "GitHubClient",
                side_effect=AssertionError(
                    "skip-commit must not construct a GitHubClient"
                ),
            ),
        ):
            status, repos = assignment.run_commit_stage(None, "test-inbox-id", impl)

        self.assertEqual(status, "completed")
        self.assertEqual(
            repos,
            [
                {
                    "name": "sandbox",
                    "pr_url": None,
                    "pr_status": "skipped",
                    "branch": None,
                    "commit_sha": None,
                }
            ],
        )


class TestNativeSignedPublish(unittest.TestCase):
    def setUp(self) -> None:
        git._git_signing_inputs_cache = None
        git._git_signing_key_cache = None
        if shutil.which("gpg") is None:
            self.skipTest("gpg is not installed")

    def _make_armored_secret_key(
        self,
    ) -> tuple[tempfile.TemporaryDirectory[str], Path, str]:
        tmp = tempfile.TemporaryDirectory()
        gnupg_home = Path(tmp.name) / "gnupg"
        gnupg_home.mkdir(mode=0o700)
        env = os.environ.copy()
        env["GNUPGHOME"] = str(gnupg_home)
        env["HOME"] = tmp.name
        try:
            subprocess.run(
                [
                    "gpg",
                    "--batch",
                    "--pinentry-mode",
                    "loopback",
                    "--passphrase",
                    "",
                    "--quick-generate-key",
                    "Harness Signer <signer@example.com>",
                    "default",
                    "default",
                    "0",
                ],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
        except subprocess.CalledProcessError as e:
            tmp.cleanup()
            detail = e.stderr.strip() or e.stdout.strip() or str(e)
            self.skipTest(
                f"gpg key generation unavailable in this environment: {detail}"
            )

        listing = subprocess.run(
            ["gpg", "--batch", "--list-secret-keys", "--with-colons"],
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        fingerprints = git._secret_key_fingerprints(listing.stdout)
        self.assertEqual(len(fingerprints), 1)
        fingerprint = fingerprints[0]

        key_path = Path(tmp.name) / "private.asc"
        with key_path.open("w", encoding="utf-8") as fh:
            subprocess.run(
                ["gpg", "--batch", "--armor", "--export-secret-keys", fingerprint],
                env=env,
                stdout=fh,
                check=True,
            )
        return tmp, key_path, fingerprint

    def _make_repo_with_remote(
        self,
    ) -> tuple[tempfile.TemporaryDirectory[str], Path, Path]:
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        bare = root / "remote.git"
        work = root / "work"

        subprocess.run(["git", "init", "--bare", "-q", str(bare)], check=True)
        subprocess.run(["git", "init", "-q", str(work)], check=True)
        subprocess.run(
            ["git", "-C", str(work), "remote", "add", "origin", str(bare)], check=True
        )
        Path(work, "seed.txt").write_text("seed\n")
        subprocess.run(["git", "-C", str(work), "add", "-A"], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(work),
                "-c",
                "user.name=Seed",
                "-c",
                "user.email=seed@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "seed",
            ],
            check=True,
        )
        subprocess.run(["git", "-C", str(work), "branch", "-M", "main"], check=True)
        subprocess.run(
            ["git", "-C", str(work), "push", "-q", "-u", "origin", "main"], check=True
        )
        return tmp, bare, work

    def test_setup_git_signing_configures_global_git(self) -> None:
        key_tmp, key_path, fingerprint = self._make_armored_secret_key()
        self.addCleanup(key_tmp.cleanup)

        with tempfile.TemporaryDirectory() as home:
            env = {
                "HOME": home,
                "GNUPGHOME": str(Path(home) / ".gnupg"),
                "HARNESS_GIT_SIGNER_NAME": "Harness Signer",
                "HARNESS_GIT_SIGNER_EMAIL": "signer@example.com",
                "HARNESS_GPG_PRIVATE_KEY_FILE": str(key_path),
            }
            with mock.patch.dict(os.environ, env, clear=False):
                resolved = git.setup_git_signing(required=True)
                self.assertEqual(resolved, fingerprint)

                name = subprocess.run(
                    ["git", "config", "--global", "user.name"],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                email = subprocess.run(
                    ["git", "config", "--global", "user.email"],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                signing_key = subprocess.run(
                    ["git", "config", "--global", "user.signingkey"],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertEqual(name.stdout.strip(), "Harness Signer")
                self.assertEqual(email.stdout.strip(), "signer@example.com")
                self.assertEqual(signing_key.stdout.strip(), fingerprint)

    def test_setup_git_signing_runs_import_and_global_git_config(self) -> None:
        with tempfile.NamedTemporaryFile("w", delete=False) as key_file:
            key_file.write("dummy\n")
            key_path = Path(key_file.name)
        self.addCleanup(lambda: key_path.unlink(missing_ok=True))

        with tempfile.TemporaryDirectory() as home:
            env = {
                "HOME": home,
                "GNUPGHOME": str(Path(home) / ".gnupg"),
                "HARNESS_GIT_SIGNER_NAME": "Harness Signer",
                "HARNESS_GIT_SIGNER_EMAIL": "signer@example.com",
                "HARNESS_GPG_PRIVATE_KEY_FILE": str(key_path),
            }
            with (
                mock.patch.dict(os.environ, env, clear=False),
                mock.patch.object(
                    git, "_resolve_signing_key_fingerprint", return_value="ABC123"
                ),
                mock.patch.object(git, "run_cmd") as run_cmd,
                # One recorder for both runners keeps the command order.
                mock.patch.object(git, "run_cmd_with_display_argv", new=run_cmd),
            ):
                run_cmd.return_value = mock.Mock(stdout="", returncode=0)
                resolved = git.setup_git_signing(required=True)

        self.assertEqual(resolved, "ABC123")
        self.assertEqual(
            run_cmd.call_args_list,
            [
                mock.call(
                    ["gpg", "--batch", "--import", str(key_path)],
                    display_argv=[
                        "gpg",
                        "--batch",
                        "--import",
                        "<gpg-private-key-file>",
                    ],
                    check=True,
                ),
                mock.call(
                    ["git", "config", "--global", "user.name", "Harness Signer"],
                    check=True,
                ),
                mock.call(
                    ["git", "config", "--global", "user.email", "signer@example.com"],
                    check=True,
                ),
                mock.call(
                    ["git", "config", "--global", "gpg.program", "gpg"], check=True
                ),
                mock.call(
                    ["git", "config", "--global", "user.signingkey", "ABC123"],
                    display_argv=[
                        "git",
                        "config",
                        "--global",
                        "user.signingkey",
                        "<signing-key>",
                    ],
                    check=True,
                ),
                mock.call(
                    ["git", "config", "--global", "commit.gpgsign", "true"], check=True
                ),
                mock.call(
                    ["git", "config", "--global", "tag.gpgsign", "true"], check=True
                ),
            ],
        )

    def test_setup_git_signing_is_cached_for_same_inputs(self) -> None:
        with tempfile.NamedTemporaryFile("w", delete=False) as key_file:
            key_file.write("dummy\n")
            key_path = Path(key_file.name)
        self.addCleanup(lambda: key_path.unlink(missing_ok=True))

        with tempfile.TemporaryDirectory() as home:
            env = {
                "HOME": home,
                "GNUPGHOME": str(Path(home) / ".gnupg"),
                "HARNESS_GIT_SIGNER_NAME": "Harness Signer",
                "HARNESS_GIT_SIGNER_EMAIL": "signer@example.com",
                "HARNESS_GPG_PRIVATE_KEY_FILE": str(key_path),
            }
            with (
                mock.patch.dict(os.environ, env, clear=False),
                mock.patch.object(
                    git, "_resolve_signing_key_fingerprint", return_value="ABC123"
                ),
                mock.patch.object(git, "run_cmd") as run_cmd,
                mock.patch.object(git, "run_cmd_with_display_argv", new=run_cmd),
            ):
                run_cmd.return_value = mock.Mock(stdout="", returncode=0)
                first = git.setup_git_signing(required=True)
                second = git.setup_git_signing(required=True)

        self.assertEqual(first, "ABC123")
        self.assertEqual(second, "ABC123")
        self.assertEqual(run_cmd.call_count, 7)

    def test_commit_one_repo_creates_signed_commit_and_pushes_branch(self) -> None:
        key_tmp, key_path, _ = self._make_armored_secret_key()
        self.addCleanup(key_tmp.cleanup)
        repo_tmp, bare, work = self._make_repo_with_remote()
        self.addCleanup(repo_tmp.cleanup)

        with tempfile.TemporaryDirectory() as home:
            env = {
                "HOME": home,
                "GNUPGHOME": str(Path(home) / ".gnupg"),
                "HARNESS_GIT_SIGNER_NAME": "Harness Signer",
                "HARNESS_GIT_SIGNER_EMAIL": "signer@example.com",
                "HARNESS_GPG_PRIVATE_KEY_FILE": str(key_path),
            }
            with mock.patch.dict(os.environ, env, clear=False):
                git.setup_git_signing(required=True)

                Path(work, "seed.txt").write_text("signed change\n")

                client = mock.Mock(spec=git.GitHubClient)

                def _get_ref_sha(_owner: str, _repo: str, ref: str) -> str | None:
                    if ref == "heads/main":
                        return "seed"
                    if ref == "heads/devbox/test-branch":
                        return None
                    return None

                client.get_ref_sha.side_effect = _get_ref_sha
                client.get_default_branch.return_value = "main"

                with mock.patch.object(
                    git,
                    "parse_owner_repo_from_git_remote",
                    return_value=("acme", "sandbox"),
                ):
                    result = git.commit_one_repo(
                        work,
                        client=client,
                        branch_name="devbox/test-branch",
                        commit_message="test: signed commit",
                    )

                self.assertEqual(result["branch"], "devbox/test-branch")
                self.assertEqual(result["base"], "main")

                current_branch = subprocess.run(
                    ["git", "-C", str(work), "branch", "--show-current"],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertEqual(current_branch.stdout.strip(), "devbox/test-branch")

                verify = subprocess.run(
                    ["git", "-C", str(work), "verify-commit", "HEAD"],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(verify.returncode, 0, verify.stderr)

                remote_branch = subprocess.run(
                    [
                        "git",
                        "--git-dir",
                        str(bare),
                        "rev-parse",
                        "refs/heads/devbox/test-branch",
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertEqual(remote_branch.stdout.strip(), result["commit_sha"])

    def test_commit_one_repo_rejects_detached_head(self) -> None:
        key_tmp, key_path, _ = self._make_armored_secret_key()
        self.addCleanup(key_tmp.cleanup)
        repo_tmp, _, work = self._make_repo_with_remote()
        self.addCleanup(repo_tmp.cleanup)

        with tempfile.TemporaryDirectory() as home:
            env = {
                "HOME": home,
                "GNUPGHOME": str(Path(home) / ".gnupg"),
                "HARNESS_GIT_SIGNER_NAME": "Harness Signer",
                "HARNESS_GIT_SIGNER_EMAIL": "signer@example.com",
                "HARNESS_GPG_PRIVATE_KEY_FILE": str(key_path),
            }
            with mock.patch.dict(os.environ, env, clear=False):
                git.setup_git_signing(required=True)
                subprocess.run(
                    ["git", "-C", str(work), "checkout", "--detach", "HEAD"],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                Path(work, "seed.txt").write_text("signed change\n")
                client = mock.Mock(spec=git.GitHubClient)
                with (
                    mock.patch.object(
                        git,
                        "parse_owner_repo_from_git_remote",
                        return_value=("acme", "sandbox"),
                    ),
                    self.assertRaises(git.CommitPublishError),
                ):
                    git.commit_one_repo(
                        work,
                        client=client,
                        branch_name="devbox/test-branch",
                        commit_message="test: signed commit",
                    )

    def test_commit_one_repo_uses_plain_git_commit_and_push(self) -> None:
        repo = Path("/tmp/repo")
        client = mock.Mock(spec=git.GitHubClient)
        client.get_ref_sha.side_effect = lambda _owner, _repo, ref: (
            "base" if ref == "heads/main" else None
        )
        client.get_default_branch.return_value = "main"

        run_results = [
            mock.Mock(stdout="", stderr="", returncode=0),
            mock.Mock(stdout="", stderr="", returncode=0),
            mock.Mock(stdout="", stderr="", returncode=0),
            mock.Mock(stdout="", stderr="", returncode=0),
        ]

        with (
            mock.patch.object(
                git,
                "parse_owner_repo_from_git_remote",
                return_value=("acme", "sandbox"),
            ),
            mock.patch.object(git, "_git_current_branch", return_value="main"),
            mock.patch.object(git, "_git_local_branch_exists", return_value=False),
            mock.patch.object(git, "_git_has_staged_changes", return_value=True),
            mock.patch.object(git, "_git_head_sha", return_value="deadbeef"),
            mock.patch.object(git, "run_cmd", side_effect=run_results) as run_cmd,
        ):
            result = git.commit_one_repo(
                repo,
                client=client,
                branch_name="devbox/test-branch",
                commit_message="test: signed commit",
            )

        self.assertEqual(
            result,
            {
                "commit_sha": "deadbeef",
                "branch": "devbox/test-branch",
                "base": "main",
            },
        )
        self.assertEqual(
            run_cmd.call_args_list,
            [
                mock.call(
                    ["git", "-C", str(repo), "checkout", "-b", "devbox/test-branch"],
                    check=True,
                ),
                mock.call(["git", "-C", str(repo), "add", "-A"], check=True),
                mock.call(
                    ["git", "-C", str(repo), "commit", "-m", "test: signed commit"],
                    check=True,
                ),
                mock.call(
                    [
                        "git",
                        "-C",
                        str(repo),
                        "push",
                        "-u",
                        "origin",
                        "devbox/test-branch",
                    ],
                    check=False,
                ),
            ],
        )

    def test_commit_one_repo_dry_run_skips_github_api_and_push(self) -> None:
        repo = Path("/tmp/repo")
        client = mock.Mock(spec=git.GitHubClient)
        run_results = [
            mock.Mock(stdout="", stderr="", returncode=0),
            mock.Mock(stdout="", stderr="", returncode=0),
            mock.Mock(stdout="", stderr="", returncode=0),
        ]

        with (
            mock.patch.dict(os.environ, {"HARNESS_DRY_RUN_PUBLISH": "1"}, clear=False),
            mock.patch.object(
                git,
                "parse_owner_repo_from_git_remote",
                return_value=("acme", "sandbox"),
            ),
            mock.patch.object(git, "_git_current_branch", return_value="main"),
            mock.patch.object(git, "_git_local_branch_exists", return_value=False),
            mock.patch.object(git, "_git_has_staged_changes", return_value=True),
            mock.patch.object(git, "_git_head_sha", return_value="deadbeef"),
            mock.patch.object(git, "run_cmd", side_effect=run_results) as run_cmd,
        ):
            result = git.commit_one_repo(
                repo,
                client=client,
                branch_name="devbox/test-branch",
                commit_message="test: dry-run commit",
            )

        self.assertEqual(
            result,
            {
                "commit_sha": "deadbeef",
                "branch": "devbox/test-branch",
                "base": "main",
            },
        )
        client.get_ref_sha.assert_not_called()
        client.get_default_branch.assert_not_called()
        self.assertNotIn(
            mock.call(
                [
                    "git",
                    "-C",
                    str(repo),
                    "push",
                    "-u",
                    "origin",
                    "devbox/test-branch",
                ],
                check=False,
            ),
            run_cmd.call_args_list,
        )


class TestGitHubClientRequestText(unittest.TestCase):
    """GitHubClient._request_text — returns raw text, not JSON."""

    def test_request_text_returns_raw_string(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        fake_response = mock.Mock()
        fake_response.status = 200
        fake_response.read.return_value = b"line 1\nline 2\nline 3"
        fake_response.__enter__ = mock.Mock(return_value=fake_response)
        fake_response.__exit__ = mock.Mock(return_value=False)

        with mock.patch(
            "harness.git.urllib.request.urlopen", return_value=fake_response
        ):
            result = client._request_text("GET", "/some/path")

        self.assertEqual(result, "line 1\nline 2\nline 3")

    def test_request_text_raises_on_unexpected_status(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        err = git.urllib.error.HTTPError(
            "https://api.github.com/x", 404, "Not Found", {}, None
        )
        err.read = mock.Mock(return_value=b"not found")
        with (
            mock.patch("harness.git.urllib.request.urlopen", side_effect=err),
            self.assertRaises(git.GitHubApiError) as ctx,
        ):
            client._request_text("GET", "/x")
        self.assertEqual(ctx.exception.status, 404)


class TestGitHubClientGetUser(unittest.TestCase):
    def test_get_user_requests_the_encoded_login_path(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(
            client, "_request", return_value={"login": "octo", "id": 5}
        ) as request:
            result = client.get_user("octo cat")
        request.assert_called_once_with("GET", "/users/octo%20cat")
        self.assertEqual(result["id"], 5)


class TestGitHubClientActionsApi(unittest.TestCase):
    """GitHubClient workflow run / job log methods."""

    def test_get_workflow_run_jobs_returns_jobs_list(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        jobs_payload = {
            "total_count": 2,
            "jobs": [
                {"id": 100, "name": "lint", "conclusion": "success"},
                {"id": 101, "name": "test", "conclusion": "failure"},
            ],
        }
        with mock.patch.object(client, "_request", return_value=jobs_payload):
            result = client.get_workflow_run_jobs("owner", "repo", 99)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[1]["name"], "test")

    def test_get_workflow_run_jobs_empty_when_no_jobs(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(
            client, "_request", return_value={"total_count": 0, "jobs": []}
        ):
            result = client.get_workflow_run_jobs("owner", "repo", 99)
        self.assertEqual(result, [])

    def test_get_job_logs_returns_text(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(
            client,
            "_request_log_download",
            return_value="2026-06-04T log line 1\nlog line 2",
        ):
            result = client.get_job_logs("owner", "repo", 101)
        self.assertIn("log line 1", result)

    def test_rerun_failed_jobs_posts_to_rerun_endpoint(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(client, "_request", return_value={}) as req:
            result = client.rerun_failed_jobs("owner", "repo", 99)
        self.assertEqual(result, {})
        req.assert_called_once_with(
            "POST",
            "/repos/owner/repo/actions/runs/99/rerun-failed-jobs",
            expected=(201,),
        )

    def test_request_log_download_follows_302_without_auth(self) -> None:
        """Signed blob URL must not receive the GitHub Authorization header."""
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        blob_url = (
            "https://productionresultssa16.blob.core.windows.net/"
            "actions-results/signed?sig=abc"
        )
        redirect_err = git.urllib.error.HTTPError(
            "https://api.github.com/repos/o/r/actions/jobs/1/logs",
            302,
            "Found",
            {"Location": blob_url},
            None,
        )
        blob_response = mock.Mock()
        blob_response.read.return_value = b"2026-06-09T job failed\n"
        blob_response.__enter__ = mock.Mock(return_value=blob_response)
        blob_response.__exit__ = mock.Mock(return_value=False)

        captured_requests: list[git.urllib.request.Request] = []

        def fake_urlopen(req, *args, **kwargs):
            captured_requests.append(req)
            return blob_response

        fake_opener = mock.Mock()
        fake_opener.open.side_effect = redirect_err
        fake_opener.__enter__ = mock.Mock(return_value=fake_opener)
        fake_opener.__exit__ = mock.Mock(return_value=False)

        with (
            mock.patch(
                "harness.git.urllib.request.build_opener", return_value=fake_opener
            ),
            mock.patch("harness.git.urllib.request.urlopen", side_effect=fake_urlopen),
        ):
            result = client._request_log_download("/repos/o/r/actions/jobs/1/logs")

        self.assertEqual(result, "2026-06-09T job failed\n")
        self.assertEqual(len(captured_requests), 1)
        blob_req = captured_requests[0]
        self.assertEqual(blob_req.full_url, blob_url)
        self.assertNotIn("Authorization", dict(blob_req.header_items()))


class TestParsePrUrl(unittest.TestCase):
    """git.parse_pr_url — extract (owner, repo, number) from a PR URL."""

    def test_parses_standard_pr_url(self) -> None:
        self.assertEqual(
            git.parse_pr_url("https://github.com/acme/acme-server/pull/42"),
            ("acme", "acme-server", 42),
        )

    def test_parses_with_trailing_slash(self) -> None:
        self.assertEqual(
            git.parse_pr_url("https://github.com/acme/foo/pull/7/"),
            ("acme", "foo", 7),
        )

    def test_parses_with_trailing_path_segment(self) -> None:
        # /files, /commits etc. after the number must not break parsing.
        self.assertEqual(
            git.parse_pr_url("https://github.com/acme/foo/pull/7/files"),
            ("acme", "foo", 7),
        )

    def test_returns_none_for_non_pr_url(self) -> None:
        self.assertIsNone(git.parse_pr_url("https://github.com/acme/foo/issues/7"))

    def test_returns_none_for_garbage(self) -> None:
        self.assertIsNone(git.parse_pr_url("not a url"))

    def test_returns_none_for_empty(self) -> None:
        self.assertIsNone(git.parse_pr_url(""))


class TestGitHubClientPullRequest(unittest.TestCase):
    """GitHubClient.get_pull_request / update_pull_request."""

    def test_get_pull_request_calls_correct_endpoint(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(
            client, "_request", return_value={"title": "old title"}
        ) as req:
            result = client.get_pull_request("acme", "foo", 42)
        req.assert_called_once_with("GET", "/repos/acme/foo/pulls/42")
        self.assertEqual(result["title"], "old title")

    def test_update_pull_request_patches_only_title(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(
            client, "_request", return_value={"title": "new title"}
        ) as req:
            result = client.update_pull_request("acme", "foo", 42, title="new title")
        req.assert_called_once_with(
            "PATCH",
            "/repos/acme/foo/pulls/42",
            {"title": "new title"},
        )
        self.assertEqual(result["title"], "new title")

    def test_update_pull_request_omits_none_fields(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(client, "_request", return_value={}) as req:
            client.update_pull_request("acme", "foo", 42, title="t", body=None)
        # body=None must not appear in the PATCH body.
        _method, _path, sent_body = req.call_args.args
        self.assertEqual(sent_body, {"title": "t"})

    def test_update_pull_request_includes_body_when_given(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(client, "_request", return_value={}) as req:
            client.update_pull_request("acme", "foo", 42, title="t", body="new body")
        _method, _path, sent_body = req.call_args.args
        self.assertEqual(sent_body, {"title": "t", "body": "new body"})

    def test_update_pull_request_can_patch_body_only(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(client, "_request", return_value={}) as req:
            client.update_pull_request("acme", "foo", 42, body="new body")
        req.assert_called_once_with(
            "PATCH",
            "/repos/acme/foo/pulls/42",
            {"body": "new body"},
        )

    def test_update_pull_request_preserves_empty_body(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with mock.patch.object(client, "_request", return_value={}) as req:
            client.update_pull_request("acme", "foo", 42, body="")
        _method, _path, sent_body = req.call_args.args
        self.assertEqual(sent_body, {"body": ""})

    def test_update_pull_request_raises_when_no_fields(self) -> None:
        client = git.GitHubClient(token="fake", api_url="https://api.github.com")
        with self.assertRaises(ValueError):
            client.update_pull_request("acme", "foo", 42)


class TestFindOpenPrByHead(unittest.TestCase):
    def test_returns_url_of_first_open_pr(self) -> None:
        client = git.GitHubClient(token="t")
        with mock.patch.object(
            client,
            "_request_text",
            return_value='[{"html_url": "https://github.com/o/r/pull/7"}]',
        ):
            url = client.find_open_pr_by_head("o", "r", "devbox/x")
        self.assertEqual(url, "https://github.com/o/r/pull/7")

    def test_returns_none_when_no_open_pr(self) -> None:
        client = git.GitHubClient(token="t")
        with mock.patch.object(client, "_request_text", return_value="[]"):
            self.assertIsNone(client.find_open_pr_by_head("o", "r", "devbox/x"))


class TestCommitAndOpenPrBody(unittest.TestCase):
    """_commit_and_open_pr publishes the implementation's PR body as written."""

    def _entry(self, repo_path: Path) -> dict[str, object]:
        return {
            "name": "acme-webapp",
            "path": str(repo_path),
            "pr_title": "feat: thing",
            "commit_message": "feat: thing",
            "pr_body": "## Summary\n- thing",
        }

    def _patches(self, workspace: str) -> contextlib.ExitStack:
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(_common, "WORKSPACE", Path(workspace)))
        stack.enter_context(
            mock.patch.object(
                _common,
                "parse_owner_repo_from_git_remote",
                return_value=("o", "acme-webapp"),
            )
        )
        stack.enter_context(
            mock.patch.object(
                _common,
                "commit_one_repo",
                return_value={
                    "commit_sha": "sha",
                    "branch": "devbox/b",
                    "base": "main",
                },
            )
        )
        return stack

    def test_create_path_uses_body_verbatim(self) -> None:
        with tempfile.TemporaryDirectory() as workspace:
            repo_path = Path(workspace) / "acme-webapp"
            repo_path.mkdir()
            client = mock.Mock(spec=git.GitHubClient)
            client.find_open_pr_by_head.return_value = None
            client.create_pr.return_value = "https://github.com/o/acme-webapp/pull/1"
            with self._patches(workspace):
                out = _common._commit_and_open_pr(
                    self._entry(repo_path), "ABC-1", "inbox-1", client
                )
            client.create_pr.assert_called_once_with(
                "o",
                "acme-webapp",
                title="feat: thing",
                body="## Summary\n- thing",
                head="devbox/b",
                base="main",
                draft=True,
            )
            self.assertEqual(
                out,
                {
                    "name": "acme-webapp",
                    "pr_url": "https://github.com/o/acme-webapp/pull/1",
                    "branch": "devbox/b",
                    "commit_sha": "sha",
                },
            )

    def test_dry_run_publish_skips_pr_create(self) -> None:
        with tempfile.TemporaryDirectory() as workspace:
            repo_path = Path(workspace) / "acme-webapp"
            repo_path.mkdir()
            client = mock.Mock(spec=git.GitHubClient)
            with (
                mock.patch.dict(
                    os.environ, {"HARNESS_DRY_RUN_PUBLISH": "1"}, clear=False
                ),
                mock.patch.object(
                    _common, "ARTIFACTS_DIR", Path(repo_path) / "artifacts"
                ),
                self._patches(workspace),
            ):
                out = _common._commit_and_open_pr(
                    self._entry(repo_path), "ABC-1", "inbox-1", client
                )
            # No network write at all on the dry-run path.
            client.create_pr.assert_not_called()
            client.update_pull_request.assert_not_called()
            client.find_open_pr_by_head.assert_not_called()
            self.assertIsNone(out["pr_url"])
            self.assertEqual(out["branch"], "devbox/b")

    def test_reuse_path_does_not_patch_body(self) -> None:
        with tempfile.TemporaryDirectory() as workspace:
            repo_path = Path(workspace) / "acme-webapp"
            repo_path.mkdir()
            client = mock.Mock(spec=git.GitHubClient)
            client.find_open_pr_by_head.return_value = (
                "https://github.com/o/acme-webapp/pull/9"
            )
            with self._patches(workspace):
                out = _common._commit_and_open_pr(
                    self._entry(repo_path), "ABC-1", "inbox-1", client
                )
            client.create_pr.assert_not_called()
            client.update_pull_request.assert_not_called()
            self.assertEqual(out["pr_url"], "https://github.com/o/acme-webapp/pull/9")


class TestWorkingTreeFingerprint(unittest.TestCase):
    @staticmethod
    def _repo(root: str) -> Path:
        repo = Path(root) / "repo"
        repo.mkdir()
        for args in (
            ("init", "-q"),
            ("config", "user.email", "t@example.com"),
            ("config", "user.name", "t"),
        ):
            subprocess.run(["git", "-C", str(repo), *args], check=True)
        (repo / "seed.txt").write_text("seed\n")
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(repo), "commit", "-q", "-m", "init"], check=True
        )
        return repo

    def test_changes_with_edit_even_when_head_is_constant(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = self._repo(td)
            (repo / "seed.txt").write_text("seed\nedit-one\n")
            fp1 = git.working_tree_fingerprint([repo])
            (repo / "seed.txt").write_text("seed\nedit-two\n")
            fp2 = git.working_tree_fingerprint([repo])
        self.assertNotEqual(fp1, fp2)

    def test_stable_for_identical_tree(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = self._repo(td)
            (repo / "seed.txt").write_text("seed\nchange\n")
            self.assertEqual(
                git.working_tree_fingerprint([repo]),
                git.working_tree_fingerprint([repo]),
            )

    def test_untracked_file_changes_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = self._repo(td)
            fp_clean = git.working_tree_fingerprint([repo])
            (repo / "new_untracked.ts").write_text("export const x = 1\n")
            fp_new = git.working_tree_fingerprint([repo])
        self.assertNotEqual(fp_clean, fp_new)


class TestCommitOneRepoReconcile(unittest.TestCase):
    def _client(self, *, remote_sha, default="main"):
        client = mock.Mock(spec=git.GitHubClient)
        client.get_ref_sha.side_effect = lambda owner, name, ref: (
            remote_sha if ref == "heads/devbox/ABC-1-slug-abcd1234" else None
        )
        client.get_default_branch.return_value = default
        return client

    def test_remote_branch_exists_is_reused_not_fatal(self) -> None:
        client = self._client(remote_sha="deadbeef")
        with (
            mock.patch.object(
                git,
                "parse_owner_repo_from_git_remote",
                return_value=("o", "r"),
            ),
            mock.patch.object(git, "_git_current_branch", return_value="main"),
            mock.patch.object(git, "run_cmd") as run_cmd,
        ):
            out = git.commit_one_repo(
                Path("/tmp/r"),
                client=client,
                branch_name="devbox/ABC-1-slug-abcd1234",
                commit_message="msg",
            )
        self.assertEqual(out["commit_sha"], "deadbeef")
        self.assertEqual(out["branch"], "devbox/ABC-1-slug-abcd1234")
        run_cmd.assert_not_called()

    def test_resume_local_branch_with_uncommitted_changes_commits(self) -> None:
        # Branch exists locally but not on remote; a prior attempt crashed after
        # `checkout -b` before committing, so changes are still staged.
        client = self._client(remote_sha=None)
        with (
            mock.patch.object(
                git,
                "parse_owner_repo_from_git_remote",
                return_value=("o", "r"),
            ),
            mock.patch.object(git, "_git_current_branch", return_value="main"),
            mock.patch.object(git, "_git_local_branch_exists", return_value=True),
            mock.patch.object(git, "_git_has_staged_changes", return_value=True),
            mock.patch.object(git, "_git_head_sha", return_value="deadbeef"),
            mock.patch.object(
                git, "run_cmd", return_value=mock.Mock(returncode=0)
            ) as run_cmd,
        ):
            out = git.commit_one_repo(
                Path("/tmp/r"),
                client=client,
                branch_name="devbox/ABC-1-slug-abcd1234",
                commit_message="msg",
            )
        self.assertEqual(out["commit_sha"], "deadbeef")
        commit_calls = [c for c in run_cmd.call_args_list if "commit" in c.args[0]]
        self.assertEqual(len(commit_calls), 1)

    def test_resume_local_branch_already_committed_skips_commit(self) -> None:
        # Branch exists locally, not on remote, but the prior attempt already
        # committed — nothing staged, so no new commit should be made.
        client = self._client(remote_sha=None)
        with (
            mock.patch.object(
                git,
                "parse_owner_repo_from_git_remote",
                return_value=("o", "r"),
            ),
            mock.patch.object(git, "_git_current_branch", return_value="main"),
            mock.patch.object(git, "_git_local_branch_exists", return_value=True),
            mock.patch.object(git, "_git_has_staged_changes", return_value=False),
            mock.patch.object(git, "_git_head_sha", return_value="cafebabe"),
            mock.patch.object(
                git, "run_cmd", return_value=mock.Mock(returncode=0)
            ) as run_cmd,
        ):
            out = git.commit_one_repo(
                Path("/tmp/r"),
                client=client,
                branch_name="devbox/ABC-1-slug-abcd1234",
                commit_message="msg",
            )
        self.assertEqual(out["commit_sha"], "cafebabe")
        commit_calls = [c for c in run_cmd.call_args_list if "commit" in c.args[0]]
        self.assertEqual(commit_calls, [])

    def test_resume_local_branch_staging_failure_reports_staging(self) -> None:
        # On the resume path, a failed `add -A` must surface as a staging error,
        # not a misleading "git checkout failed".
        client = self._client(remote_sha=None)

        def fake_run_cmd(argv, **kwargs):
            if "add" in argv:
                raise subprocess.CalledProcessError(1, argv, stderr="fatal: pathspec")
            return mock.Mock(returncode=0)

        with (
            mock.patch.object(
                git,
                "parse_owner_repo_from_git_remote",
                return_value=("o", "r"),
            ),
            mock.patch.object(git, "_git_current_branch", return_value="main"),
            mock.patch.object(git, "_git_local_branch_exists", return_value=True),
            mock.patch.object(git, "run_cmd", side_effect=fake_run_cmd),
            self.assertRaises(git.CommitPublishError) as ctx,
        ):
            git.commit_one_repo(
                Path("/tmp/r"),
                client=client,
                branch_name="devbox/ABC-1-slug-abcd1234",
                commit_message="msg",
            )
        self.assertIn("git staging failed", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
