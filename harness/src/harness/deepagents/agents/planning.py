"""PlanningAgent — per-repository DeepAgents planning preset."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from langchain.agents.structured_output import ProviderStrategy
from langchain_core.language_models import BaseChatModel

from harness.deepagents.dense_turns import DENSE_TURNS_READONLY_PROMPT
from harness.deepagents.middleware.knowledge import build_knowledge_middleware
from harness.deepagents.middleware.skills import build_skills_middleware
from harness.deepagents.session import DeepAgentSession
from harness.events import RoundEvents
from harness.paths import SHARED_SKILLS_DIR
from harness.schemas import RepoPlanOutput

PLANNING_SYSTEM_PROMPT = (
    """\
You are a read-only planning agent working inside a single repository.

Your task is to inspect repository structure, tests, configuration, and the
provided orientation context so the harness can produce an implementation plan.

Rules:
- Read files and run only safe, non-mutating inspection commands when needed.
- Do not edit files, create files, run formatters, commit, push, or perform any
  mutating operation.
- Use repository knowledge and skills supplied in the system context.
- Produce a concrete per-repository plan with a goal, files/areas to inspect or
  change, implementation steps, validation steps, risks, relevant components,
  planning notes, and cross-repository assumptions.
- Component paths must be repository-relative paths.
"""
    + DENSE_TURNS_READONLY_PROMPT
)


class PlanningAgent(DeepAgentSession[RepoPlanOutput]):
    """A repo-scoped, in-memory, non-durable planning preset."""

    def __init__(
        self,
        *,
        model: BaseChatModel,
        repo_path: Path,
        thread_id: str,
        knowledge_subpaths: Sequence[str] = (),
        durable: bool = False,
        middleware: Sequence[Any] | None = None,
        response_format: type[Any] = RepoPlanOutput,
        events: RoundEvents | None,
    ) -> None:
        scope_dirs = [repo_path, *(repo_path / sub for sub in knowledge_subpaths)]
        knowledge_mw = build_knowledge_middleware(scope_dirs)
        skills_mw = build_skills_middleware([SHARED_SKILLS_DIR, *scope_dirs])
        prepended = [mw for mw in (knowledge_mw, skills_mw) if mw is not None]
        combined: list[Any] | None = [*prepended, *(middleware or [])]
        if not combined:
            combined = None

        super().__init__(
            events=events,
            model=model,
            thread_id=thread_id,
            workspace_dir=repo_path,
            system_prompt=PLANNING_SYSTEM_PROMPT,
            middleware=combined,
            response_format=ProviderStrategy(response_format, strict=True),
            durable=durable,
            in_memory=True,
            emit_identifier=f"{repo_path.name}/planning",
        )
