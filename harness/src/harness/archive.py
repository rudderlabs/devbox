"""Archive CLI surface for bundling harness artifacts."""

from __future__ import annotations

import argparse
import sys
import tarfile
from pathlib import Path

from harness.paths import HARNESS_DIR


def _validate_out_path(out: str) -> Path:
    path = Path(out)
    if not path.is_absolute():
        raise ValueError("--out must be an absolute path")
    if "".join(path.suffixes[-2:]) != ".tar.gz":
        raise ValueError("--out must end with .tar.gz")
    return path


def _add_tree_if_exists(
    archive: tarfile.TarFile,
    source_dir: Path,
    dest_dir: str,
) -> None:
    if not source_dir.is_dir():
        print(
            f"warning: source directory missing, skipping: {source_dir}",
            file=sys.stderr,
        )
        return

    archive.add(source_dir, arcname=dest_dir)


def _build_archive(out: Path, *, override: bool) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)

    if out.exists():
        if not override:
            raise FileExistsError(
                f"output archive already exists: {out}. Use --override to overwrite."
            )
        out.unlink()

    with tarfile.open(out, mode="w:gz") as archive:
        _add_tree_if_exists(archive, HARNESS_DIR, "data/harness-artifacts")

    return out


def _archive_main_impl(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Archive harness artifacts")
    parser.add_argument("--out", required=True, help="Absolute path to .tar.gz output")
    parser.add_argument(
        "--override",
        action="store_true",
        help="Overwrite an existing archive at --out",
    )
    ns = parser.parse_args(argv)

    try:
        out = _validate_out_path(ns.out)
        result = _build_archive(out, override=ns.override)
    except (ValueError, FileExistsError) as exc:
        parser.error(str(exc))

    print(f"archive written: {result}")
    return 0


def archive_main(argv: list[str]) -> int:
    try:
        return _archive_main_impl(argv)
    except SystemExit as exc:
        code = exc.code
        return code if isinstance(code, int) else (0 if code is None else 2)
