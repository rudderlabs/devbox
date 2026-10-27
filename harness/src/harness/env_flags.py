"""Shared environment-flag parsing.

A single ``bool_env`` so feature flags parse consistently instead of each call
site inlining its own ``{"1","true","yes","on"}`` check.
"""

from __future__ import annotations

import os
from pathlib import Path

_TRUTHY = frozenset({"1", "true", "yes", "on"})
_DEEPAGENTS_MODEL_TIMEOUT_SECONDS_DEFAULT = 180
_DEFAULT_KNOWLEDGE_DIR = Path(".agents/knowledge")


def distillation_enabled() -> bool:
    """Return whether repository knowledge distillation is enabled."""
    return bool_env("HARNESS_DISTILLATION_ENABLED", default=True)


def knowledge_dir_relative_path() -> Path:
    """Return the validated repo-relative knowledge directory.

    A configured value must identify a directory below a repository or component
    root. Invalid values raise rather than silently reverting to the default.
    """
    raw = os.environ.get("HARNESS_REPO_KNOWLEDGE_DIR")
    if raw is None:
        return _DEFAULT_KNOWLEDGE_DIR

    value = raw.strip()
    path = Path(value)
    if (
        not value
        or path == Path(".")
        or path.is_absolute()
        or "\\" in value
        or ".." in path.parts
    ):
        raise ValueError(
            "HARNESS_REPO_KNOWLEDGE_DIR must be a non-empty repository-relative "
            "directory below the repository root without '..' segments"
        )
    return path


def knowledge_dir_for_scope(
    scope_root: Path, relative_path: Path, *, repo_root: Path
) -> Path | None:
    """Resolve a validated relative knowledge path below *scope_root*.

    Symlinks are followed while they stay inside *repo_root*, so a component
    may share another directory's knowledge. Returns ``None`` when a symlink
    makes the directory resolve outside *repo_root*, or onto *scope_root* or
    *repo_root* themselves; such a directory is ignored rather than failing
    the stage.
    """
    repo = repo_root.resolve()
    scope = scope_root.resolve()
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ValueError("knowledge directory must be repository-relative")
    knowledge_dir = (scope / relative_path).resolve()
    if knowledge_dir in (repo, scope) or not knowledge_dir.is_relative_to(repo):
        print(
            f"knowledge: ignoring {scope / relative_path} — resolves to "
            f"{knowledge_dir}, not a directory inside the repository {repo}"
        )
        return None
    return knowledge_dir


def bool_env(name: str, *, default: bool = False) -> bool:
    """Return the boolean value of env var *name* (truthy = 1/true/yes/on).

    Unset (or empty) → *default*. Case- and whitespace-insensitive.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if not value:
        return default
    return value in _TRUTHY


def int_env(name: str, *, default: int) -> int:
    """Return the integer value of env var *name*.

    Unset, empty, or unparseable values fall back to *default*, matching the
    forgiving behavior of ``bool_env`` for feature flags.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    raw = raw.strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def deepagents_model_timeout_seconds() -> int:
    """Return the positive inactivity timeout for streaming model reads."""
    configured = int_env(
        "HARNESS_DEEPAGENTS_MODEL_TIMEOUT_SECONDS",
        default=_DEEPAGENTS_MODEL_TIMEOUT_SECONDS_DEFAULT,
    )
    if configured <= 0:
        return _DEEPAGENTS_MODEL_TIMEOUT_SECONDS_DEFAULT
    return configured


def classifier_skip_orientation_enabled() -> bool:
    """When true, allow the repo classifier to skip full orientation."""
    return bool_env("HARNESS_EXP_CLASSIFIER_SKIP_ORIENTATION")


def deepagents_event_streaming_enabled() -> bool:
    """Experimental gate for capturing DeepAgents v1 execution events."""
    return bool_env("HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING")
