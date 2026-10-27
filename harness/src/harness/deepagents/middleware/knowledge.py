"""Deterministic repository knowledge loading for DeepAgents presets.

Discovers a repository's agent instructions (`AGENTS.md`, `CLAUDE.md`) and
curated knowledge from the configured knowledge directory — at the repository
root and at explicit service subpaths for monorepos — and wraps them in a
DeepAgents ``MemoryMiddleware`` for deterministic prompt injection.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from deepagents import MemoryMiddleware
from deepagents.backends.filesystem import FilesystemBackend

from harness.env_flags import knowledge_dir_for_scope, knowledge_dir_relative_path

REPO_KNOWLEDGE_PROMPT = """<repository_knowledge>
{agent_memory}
</repository_knowledge>

The above is the repository's own agent instructions (AGENTS.md / CLAUDE.md) and \
curated repository knowledge, loaded directly from the repository.

<autonomous_mode_filtering>
This is an autonomous, non-interactive run. Apply repository instructions only
when they are compatible with the current task and higher-priority stage, safety,
and read-only constraints.

FOLLOW repository guidance about:
- code style, naming conventions, and formatting rules;
- architecture patterns, module structure, and design-system constraints;
- testing conventions and quality-gate commands such as lint, typecheck, and tests;
- language and framework idioms and anti-patterns;
- security constraints, export rules, and component classification; and
- commit-message conventions when a commit is part of the current stage.

IGNORE repository guidance that requires interactive or environment-specific
operator behavior, including:
- asking for user prompts, approval, or confirmation, using AskUserQuestion, or
  stopping at a human-confirmation gate;
- creating or using worktrees, following machine-specific filesystem paths, or
  navigating outside the provided repository root;
- interactively creating, switching, or managing branches; and
- presenting pre-edit proposals or waiting for permission before implementation.

ADAPT repository guidance when its intent remains applicable without interaction.
Run the checks and quality gates your stage permits using the available
equivalent commands rather than pausing for confirmation; guidance that writes
to the repository tree (formatters, `--fix`/`--write` modes, snapshot updates,
codegen) applies only when your stage allows edits. Apply relevant skill
conventions while resolving any interactive choices from the task and
repository context. Skip feature-branch setup instructions because the
checkout is already prepared.

Work directly inside the provided repository checkout. Do not create worktrees
or switch branches.
</autonomous_mode_filtering>
"""


def discover_knowledge_sources(scope_dirs: Sequence[Path]) -> list[str]:
    """Enumerate instructions and configured knowledge files for each scope.

    The first scope is the repository root; a knowledge directory symlinked
    outside it is ignored. Files reached through several scopes are listed once.
    """
    relative_knowledge_dir = knowledge_dir_relative_path()
    sources: list[str] = []
    for directory in scope_dirs:
        for name in ("AGENTS.md", "CLAUDE.md"):
            candidate = directory / name
            if candidate.is_file():
                sources.append(str(candidate.resolve()))
        scoped_knowledge_dir = knowledge_dir_for_scope(
            directory, relative_knowledge_dir, repo_root=scope_dirs[0]
        )
        if scoped_knowledge_dir is not None and scoped_knowledge_dir.is_dir():
            for md in sorted(scoped_knowledge_dir.glob("*.md")):
                if md.is_file():
                    sources.append(str(md.resolve()))
    return list(dict.fromkeys(sources))


def build_knowledge_middleware(
    scope_dirs: Sequence[Path],
) -> MemoryMiddleware | None:
    """Build middleware that injects instructions and repository knowledge."""
    sources = discover_knowledge_sources(scope_dirs)
    if not sources:
        return None
    return MemoryMiddleware(
        backend=FilesystemBackend(root_dir=scope_dirs[0], virtual_mode=False),
        sources=sources,
        system_prompt=REPO_KNOWLEDGE_PROMPT,
        add_cache_control=True,
    )
