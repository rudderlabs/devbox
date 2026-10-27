"""ImplementationAgent — a single-repo DeepAgentSession preset.

A minimal preset: it wires the invariant implementation discipline
(``IMPLEMENTATION_SYSTEM_PROMPT``) into a ``DeepAgentSession`` rooted at one
repository. The brief is opaque — the caller assembles it (a
``<repo>``/``<task>``/``<context>`` convention is recommended but not enforced).
Structured output is caller-supplied via ``response_format``; the
implementation stage passes ``RepoImplementationOutput``.

The repository's own instructions (``AGENTS.md``/``CLAUDE.md``), curated
knowledge from the configured directory, skills, and the harness memory-writing tool come from
the shared repo middleware stack (``middleware.repo.build_repo_middleware``);
``knowledge_subpaths`` layers explicit monorepo service scopes (e.g.
``["acme-api"]``) on top of the repository root.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from langchain_core.language_models import BaseChatModel

from harness.deepagents.dense_turns import DENSE_TURNS_EDIT_PROMPT
from harness.deepagents.middleware.repo import build_repo_middleware
from harness.deepagents.session import DeepAgentSession
from harness.events import RoundEvents

AUTONOMOUS_DECISIONS_PROMPT = """\
<autonomous_decision_making>
This run is non-interactive; there is no human to ask questions to. Resolve
reasonable implementation ambiguity independently using `<repository_knowledge>`,
surrounding code and prior art, and the task or plan. Deciding and continuing is
the default.

For each resolved ambiguity, call `record_memory` with `type="decision"`. Include
the ambiguity, the chosen approach and rationale, and the alternatives considered.
Then continue implementation without avoidable TODOs, pauses, or requests for
confirmation.

Use `type="question"` only for a genuinely unresolvable blocker, such as missing
external credentials, contradictory requirements, or an architectural choice
with no available signal. Omit `context` for question entries.
</autonomous_decision_making>
"""

IMPLEMENTATION_SYSTEM_PROMPT = (
    """\
You are an implementation agent working inside a single repository.

The repository is your current working directory; you have shell and filesystem
access scoped to it. Your task and its context are provided in the user message,
which follows a <repo>/<task>/<context> convention:
  - <repo> names the repository you are working in.
  - <task> is the concrete change to make.
  - <context> holds supporting material (a plan, a review comment, CI logs).

Implement the task: make the necessary code changes, and validate them by
running the repository's relevant tests, build, and/or linters. Fix what you
break.

Treat the <repository_knowledge> context as authoritative: follow its conventions,
toolchain, and test commands. When it conflicts with the task in the user message,
prefer the explicit task and verify against the actual code.

Before writing the final structured output:
- Check for a GitHub PR template at `.github/PULL_REQUEST_TEMPLATE.md`,
  `.github/pull_request_template.md`, or `docs/pull_request_template.md` (in that
  order) and use its structure for `pr_body`.
- Use conventional-commit style for `commit_message` by default unless repo-local
  instructions clearly require another format.
- If a quality gate was already failing on the baseline before the change, do not
  try to fix that unrelated failure; surface it in `pr_body` under
  `## ⚠️ Known Issues`.
- Do NOT push branches, create pull requests, or perform any publish action.
- Do NOT start the repository's own `docker compose` stack.

When you are done, report what you changed (the files and the essence of the
change) and how you validated it (the commands you ran and their outcome).
Your structured output must also include:
- `exercise_hint`: how the change is observably exercised end-to-end for the
  reviewer to drive, in one or two lines. Use an HTTP route and
  element/behavior, a CLI invocation, or `n/a — no runtime surface` for pure
  library, docs, or config changes.
- `feature_baseline`: what pre-existing behavior or layout must still work after
  this change, for example `The DestinationCard component should still render at
  full width inside its grid cell, with the action buttons visible below the
  description area.` Write `n/a — net-new feature` if nothing pre-exists.
- `design_notes`: your account of intent for whoever triages review findings
  on this change without your session context — the design choices you made
  and why, alternatives you tried or rejected, and anything you deliberately
  left out. Three to eight lines; concrete, not a restatement of the diff.
"""
    + "\n"
    + AUTONOMOUS_DECISIONS_PROMPT
    + DENSE_TURNS_EDIT_PROMPT
)


class ImplementationAgent(DeepAgentSession[Any]):
    """A single-repo implementation preset for ``DeepAgentSession``."""

    def __init__(
        self,
        *,
        model: BaseChatModel,
        repo_path: Path,
        thread_id: str,
        durable: bool = True,
        middleware: Sequence[Any] | None = None,
        knowledge_subpaths: Sequence[str] = (),
        response_format: type[Any] | None = None,
        repo: str | None = None,
        stage: str = "implementation",
        events: RoundEvents | None,
    ) -> None:
        repo_name = repo or repo_path.name
        super().__init__(
            events=events,
            model=model,
            thread_id=thread_id,
            workspace_dir=repo_path,
            system_prompt=IMPLEMENTATION_SYSTEM_PROMPT,
            middleware=build_repo_middleware(
                repo_path=repo_path,
                repo=repo_name,
                knowledge_subpaths=knowledge_subpaths,
                memory_stage=stage,
                events=events,
                extra=middleware,
            ),
            response_format=response_format,
            durable=durable,
            emit_identifier=f"{repo_name}/{stage}",
        )
