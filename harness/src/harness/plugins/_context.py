"""What the harness hands a plugin when it calls a hook."""

from __future__ import annotations

import logging
import os
import re
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from harness.plugins._api import TaskInfo

if TYPE_CHECKING:
    from harness.events import RoundEvents

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


def _pid_alive(pid: int) -> bool:
    proc = _spawned.get(pid)
    if proc is not None:
        if proc.poll() is None:
            return True
        del _spawned[pid]
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
    # The assignment a stage hook runs for. None in daemon_start.
    task: TaskInfo | None = None
    # Where ``say`` posts. None outside a round, and for a task whose source
    # shows no progress messages.
    _events: RoundEvents | None = field(default=None, repr=False)

    def say(self, text: str) -> None:
        """Post a short progress line where the task's person follows it.

        Best-effort: it does nothing in daemon_start or when the task's source
        shows no progress, and it never raises. Write it as the agent would,
        in the first person, about the work and not about how it is run.
        """
        if self._events is None or not text.strip():
            return
        try:
            self._events.publish("agent_action", body=text.strip())
        except Exception as exc:
            self.log.warning("say failed (ignored): %s: %s", type(exc).__name__, exc)

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
