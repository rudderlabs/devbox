"""What a plugin author writes against: the base class, the hook marker and
the table of hooks the harness calls."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
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
    # The hook may return data. The harness saves what it returns per inbox
    # id, and on a restart reuses the saved result instead of calling again.
    saves_result: bool = False
    # The hook may also return sections for the pull request bodies.
    pr_sections: bool = False


HOOKS: dict[str, HookSpec] = {
    "daemon_start": HookSpec(
        params=("ctx",),
        budget_seconds=10.0,
        summary=(
            "Once per daemon process, before the first inbox file is read. "
            "Also runs when a sandbox is recreated from its volume."
        ),
    ),
    "after_planning": HookSpec(
        params=("ctx", "plan"),
        budget_seconds=300.0,
        summary="Once per assignment, after the plan is written.",
        saves_result=True,
    ),
    "before_implementation": HookSpec(
        params=("ctx", "plan"),
        budget_seconds=30.0,
        summary=(
            "Each time the daemon is about to run or resume an assignment's "
            "implementation. Not when the implementation is already complete."
        ),
    ),
    "after_implementation": HookSpec(
        params=("ctx", "plan", "implementation"),
        budget_seconds=1800.0,
        summary=(
            "Once per assignment, after every repository's implementation is "
            "complete. Before the review, unless a first try failed and the "
            "daemon restarted later."
        ),
        saves_result=True,
        pr_sections=True,
    ),
    "prompt_fragments": HookSpec(
        params=("ctx", "stage"),
        budget_seconds=10.0,
        summary=(
            "Each time the daemon is about to start a stage's agents. Returns "
            "text for their system prompt. stage is planning, implementation, "
            "comment, review or ci_result."
        ),
    ),
    "followup_start": HookSpec(
        params=("ctx", "kind"),
        budget_seconds=30.0,
        summary=(
            "Each time the daemon is about to run or resume a follow-up "
            "round. kind is the round's inbox kind: comment, review or "
            "ci_result."
        ),
    ),
}


# The stages whose agents take plugin text in their system prompt, as the
# prompt_fragments hook is told them. The last three are the follow-up rounds,
# named by inbox kind like followup_start's ``kind``.
PROMPT_STAGES = ("planning", "implementation", "comment", "review", "ci_result")


@dataclass(frozen=True)
class TaskInfo:
    """The round a hook runs for: an assignment, or a follow-up round of its
    task."""

    task_key: str
    inbox_id: str
    run_id: str


@dataclass(frozen=True)
class PrSection:
    """A titled section the harness appends to one repository's pull request
    body. ``repo`` is the repository's name in the implementation."""

    repo: str
    title: str
    body: str


@dataclass(frozen=True)
class HookResult:
    """What a hook that saves its result may return.

    ``data`` must be JSON. The harness stores it under
    ``extensions.<plugin name>`` in the stage's artifact. Returning a plain
    mapping is the same as ``HookResult(data=mapping)``, and returning
    ``None`` the same as an empty ``HookResult``.
    """

    data: Mapping[str, Any] | None = None
    pr_sections: Sequence[PrSection] = ()


class Plugin:
    """Base class of every plugin.

    The harness creates one instance per daemon process, with no arguments.
    ``name`` must equal the plugin's entry point name.
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
