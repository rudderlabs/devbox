"""Repository-scoped middleware stack shared by single-repo agent presets.

Every preset rooted in one repository (implementation, review lens, review
fix) wants the same deterministic context: the repo's instructions and
curated repository knowledge injected via ``MemoryMiddleware``, repository
and shared skills exposed via ``SkillsMiddleware``, and — for stages that
learn — the harness memory-writing tool. ``build_repo_middleware`` composes
that stack once so presets differ only in persona, contract, and thread.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from harness.deepagents.middleware.knowledge import build_knowledge_middleware
from harness.deepagents.middleware.memory_writing import (
    MemoryWritingMiddleware,
    RepoScope,
)
from harness.deepagents.middleware.skills import build_skills_middleware
from harness.events import RoundEvents
from harness.memory import MemoryStore
from harness.paths import SHARED_SKILLS_DIR


def build_repo_middleware(
    *,
    repo_path: Path,
    repo: str,
    knowledge_subpaths: Sequence[str] = (),
    memory_stage: str | None = None,
    events: RoundEvents | None = None,
    extra: Sequence[Any] | None = None,
) -> list[Any] | None:
    """Compose knowledge → skills → memory writer → caller middleware.

    ``knowledge_subpaths`` layers explicit monorepo service scopes (e.g.
    ``["acme-api"]``) on top of the repository root for both knowledge and
    skills. The memory-writing tool is attached only when ``memory_stage`` is
    set (read-only stages pass ``None``), writing through a new
    ``MemoryStore()`` and posting its heartbeat to the round's target through
    ``events`` when it is given. Builders that
    find nothing contribute nothing; returns ``None`` (equivalent to an empty
    list) when the stack is empty.
    """
    scope_dirs = [repo_path, *(repo_path / sub for sub in knowledge_subpaths)]
    stack: list[Any | None] = [
        build_knowledge_middleware(scope_dirs),
        build_skills_middleware([SHARED_SKILLS_DIR, *scope_dirs]),
    ]
    if memory_stage is not None:
        stack.append(
            MemoryWritingMiddleware(
                store=MemoryStore(),
                stage=memory_stage,
                repos=[RepoScope(repo, tuple(knowledge_subpaths))],
                events=events,
            )
        )
    combined = [mw for mw in stack if mw is not None]
    combined.extend(extra or [])
    return combined or None
