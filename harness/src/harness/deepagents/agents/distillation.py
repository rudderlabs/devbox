"""DistillationAgent — a workspace-rooted DeepAgentSession preset.

The preset runs the distillation stage in a fresh standalone session. It roots
filesystem access at the harness workspace, injects knowledge from one eligible
repository plus any planned component knowledge subpaths, and leaves the
caller-owned prompt to provide the exact memory and artifact paths for the run.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from langchain_core.language_models import BaseChatModel

from harness.deepagents.middleware.knowledge import build_knowledge_middleware
from harness.deepagents.session import DeepAgentSession
from harness.env_flags import knowledge_dir_relative_path
from harness.events import RoundEvents

DISTILLATION_SYSTEM_PROMPT_TEMPLATE = """\
You are a distillation agent running in a fresh, standalone session.

Your only job is to promote durable, high-signal observations from staged
harness memory into repository knowledge files.

Hard scope boundaries:
- Read only the staged memory files listed in the harness context under
  `.harness/memory/<repo>/`.
- Read only existing repository knowledge files under the eligible repository's
  root or listed component `{knowledge_dir}/*.md` directories. Repository
  knowledge may also be provided in the system context by middleware.
- Never read repository source files, tests, configs, generated artifacts, or
  any files outside the staged memory and `{knowledge_dir}/*.md` knowledge
  files.
- Never run tests, builds, linters, formatters, git commands, verification
  commands, package managers, or any other validation command.
- Do not create or edit source files. For knowledge files, append a new
  `## <task-id> — <short title>` section only when that task has no section in
  that destination file; otherwise merge into the existing `## <task-id>` section
  in place, avoid restating observations already captured there, and do not
  rewrite, remove, or reorder other tasks' knowledge content.
- Touch a knowledge file only when at least one observation is promoted there.
- Choose the destination directory by scope: if an observation is specific to a
  listed component subpath, append to that component's `{knowledge_dir}/*.md`;
  append to the repository-root `{knowledge_dir}/*.md` only for repo-wide
  observations or when no listed component subpath matches.

Eligible destination files are limited to:
- architecture.md
- patterns.md
- conventions.md
- stack.md
- entry-points.md
- concerns.md
- mistakes.md
- feedback.md

For each eligible repository:
1. Process only the memory file names listed for that repository in the harness
   context. If the list is empty, record zero reads and zero promotions for that
   repository.
2. Drop marginal, run-specific, duplicate, or non-self-sufficient memory
   entries.
3. Route memory by type and durable content:
   - `feedback` entries promote to `feedback.md` when they capture high-signal
     human direction, preferences, corrections, or review guidance; extract
     durable code-specific facts into architecture/conventions/patterns/concerns
     when those files are the better long-term home.
   - `mistake` entries, especially CI-fix memory, promote to `mistakes.md`.
   - `concern` entries promote to `concerns.md`.
   - `pattern` entries promote to `patterns.md`.
   - `decision` and `note` entries route by content to
     architecture/conventions/patterns/entry-points/stack.
4. Promote durable observations under headers in the form
   `## <task-id> \N{EM DASH} <short title>` without creating duplicate
   same-task sections. If a destination already has a `## <task-id>` section,
   merge new observations into that existing section in place, avoid restating
   observations already captured there, and leave every other task section
   unchanged.
5. Include `response_summary` only when knowledge was promoted. It must contain
   concise bullet lines for the user summarising what was captured, with each
   bullet prefixed by the destination knowledge type derived from the updated
   filename, for example:
   - `patterns`: Captured ... for `patterns.md`.
   - `feedback`: Captured ... for `feedback.md`.
6. Isolate failures per repository and record an `error` string in that repo
   entry when needed.
"""


def distillation_system_prompt(knowledge_dir: Path) -> str:
    """Return the distillation system prompt for a repo-relative knowledge dir."""
    return DISTILLATION_SYSTEM_PROMPT_TEMPLATE.format(
        knowledge_dir=knowledge_dir.as_posix()
    )


class DistillationAgent(DeepAgentSession[Any]):
    """A workspace-scoped distillation preset for ``DeepAgentSession``."""

    def __init__(
        self,
        *,
        model: BaseChatModel,
        workspace_dir: Path,
        thread_id: str,
        repo_path: Path,
        knowledge_subpaths: Sequence[str] = (),
        durable: bool = False,
        middleware: Sequence[Any] | None = None,
        response_format: type[Any] | None = None,
        events: RoundEvents | None,
    ) -> None:
        # Distillation needs existing repo knowledge injected, but it should not
        # receive implementation skills or source-reading guidance.
        relative_knowledge_dir = knowledge_dir_relative_path()
        scope_dirs = [repo_path, *(repo_path / sub for sub in knowledge_subpaths)]
        knowledge_mw = build_knowledge_middleware(scope_dirs)
        combined: list[Any] | None = [
            *([knowledge_mw] if knowledge_mw is not None else []),
            *(middleware or []),
        ]
        if not combined:
            combined = None

        super().__init__(
            events=events,
            model=model,
            thread_id=thread_id,
            workspace_dir=workspace_dir,
            system_prompt=distillation_system_prompt(relative_knowledge_dir),
            middleware=combined,
            response_format=response_format,
            durable=durable,
        )
