"""
Subprocess runner utilities shared across modules.
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Mapping, Sequence
from pathlib import Path


def run_cmd(
    argv: Sequence[str],
    *,
    cwd: Path | None = None,
    input_text: str | None = None,
    check: bool = True,
    env: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """`env` is laid over the process environment for this one command."""
    print(f"[CMD]: {' '.join(argv)}")

    return _run_cmd(argv, cwd=cwd, input_text=input_text, check=check, env=env)


def run_cmd_with_display_argv(
    argv: Sequence[str],
    *,
    display_argv: Sequence[str],
    cwd: Path | None = None,
    input_text: str | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    print(f"[CMD]: {' '.join(display_argv)}")

    return _run_cmd(argv, cwd=cwd, input_text=input_text, check=check)


def _run_cmd(
    argv: Sequence[str],
    *,
    cwd: Path | None = None,
    input_text: str | None = None,
    check: bool = True,
    env: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(argv),
        cwd=str(cwd) if cwd else None,
        input=input_text,
        text=True,
        capture_output=True,
        check=check,
        env={**os.environ, **env} if env else None,
    )
