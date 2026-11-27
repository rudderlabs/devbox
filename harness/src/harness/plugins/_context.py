"""What the harness hands a plugin when it calls a hook."""

from __future__ import annotations

import logging
import os
import re
import subprocess
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

_KEY = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")


def settings_stem(name: str) -> str:
    """The plugin name as it appears in a setting's variable name.

    An environment variable name cannot hold a dot, so the one between the
    namespace and the name is an underscore there.
    """
    return name.upper().replace(".", "_")


def plugin_settings(name: str, env: Mapping[str, str]) -> dict[str, str]:
    """The plugin's settings: ``HARNESS_PLUGIN_<NAMESPACE>_<NAME>_<KEY>`` as
    ``<key>``."""
    prefix = f"HARNESS_PLUGIN_{settings_stem(name)}_"
    return {
        key[len(prefix) :].lower(): value
        for key, value in env.items()
        if key.startswith(prefix) and len(key) > len(prefix)
    }


# Live processes this daemon started, by pid, and the pids of those that have
# exited. Each child has a thread that waits for it, so its exit is collected
# whether or not anything is spawned again; a finished child that nobody has
# collected stays behind as a zombie and still answers a signal.
_spawned: dict[int, subprocess.Popen[bytes]] = {}
_exited: set[int] = set()
# Held from reading a ``once`` marker to writing it, so two hooks running at
# the same time cannot both start the same work. A hook left running past its
# budget overlaps the next one.
_lock = threading.Lock()


def _reap(proc: subprocess.Popen[bytes]) -> None:
    """Thread body: wait for one child, then record that it has exited."""
    proc.wait()
    with _lock:
        _spawned.pop(proc.pid, None)
        _exited.add(proc.pid)


def _pid_alive(pid: int) -> bool:
    """Whether the process a ``once`` marker names is still running. Call it
    with ``_lock`` held."""
    proc = _spawned.get(pid)
    if proc is not None:
        return proc.poll() is None
    if pid in _exited:
        # Ours, and gone. The pid may since belong to another process.
        return False
    # Not started by this daemon process: ask the system.
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
    # HARNESS_PLUGIN_<NAMESPACE>_<NAME>_<KEY> from the environment, keyed by lowercased KEY.
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

        with _lock:
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
            _exited.discard(proc.pid)
            if marker is not None:
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_text(f"{proc.pid}\n", encoding="utf-8")
        threading.Thread(
            target=_reap, args=(proc,), name=f"plugin-reap-{proc.pid}", daemon=True
        ).start()
        return proc.pid
