"""Base for tool middlewares that add their own text to the system prompt.

A tool middleware registers its tool and adds that tool's section to the
system prompt. Tool mechanics live in the tool schema; this text says when to
use the tool and how to write what goes through it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from deepagents.middleware._utils import append_to_system_message
from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse

EMIT_VOICE_RULES = """\
- Write in the first person ("I", "me").
- Talk about the work, not how it is run: never name the harness, the daemon,
  the agent, the sandbox or "this environment", and never mention
  sessions, rounds, stages or protocol.
- Never mention internal files: `plan.json`, `implementation.json`, the
  `.harness/` directory, memory or knowledge paths, `events.jsonl`.
"""


class SystemPromptMiddleware(AgentMiddleware):
    """Adds ``system_prompt`` to the system message on every model call.

    ``system_prompt=None`` adds nothing and passes the request through.
    """

    system_prompt: str | None = None

    def _with_system_prompt(self, request: ModelRequest) -> ModelRequest:
        if self.system_prompt is None:
            return request
        return request.override(
            system_message=append_to_system_message(
                request.system_message, self.system_prompt
            )
        )

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        return handler(self._with_system_prompt(request))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> ModelResponse:
        return await handler(self._with_system_prompt(request))
