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
from typing import TYPE_CHECKING, Any

from harness.env_flags import bool_from
from harness.paths import HARNESS_DIR, RUNTIME_DIR, WORKSPACE
from harness.plugins._api import (
    ENTRY_POINT_GROUP,
    HOOKS,
    SUPPORTED_API_VERSIONS,
    Plugin,
    TaskInfo,
    hook_name_of,
)
from harness.plugins._context import PluginContext, plugin_settings, settings_stem

if TYPE_CHECKING:
    from harness.events import RoundEvents

# ``<namespace>.<name>``: the namespace says whose plugin it is, so two
# authors' plugins can share the short name.
_NAME = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")
# How long one plugin may take to import, be created and be checked. Past
# that the daemon goes on without it.
LOAD_BUDGET_SECONDS = 30.0
NAME_RULE = (
    "name must be <namespace>.<name>, each part lowercase letters, digits and "
    "underscores, starting with a letter"
)

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
    It is a list of names and nothing else: ``HARNESS_PLUGINS_ENABLED`` is
    what turns plugins off.
    """
    raw = (env.get("HARNESS_PLUGINS") or "").strip()
    if not raw:
        return None
    # Plugin names are lowercase, so the list is read without regard to case.
    names = [part.lower() for part in re.split(r"[,\s]+", raw) if part]
    return list(dict.fromkeys(names))


def settings_overlaps(names: Iterable[str]) -> dict[str, str]:
    """Names whose settings another name would also read: name -> that other.

    Settings are ``HARNESS_PLUGIN_<NAME>_<KEY>`` with the dot in the name
    written as an underscore, so plugin ``acme.foo`` would read every setting
    of a plugin ``acme.foo_bar`` as its own ``bar_<key>``, and ``a.b_c`` and
    ``a_b.c`` would read the same ones. The longer name is the one reported,
    or the later one of two that read the same.
    """
    names = sorted(set(names))
    stems = {name: settings_stem(name) for name in names}
    overlaps: dict[str, str] = {}
    for name in names:
        for other in names:
            if name == other:
                continue
            if stems[name].startswith(f"{stems[other]}_") or (
                stems[name] == stems[other] and other < name
            ):
                overlaps[name] = other
                break
    return overlaps


def name_error(name: object) -> str | None:
    """Why ``name`` cannot be a plugin's name, or ``None`` when it can."""
    if isinstance(name, str) and _NAME.match(name):
        return None
    return NAME_RULE


def _overlap_message(other: str) -> str:
    return (
        f"its settings prefix starts with that of plugin {other!r}, "
        "so that plugin would read its settings; rename one of them"
    )


def _hook_shape_error(fn: Callable[..., Any], params: tuple[str, ...]) -> str | None:
    """Why the bound method ``fn`` cannot be called as a hook with ``params``,
    or ``None`` when it can."""
    target = inspect.unwrap(getattr(fn, "__func__", fn))
    if (
        inspect.iscoroutinefunction(target)
        or inspect.isasyncgenfunction(target)
        or inspect.isgeneratorfunction(target)
    ):
        # Calling one returns an object and runs none of its body.
        return "must be a plain function, not async and not a generator"
    try:
        inspect.signature(fn).bind(*params)
    except TypeError:
        return f"must take ({', '.join(('self', *params))})"
    return None


def _build(name: str, obj: Any) -> tuple[LoadedPlugin | None, list[str]]:
    """Check one plugin class and create it. Returns it, or what is wrong.

    Never raises: whatever a plugin's own code raises while it is checked is
    that plugin's problem, and the others still load. Call it through
    ``_load_on_thread``, which is what makes catching BaseException safe.
    """
    try:
        return _build_checked(name, obj)
    except BaseException as exc:
        return None, [f"could not be checked: {type(exc).__name__}: {exc}"]


def _hook_methods(instance: Plugin) -> list[tuple[str, str]]:
    """(attribute, hook name) of each method marked with ``hook``.

    Reads the class without evaluating anything on it, so a property is never
    run while the plugin loads.
    """
    marked: list[tuple[str, str]] = []
    for attr in dir(type(instance)):
        raw = inspect.getattr_static(type(instance), attr, None)
        # The marker is on the function. Under @staticmethod or @classmethod
        # the class holds a wrapper, with the function behind __func__.
        hook_name = hook_name_of(raw) or hook_name_of(getattr(raw, "__func__", None))
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
    except BaseException as exc:
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
        shape_error = _hook_shape_error(member, spec.params)
        if shape_error is not None:
            errors.append(f"{attr} {shape_error} for hook {hook_name!r}")
            continue
        hooks[hook_name] = member
    if errors:
        return None, errors
    return LoadedPlugin(name=name, instance=instance, hooks=hooks), []


def _load_on_thread(
    name: str, load: Callable[[], Any]
) -> tuple[LoadedPlugin | None, list[str]]:
    """Import, create and check one plugin on a thread of its own.

    A plugin's code may raise or call ``sys.exit()`` while it loads. On its
    own thread, either is that plugin's problem and nothing else's. Signal
    handlers run on the main thread only, so a SystemExit that reaches the
    caller while it waits here is a real shutdown, and it passes through.
    """
    result: list[tuple[LoadedPlugin | None, list[str]]] = []

    def body() -> None:
        try:
            obj = load()
        except BaseException as exc:
            result.append((None, [f"import failed: {type(exc).__name__}: {exc}"]))
            return
        result.append(_build(name, obj))

    thread = threading.Thread(target=body, name=f"plugin-{name}-load", daemon=True)
    thread.start()
    thread.join(LOAD_BUDGET_SECONDS)
    if not result:
        # Left behind like a hook over its budget: the daemon must reach its
        # inbox whatever a plugin does while it loads.
        return None, [f"still loading after {LOAD_BUDGET_SECONDS:g}s; left out"]
    return result[0]


def _call(
    handler: Callable[..., Any],
    args: tuple[Any, ...],
    outcome: list[tuple[bool, Any]],
) -> None:
    """Thread body of one hook call: (True, value) or (False, exception).

    BaseException, so a hook that calls ``sys.exit`` is a failed hook like any
    other and not a thread that ends without a word.
    """
    try:
        outcome.append((True, handler(*args)))
    except BaseException as exc:
        outcome.append((False, exc))


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

    def context(
        self,
        plugin: LoadedPlugin,
        *,
        task: TaskInfo | None = None,
        events: RoundEvents | None = None,
    ) -> PluginContext:
        return PluginContext(
            name=plugin.name,
            settings=plugin_settings(plugin.name, self.env),
            state_dir=self.state_root / plugin.name,
            runtime_dir=self.runtime_root / plugin.name,
            workspace=self.workspace,
            log=_log.getChild(plugin.name),
            task=task,
            _events=events,
        )

    def invoke(
        self, plugin: LoadedPlugin, hook_name: str, ctx: PluginContext, *args: Any
    ) -> tuple[bool, Any]:
        """Call one plugin's hook. Returns (finished without raising, its
        return value).

        Never raises. A hook that raises is logged. A hook still running after
        its budget is logged and left behind: it keeps running on its own
        thread while the daemon moves on, and whatever it returns is dropped.
        """
        spec = HOOKS[hook_name]
        outcome: list[tuple[bool, Any]] = []
        thread = threading.Thread(
            target=_call,
            args=(plugin.hooks[hook_name], (ctx, *args), outcome),
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
            return False, None
        if not outcome:
            # Cannot happen while _call records every way a hook can end, but
            # a hook must never be able to raise out of here.
            _log.error("plugin %s: %s ended without a result", plugin.name, hook_name)
            return False, None
        ok, value = outcome[0]
        if not ok:
            _log.error(
                "plugin %s: %s failed (ignored): %s: %s",
                plugin.name,
                hook_name,
                type(value).__name__,
                value,
                exc_info=value,
            )
            return False, None
        return True, value

    def run(self, hook_name: str, *args: Any) -> None:
        """Call ``hook_name`` on every plugin that handles it, in order, and
        drop what the hooks return. Never raises (see ``invoke``)."""
        for plugin in self.plugins:
            if hook_name in plugin.hooks:
                self.invoke(plugin, hook_name, self.context(plugin), *args)


def load_plugins(
    *,
    env: Mapping[str, str] | None = None,
    entry_points: Iterable[metadata.EntryPoint] | None = None,
    every: bool = False,
    **registry_fields: Any,
) -> PluginRegistry:
    """Load the installed plugins the environment allows.

    None when ``HARNESS_PLUGINS_ENABLED`` is false; otherwise those in
    ``HARNESS_PLUGINS``, in that order, or every installed one by name when it
    is unset. ``every`` ignores both settings and loads every installed
    plugin: the build-time check uses it, so a plugin that is off in the image
    is still checked before someone turns it on.
    ``entry_points`` and ``registry_fields`` are for tests.
    """
    env = os.environ if env is None else env
    registry = PluginRegistry(env=env, **registry_fields)
    if not every and not bool_from(env, "HARNESS_PLUGINS_ENABLED", default=True):
        return registry
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
        if name_error(entry_point.name) is not None:
            registry.problems.append(PluginProblem(entry_point.name, NAME_RULE))
        elif entry_point.name in by_name:
            registry.problems.append(
                PluginProblem(entry_point.name, "installed more than once")
            )
        else:
            by_name[entry_point.name] = entry_point

    wanted = None if every else enabled_names(env)
    if wanted is None:
        order = sorted(by_name)
    else:
        order = [name for name in wanted if name in by_name]
        registry.problems.extend(
            PluginProblem(name, "listed in HARNESS_PLUGINS but not installed")
            for name in wanted
            if name not in by_name
        )

    loaded: list[LoadedPlugin] = []
    for name in order:
        entry_point = by_name[name]
        plugin, errors = _load_on_thread(name, entry_point.load)
        registry.problems.extend(PluginProblem(name, error) for error in errors)
        if plugin is not None:
            loaded.append(
                LoadedPlugin(
                    name=plugin.name,
                    instance=plugin.instance,
                    hooks=plugin.hooks,
                    source=_source(entry_point),
                )
            )
    # Among the plugins that did load: one that failed reads no settings, so
    # it must not cost another plugin its place.
    overlaps = settings_overlaps(plugin.name for plugin in loaded)
    for plugin in loaded:
        if plugin.name in overlaps:
            registry.problems.append(
                PluginProblem(plugin.name, _overlap_message(overlaps[plugin.name]))
            )
        else:
            registry.plugins.append(plugin)
    return registry
