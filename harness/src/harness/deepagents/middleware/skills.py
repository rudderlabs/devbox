"""Progressive-disclosure skills loading for DeepAgents sessions.

Discovers skill packages under caller-provided directories and wraps them in
deepagents ``SkillsMiddleware``. Skills stay progressively disclosed: the model
sees available skill names/descriptions and reads a full ``SKILL.md`` only when
the task naturally invokes it.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from deepagents.backends.filesystem import FilesystemBackend
from deepagents.middleware.skills import SkillsMiddleware

SKILL_SOURCE_SUBDIRS = (
    Path("skills"),
    Path(".claude") / "skills",
    Path(".agents") / "skills",
)


def _is_direct_skill_source(directory: Path) -> bool:
    if not directory.is_dir():
        return False
    if directory.name == "skills":
        return True
    return any((child / "SKILL.md").is_file() for child in directory.iterdir())


def _source_label(scope: Path, source: Path) -> str:
    if source == scope:
        if source.name == "skills":
            return source.parent.name
        return source.name
    return str(source.relative_to(scope))


def _skill_sources_under(directory: Path) -> list[tuple[str, str]]:
    scope = directory.resolve()
    sources: list[tuple[str, str]] = []
    if _is_direct_skill_source(scope):
        sources.append((str(scope), _source_label(scope, scope)))
    for subdir in SKILL_SOURCE_SUBDIRS:
        candidate = scope / subdir
        if candidate.is_dir():
            resolved = candidate.resolve()
            sources.append((str(resolved), _source_label(scope, resolved)))
    return sources


def discover_skill_sources(
    skill_dirs: Sequence[Path],
) -> list[tuple[str, str]]:
    """Return existing skills directories in increasing precedence order.

    Sources are absolute path strings paired with human-readable labels for the
    skills locations block. For each caller-provided directory in order, this
    includes the directory itself when it is a direct skill source, plus any
    harness-convention skill source directories beneath it: ``skills``,
    ``.claude/skills`` and ``.agents/skills``. DeepAgents
    resolves same-named skill conflicts with later sources winning, so callers
    control precedence by ordering ``skill_dirs`` from broadest to most
    specific.
    """
    sources: list[tuple[str, str]] = []
    for directory in skill_dirs:
        sources.extend(_skill_sources_under(directory))
    return sources


def build_skills_middleware(
    skill_dirs: Sequence[Path],
) -> SkillsMiddleware | None:
    """Build ``SkillsMiddleware`` for discovered sources, or ``None``.

    Returning ``None`` when no skill sources exist avoids changing prompts for
    sessions whose caller-provided directories do not provide skills.
    """
    sources = discover_skill_sources(skill_dirs)
    if not sources:
        return None
    root_dir = next(
        (directory.resolve() for directory in skill_dirs if directory.exists()),
        Path(sources[0][0]),
    )
    return SkillsMiddleware(
        backend=FilesystemBackend(root_dir=root_dir, virtual_mode=False),
        sources=sources,
    )
