"""LoggingMiddleware — logs a deepagents session's inner loop.

DeepAgentSession installs it automatically unless the caller supplies an instance.
By default it emits INFO records on the ``deepagents.middleware.logging`` logger;
callers may bind a different logger for session-scoped sinks. Records cover each
model call (message count, reasoning summary, requested tool calls, token usage,
parsed structured output) and tool call (name, args, result). Never alters behavior: on a handler error it
logs and re-raises, leaving the result/exception unchanged.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import suppress
from typing import Any

from langchain.agents.middleware import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
    ToolCallRequest,
)

log = logging.getLogger("deepagents.middleware.logging")

_LIMIT = 500


def _truncate(value: Any, limit: int = _LIMIT) -> str:
    text = value if isinstance(value, str) else repr(value)
    return text if len(text) <= limit else text[:limit] + f"… (+{len(text) - limit})"


def _reasoning_text(message: Any) -> str:
    """Pull a reasoning summary out of an AIMessage, across content shapes.

    Responses-API messages carry reasoning as typed content blocks, and
    Anthropic messages as `thinking` blocks; chat-API messages have
    plain-string content (no reasoning block). Returns "" when there is no
    reasoning to show.
    """
    content = getattr(message, "content", None)
    if not isinstance(content, list):
        return ""
    out: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") in (
            "reasoning",
            "reasoning_content",
            "thinking",
        ):
            text = (
                block.get("text")
                or block.get("reasoning")
                or block.get("thinking")
                or ""
            )
            summary = block.get("summary")
            if not text and isinstance(summary, list):
                text = " ".join(
                    s.get("text", "") for s in summary if isinstance(s, dict)
                )
            if text:
                out.append(text)
    return " ".join(out)


def _reply_text(message: Any) -> str:
    """The text blocks of an AIMessage, joined; "" when there are none."""
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return " ".join(
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()


def _is_structured_output_validation_error(exc: BaseException) -> bool:
    candidates: list[type[BaseException]] = []
    with suppress(Exception):
        import openai

        sdk_error = getattr(openai, "StructuredOutputValidationError", None)
        if isinstance(sdk_error, type) and issubclass(sdk_error, BaseException):
            candidates.append(sdk_error)

    with suppress(Exception):
        from langchain.agents.structured_output import (
            StructuredOutputValidationError,
        )

        candidates.append(StructuredOutputValidationError)

    return bool(candidates) and isinstance(exc, tuple(candidates))


def _raw_response_candidate(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    text = getattr(value, "text", None)
    if isinstance(text, str):
        return text
    content = getattr(value, "content", None)
    if isinstance(content, bytes):
        return content.decode("utf-8", errors="replace")
    if content is not None:
        return content
    return value


def _structured_output_raw_response(exc: BaseException) -> Any | None:
    ai_message = getattr(exc, "ai_message", None)
    if ai_message is not None:
        content = getattr(ai_message, "content", None)
        if content is not None:
            return content

    for attr in ("response", "body", "raw_response", "raw-response"):
        value = getattr(exc, attr, None)
        if value is not None:
            return _raw_response_candidate(value)

    state = getattr(exc, "__dict__", {})
    if isinstance(state, dict):
        for key in ("response", "body", "raw_response", "raw-response"):
            value = state.get(key)
            if value is not None:
                return _raw_response_candidate(value)
    return None


class LoggingMiddleware(AgentMiddleware):
    """Logs model calls, tool calls, and errors for an agent session."""

    def __init__(self, logger: logging.Logger | None = None) -> None:
        self.logger = logger if logger is not None else log

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        self.logger.info("→ model call (%d messages in context)", len(request.messages))
        try:
            response = handler(request)
        except Exception as exc:
            self.logger.error("✗ model error: %s: %s", type(exc).__name__, exc)
            if _is_structured_output_validation_error(exc):
                raw_response = _structured_output_raw_response(exc)
                if raw_response is not None:
                    self.logger.error(
                        "✗ structured output raw response: %s",
                        _truncate(raw_response),
                    )
            raise
        for message in response.result:
            reasoning = _reasoning_text(message)
            if reasoning:
                self.logger.info("  reasoning: %s", _truncate(reasoning))
            usage = getattr(message, "usage_metadata", None)
            if usage:
                self.logger.info("  usage: %s", usage)
            metadata = getattr(message, "response_metadata", None) or {}
            if metadata.get("stop_reason") == "refusal":
                # langchain-anthropic does not copy the API's `stop_details`
                # into `response_metadata`, so the reply text is the only
                # explanation there is.
                self.logger.warning(
                    "  ✗ model refused: %s",
                    _truncate(_reply_text(message) or "(no text)"),
                )
            for call in getattr(message, "tool_calls", None) or []:
                self.logger.info(
                    "  ↳ requests tool %s args=%s",
                    call.get("name"),
                    _truncate(call.get("args")),
                )
        structured = getattr(response, "structured_response", None)
        if structured is not None:
            dump_json = getattr(structured, "model_dump_json", None)
            rendered = dump_json() if callable(dump_json) else structured
            self.logger.info("  structured output: %s", _truncate(rendered, 2000))
        return response

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Any],
    ) -> Any:
        name = request.tool_call.get("name")
        self.logger.info(
            "→ tool %s(%s)", name, _truncate(request.tool_call.get("args"), 300)
        )
        try:
            result = handler(request)
        except Exception as exc:
            self.logger.error("✗ tool %s error: %s: %s", name, type(exc).__name__, exc)
            raise
        content = getattr(result, "content", result)
        self.logger.info("← tool %s result: %s", name, _truncate(content, 300))
        return result
