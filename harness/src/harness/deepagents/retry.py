"""Shared retry utilities for DeepAgents whole-agent runs."""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from random import uniform
from typing import Any

from harness.env_flags import int_env

# Provider rejections that arrive *inside* an SSE stream. A 429 on the initial
# request raises ``RateLimitError``; once a model is streaming, providers can
# deliver a rejection as an SSE ``error`` event and the SDK raises a bare
# ``APIError`` (no HTTP status), for example:
#   ``APIError: Requests have exceeded the provider rate limit.``
#   ``APIError: The server had an error processing your request.``
# Both forms are transient and should be retried.
#
# The Responses API can also deliver a rejection as a top-level
# ``{"type": "error", ...}`` event with no ``error`` wrapper. The SDK raises
# nothing for that shape; langchain_openai drops the event and langchain_core
# ends the stream with ``ValueError("No generations found in stream.")``.
# Same transient cause, so that exact error is classified alongside.
_RATE_LIMIT_CODES = frozenset({
    "429",
    "rate_limit",
    "rate_limit_exceeded",
    "too_many_requests",
})
_RATE_LIMIT_MESSAGE = re.compile(r"rate[ _-]?limit|too many requests", re.IGNORECASE)
_STREAM_SERVER_ERROR_CODES = frozenset({
    "500",
    "502",
    "503",
    "504",
    "internal_error",
    "server_error",
    "service_unavailable",
})
_STREAM_SERVER_ERROR_MESSAGE = re.compile(
    r"server had an error processing your request"
    r"|error occurred during streaming"
    r"|internal server error"
    r"|service (?:is )?(?:temporarily )?unavailable"
    r"|(?:currently )?overloaded",
    re.IGNORECASE,
)
_EMPTY_STREAM_MESSAGE = re.compile(
    r"no generations? (?:found in stream|chunks were returned)", re.IGNORECASE
)


def default_agent_max_retries() -> int:
    """Whole-agent-run retry count for transient DeepAgents failures."""
    return max(0, int_env("HARNESS_DEEPAGENTS_MAX_RETRIES", default=3))


def is_structured_output_validation_error(exc: BaseException) -> bool:
    """Return whether *exc* represents a provider/LangChain parse failure."""
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


def _error_code(exc: BaseException) -> str:
    return str(getattr(exc, "code", None) or "").strip().lower()


# Anthropic SSE ``error`` event types worth a retry. The SDK raises them as a
# plain ``APIStatusError`` carrying the stream's 200 status, so only the body's
# ``error.type`` tells them apart from a real client error.
_ANTHROPIC_STREAM_RATE_LIMIT_TYPES = frozenset({"rate_limit_error"})
_ANTHROPIC_STREAM_TRANSIENT_TYPES = frozenset({
    "rate_limit_error",
    "overloaded_error",
    "api_error",
})


def _anthropic_stream_error_type(exc: BaseException) -> str | None:
    """The ``error.type`` of an Anthropic error delivered mid-stream, else None."""
    try:
        from anthropic import APIStatusError
    except Exception:
        return None
    if type(exc) is not APIStatusError or getattr(exc, "status_code", None) != 200:
        return None
    body = getattr(exc, "body", None)
    error = body.get("error") if isinstance(body, dict) else None
    kind = error.get("type") if isinstance(error, dict) else None
    return kind if isinstance(kind, str) else None


def _is_anthropic_rate_limit(exc: BaseException) -> bool:
    try:
        from anthropic import RateLimitError
    except Exception:
        return False
    if isinstance(exc, RateLimitError):
        return True
    return _anthropic_stream_error_type(exc) in _ANTHROPIC_STREAM_RATE_LIMIT_TYPES


def _is_transient_anthropic_exception(exc: BaseException) -> bool:
    try:
        from anthropic import (
            APIConnectionError,
            APITimeoutError,
            InternalServerError,
            OverloadedError,
            RateLimitError,
        )
    except Exception:
        return False
    if isinstance(
        exc,
        (
            APIConnectionError,
            APITimeoutError,
            InternalServerError,
            OverloadedError,
            RateLimitError,
        ),
    ):
        return True
    return _anthropic_stream_error_type(exc) in _ANTHROPIC_STREAM_TRANSIENT_TYPES


def is_rate_limit_exception(exc: BaseException) -> bool:
    """Return whether *exc* is a provider rate-limit rejection.

    Covers both the HTTP form (``RateLimitError``, status 429) and the
    stream-delivered form (bare ``APIError`` carrying a rate-limit code or
    message, or an Anthropic ``rate_limit_error`` event). Rate limits get a
    longer, floor-bounded backoff than other transient failures because the
    token bucket refills per minute.
    """
    if _is_anthropic_rate_limit(exc):
        return True
    try:
        from openai import APIError, APIStatusError, RateLimitError
    except Exception:
        return False
    if isinstance(exc, RateLimitError):
        return True
    if not isinstance(exc, APIError):
        return False
    if isinstance(exc, APIStatusError):
        return getattr(exc, "status_code", None) == 429
    if _error_code(exc) in _RATE_LIMIT_CODES:
        return True
    return bool(_RATE_LIMIT_MESSAGE.search(str(exc)))


def is_stream_server_error(exc: BaseException) -> bool:
    """Return whether *exc* is a provider 5xx delivered mid-stream.

    Only bare ``APIError`` instances qualify: an ``APIStatusError`` carries a
    real status and is classified by ``is_transient_model_exception``; a
    connection failure is ``APIConnectionError``. Context-overflow errors are
    also ``APIError`` subclasses but match neither code nor message.
    """
    try:
        from openai import APIConnectionError, APIError, APIStatusError
    except Exception:
        return False
    if not isinstance(exc, APIError) or isinstance(
        exc, (APIStatusError, APIConnectionError)
    ):
        return False
    if _error_code(exc) in _STREAM_SERVER_ERROR_CODES:
        return True
    return bool(_STREAM_SERVER_ERROR_MESSAGE.search(str(exc)))


def is_empty_stream_error(exc: BaseException) -> bool:
    """Return whether *exc* is langchain's "the stream produced nothing" error.

    Exact ``ValueError`` only (subclasses such as pydantic's are real bugs),
    matched on langchain_core's two message forms. Raised when the provider
    ends a stream without content, e.g. a Responses-API ``error`` event the
    SDK never turned into an ``APIError``.
    """
    return type(exc) is ValueError and bool(_EMPTY_STREAM_MESSAGE.search(str(exc)))


def is_transient_model_exception(exc: BaseException) -> bool:
    """Classify retryable OpenAI/Anthropic/LangChain failures for whole-agent
    retries."""
    if is_structured_output_validation_error(exc):
        return True
    if is_rate_limit_exception(exc) or is_stream_server_error(exc):
        return True
    if is_empty_stream_error(exc):
        return True
    if _is_transient_anthropic_exception(exc):
        return True

    with suppress(Exception):
        import httpx

        if isinstance(exc, httpx.TransportError):
            return True

    try:
        from openai import (
            APIConnectionError,
            APITimeoutError,
            InternalServerError,
            RateLimitError,
        )
    except Exception:
        return False

    if isinstance(exc, (APIConnectionError, APITimeoutError, RateLimitError)):
        return True
    if isinstance(exc, InternalServerError):
        status_code = getattr(exc, "status_code", None)
        return status_code is None or int(status_code) >= 500
    return False


def retry_backoff_base_seconds() -> float:
    """Initial DeepAgents whole-run retry backoff in seconds."""
    return max(
        1,
        int_env("HARNESS_DEEPAGENTS_RETRY_BASE_SECONDS", default=10),
    )


def retry_backoff_max_seconds() -> float:
    """Maximum DeepAgents whole-run retry backoff in seconds."""
    base = retry_backoff_base_seconds()
    configured = int_env("HARNESS_DEEPAGENTS_RETRY_MAX_SECONDS", default=300)
    return max(base, configured)


def rate_limit_min_backoff_seconds() -> float:
    """Floor for the retry sleep after a rate-limit rejection, in seconds."""
    return max(1, int_env("HARNESS_DEEPAGENTS_RATE_LIMIT_MIN_SECONDS", default=30))


def retry_sleep_seconds(attempt: int, *, rate_limited: bool = False) -> float:
    """Exponential backoff with bounded jitter for a 1-indexed retry attempt.

    ``rate_limited`` raises the sleep to at least the rate-limit floor and
    jitters across a full floor window, so parallel workers that were
    rejected together do not retry in lockstep against a per-minute bucket.
    The cap bounds the deterministic part only; the jitter rides on top of
    it, otherwise every worker at the cap would wake in the same second.
    """
    cap = retry_backoff_max_seconds()
    base = min(cap, retry_backoff_base_seconds() * (2 ** max(0, attempt - 1)))
    if rate_limited:
        floor = rate_limit_min_backoff_seconds()
        return min(cap, max(base, floor)) + uniform(0.0, floor)
    return min(cap, base + uniform(0.0, min(1.0, base * 0.25)))


def run_model_with_retries[T](
    operation: Callable[[], T],
    *,
    max_retries: int,
    label: str,
) -> T:
    """Run a direct model operation with shared transient-error retry semantics."""
    for attempt in range(max_retries + 1):
        try:
            return operation()
        except Exception as exc:
            if not is_transient_model_exception(exc) or attempt >= max_retries:
                raise
            rate_limited = is_rate_limit_exception(exc)
            sleep_for = retry_sleep_seconds(attempt + 1, rate_limited=rate_limited)
            kind = "rate limit" if rate_limited else "transient model error"
            print(
                f"warning: {kind} in {label}; "
                f"retrying attempt {attempt + 2}/{max_retries + 1} "
                f"after {sleep_for:.1f}s: {type(exc).__name__}: {exc}"
            )
            time.sleep(sleep_for)

    raise RuntimeError("unreachable DeepAgents retry state")


@dataclass
class AttemptState:
    """Per-attempt bookkeeping shared between the retry loop and its caller.

    The caller's attempt body calls ``begin_turn`` right before the model turn
    it wants measured (after any repair), so only that turn counts as progress.
    ``resume_current_turn`` persists across attempts: it turns True once an
    attempt made checkpoint progress.
    """

    agent: Any
    resume_current_turn: bool = False
    attempted_turn: bool = False
    before_marker: int | None = None

    def begin_turn(self) -> None:
        self.before_marker = self.agent.progress_marker
        self.attempted_turn = True


def run_with_retry_policy[T](
    build_agent: Callable[[], Any],
    attempt_body: Callable[[AttemptState], T],
    *,
    label: str,
    max_retries: int | None = None,
    close_agent: bool = True,
) -> T:
    """The transient-retry loop shared by every checkpointed worker runner.

    Each attempt builds an agent and runs ``attempt_body(state)``, which must
    call ``state.begin_turn()`` before the turn to measure. Checkpoint progress
    during that turn resets the consecutive-failure budget; a hard cap on total
    attempts bounds the loop regardless; backoff grows with total attempts.
    The agent is closed after every attempt unless ``close_agent`` is False.
    """
    if max_retries is None:
        max_retries = default_agent_max_retries()
    hard_cap = max_retries * 3 + 1
    consecutive_failures = 0
    attempt = 1
    resume_current_turn = False
    while True:
        agent: Any = None
        state: AttemptState | None = None
        try:
            agent = build_agent()
            state = AttemptState(agent=agent, resume_current_turn=resume_current_turn)
            return attempt_body(state)
        except Exception as exc:
            after_marker = agent.progress_marker if agent is not None else None
            if not is_transient_model_exception(exc):
                raise
            made_progress = (
                state is not None
                and state.attempted_turn
                and after_marker is not None
                and after_marker != state.before_marker
            )
            if made_progress:
                consecutive_failures = 0
                resume_current_turn = True
            else:
                consecutive_failures += 1
            if consecutive_failures > max_retries or attempt >= hard_cap:
                raise
            rate_limited = is_rate_limit_exception(exc)
            sleep_for = retry_sleep_seconds(
                min(attempt, max(1, max_retries)), rate_limited=rate_limited
            )
            progress_note = " after checkpoint progress" if made_progress else ""
            kind = "rate limit" if rate_limited else "transient model error"
            print(
                f"warning: {kind} in DeepAgents worker "
                f"{label}; retrying after attempt {attempt}/{hard_cap}{progress_note}; "
                f"consecutive no-progress failures "
                f"{consecutive_failures}/{max_retries}; "
                f"sleeping {sleep_for:.1f}s: {type(exc).__name__}: {exc}"
            )
            attempt += 1
            time.sleep(sleep_for)
        finally:
            if agent is not None and close_agent:
                agent.close()


def run_agent_with_retries(
    build_agent: Callable[[], Any],
    brief: str,
    *,
    label: str,
    resume_prior_state: bool,
    max_retries: int | None = None,
    close_agent: bool = True,
) -> Any:
    """Run one checkpointed DeepAgents worker turn under the transient-retry policy.

    By default, ``build_agent`` constructs a fresh ``DeepAgentSession`` per
    attempt and the session is closed after each. ``close_agent=False`` supports
    caller-owned, multi-turn sessions; in that mode the factory may return the
    same session and the caller must close it. A retry after checkpoint progress
    resumes the interrupted turn instead of duplicating its brief. A failure
    without checkpoint progress re-sends the brief because there is no current
    turn to resume.

    ``resume_prior_state`` decides what prior thread state on the *first*
    attempt means:

    - ``True`` (implementation, review lens and fix workers): a durable
      thread that survived a daemon restart — resume it, never send the brief.
    - ``False`` (the review merge agent): a non-durable session, so prior
      state cannot exist. Should a durable caller pass it, prior state is
      unexpected — repair any dangling tool-call tail, then send the brief
      anyway.

    Progress is measured by checkpoint advance and resets the
    consecutive-failure budget. LangGraph checkpoints the input message before
    the model runs, so on a durable thread every failed attempt can look like
    progress — a hard cap on total attempts bounds the loop regardless, and
    backoff grows with total attempts (capped at ``max_retries`` doublings)
    rather than the resettable counter. A non-durable session has no
    checkpoint to resume, so its brief is re-sent on every attempt — correct
    for the stateless merge agent.
    """

    def attempt_body(state: AttemptState) -> Any:
        agent = state.agent
        if agent.has_prior_state and (resume_prior_state or state.resume_current_turn):
            state.begin_turn()
            return agent.resume_from_restart()
        if agent.has_prior_state:
            agent.repair_dangling_tool_calls()
            # Repair may checkpoint the old turn. Do not mistake that for
            # progress on the new brief if the next model call fails early.
        state.begin_turn()
        return agent.run(brief)

    return run_with_retry_policy(
        build_agent,
        attempt_body,
        label=label,
        max_retries=max_retries,
        close_agent=close_agent,
    )
