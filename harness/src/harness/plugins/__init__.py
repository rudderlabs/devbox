"""The harness plugin interface.

A plugin is a Python package installed next to the harness, usually in an image
built on top of the harness image. It names a ``Plugin`` subclass in the
``devbox.plugins`` entry point group; the daemon loads every such class once at
startup and calls its hooks at fixed points.

This module is the whole public interface: ``Plugin``, ``hook``,
``PluginContext``, ``API_VERSION`` and, for tests, ``harness.plugins.testing``.
Everything else under ``harness`` is private and may change in any release.
See ``docs/plugins.md``.
"""

from __future__ import annotations

from harness.plugins._api import (
    API_VERSION,
    ENTRY_POINT_GROUP,
    HOOKS,
    SUPPORTED_API_VERSIONS,
    HookSpec,
    Plugin,
    hook,
)
from harness.plugins._context import PluginContext
from harness.plugins._registry import (
    LoadedPlugin,
    PluginProblem,
    PluginRegistry,
    load_plugins,
)

__all__ = [
    "API_VERSION",
    "ENTRY_POINT_GROUP",
    "HOOKS",
    "SUPPORTED_API_VERSIONS",
    "HookSpec",
    "LoadedPlugin",
    "Plugin",
    "PluginContext",
    "PluginProblem",
    "PluginRegistry",
    "hook",
    "load_plugins",
]
