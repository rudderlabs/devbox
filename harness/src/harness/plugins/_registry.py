"""Finding plugins, checking them and calling their hooks.

Loading never raises: a plugin that cannot be loaded becomes a
``PluginProblem`` and is left out. The daemon logs problems and carries on;
``harness plugins check`` turns them into a failed image build.
"""

from __future__ import annotations

import inspect
import logging
import os
import re
import threading
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Any

from harness.paths import HARNESS_DIR, RUNTIME_DIR, WORKSPACE
from harness.plugins._api import (
    ENTRY_POINT_GROUP,
    HOOKS,
    SUPPORTED_API_VERSIONS,
    Plugin,
    hook_name_of,
)
from harness.plugins._context import PluginContext, plugin_settings

_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
# HARNESS_PLUGINS value that turns every installed plugin off.
_NONE = "none"

_log = logging.getLogger("harness.plugins")


@dataclass(frozen=True)
class PluginProblem:
    plugin: str
    message: str

    def __str__(self) -> str:
        return f"{self.plugin}: {self.message}"


@dataclass(frozen=True)
class LoadedPlugin:
    name: str
    instance: Plugin
    # hook name -> bound method
    hooks: Mapping[str, Callable[..., Any]]
    # "<distribution> <version>", or "" when the entry point has none.
    source: str = ""


def enabled_names(env: Mapping[str, str]) -> list[str] | None:
    """The names in ``HARNESS_PLUGINS``, in order. ``None``: every installed one.

    Unset or empty means every installed plugin, like other harness flags.
    ``none`` turns them all off.
    """
    raw = (env.get("HARNESS_PLUGINS") or "").strip()
    if not raw:
        return None
    # Plugin names are lowercase, so the list is read without regard to case.
    names = [part.lower() for part in re.split(r"[,\s]+", raw) if part]
    if names == [_NONE]:
        return []
    return list(dict.fromkeys(names))


def settings_overlaps(names: Iterable[str]) -> dict[str, str]:
    """Names whose settings another name would also read: name -> that other.

    Settings are ``HARNESS_PLUGIN_<NAME>_<KEY>``, so plugin ``foo`` would read
    every setting of a plugin ``foo_bar`` as its own ``bar_<key>``. The longer
    name is the one reported.
    """
    names = list(names)
    return {
        name: other
        for name in names
        for other in names
        if name != other and name.startswith(f"{other}_")
    }


def _overlap_message(other: str) -> str:
    return (
        f"its name starts with the name of plugin {other!r} and an underscore, "
        "so that plugin would read its settings; rename one of them"
    )


def _positional_params(fn: Callable[..., Any]) -> list[str] | None:
    """Names of the positional parameters of a bound method, or ``None`` when
    it also takes ``*args`` and so fits any hook."""
    names: list[str] = []
    for param in inspect.signature(fn).parameters.values():
        if param.kind is param.VAR_POSITIONAL:
            return None
        if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD):
            names.append(param.name)
    return names


def _build(name: str, obj: Any) -> tuple[LoadedPlugin | None, list[str]]:
    """Check one plugin class and create it. Returns it, or what is wrong.

    Never raises: whatever a plugin's own code raises while it is checked is
    that plugin's problem, and the others still load.
    """
    try:
        return _build_checked(name, obj)
    except Exception as exc:
        return None, [f"could not be checked: {type(exc).__name__}: {exc}"]


def _hook_methods(instance: Plugin) -> list[tuple[str, str]]:
    """(attribute, hook name) of each method marked with ``hook``.

    Reads the class without evaluating anything on it, so a property is never
    run while the plugin loads.
    """
    marked: list[tuple[str, str]] = []
    for attr in dir(type(instance)):
        hook_name = hook_name_of(inspect.getattr_static(type(instance), attr, None))
        if hook_name is not None:
            marked.append((attr, hook_name))
    return marked


def _build_checked(name: str, obj: Any) -> tuple[LoadedPlugin | None, list[str]]:
    if not (inspect.isclass(obj) and issubclass(obj, Plugin)):
        return None, ["its entry point is not a harness.plugins.Plugin subclass"]
    errors: list[str] = []
    if obj.name != name:
        errors.append(f"class name {obj.name!r} differs from its entry point name")
    if obj.requires_api not in SUPPORTED_API_VERSIONS:
        supported = ", ".join(str(v) for v in sorted(SUPPORTED_API_VERSIONS))
        errors.append(
            f"requires_api is {obj.requires_api!r}; this harness supports {supported}"
        )
    if errors:
        return None, errors
    try:
        instance = obj()
    except Exception as exc:
        return None, [f"could not be created: {type(exc).__name__}: {exc}"]

    hooks: dict[str, Callable[..., Any]] = {}
    for attr, hook_name in _hook_methods(instance):
        member = getattr(instance, attr)
        spec = HOOKS.get(hook_name)
        if spec is None:
            errors.append(f"{attr} handles unknown hook {hook_name!r}")
            continue
        if hook_name in hooks:
            errors.append(f"hook {hook_name!r} has more than one handler")
            continue
        params = _positional_params(member)
        if params is not None and len(params) != len(spec.params):
            expected = ", ".join(("self", *spec.params))
            errors.append(f"{attr} must take ({expected}) for hook {hook_name!r}")
            continue
        hooks[hook_name] = member
    if errors:
        return None, errors
    return LoadedPlugin(name=name, instance=instance, hooks=hooks), []


def _call(
    handler: Callable[..., Any], args: tuple[Any, ...], failure: list[BaseException]
) -> None:
    """Thread body of one hook call: what it raises goes into ``failure``.

    BaseException, so a hook that calls ``sys.exit`` is a failed hook like any
    other and not a thread that ends without a word.
    """
    try:
        handler(*args)
    except BaseException as exc:
        failure.append(exc)


def _source(entry_point: metadata.EntryPoint) -> str:
    dist = getattr(entry_point, "dist", None)
    return f"{dist.name} {dist.version}" if dist is not None else ""


@dataclass
class PluginRegistry:
    """The plugins of one daemon process, in the order their hooks run."""

    plugins: list[LoadedPlugin] = field(default_factory=list)
    problems: list[PluginProblem] = field(default_factory=list)
    env: Mapping[str, str] = field(default_factory=lambda: os.environ)
    state_root: Path = HARNESS_DIR / "plugins"
    runtime_root: Path = RUNTIME_DIR / "devbox-plugins"
    workspace: Path = WORKSPACE

    def context(self, plugin: LoadedPlugin) -> PluginContext:
        return PluginContext(
            name=plugin.name,
            settings=plugin_settings(plugin.name, self.env),
            state_dir=self.state_root / plugin.name,
            runtime_dir=self.runtime_root / plugin.name,
            workspace=self.workspace,
            log=_log.getChild(plugin.name),
        )

    def run(self, hook_name: str, *args: Any) -> None:
        """Call ``hook_name`` on every plugin that handles it, in order.

        Never raises. A hook that raises is logged and the next plugin runs.
        A hook still running after its budget is logged and left behind: it
        keeps running on its own thread while the daemon moves on.
        """
        spec = HOOKS[hook_name]
        for plugin in self.plugins:
            handler = plugin.hooks.get(hook_name)
            if handler is None:
                continue
            failure: list[BaseException] = []
            thread = threading.Thread(
                target=_call,
                args=(handler, (self.context(plugin), *args), failure),
                name=f"plugin-{plugin.name}-{hook_name}",
                daemon=True,
            )
            thread.start()
            thread.join(spec.budget_seconds)
            if thread.is_alive():
                _log.warning(
                    "plugin %s: %s is still running after %ss; continuing",
                    plugin.name,
                    hook_name,
                    spec.budget_seconds,
                )
            elif failure:
                exc = failure[0]
                _log.error(
                    "plugin %s: %s failed (ignored): %s: %s",
                    plugin.name,
                    hook_name,
                    type(exc).__name__,
                    exc,
                    exc_info=exc,
                )


def load_plugins(
    *,
    env: Mapping[str, str] | None = None,
    entry_points: Iterable[metadata.EntryPoint] | None = None,
    **registry_fields: Any,
) -> PluginRegistry:
    """Load the installed plugins that ``HARNESS_PLUGINS`` allows.

    Hooks run in ``HARNESS_PLUGINS`` order, or by name when it is unset.
    ``entry_points`` and ``registry_fields`` are for tests.
    """
    env = os.environ if env is None else env
    registry = PluginRegistry(env=env, **registry_fields)
    try:
        found = (
            list(metadata.entry_points(group=ENTRY_POINT_GROUP))
            if entry_points is None
            else list(entry_points)
        )
    except Exception as exc:
        registry.problems.append(
            PluginProblem("*", f"could not list plugins: {type(exc).__name__}: {exc}")
        )
        return registry

    by_name: dict[str, metadata.EntryPoint] = {}
    for entry_point in found:
        if not _NAME.match(entry_point.name):
            registry.problems.append(
                PluginProblem(
                    entry_point.name,
                    "name must be lowercase letters, digits and underscores",
                )
            )
        elif entry_point.name in by_name:
            registry.problems.append(
                PluginProblem(entry_point.name, "installed more than once")
            )
        else:
            by_name[entry_point.name] = entry_point

    wanted = enabled_names(env)
    if wanted is None:
        order = sorted(by_name)
    else:
        order = [name for name in wanted if name in by_name]
        registry.problems.extend(
            PluginProblem(name, "listed in HARNESS_PLUGINS but not installed")
            for name in wanted
            if name not in by_name
        )

    overlaps = settings_overlaps(order)
    for name in order:
        if name in overlaps:
            registry.problems.append(
                PluginProblem(name, _overlap_message(overlaps[name]))
            )
            continue
        entry_point = by_name[name]
        try:
            obj = entry_point.load()
        except Exception as exc:
            registry.problems.append(
                PluginProblem(name, f"import failed: {type(exc).__name__}: {exc}")
            )
            continue
        plugin, errors = _build(name, obj)
        registry.problems.extend(PluginProblem(name, error) for error in errors)
        if plugin is not None:
            registry.plugins.append(
                LoadedPlugin(
                    name=plugin.name,
                    instance=plugin.instance,
                    hooks=plugin.hooks,
                    source=_source(entry_point),
                )
            )
    return registry
