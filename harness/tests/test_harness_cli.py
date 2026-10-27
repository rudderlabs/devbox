"""Tests for top-level harness CLI help and dispatch ergonomics."""

from __future__ import annotations

import importlib.util
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_harness_with_workspace(workspace: Path, module_name: str):
    env = {
        "WORKSPACE": str(workspace),
        "DEVBOX_SHARED_SKILLS_DIR": str(workspace / "shared-skills" / "skills"),
    }
    with patch.dict(os.environ, env, clear=False):
        for mod_name in (
            "harness.paths",
            "harness.util",
            "harness.memory",
            "harness.distillation",
            "harness.cli",
        ):
            sys.modules.pop(mod_name, None)
        path = REPO_ROOT / "src" / "harness" / "cli.py"
        spec = importlib.util.spec_from_file_location(module_name, path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = mod
        spec.loader.exec_module(mod)
        return mod


class TestHarnessCLIHelp(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        (self.ws / ".harness").mkdir(parents=True)
        self.h = _load_harness_with_workspace(self.ws, "harness_cli")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, argv: list[str]) -> tuple[int, str, str]:
        out = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = self.h.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def test_root_help_entrypoints_exit_zero(self) -> None:
        for argv in ([], ["--help"], ["help"]):
            rc, stdout, stderr = self._run(list(argv))
            self.assertEqual(rc, 0)
            self.assertIn("usage: harness", stdout)
            self.assertIn("Harness CLI", stdout)
            self.assertEqual(stderr, "")

    def test_root_help_does_not_embed_subcommand_specific_flags(self) -> None:
        rc, stdout, stderr = self._run(["--help"])
        self.assertEqual(rc, 0)
        self.assertNotIn("--stage", stdout)
        self.assertNotIn("--repo", stdout)
        self.assertNotIn("--context", stdout)
        self.assertEqual(stderr, "")

    def test_subcommand_help_entrypoints_exit_zero(self) -> None:
        for argv in (["memory", "-h"], ["memory", "--help"], ["help", "memory"]):
            rc, stdout, stderr = self._run(list(argv))
            self.assertEqual(rc, 0)
            self.assertIn("Append a harness memory entry", stdout)
            self.assertIn("--add", stdout)
            self.assertIn("--stage", stdout)
            self.assertIn("--repo", stdout)
            self.assertEqual(stderr, "")

    def test_root_help_lists_all_subcommands(self) -> None:
        for argv in ([], ["--help"], ["help"]):
            rc, stdout, stderr = self._run(list(argv))
            self.assertEqual(rc, 0)
            self.assertEqual(stderr, "")
            for name, (description, _handler) in self.h.ROOT_SUBCOMMANDS.items():
                self.assertIn(
                    name,
                    stdout,
                    msg=f"argv={argv!r}: subcommand {name!r} missing from root help",
                )
                self.assertIn(
                    description,
                    stdout,
                    msg=f"argv={argv!r}: description for {name!r} missing from root help",
                )

    def test_all_subcommands_support_dash_h(self) -> None:
        expectations = {
            "memory": (
                "Append a harness memory entry",
                ("--add", "--stage", "--repo", "--context"),
            ),
            "daemon": ("Inbox event loop", ("-h, --help",)),
            "archive": (
                "Archive harness artifacts",
                ("--out", "--override", "-h, --help"),
            ),
        }
        for command, (description, arg_markers) in expectations.items():
            rc, stdout, stderr = self._run([command, "-h"])
            self.assertEqual(rc, 0)
            self.assertIn(description, stdout)
            for arg_marker in arg_markers:
                self.assertIn(arg_marker, stdout)
            self.assertEqual(stderr, "")


if __name__ == "__main__":
    unittest.main()
