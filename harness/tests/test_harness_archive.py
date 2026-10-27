"""Tests for harness archive CLI."""

from __future__ import annotations

import importlib.util
import io
import os
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_harness_with_workspace(workspace: Path, module_name: str):
    env = {"WORKSPACE": str(workspace)}
    with patch.dict(os.environ, env, clear=False):
        for mod_name in (
            "harness.paths",
            "harness.util",
            "harness.memory",
            "harness.archive",
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


class TestHarnessArchive(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        (self.ws / ".harness").mkdir(parents=True)
        self.h = _load_harness_with_workspace(self.ws, "harness_archive")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run_archive(self, *args: str) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            rc = self.h.main(["archive", *args])
        return rc, stdout.getvalue(), stderr.getvalue()

    def _create_sources(self) -> Path:
        harness_dir = self.ws / ".harness"
        (harness_dir / "note.txt").write_text("harness-data", encoding="utf-8")
        return harness_dir

    def test_happy_path_creates_archive_with_expected_entries(self) -> None:
        self._create_sources()
        out = self.ws / "out" / "bundle.tar.gz"
        rc, _, _ = self._run_archive("--out", str(out))
        self.assertEqual(rc, 0)
        self.assertTrue(out.is_file())

        with tarfile.open(out, "r:gz") as handle:
            names = set(handle.getnames())
        self.assertEqual(
            names, {"data/harness-artifacts", "data/harness-artifacts/note.txt"}
        )

    def test_archive_preserves_content_fidelity(self) -> None:
        self._create_sources()
        out = self.ws / "bundle.tar.gz"
        rc, _, _ = self._run_archive("--out", str(out))
        self.assertEqual(rc, 0)

        with tarfile.open(out, "r:gz") as handle:
            harness_payload = (
                handle
                .extractfile("data/harness-artifacts/note.txt")
                .read()
                .decode("utf-8")
            )
        self.assertEqual(harness_payload, "harness-data")

    def test_rejects_non_tar_gz_extensions(self) -> None:
        self._create_sources()
        for suffix in (".zip", ".tar"):
            with self.subTest(suffix=suffix):
                out = self.ws / f"bundle{suffix}"
                rc, _, stderr = self._run_archive("--out", str(out))
                self.assertNotEqual(rc, 0)
                self.assertIn(".tar.gz", stderr)

    def test_rejects_relative_output_path(self) -> None:
        self._create_sources()
        rc, _, stderr = self._run_archive("--out", "relative.tar.gz")
        self.assertNotEqual(rc, 0)
        self.assertIn("absolute", stderr)

    def test_rejects_existing_output_without_override(self) -> None:
        self._create_sources()
        out = self.ws / "bundle.tar.gz"
        out.write_text("already here", encoding="utf-8")
        rc, _, stderr = self._run_archive("--out", str(out))
        self.assertNotEqual(rc, 0)
        self.assertIn("--override", stderr)

    def test_override_allows_overwrite(self) -> None:
        self._create_sources()
        out = self.ws / "bundle.tar.gz"
        out.write_text("old-bytes", encoding="utf-8")

        rc, _, _ = self._run_archive("--out", str(out), "--override")
        self.assertEqual(rc, 0)

        with tarfile.open(out, "r:gz") as handle:
            names = set(handle.getnames())
        self.assertIn("data/harness-artifacts/note.txt", names)

    def test_creates_parent_directories_for_output(self) -> None:
        self._create_sources()
        out = self.ws / "deep" / "nested" / "bundle.tar.gz"
        rc, _, _ = self._run_archive("--out", str(out))
        self.assertEqual(rc, 0)
        self.assertTrue(out.is_file())

    def test_missing_harness_directory_skips_gracefully(self) -> None:
        out = self.ws / "bundle.tar.gz"

        (self.ws / ".harness").rename(self.ws / ".harness.backup")
        rc, _, stderr = self._run_archive("--out", str(out))
        self.assertEqual(rc, 0)
        self.assertIn("warning: source directory missing", stderr)
        self.assertTrue(out.is_file())

    def test_missing_source_still_creates_valid_archive(self) -> None:
        (self.ws / ".harness").rename(self.ws / ".harness.backup")
        out = self.ws / "bundle.tar.gz"
        rc, _, stderr = self._run_archive("--out", str(out))
        self.assertEqual(rc, 0)
        self.assertIn("warning: source directory missing", stderr)

        with tarfile.open(out, "r:gz") as handle:
            self.assertEqual(handle.getnames(), [])

    def test_nested_directory_structure_is_preserved(self) -> None:
        harness_nested = self.ws / ".harness" / "nested" / "one"
        harness_nested.mkdir(parents=True, exist_ok=True)
        (harness_nested / "a.txt").write_text("a", encoding="utf-8")
        out = self.ws / "bundle.tar.gz"

        rc, _, _ = self._run_archive("--out", str(out))
        self.assertEqual(rc, 0)

        with tarfile.open(out, "r:gz") as handle:
            names = set(handle.getnames())
        self.assertIn("data/harness-artifacts/nested/one/a.txt", names)

    def test_missing_out_flag_returns_argparse_error(self) -> None:
        rc, _, stderr = self._run_archive()
        self.assertNotEqual(rc, 0)
        self.assertIn("--out", stderr)


if __name__ == "__main__":
    unittest.main()
