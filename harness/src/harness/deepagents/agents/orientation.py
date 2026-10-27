"""OrientationAgent — workspace-rooted DeepAgents planning orientation preset."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from langchain.agents.structured_output import ProviderStrategy
from langchain_core.language_models import BaseChatModel

from harness.deepagents.dense_turns import DENSE_TURNS_READONLY_PROMPT
from harness.deepagents.middleware.skills import build_skills_middleware
from harness.deepagents.session import DeepAgentSession
from harness.events import RoundEvents
from harness.paths import SHARED_SKILLS_DIR
from harness.schemas import OrientationOutput

ORIENTATION_SYSTEM_PROMPT = (
    """\
You are the read-only orientation agent for the harness planning stage.

Your job is to inspect the checked-out repositories under WORKSPACE and identify
the repositories and repository-relative components that are likely required for
the requested task.

Rules:
- Read repository files and metadata needed to orient the task.
- Do not edit files, create files, run formatters, run tests, commit, push, or
  perform any mutating operation.
- Return only structured orientation data: bare checkout repository names,
  confidence for each repository, optional repo-relative component paths, concise
  rationale, orientation notes, and cross-repository assumptions.
- Repository names must be bare WORKSPACE child directory names, never paths or
  owner/repo slugs.
"""
    + DENSE_TURNS_READONLY_PROMPT
)


class OrientationAgent(DeepAgentSession[OrientationOutput]):
    """A workspace-scoped, non-durable orientation preset."""

    def __init__(
        self,
        *,
        model: BaseChatModel,
        workspace_dir: Path,
        thread_id: str,
        durable: bool = False,
        middleware: Sequence[Any] | None = None,
        response_format: type[Any] = OrientationOutput,
        events: RoundEvents | None,
    ) -> None:
        skills_mw = build_skills_middleware([SHARED_SKILLS_DIR])
        prepended = [mw for mw in (skills_mw,) if mw is not None]
        combined: list[Any] | None = [*prepended, *(middleware or [])]
        if not combined:
            combined = None

        super().__init__(
            events=events,
            model=model,
            thread_id=thread_id,
            workspace_dir=workspace_dir,
            system_prompt=ORIENTATION_SYSTEM_PROMPT,
            middleware=combined,
            response_format=ProviderStrategy(response_format, strict=True),
            durable=durable,
            in_memory=False,
        )
