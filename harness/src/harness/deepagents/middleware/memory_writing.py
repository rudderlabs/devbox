"""In-process DeepAgents memory-writing tool and middleware."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.tools import StructuredTool, ToolException
from pydantic import Field, create_model

from harness.deepagents.middleware.arguments import (
    NonBlankStr,
    format_validation_error,
)
from harness.deepagents.middleware.system_prompt import SystemPromptMiddleware
from harness.events import RoundEvents
from harness.memory import (
    MemoryStore,
    memory_heartbeat_body,
    normalize_component_subpath,
)

MemoryType = Literal[
    "note",
    "decision",
    "feedback",
    "question",
    "mistake",
    "pattern",
    "concern",
]

MEMORY_INSTRUCTIONS = """\
<memory_writing>
Record durable observations with `record_memory`: facts, decisions, feedback,
open questions, mistakes, patterns and concerns that should outlive this
conversation.

Each entry must stand on its own. Memory is distilled later without reading
source code, so name the file path, symbol and behavior the entry is about
instead of pointing elsewhere ("see foo.py").

Don't record cross-repository observations, step-by-step status, or debugging
noise that produced no corrected understanding.
</memory_writing>
"""

_TYPE_DESCRIPTION = (
    "What the observation is. note: a durable fact about the repository (a "
    "constraint, naming rule, structural quirk or invariant). decision: a choice "
    "made in this run and the alternatives; give the rationale in `context`. "
    "feedback: a human directive or correction; give the reviewer's reasoning in "
    "`context`. question: an unresolved question that blocked or slowed progress. "
    "mistake: a wrong assumption, the symptom it caused, and the correct model. "
    "pattern: a reusable idiom that appears in several places. concern: a risk, "
    "debt item or security issue worth attention."
)


@dataclass(frozen=True)
class RepoScope:
    """A repository the agent may write memory for, with its component subpaths."""

    name: str
    component_subpaths: tuple[str, ...] = ()


def _normalize_component_subpaths(component_subpaths: Sequence[str]) -> tuple[str, ...]:
    normalized: list[str] = []
    for component in component_subpaths:
        value = normalize_component_subpath(component)
        if value is not None:
            normalized.append(value)
    return tuple(dict.fromkeys(normalized))


class MemoryWritingMiddleware(SystemPromptMiddleware):
    """Registers ``record_memory`` and optionally injects memory-writing guidance."""

    def __init__(
        self,
        *,
        store: MemoryStore,
        stage: str,
        repos: Sequence[RepoScope],
        events: RoundEvents | None = None,
        system_prompt: str | None = MEMORY_INSTRUCTIONS,
    ) -> None:
        if not repos:
            raise ValueError("MemoryWritingMiddleware requires at least one repo")
        self.store = store
        self.stage = stage
        self.repos = list(repos)
        self.events = events
        self.system_prompt = system_prompt
        self._components: dict[str, tuple[str, ...]] = {
            repo.name: _normalize_component_subpaths(repo.component_subpaths)
            for repo in self.repos
        }
        self.tools = [self._build_tool()]

    def _build_tool(self) -> StructuredTool:
        names = tuple(repo.name for repo in self.repos)
        listing = "; ".join(
            f"{repo.name}: {', '.join(subpaths)}"
            for repo in self.repos
            if (subpaths := self._components[repo.name])
        )
        component_description = (
            "Component subpath the observation is specific to. Configured: "
            f"{listing or 'none'}. A value not listed is recorded repo-wide."
        )
        fields: dict[str, Any] = {
            "type": (MemoryType, Field(description=_TYPE_DESCRIPTION)),
            "text": (
                NonBlankStr,
                Field(
                    description=(
                        "Self-contained memory text: the path, symbol and "
                        "behavior it is about. Must not be blank."
                    )
                ),
            ),
            "context": (
                str | None,
                Field(
                    default=None,
                    description=(
                        "Rationale. Used only for decision and feedback; "
                        "ignored otherwise."
                    ),
                ),
            ),
            "component": (
                str | None,
                Field(default=None, description=component_description),
            ),
        }
        if len(names) > 1:
            fields["repo"] = (
                Literal[names],  # type: ignore[valid-type]
                Field(description="Repository the observation belongs to."),
            )
        model = create_model("RecordMemoryArgs", **fields)
        return StructuredTool.from_function(
            func=self._record,
            name="record_memory",
            description="Record one durable memory entry for a repository.",
            args_schema=model,
            handle_tool_error=True,
            handle_validation_error=format_validation_error,
        )

    def _record(
        self,
        type: str,
        text: str,
        context: str | None = None,
        component: str | None = None,
        repo: str | None = None,
    ) -> str:
        repo_name = repo if repo is not None else self.repos[0].name

        matched: str | None = None
        if component is not None:
            normalized = normalize_component_subpath(component)
            if normalized is not None and normalized in self._components[repo_name]:
                matched = normalized

        # ``context`` is only meaningful for decision/feedback entries; the
        # store rejects it otherwise. Drop it silently for other types.
        effective_context = context if type in ("decision", "feedback") else None
        try:
            path = self.store.append(
                entry_type=type,
                stage=self.stage,
                repo=repo_name,
                text=text,
                context=effective_context,
                component=matched,
            )
        except ValueError as exc:
            raise ToolException(str(exc)) from exc
        except OSError as exc:
            raise ToolException(f"{exc.__class__.__name__}: {exc}") from exc

        if self.events is not None:
            self.events.thought(
                memory_heartbeat_body(
                    entry_type=type,
                    stage=self.stage,
                    repo=repo_name,
                    text=text,
                    context=effective_context,
                    component=matched,
                ),
            )

        scope = f"component {matched}" if matched else "repo-wide"
        return f"memory recorded ({scope}): {path}"
