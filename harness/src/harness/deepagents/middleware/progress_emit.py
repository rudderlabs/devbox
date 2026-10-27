"""In-process DeepAgents progress-emitting tool and middleware."""

from __future__ import annotations

from typing import Literal

from langchain_core.tools import BaseTool, tool
from pydantic import BaseModel, Field

from harness.deepagents.middleware.system_prompt import (
    EMIT_VOICE_RULES,
    SystemPromptMiddleware,
)
from harness.events import RoundEvents

ProgressKind = Literal["thought", "action"]

TYPE_BY_KIND: dict[str, str] = {"thought": "agent_thought", "action": "agent_action"}

PROGRESS_INSTRUCTIONS = f"""\
<progress_updates>
Stream brief progress updates to the user with `emit_progress`. The user is
watching live, and long silence looks stuck. Post an update when you switch
focus, finish a meaningful milestone, start a long-running command, or hit a
snag. Skip the obvious: don't narrate every tool call or repeat yourself.

Call `emit_progress` in the same response as your next real tool call, never
as the only tool call of a response.

Stage changes and parallel worker labels are already announced for you.
Don't repeat those announcements, and don't prefix your updates with your own
worker or repository label.

Each update is shown to the user live, as one bot working on their request:
{EMIT_VOICE_RULES}
Keep updates short and free of secrets, credentials and large logs. Posting is
best-effort: if an update can't be posted, keep working.
</progress_updates>
"""


class EmitProgressArgs(BaseModel):
    """Model-visible schema for the bound ``emit_progress`` tool."""

    kind: ProgressKind = Field(
        description=(
            "thought: a short first-person sentence about the work and its "
            "status. action: a short activity label of about three words, such "
            'as "Running tests".'
        )
    )
    body: str = Field(
        description=(
            "Brief progress text to stream to the user. Do not include secrets, "
            "credentials, or large logs."
        )
    )


def _clean_label(label: str | None) -> str | None:
    value = (label or "").strip()
    return value or None


class ProgressEmitMiddleware(SystemPromptMiddleware):
    """Registers ``emit_progress``, posting to the round's target."""

    def __init__(
        self,
        *,
        events: RoundEvents,
        worker_label: str | None = None,
        system_prompt: str | None = PROGRESS_INSTRUCTIONS,
    ) -> None:
        self.events = events
        self.worker_label = _clean_label(worker_label)
        self.system_prompt = system_prompt
        self.tools = [self._build_tool()]

    def _build_tool(self) -> BaseTool:
        events, label = self.events, self.worker_label

        @tool("emit_progress", args_schema=EmitProgressArgs)
        def emit_progress(kind: ProgressKind, body: str) -> str:
            """Post a short progress update the user sees live."""
            event_type = TYPE_BY_KIND[kind]
            fields: dict[str, object] = {}
            text = body
            if label is not None:
                fields["identifier"] = label
                text = f"`{label}` {body}"
            try:
                seq = events.publish(event_type, body=text, **fields)
            except Exception as exc:
                return f"progress not posted: {type(exc).__name__}: {exc}"
            return f"progress emitted ({event_type}): seq {seq}"

        return emit_progress
