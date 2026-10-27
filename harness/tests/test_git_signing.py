"""Unit tests for harness-managed git signing setup (no real gpg or git)."""

from __future__ import annotations

import contextlib
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import git

FINGERPRINT = "0123456789ABCDEF0123456789ABCDEF01234567"
KEY_ID = "89ABCDEF01234567"


class TestSetupGitSigningLogging(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.key_file = self.home / "secret-signing-key.asc"
        self.key_file.write_text("-----BEGIN PGP PRIVATE KEY BLOCK-----\n")
        self.calls: list[list[str]] = []

        git._git_signing_inputs_cache = None
        git._git_signing_key_cache = None
        self.addCleanup(setattr, git, "_git_signing_inputs_cache", None)
        self.addCleanup(setattr, git, "_git_signing_key_cache", None)

    def _fake_run(self, argv, **_kwargs) -> subprocess.CompletedProcess[str]:
        self.calls.append(list(argv))
        stdout = ""
        if "--list-secret-keys" in argv:
            stdout = f"sec:u:255:22:{KEY_ID}:::::::\nfpr:::::::::{FINGERPRINT}:\n"
        return subprocess.CompletedProcess(argv, 0, stdout=stdout, stderr="")

    def _setup(self) -> tuple[str | None, str]:
        env = {
            git.GIT_SIGNER_NAME_ENV: "Devbox Bot",
            git.GIT_SIGNER_EMAIL_ENV: "bot@example.com",
            git.GPG_PRIVATE_KEY_FILE_ENV: str(self.key_file),
            git.GPG_KEY_ID_ENV: KEY_ID,
        }
        out = io.StringIO()
        with (
            mock.patch.dict(os.environ, env),
            mock.patch.object(Path, "home", return_value=self.home),
            mock.patch("harness.cmd_runner.subprocess.run", side_effect=self._fake_run),
            contextlib.redirect_stdout(out),
        ):
            signing_key = git.setup_git_signing(required=True)
        return signing_key, out.getvalue()

    def test_command_log_omits_key_material(self) -> None:
        _, logged = self._setup()

        self.assertIn("[CMD]: gpg --batch --import", logged)
        self.assertIn("[CMD]: git config --global user.signingkey", logged)
        self.assertNotIn(str(self.key_file), logged)
        self.assertNotIn(FINGERPRINT, logged)
        self.assertNotIn(KEY_ID, logged)

    def test_commands_still_receive_real_values(self) -> None:
        signing_key, _ = self._setup()

        self.assertEqual(signing_key, FINGERPRINT)
        self.assertIn(["gpg", "--batch", "--import", str(self.key_file)], self.calls)
        self.assertIn(
            ["gpg", "--batch", "--list-secret-keys", "--with-colons", KEY_ID],
            self.calls,
        )
        self.assertIn(
            ["git", "config", "--global", "user.signingkey", FINGERPRINT], self.calls
        )


if __name__ == "__main__":
    unittest.main()
