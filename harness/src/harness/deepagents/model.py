"""Model settings and the in-process LangChain chat model used by deepagents.

`resolve_model` is the single place a DeepAgents stage's model and reasoning
effort are chosen from `HARNESS_*` settings.
`build_model` returns the chat model for the provider named by
`HARNESS_LLM_PROVIDER`: `build_openai_model` (a `ChatOpenAI` on the Responses
API of the endpoint named by `HARNESS_LLM_*`) or `build_anthropic_model` (a
`ChatAnthropic` on the Messages API). The caller passes the resolved model
and effort.

The key comes from HARNESS_LLM_API_KEY. In the sandbox it holds the
egress proxy's placeholder, which the proxy swaps for the real key.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from langchain_core.language_models import BaseChatModel

from harness.env_flags import deepagents_model_timeout_seconds, int_env

_PROVIDERS = ("openai", "anthropic")
_DEFAULT_PROVIDER = "openai"

# The reasoning efforts each provider accepts. Claude cannot turn thinking
# off on current models, so there is no `none` or `minimal`. Keep in sync with
# SUPPORTED_REASONING_EFFORTS in control-plane/scripts/up/config.ts and the
# list in deploy/helm/devbox/templates/validate.yaml.
_SUPPORTED_REASONING_EFFORTS: dict[str, frozenset[str]] = {
    "openai": frozenset({"none", "minimal", "low", "medium", "high", "xhigh"}),
    "anthropic": frozenset({"low", "medium", "high", "xhigh", "max"}),
}

# Claude's output cap per response. Large values need streaming, which the
# Anthropic builder always uses.
_ANTHROPIC_MAX_TOKENS = 64000


class ModelStage(StrEnum):
    """A DeepAgents model choice. The value is the `<STAGE>` segment of
    `HARNESS_<STAGE>_MODEL` / `HARNESS_<STAGE>_REASONING_EFFORT`.

    Not the pipeline `harness.stages.Stage`: orientation and plan review are
    model choices inside the planning stage.
    """

    ORIENTATION = "ORIENTATION"
    PLANNING = "PLANNING"
    PLAN_REVIEW = "PLAN_REVIEW"
    IMPLEMENTATION = "IMPLEMENTATION"
    DISTILLATION = "DISTILLATION"
    REVIEW = "REVIEW"
    FOLLOWUP = "FOLLOWUP"


@dataclass(frozen=True)
class ModelChoice:
    model: str
    reasoning_effort: str


_STAGE_EFFORTS: dict[ModelStage, str] = {
    ModelStage.ORIENTATION: "low",
    ModelStage.PLANNING: "medium",
    ModelStage.PLAN_REVIEW: "low",
    ModelStage.IMPLEMENTATION: "medium",
    ModelStage.DISTILLATION: "medium",
    ModelStage.REVIEW: "high",
    ModelStage.FOLLOWUP: "high",
}

_DEFAULT_MODELS = {
    "openai": "gpt-5.6-sol",
    "anthropic": "claude-opus-5-5",
}


def _code_default(stage: ModelStage, provider: str) -> ModelChoice:
    return ModelChoice(_DEFAULT_MODELS[provider], _STAGE_EFFORTS[stage])


# A `/v1` path segment in an Anthropic base URL: the SDK appends
# `/v1/messages` itself, so the request would go to `.../v1/v1/messages`.
_ANTHROPIC_V1_PATH = re.compile(r"/v1(/|$)")

# The httpx timeouts, in seconds, of every phase but the read. The read
# timeout is the streaming inactivity timeout,
# `HARNESS_DEEPAGENTS_MODEL_TIMEOUT_SECONDS`.
_CONNECT_TIMEOUT = 10
_WRITE_TIMEOUT = 60
_POOL_TIMEOUT = 10


def _setting(name: str) -> tuple[str, str] | None:
    """Return `(variable, value)` for setting *name*, or None when unset.

    Values are stripped; empty counts as unset.
    """
    value = os.environ.get(name, "").strip()
    if value:
        return name, value
    return None


def _stage_setting(stage: ModelStage, field: str) -> tuple[str, str] | None:
    return _setting(f"HARNESS_{stage}_{field}") or _setting(f"HARNESS_{field}")


def provider() -> str:
    """The configured LLM provider, `openai` when unset.

    Raises `ValueError` naming the allowed values for anything else.
    """
    setting = _setting("HARNESS_LLM_PROVIDER")
    if setting is None:
        return _DEFAULT_PROVIDER
    variable, value = setting
    if value not in _PROVIDERS:
        raise ValueError(
            f"{variable}={value!r} is not a supported LLM provider; "
            f"expected one of {list(_PROVIDERS)}"
        )
    return value


def resolve_model(stage: ModelStage) -> ModelChoice:
    """Resolve *stage*'s model and reasoning effort.

    Each field independently: the stage setting, then the default setting,
    then the stage's code default for the configured provider. Raises
    `ValueError` naming the variable when the effort is not one the provider
    supports.
    """
    llm_provider = provider()
    default = _code_default(stage, llm_provider)
    supported = _SUPPORTED_REASONING_EFFORTS[llm_provider]
    model = _stage_setting(stage, "MODEL")
    effort = _stage_setting(stage, "REASONING_EFFORT")
    reasoning_effort = default.reasoning_effort
    if effort is not None:
        variable, value = effort
        reasoning_effort = value.lower()
        if reasoning_effort not in supported:
            raise ValueError(
                f"{variable}={value!r} is not a supported reasoning effort "
                f"for the {llm_provider} provider; "
                f"expected one of {sorted(supported)}"
            )
    return ModelChoice(
        model=model[1] if model else default.model,
        reasoning_effort=reasoning_effort,
    )


def default_model_max_retries() -> int:
    """LangChain/OpenAI HTTP retry count for per-call model requests."""
    return max(0, int_env("HARNESS_DEEPAGENTS_MODEL_MAX_RETRIES", default=5))


def _http_timeout() -> Any:
    import httpx

    return httpx.Timeout(
        connect=_CONNECT_TIMEOUT,
        read=deepagents_model_timeout_seconds(),
        write=_WRITE_TIMEOUT,
        pool=_POOL_TIMEOUT,
    )


def build_openai_model(*, model: str, reasoning_effort: str) -> BaseChatModel:
    """Build a `ChatOpenAI` on the Responses API from the harness's LLM settings.

    `model` and `reasoning_effort` are mandatory — the caller resolves its own
    defaults. Raises `RuntimeError` if the base URL or the API key is missing.
    """
    from langchain_openai import ChatOpenAI

    base_url = _setting("HARNESS_LLM_BASE_URL")
    if base_url is None:
        raise RuntimeError(
            "HARNESS_LLM_BASE_URL is required (the OpenAI endpoint's base URL, "
            "for example https://api.openai.com/v1)"
        )

    api_key = _setting("HARNESS_LLM_API_KEY")
    if api_key is None:
        raise RuntimeError("HARNESS_LLM_API_KEY is required (the LLM API key)")

    # `summary: "auto"` asks for a human-readable reasoning summary.
    # `store=False` keeps the endpoint stateless, and
    # `reasoning.encrypted_content` carries the reasoning between turns inline.
    return ChatOpenAI(
        model=model,
        base_url=base_url[1],
        api_key=api_key[1],
        use_responses_api=True,
        reasoning={"summary": "auto", "effort": reasoning_effort.lower()},
        store=False,
        include=["reasoning.encrypted_content"],
        max_retries=default_model_max_retries(),
        timeout=_http_timeout(),
        streaming=True,
        stream_usage=True,
    )


def _chat_anthropic_class() -> type[BaseChatModel]:
    """`ChatAnthropic` with the OpenAI path's per-phase httpx timeouts.

    `ChatAnthropic` only takes a float timeout, which would make the connect
    timeout as long as the streaming read timeout. Its SDK clients take a
    per-phase `httpx.Timeout` through `with_options`, which keeps the same
    connection pool.
    """
    from functools import cached_property

    from langchain_anthropic import ChatAnthropic

    class _ChatAnthropic(ChatAnthropic):
        @cached_property
        def _client(self) -> Any:
            return super()._client.with_options(timeout=_http_timeout())

        @cached_property
        def _async_client(self) -> Any:
            return super()._async_client.with_options(timeout=_http_timeout())

    return _ChatAnthropic


def build_anthropic_model(*, model: str, reasoning_effort: str) -> BaseChatModel:
    """Build a `ChatAnthropic` from the harness's LLM settings.

    `HARNESS_LLM_BASE_URL` is the API root without `/v1`, for example
    `https://api.anthropic.com`: the SDK appends `/v1/messages` itself.
    Thinking is adaptive (current Claude models cannot turn it off) with a
    readable summary, and `reasoning_effort` becomes `output_config.effort`.
    Raises `RuntimeError` if the base URL or the API key is missing or the
    base URL has a `/v1` path segment.
    """
    from urllib.parse import urlsplit

    base_url = _setting("HARNESS_LLM_BASE_URL")
    if base_url is None:
        raise RuntimeError(
            "HARNESS_LLM_BASE_URL is required (the Anthropic API root, "
            "for example https://api.anthropic.com)"
        )
    url = base_url[1].rstrip("/")
    if _ANTHROPIC_V1_PATH.search(urlsplit(url).path):
        raise RuntimeError(
            f"HARNESS_LLM_BASE_URL={base_url[1]!r} must not contain /v1 for the "
            "anthropic provider; the SDK adds /v1/messages itself"
        )

    api_key = _setting("HARNESS_LLM_API_KEY")
    if api_key is None:
        raise RuntimeError("HARNESS_LLM_API_KEY is required (the LLM API key)")

    return _chat_anthropic_class()(
        model=model,
        base_url=url,
        api_key=api_key[1],
        effort=reasoning_effort.lower(),
        thinking={"type": "adaptive", "display": "summarized"},
        max_tokens=_ANTHROPIC_MAX_TOKENS,
        max_retries=default_model_max_retries(),
        streaming=True,
        stream_usage=True,
    )


def build_model(*, model: str, reasoning_effort: str) -> BaseChatModel:
    """Build the chat model for the configured `HARNESS_LLM_PROVIDER`."""
    if provider() == "anthropic":
        return build_anthropic_model(model=model, reasoning_effort=reasoning_effort)
    return build_openai_model(model=model, reasoning_effort=reasoning_effort)
