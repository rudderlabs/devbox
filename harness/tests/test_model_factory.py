"""Unit tests for deepagents.model.build_openai_model — no network calls."""

from __future__ import annotations

import sys
import unittest
from inspect import signature
from pathlib import Path
from unittest.mock import patch

import httpx
import openai
from openai.resources.responses import Responses

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.deepagents.model import build_openai_model

_BASE = "https://proxy.example/v1"
_OPENAI_ENV = {"HARNESS_LLM_BASE_URL": _BASE, "HARNESS_LLM_API_KEY": "real-key"}


class _EmptyStream:
    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        return None

    def __iter__(self):
        return iter(())


def _signature_checked_create(real_create, payloads: list[dict]):
    real_signature = signature(real_create)

    def create(resource, *args, **kwargs):
        real_signature.bind(resource, *args, **kwargs)
        payloads.append(kwargs)
        return _EmptyStream()

    return create


_RESPONSES_ONLY = ("reasoning", "store", "include")


def _chat_openai_kwargs(*, reasoning_effort: str = "medium") -> dict:
    """The keyword arguments `build_openai_model` passes to `ChatOpenAI`."""
    with patch("langchain_openai.ChatOpenAI") as chat_openai:
        build_openai_model(model="gpt-5.5", reasoning_effort=reasoning_effort)
    chat_openai.assert_called_once()
    return chat_openai.call_args.kwargs


class TestResponsesApi(unittest.TestCase):
    """The openai provider always uses the Responses API, with reasoning."""

    @patch.dict(
        "os.environ",
        _OPENAI_ENV,
        clear=True,
    )
    def test_sends_the_responses_parameters(self) -> None:
        kwargs = _chat_openai_kwargs(reasoning_effort="high")
        self.assertTrue(kwargs["use_responses_api"])
        self.assertEqual(
            {name: kwargs[name] for name in _RESPONSES_ONLY},
            {
                "reasoning": {"summary": "auto", "effort": "high"},
                "store": False,
                "include": ["reasoning.encrypted_content"],
            },
        )

    @patch.dict(
        "os.environ",
        {**_OPENAI_ENV, "HARNESS_LLM_WIRE_API": "chat"},
        clear=True,
    )
    def test_ignores_the_removed_wire_api_setting(self) -> None:
        m = build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        self.assertTrue(m.use_responses_api)


class TestBuildOpenAIModel(unittest.TestCase):
    @patch.dict(
        "os.environ",
        _OPENAI_ENV,
        clear=True,
    )
    def test_responses_api_sets_reasoning(self) -> None:
        m = build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        self.assertEqual(m.model_name, "gpt-5.5")
        self.assertEqual(m.openai_api_base, _BASE)
        self.assertTrue(m.use_responses_api)
        self.assertEqual(m.reasoning, {"summary": "auto", "effort": "medium"})
        self.assertIs(m.store, False)
        self.assertEqual(m.include, ["reasoning.encrypted_content"])
        self.assertEqual(m.max_retries, 5)
        self.assertIsInstance(m.request_timeout, httpx.Timeout)
        self.assertEqual(m.request_timeout.connect, 10)
        self.assertEqual(m.request_timeout.read, 180)
        self.assertEqual(m.request_timeout.write, 60)
        self.assertEqual(m.request_timeout.pool, 10)
        self.assertTrue(m.streaming)
        self.assertTrue(m.stream_usage)
        self.assertNotIn("streaming", m.model_kwargs)
        self.assertNotIn("stream_usage", m.model_kwargs)
        self.assertNotIn("store", m.model_kwargs)
        self.assertNotIn("include", m.model_kwargs)
        self.assertNotIn("strict", m.model_kwargs)

    @patch.dict(
        "os.environ",
        {**_OPENAI_ENV, "HARNESS_DEEPAGENTS_MODEL_MAX_RETRIES": "8"},
        clear=True,
    )
    def test_model_max_retries_is_configurable(self) -> None:
        m = build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        self.assertEqual(m.max_retries, 8)

    @patch.dict(
        "os.environ",
        {**_OPENAI_ENV, "HARNESS_DEEPAGENTS_MODEL_TIMEOUT_SECONDS": "900"},
        clear=True,
    )
    def test_model_timeout_is_configurable(self) -> None:
        m = build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        self.assertIsInstance(m.request_timeout, httpx.Timeout)
        self.assertEqual(m.request_timeout.connect, 10)
        self.assertEqual(m.request_timeout.read, 900)
        self.assertEqual(m.request_timeout.write, 60)
        self.assertEqual(m.request_timeout.pool, 10)
        self.assertNotIn("timeout", m.model_kwargs)

    @patch.dict(
        "os.environ",
        _OPENAI_ENV,
        clear=True,
    )
    def test_timeout_reaches_underlying_openai_client(self) -> None:
        with patch("openai.OpenAI", wraps=openai.OpenAI) as openai_client:
            m = build_openai_model(model="gpt-5.5", reasoning_effort="medium")

        timeout = openai_client.call_args.kwargs["timeout"]
        self.assertIs(timeout, m.request_timeout)
        self.assertIsInstance(timeout, httpx.Timeout)
        self.assertEqual(timeout.read, 180)
        self.assertIs(m.root_client.timeout, timeout)

    def test_invalid_model_timeout_uses_bounded_default(self) -> None:
        for configured in ("", "invalid", "0", "-1"):
            with self.subTest(configured=configured):
                with patch.dict(
                    "os.environ",
                    {
                        **_OPENAI_ENV,
                        "HARNESS_DEEPAGENTS_MODEL_TIMEOUT_SECONDS": configured,
                    },
                    clear=True,
                ):
                    m = build_openai_model(model="gpt-5.5", reasoning_effort="medium")
                self.assertIsInstance(m.request_timeout, httpx.Timeout)
                self.assertEqual(m.request_timeout.read, 180)

    @patch.dict(
        "os.environ",
        _OPENAI_ENV,
        clear=True,
    )
    def test_responses_public_stream_payload_matches_real_sdk_signature(self) -> None:
        m = build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        payloads = []
        checked_create = _signature_checked_create(Responses.create, payloads)
        with (
            patch.object(type(m.root_client.responses), "create", checked_create),
            self.assertRaises(ValueError),
        ):
            list(m.stream("hi"))

        self.assertEqual(len(payloads), 1)
        self.assertNotIn("stream_usage", payloads[0])

    @patch.dict(
        "os.environ",
        _OPENAI_ENV,
        clear=True,
    )
    def test_effort_is_lowercased(self) -> None:
        m = build_openai_model(model="gpt-5.5", reasoning_effort="HIGH")
        self.assertEqual(m.reasoning["effort"], "high")

    @patch.dict(
        "os.environ",
        {"HARNESS_LLM_API_KEY": "real-key"},
        clear=True,
    )
    def test_missing_base_url_raises(self) -> None:
        with self.assertRaises(RuntimeError) as ctx:
            build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        self.assertEqual(
            str(ctx.exception),
            "HARNESS_LLM_BASE_URL is required (the OpenAI endpoint's base URL, "
            "for example https://api.openai.com/v1)",
        )

    @patch.dict(
        "os.environ",
        {"HARNESS_LLM_BASE_URL": _BASE},
        clear=True,
    )
    def test_missing_api_key_names_the_setting(self) -> None:
        with self.assertRaises(RuntimeError) as ctx:
            build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        self.assertEqual(
            str(ctx.exception),
            "HARNESS_LLM_API_KEY is required (the LLM API key)",
        )

    @patch.dict(
        "os.environ",
        {
            "HARNESS_LLM_BASE_URL": _BASE,
            "HARNESS_LLM_API_KEY_ENV": "AZURE_FOUNDRY_KEY",
            "AZURE_FOUNDRY_KEY": "real-key",
        },
        clear=True,
    )
    def test_api_key_indirection_is_not_read(self) -> None:
        with self.assertRaises(RuntimeError) as ctx:
            build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        self.assertEqual(
            str(ctx.exception),
            "HARNESS_LLM_API_KEY is required (the LLM API key)",
        )

    @patch.dict(
        "os.environ",
        {**_OPENAI_ENV, "HARNESS_LLM_API_KEY": " real-key "},
        clear=True,
    )
    def test_api_key_is_read_directly(self) -> None:
        m = build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        self.assertEqual(m.openai_api_key.get_secret_value(), "real-key")

    @patch.dict(
        "os.environ",
        _OPENAI_ENV,
        clear=True,
    )
    def test_streams_with_usage(self) -> None:
        m = build_openai_model(model="gpt-5.5", reasoning_effort="medium")
        self.assertTrue(m.streaming)
        self.assertTrue(m.stream_usage)
        self.assertNotIn("streaming", m.model_kwargs)
        self.assertNotIn("stream_usage", m.model_kwargs)


if __name__ == "__main__":
    unittest.main()
