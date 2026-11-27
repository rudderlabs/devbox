"""Helpers for testing a plugin without installing it or starting a daemon.

    registry = registry_for([MyPlugin], root=tmp_path, env={...})
    registry.run("daemon_start")

``root`` holds everything the plugin may write: its state under
``root/state/<name>``, its runtime files under ``root/runtime/<name>`` and the
workspace at ``root/workspace``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path

from harness.plugins._api import Plugin
from harness.plugins._registry import (
    PluginProblem,
    PluginRegistry,
    _load_on_thread,
    _overlap_message,
    name_error,
    settings_overlaps,
)


def registry_for(
    plugin_classes: Sequence[type[Plugin]],
    *,
    root: Path,
    env: Mapping[str, str] | None = None,
) -> PluginRegistry:
    """A registry of ``plugin_classes``, checked the way the loader checks.

    Raises ``ValueError`` when a class would not load, so a test fails on the
    same mistakes ``harness plugins check`` reports.
    """
    registry = PluginRegistry(
        env=dict(env or {}),
        state_root=root / "state",
        runtime_root=root / "runtime",
        workspace=root / "workspace",
    )
    for cls in plugin_classes:
        if (error := name_error(cls.name)) is not None:
            registry.problems.append(PluginProblem(str(cls.name), error))
            continue
        plugin, errors = _load_on_thread(cls.name, lambda cls=cls: cls)
        registry.problems.extend(PluginProblem(cls.name, error) for error in errors)
        if plugin is not None:
            registry.plugins.append(plugin)
    named = [cls.name for cls in plugin_classes if name_error(cls.name) is None]
    for name, other in settings_overlaps(named).items():
        registry.problems.append(PluginProblem(name, _overlap_message(other)))
    if registry.problems:
        raise ValueError("; ".join(str(problem) for problem in registry.problems))
    return registry
