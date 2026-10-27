"""Pure helpers over Plan artifacts, safe to import on the default daemon path.

Kept free of any heavy (DeepAgents / LangChain) imports so modules on the
default startup path can reuse plan-derived logic without unnecessary startup
cost.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from harness.paths import WORKSPACE
from harness.schemas import PlanRepo


def repo_checkout_path(repo_name: str, *, workspace: Path | None = None) -> Path:
    """Return the authoritative checkout root for a repository name."""
    if (
        not repo_name
        or repo_name in {".", ".."}
        or "/" in repo_name
        or "\\" in repo_name
        or Path(repo_name).is_absolute()
    ):
        raise ValueError(f"repo name must be a bare checkout directory: {repo_name!r}")

    workspace_root = (workspace or WORKSPACE).resolve()
    repo_path = (workspace_root / repo_name).resolve()
    if repo_path.parent != workspace_root or repo_path.name != repo_name:
        raise ValueError(
            f"repo checkout must be a direct WORKSPACE child: {repo_name!r}"
        )
    return repo_path


def knowledge_subpaths_for_repo(
    repo: PlanRepo, *, workspace: Path | None = None
) -> list[str]:
    """Return each component's repo-relative knowledge subpath, sorted & deduped.

    Component paths may be absolute or repo-relative; entries that resolve
    outside the repository (or to the repo root itself) are dropped.
    """
    return knowledge_subpaths_for_component_paths(
        repo.name,
        (component.path for component in repo.components),
        workspace=workspace,
    )


def knowledge_subpaths_for_component_paths(
    repo_name: str, component_paths: Iterable[str], *, workspace: Path | None = None
) -> list[str]:
    """``knowledge_subpaths_for_repo`` over raw component paths of *repo_name*."""
    repo_path = repo_checkout_path(repo_name, workspace=workspace)
    subpaths: list[str] = []
    for component_path_raw in component_paths:
        if not component_path_raw:
            continue
        component_path = Path(component_path_raw)
        if not component_path.is_absolute():
            component_path = repo_path / component_path
        try:
            rel = component_path.resolve().relative_to(repo_path)
        except ValueError:
            continue
        if str(rel) not in ("", "."):
            subpaths.append(str(rel))
    return sorted(dict.fromkeys(subpaths))
