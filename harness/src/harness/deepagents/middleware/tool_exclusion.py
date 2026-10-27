"""Hide named tools from the model and refuse any call to them.

``create_deep_agent`` always installs some tools (the ``task`` subagent tool).
An agent that must not have one lists it here: the tool is dropped from every
model request, and a call to it anyway (a hallucinated name, a replayed
history) comes back as an error message instead of running.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from deepagents.middleware.subagents import TASK_SYSTEM_PROMPT
from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.messages import SystemMessage, ToolMessage
from langgraph.types import Command

_TASK_HEADING = TASK_SYSTEM_PROMPT.splitlines()[0]


def _without_task_section(message: SystemMessage | None) -> SystemMessage | None:
    """Drop the text blocks DeepAgents' SubAgentMiddleware added for ``task``.

    The middleware appends its instructions as their own text block; with the
    tool hidden they would tell the model to use a tool it does not have.
    """
    if message is None:
        return None
    blocks = message.content_blocks
    kept = [
        b
        for b in blocks
        if not (
            b.get("type") == "text"
            and str(b.get("text", "")).lstrip().startswith(_TASK_HEADING)
        )
    ]
    if len(kept) == len(blocks):
        return message
    return SystemMessage(content_blocks=kept)


def _tool_name(tool: Any) -> str | None:
    """The name of a ``BaseTool`` or of a dict-form tool."""
    name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
    return name if isinstance(name, str) else None


class ToolExclusionMiddleware(AgentMiddleware[Any, Any, Any]):
    """Removes ``excluded`` tools from model requests and rejects their calls."""

    def __init__(self, *, excluded: frozenset[str]) -> None:
        self.excluded = excluded

    def _without_excluded(self, request: ModelRequest[Any]) -> ModelRequest[Any]:
        overrides: dict[str, Any] = {
            "tools": [t for t in request.tools if _tool_name(t) not in self.excluded]
        }
        if "task" in self.excluded:
            overrides["system_message"] = _without_task_section(request.system_message)
        return request.override(**overrides)

    def _refusal(self, request: ToolCallRequest) -> ToolMessage | None:
        name = request.tool_call.get("name")
        if name not in self.excluded:
            return None
        return ToolMessage(
            content=f"{name} is not available to this agent.",
            name=name,
            tool_call_id=request.tool_call["id"],
            status="error",
        )

    def wrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        return handler(self._without_excluded(request))

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        return await handler(self._without_excluded(request))

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        return self._refusal(request) or handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        return self._refusal(request) or await handler(request)
