"""Unit tests for opt-in Langfuse tracing (no network, no real Langfuse client)."""

from __future__ import annotations

import base64
import importlib
import os
import unittest
from unittest.mock import MagicMock, patch

from harness import tracing
from harness.env_flags import bool_env


class TestTracingDisabled(unittest.TestCase):
    _MANAGED_ENV = (
        "HARNESS_LANGFUSE_ENABLED",
        "LANGFUSE_BASE_URL",
        "LANGFUSE_AUTH",
    )

    def setUp(self) -> None:
        self._env_snapshot = {k: os.environ.get(k) for k in self._MANAGED_ENV}
        os.environ["HARNESS_LANGFUSE_ENABLED"] = "false"

    def tearDown(self) -> None:
        for k, v in self._env_snapshot.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)

    def test_enabled_defaults_false_when_env_unset(self) -> None:
        env = os.environ.copy()
        env.pop("HARNESS_LANGFUSE_ENABLED", None)
        with patch.dict(os.environ, env, clear=True):
            self.assertFalse(bool_env("HARNESS_LANGFUSE_ENABLED"))

    def test_module_enabled_default_is_false_when_env_unset(self) -> None:
        env = os.environ.copy()
        env.pop("HARNESS_LANGFUSE_ENABLED", None)
        with patch.dict(os.environ, env, clear=True):
            reloaded = importlib.reload(tracing)
            self.assertFalse(reloaded.is_tracing_enabled())

    def test_flush_trace_safe(self) -> None:
        with patch.object(tracing, "_ENABLED", False):
            tracing.flush_trace()

    def test_init_trace_noop(self) -> None:
        with (
            patch.object(tracing, "_ENABLED", False),
            tracing.init_trace(
                run_id="r1",
                task="t",
                task_key="ABC-1",
                agent="deepagents",
            ),
        ):
            pass

    def test_traced_stage_runs_function(self) -> None:
        with patch.object(tracing, "_ENABLED", False):

            @tracing.traced_stage("setup")
            def stage() -> str:
                return "ok"

            self.assertEqual(stage(), "ok")

    def test_trace_root_name_without_ticket(self) -> None:
        self.assertEqual(tracing.trace_root_name("ABC-1"), "devbox/ABC-1")

    def test_trace_root_name_with_ticket(self) -> None:
        self.assertEqual(tracing.trace_root_name("ABC-104"), "devbox/ABC-104")

    def test_finalize_root_trace_noop_when_disabled(self) -> None:
        tracing.finalize_root_trace(None, summary_status="failed", error="boom")

    def test_finalize_root_trace_successful(self) -> None:
        root = MagicMock()
        tracing.finalize_root_trace(root, summary_status="completed")
        root.update.assert_called_once_with(output={"status": "successful"})

    def test_finalize_root_trace_errored(self) -> None:
        root = MagicMock()
        tracing.finalize_root_trace(
            root,
            summary_status="failed",
            error="RuntimeError: boom",
        )
        root.update.assert_called_once_with(
            output={"status": "errored", "error": "RuntimeError: boom"}
        )


class TestTracingSdkAuth(unittest.TestCase):
    _MANAGED_ENV = (
        "LANGFUSE_PUBLIC_KEY",
        "LANGFUSE_SECRET_KEY",
        "LANGFUSE_AUTH",
        "LANGFUSE_BASE_URL",
    )

    def setUp(self) -> None:
        self._env_snapshot = {k: os.environ.get(k) for k in self._MANAGED_ENV}

    def tearDown(self) -> None:
        for k, v in self._env_snapshot.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)

    def test_proxy_auth_mode_without_explicit_keys(self) -> None:
        os.environ.pop("LANGFUSE_PUBLIC_KEY", None)
        os.environ.pop("LANGFUSE_SECRET_KEY", None)
        self.assertTrue(tracing._proxy_auth_mode())

    def test_proxy_auth_mode_off_when_keys_set(self) -> None:
        os.environ["LANGFUSE_PUBLIC_KEY"] = "pk"
        os.environ["LANGFUSE_SECRET_KEY"] = "sk"
        self.assertFalse(tracing._proxy_auth_mode())

    def test_trace_headers_use_basic_auth_only(self) -> None:
        os.environ["LANGFUSE_AUTH"] = "langfuse-auth-test"
        public_key, _ = tracing._sdk_public_secret()
        expected = base64.b64encode(b"langfuse-auth-test").decode()
        self.assertEqual(
            tracing._otlp_trace_headers(public_key),
            {"Authorization": f"Basic {expected}"},
        )

    def test_trace_headers_default_dummy_auth(self) -> None:
        os.environ.pop("LANGFUSE_AUTH", None)
        public_key, _ = tracing._sdk_public_secret()
        self.assertEqual(
            tracing._otlp_trace_headers(public_key),
            {"Authorization": "Basic dummy-langfuse-auth"},
        )

    def test_span_exporter_receives_trace_headers(self) -> None:
        os.environ["LANGFUSE_AUTH"] = "langfuse-auth-test"
        public_key, _ = tracing._sdk_public_secret()
        with patch(
            "opentelemetry.exporter.otlp.proto.http.trace_exporter.OTLPSpanExporter"
        ) as exporter_cls:
            tracing._build_span_exporter(public_key)
        exporter_cls.assert_called_once_with(
            endpoint=f"{tracing._langfuse_base_url()}/api/public/otel/v1/traces",
            headers=tracing._otlp_trace_headers(public_key),
        )

    def test_create_client_exports_in_proxy_mode(self) -> None:
        from opentelemetry import trace as otel_trace_api

        os.environ.pop("LANGFUSE_PUBLIC_KEY", None)
        os.environ.pop("LANGFUSE_SECRET_KEY", None)
        client = tracing._create_langfuse_client()
        self.assertFalse(isinstance(client._otel_tracer, otel_trace_api.NoOpTracer))
        self.assertIsNotNone(client._resources.span_exporter)
