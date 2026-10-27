"""``reply`` tool middleware: post the final answer to an item of the round."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.tools import BaseTool, StructuredTool, ToolException
from pydantic import BaseModel, Field, create_model

from harness.deepagents.middleware.arguments import (
    NonBlankStr,
    format_validation_error,
)
from harness.deepagents.middleware.system_prompt import (
    EMIT_VOICE_RULES,
    SystemPromptMiddleware,
)
from harness.events import RoundEvents

REPLY_INSTRUCTIONS = f"""\
<replies>
Answer each item with `reply` exactly once.

A reply is your final word on an item, not a progress update. Send it only
after your change is committed and pushed, or after you concluded that no
change is needed. Never reply about work you are about to do.

The user sees only what you pushed. For a code change, link the commit you
pushed (its GitHub `.../commit/<sha>` URL), not the pull request. If you
opened a new pull request, link that pull request instead.

If you could not push or open the pull request, say so and say why: a rejected
push, an authentication error, an unresolved conflict, a missing repository.
Never present unfinished or local-only work as done.

The user reads your reply as one bot's answer on their comment or review:
{EMIT_VOICE_RULES}</replies>
"""


@dataclass(frozen=True)
class ReplyTarget:
    id: str
    description: str


class ReplyMiddleware(SystemPromptMiddleware):
    """Registers ``reply``: post the final answer to one of the round's items."""

    def __init__(
        self,
        *,
        events: RoundEvents,
        targets: Sequence[ReplyTarget],
        system_prompt: str | None = REPLY_INSTRUCTIONS,
    ) -> None:
        if not targets:
            raise ValueError("ReplyMiddleware requires at least one target")
        self.events = events
        self.targets = tuple(targets)
        self.system_prompt = system_prompt
        self.tools = [self._build_tool()]

    def _args_model(self) -> type[BaseModel]:
        fields: dict[str, Any] = {
            "body": (
                NonBlankStr,
                Field(description="The reply text, in Markdown. Must not be blank."),
            ),
        }
        if len(self.targets) > 1:
            listed = "; ".join(f"{t.id}: {t.description}" for t in self.targets)
            fields["target"] = (
                Literal[tuple(t.id for t in self.targets)],
                Field(description=f"The item this reply answers. {listed}."),
            )
        return create_model("ReplyArgs", **fields)

    def _build_tool(self) -> BaseTool:
        return StructuredTool.from_function(
            func=self._reply,
            name="reply",
            description=(
                "Post your final reply to one item of this conversation. The user "
                "sees it on the comment or review it answers."
            ),
            args_schema=self._args_model(),
            handle_tool_error=True,
            handle_validation_error=format_validation_error,
        )

    def _reply(self, **kwargs: Any) -> str:
        body: str = kwargs["body"]
        target: str = kwargs.get("target") or self.targets[0].id

        try:
            seq = self.events.publish("agent_response", target_id=target, body=body)
        except Exception as exc:
            raise ToolException(
                f"reply not posted: {type(exc).__name__}: {exc}"
            ) from exc

        return f"reply posted to {target} (seq {seq})"
