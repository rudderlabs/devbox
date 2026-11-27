"""What a plugin author writes against: the base class, the hook marker and
the table of hooks the harness calls."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, ClassVar

# Raised only when a hook or a context member is removed or changes meaning.
# Adding a hook or a context member keeps it.
API_VERSION = 1
# A plugin written for any of these loads. The previous version stays here for
# one release after API_VERSION is raised.
SUPPORTED_API_VERSIONS = frozenset({1})

ENTRY_POINT_GROUP = "devbox.plugins"

_HOOK_ATTR = "_devbox_plugin_hook"


@dataclass(frozen=True)
class HookSpec:
    """One point where the harness calls plugins."""

    # Positional parameters after ``self``. Checked when a plugin loads.
    params: tuple[str, ...]
    # How long the harness waits for one plugin's hook before it moves on.
    budget_seconds: float
    summary: str


HOOKS: dict[str, HookSpec] = {
    "daemon_start": HookSpec(
        params=("ctx",),
        budget_seconds=10.0,
        summary=(
            "Once per daemon process, before the first inbox file is read. "
            "Also runs when a sandbox is recreated from its volume."
        ),
    ),
}


class Plugin:
    """Base class of every plugin.

    The harness creates one instance per daemon process, with no arguments.
    ``name`` is ``<namespace>.<name>`` and must equal the plugin's entry point
    name.
    """

    name: ClassVar[str] = ""
    requires_api: ClassVar[int] = 0


def hook[F: Callable[..., Any]](name: str) -> Callable[[F], F]:
    """Mark a ``Plugin`` method as the handler of hook ``name``.

    An unknown name is reported when the plugin loads, not here, so one
    plugin module can be imported by harness versions that know fewer hooks.
    """

    def mark(fn: F) -> F:
        setattr(fn, _HOOK_ATTR, name)
        return fn

    return mark


def hook_name_of(member: Any) -> str | None:
    """The hook a method was marked for, or ``None``."""
    name = getattr(member, _HOOK_ATTR, None)
    return name if isinstance(name, str) else None
