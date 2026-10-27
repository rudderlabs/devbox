"""Unit tests for the anthropic LLM provider — no network calls."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import anthropic
import httpx

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.deepagents.model import (
    ModelChoice,
    ModelStage,
    build_model,
    provider,
    resolve_model,
)
from harness.deepagents.retry import (
    is_rate_limit_exception,
    is_transient_model_exception,
)

_ANTHROPIC = {
    "HARNESS_LLM_PROVIDER": "anthropic",
    "HARNESS_LLM_BASE_URL": "https://api.anthropic.com",
    "HARNESS_LLM_API_KEY": "proxy-llm-dummy-token",
}


def _response(status: int) -> httpx.Response:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return httpx.Response(status, request=request)


def _stream_error(kind: str) -> anthropic.APIStatusError:
    """The error the SDK raises for an SSE `error` event on a 200 stream."""
    body = {"type": "error", "error": {"type": kind, "message": kind}}
    return anthropic.APIStatusError(str(body), response=_response(200), body=body)


class TestProvider(unittest.TestCase):
    @patch.dict("os.environ", {}, clear=True)
    def test_default_is_openai(self) -> None:
        self.assertEqual(provider(), "openai")

    @patch.dict("os.environ", {"HARNESS_LLM_PROVIDER": " anthropic "}, clear=True)
    def test_value_is_stripped(self) -> None:
        self.assertEqual(provider(), "anthropic")

    @patch.dict("os.environ", {"HARNESS_LLM_PROVIDER": "Anthropic"}, clear=True)
    def test_value_is_case_sensitive_like_the_config(self) -> None:
        with self.assertRaisesRegex(ValueError, "'Anthropic'"):
            provider()

    @patch.dict("os.environ", {"HARNESS_LLM_PROVIDER": "gemini"}, clear=True)
    def test_unknown_provider_names_the_variable(self) -> None:
        with self.assertRaisesRegex(ValueError, "HARNESS_LLM_PROVIDER"):
            provider()


class TestAnthropicResolution(unittest.TestCase):
    @patch.dict("os.environ", {"HARNESS_LLM_PROVIDER": "anthropic"}, clear=True)
    def test_code_defaults_use_claude_with_stage_efforts(self) -> None:
        self.assertEqual(
            resolve_model(ModelStage.REVIEW), ModelChoice("claude-opus-5-5", "high")
        )
        self.assertEqual(
            resolve_model(ModelStage.ORIENTATION),
            ModelChoice("claude-opus-5-5", "low"),
        )

    @patch.dict(
        "os.environ",
        {"HARNESS_LLM_PROVIDER": "anthropic", "HARNESS_REASONING_EFFORT": "max"},
        clear=True,
    )
    def test_max_effort_is_accepted(self) -> None:
        self.assertEqual(resolve_model(ModelStage.PLANNING).reasoning_effort, "max")

    @patch.dict(
        "os.environ",
        {"HARNESS_LLM_PROVIDER": "anthropic", "HARNESS_REASONING_EFFORT": "minimal"},
        clear=True,
    )
    def test_openai_only_effort_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "HARNESS_REASONING_EFFORT"):
            resolve_model(ModelStage.PLANNING)

    @patch.dict("os.environ", {"HARNESS_REASONING_EFFORT": "max"}, clear=True)
    def test_max_effort_is_rejected_for_openai(self) -> None:
        with self.assertRaises(ValueError):
            resolve_model(ModelStage.PLANNING)


class TestBuildAnthropicModel(unittest.TestCase):
    @patch.dict("os.environ", _ANTHROPIC, clear=True)
    def test_builds_chat_anthropic_with_adaptive_thinking_and_effort(self) -> None:
        from langchain_anthropic import ChatAnthropic

        m = build_model(model="claude-opus-5-5", reasoning_effort="HIGH")

        self.assertIsInstance(m, ChatAnthropic)
        self.assertEqual(m.model, "claude-opus-5-5")
        self.assertEqual(m.anthropic_api_url, "https://api.anthropic.com")
        self.assertEqual(
            m.anthropic_api_key.get_secret_value(), "proxy-llm-dummy-token"
        )
        self.assertEqual(m.effort, "high")
        self.assertEqual(m.thinking, {"type": "adaptive", "display": "summarized"})
        self.assertEqual(m.max_tokens, 64000)
        self.assertTrue(m.streaming)
        self.assertTrue(m.stream_usage)

    @patch.dict("os.environ", _ANTHROPIC, clear=True)
    def test_sdk_clients_get_per_phase_timeouts_and_retries(self) -> None:
        m = build_model(model="claude-opus-5-5", reasoning_effort="high")

        for client in (m._client, m._async_client):
            with self.subTest(client=type(client).__name__):
                self.assertEqual(
                    client.timeout,
                    httpx.Timeout(connect=10, read=180, write=60, pool=10),
                )
                self.assertEqual(client.max_retries, 5)
                self.assertEqual(str(client.base_url), "https://api.anthropic.com")
        self.assertIs(m._client, m._client)

    @patch.dict(
        "os.environ",
        {
            **_ANTHROPIC,
            "HARNESS_DEEPAGENTS_MODEL_TIMEOUT_SECONDS": "900",
            "HARNESS_DEEPAGENTS_MODEL_MAX_RETRIES": "8",
        },
        clear=True,
    )
    def test_timeout_and_retries_are_configurable(self) -> None:
        m = build_model(model="claude-opus-5-5", reasoning_effort="high")

        self.assertEqual(m.max_retries, 8)
        self.assertEqual(m._client.max_retries, 8)
        self.assertEqual(m._client.timeout.read, 900)
        self.assertEqual(m._client.timeout.connect, 10)

    def test_base_url_with_a_v1_segment_is_rejected(self) -> None:
        for url in (
            "https://api.anthropic.com/v1",
            "https://api.anthropic.com/v1/",
            "https://api.anthropic.com/v1/messages",
            "https://gateway.example/anthropic/v1",
        ):
            with (
                self.subTest(url=url),
                patch.dict(
                    "os.environ",
                    {**_ANTHROPIC, "HARNESS_LLM_BASE_URL": url},
                    clear=True,
                ),
                self.assertRaisesRegex(RuntimeError, "/v1"),
            ):
                build_model(model="claude-opus-5-5", reasoning_effort="high")

    @patch.dict(
        "os.environ",
        {**_ANTHROPIC, "HARNESS_LLM_BASE_URL": "https://gateway.example/v1beta/"},
        clear=True,
    )
    def test_base_url_path_without_a_v1_segment_is_kept(self) -> None:
        m = build_model(model="claude-opus-5-5", reasoning_effort="high")
        self.assertEqual(m.anthropic_api_url, "https://gateway.example/v1beta")

    @patch.dict(
        "os.environ",
        {"HARNESS_LLM_PROVIDER": "anthropic", "HARNESS_LLM_API_KEY": "k"},
        clear=True,
    )
    def test_missing_base_url_is_an_error(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "HARNESS_LLM_BASE_URL"):
            build_model(model="claude-opus-5-5", reasoning_effort="high")


class TestBuildModelDispatch(unittest.TestCase):
    def test_openai_when_unset_or_openai(self) -> None:
        from langchain_openai import ChatOpenAI

        base = {
            "HARNESS_LLM_BASE_URL": "https://api.openai.com/v1",
            "HARNESS_LLM_API_KEY": "k",
        }
        for env in (base, {**base, "HARNESS_LLM_PROVIDER": "openai"}):
            with (
                self.subTest(provider=env.get("HARNESS_LLM_PROVIDER")),
                patch.dict("os.environ", env, clear=True),
            ):
                m = build_model(model="gpt-5.6-sol", reasoning_effort="medium")
                self.assertIsInstance(m, ChatOpenAI)
                self.assertTrue(m.use_responses_api)


class TestAnthropicRetryClassification(unittest.TestCase):
    def test_http_failures_are_transient(self) -> None:
        cases = [
            anthropic.RateLimitError("429", response=_response(429), body=None),
            anthropic.OverloadedError("529", response=_response(529), body=None),
            anthropic.InternalServerError("500", response=_response(500), body=None),
            anthropic.APIConnectionError(request=_response(200).request),
        ]
        for exc in cases:
            with self.subTest(exc=type(exc).__name__):
                self.assertTrue(is_transient_model_exception(exc))

    def test_stream_errors_are_transient(self) -> None:
        for kind in ("overloaded_error", "api_error", "rate_limit_error"):
            with self.subTest(kind=kind):
                self.assertTrue(is_transient_model_exception(_stream_error(kind)))

    def test_rate_limits_are_recognised_in_both_forms(self) -> None:
        self.assertTrue(
            is_rate_limit_exception(
                anthropic.RateLimitError("429", response=_response(429), body=None)
            )
        )
        self.assertTrue(is_rate_limit_exception(_stream_error("rate_limit_error")))
        self.assertFalse(is_rate_limit_exception(_stream_error("overloaded_error")))

    def test_client_errors_are_not_transient(self) -> None:
        self.assertFalse(
            is_transient_model_exception(
                anthropic.BadRequestError("400", response=_response(400), body=None)
            )
        )
        self.assertFalse(
            is_transient_model_exception(_stream_error("invalid_request_error"))
        )


if __name__ == "__main__":
    unittest.main()
