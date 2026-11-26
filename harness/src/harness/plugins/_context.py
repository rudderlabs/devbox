"""What the harness hands a plugin when it calls a hook."""

from __future__ import annotations

import logging
import os
import re
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

_KEY = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")


def plugin_settings(name: str, env: Mapping[str, str]) -> dict[str, str]:
    """The plugin's settings: ``HARNESS_PLUGIN_<NAME>_<KEY>`` as ``<key>``."""
    prefix = f"HARNESS_PLUGIN_{name.upper()}_"
    return {
        key[len(prefix) :].lower(): value
        for key, value in env.items()
        if key.startswith(prefix) and len(key) > len(prefix)
    }


# Processes this daemon started, by pid. Holding them lets the exit of each be
# collected, and tells a finished one from a live one: a finished child that
# nobody has collected still answers a signal.
_spawned: dict[int, subprocess.Popen[bytes]] = {}


def _collect_finished() -> None:
    """Collect the exit of every started process that has finished, so none
    stays behind as a zombie or in the table."""
    for pid, proc in list(_spawned.items()):
        if proc.poll() is not None:
            # pop, not del: a hook left running past its budget can be in
            # spawn at the same time as the next hook.
            _spawned.pop(pid, None)


def _pid_alive(pid: int) -> bool:
    proc = _spawned.get(pid)
    if proc is not None:
        if proc.poll() is None:
            return True
        _spawned.pop(pid, None)
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@dataclass(frozen=True)
class PluginContext:
    """One plugin's view of the sandbox. Built fresh for every hook call."""

    name: str
    # HARNESS_PLUGIN_<NAME>_<KEY> from the environment, keyed by lowercased KEY.
    settings: Mapping[str, str]
    # The plugin's own directory on the task volume. It survives a sandbox
    # restart. Created on first use by ``spawn``; create it yourself otherwise.
    state_dir: Path
    # The plugin's own directory off the volume. A restart empties it, so a
    # file here was written by a process of this sandbox instance.
    runtime_dir: Path
    workspace: Path
    log: logging.Logger

    def spawn(
        self,
        argv: Sequence[str],
        *,
        log: str,
        once: str | None = None,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
    ) -> int | None:
        """Start a detached process and return its pid without waiting.

        Output is appended to ``state_dir/<log>``. The process gets its own
        session, so it outlives the hook and is not signalled with the daemon.

        ``once`` names the work. While a process started under the same name
        by this sandbox instance is alive, the call starts nothing and returns
        ``None``. Use it for anything that must not run twice, such as a
        server on a fixed port.
        """
        if not argv:
            raise ValueError("spawn: argv is empty")
        if not _KEY.match(log) or (once is not None and not _KEY.match(once)):
            raise ValueError("spawn: log and once must be plain file names")

        _collect_finished()
        marker = None
        if once is not None:
            marker = self.runtime_dir / f"{once}.pid"
            try:
                if _pid_alive(int(marker.read_text(encoding="utf-8").strip())):
                    return None
            except (OSError, ValueError):
                pass

        self.state_dir.mkdir(parents=True, exist_ok=True)
        with (self.state_dir / log).open("ab") as out:
            proc = subprocess.Popen(
                list(argv),
                cwd=str(cwd) if cwd is not None else None,
                env={**os.environ, **env} if env is not None else None,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        _spawned[proc.pid] = proc
        if marker is not None:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(f"{proc.pid}\n", encoding="utf-8")
        return proc.pid
