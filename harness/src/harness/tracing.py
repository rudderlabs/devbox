"""
Langfuse tracing for harness runs.

Gated by HARNESS_LANGFUSE_ENABLED (default off). Set to true to enable.
Requires the langfuse package (see pyproject.toml).
"""

from __future__ import annotations

import base64
import functools
import os
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

from harness.env_flags import bool_env

_ENABLED = bool_env("HARNESS_LANGFUSE_ENABLED")

_langfuse: Any = None
_propagate_attributes: Any = None

# Placeholders for iron-proxy / egress auth swap (see LANGFUSE_AUTH). Not used
# for OTLP Authorization when proxy-auth mode is active — see _build_span_exporter.
_DEFAULT_PUBLIC_KEY = "proxy-langfuse-public"
_DEFAULT_SECRET_KEY = "proxy-langfuse-secret"
_DEFAULT_LANGFUSE_AUTH = "dummy-langfuse-auth"


def _proxy_auth_mode() -> bool:
    """Use LANGFUSE_AUTH Basic header (egress-proxy path) unless real keys are set."""
    return not (
        os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")
    )


def _sdk_public_secret() -> tuple[str, str]:
    pk = os.environ.get("LANGFUSE_PUBLIC_KEY")
    sk = os.environ.get("LANGFUSE_SECRET_KEY")
    if pk and sk:
        return pk, sk
    raw = os.environ.get("LANGFUSE_AUTH")
    if raw and ":" in raw:
        public, secret = raw.split(":", 1)
        return public, secret
    return _DEFAULT_PUBLIC_KEY, _DEFAULT_SECRET_KEY


def _langfuse_base_url() -> str:
    return (
        os.environ.get("LANGFUSE_BASE_URL") or "https://us.cloud.langfuse.com"
    ).rstrip("/")


def _require_langfuse_creds() -> tuple[str, str]:
    base_url = _langfuse_base_url()
    raw_auth = os.environ.get("LANGFUSE_AUTH")
    if raw_auth is not None:
        auth = base64.b64encode(raw_auth.encode()).decode()
    else:
        auth = _DEFAULT_LANGFUSE_AUTH
    return base_url, auth


def _otlp_trace_headers(public_key: str) -> dict[str, str]:
    """OTLP headers for Langfuse (the egress proxy swaps Authorization)."""
    _, auth = _require_langfuse_creds()
    if _proxy_auth_mode():
        # Proxy mode sends only Authorization, to keep the egress proxy's
        # auth-rewrite rule simple.
        return {
            "Authorization": f"Basic {auth}",
        }

    from langfuse._version import __version__ as langfuse_version

    return {
        "Authorization": f"Basic {auth}",
        "x-langfuse-sdk-name": "python",
        "x-langfuse-sdk-version": langfuse_version,
        "x-langfuse-public-key": public_key,
        "x-langfuse-ingestion-version": "4",
    }


def _build_span_exporter(public_key: str) -> Any:
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
        OTLPSpanExporter,
    )

    base_url = _langfuse_base_url()
    endpoint = f"{base_url}/api/public/otel/v1/traces"
    return OTLPSpanExporter(
        endpoint=endpoint,
        headers=_otlp_trace_headers(public_key),
    )


def _create_langfuse_client() -> Any:
    from langfuse import Langfuse

    public_key, secret_key = _sdk_public_secret()
    kwargs: dict[str, Any] = {
        "public_key": public_key,
        "secret_key": secret_key,
        "base_url": _langfuse_base_url(),
    }
    if _proxy_auth_mode():
        kwargs["span_exporter"] = _build_span_exporter(public_key)
    return Langfuse(**kwargs)


if _ENABLED:
    try:
        from langfuse import propagate_attributes as _propagate_attributes

        _langfuse = _create_langfuse_client()
    except ImportError as exc:
        raise RuntimeError(
            "HARNESS_LANGFUSE_ENABLED is set but langfuse is not installed. "
            "Install with: uv sync"
        ) from exc


@contextmanager
def _noop_context(*_args: Any, **_kwargs: Any) -> Generator[None]:
    yield None


def is_tracing_enabled() -> bool:
    return _ENABLED


def trace_root_name(task_key: str) -> str:
    """Langfuse trace/span name for the root harness observation."""
    return f"devbox/{task_key}"


def finalize_root_trace(
    root: Any,
    *,
    summary_status: str,
    error: str | None = None,
) -> None:
    """Set root span output from harness terminal summary status."""
    if root is None:
        return

    if summary_status in ("completed", "no_action", "partial_failure"):
        output: dict[str, Any] = {"status": "successful"}
    else:
        output = {"status": "errored"}
        if error:
            output["error"] = error

    root.update(output=output)


@contextmanager
def init_trace(
    *,
    run_id: str,
    task: str,
    task_key: str,
    agent: str,
    model: str | None = None,
) -> Generator[Any]:
    """Root harness-run span for the full pipeline lifetime."""
    if not _ENABLED:
        with _noop_context():
            yield None
        return

    _require_langfuse_creds()
    metadata: dict[str, Any] = {
        "run_id": run_id,
        "task": task,
        "agent": agent,
    }
    metadata["task_key"] = task_key
    if model:
        metadata["model"] = model

    tags = ["devbox", f"task:{task_key}"]

    span_input: dict[str, Any] = {
        "task": task,
        "run_id": run_id,
        "task_key": task_key,
    }

    with (
        _propagate_attributes(
            session_id=run_id,
            tags=tags,
            metadata=metadata,
        ),
        _langfuse.start_as_current_observation(
            as_type="span",
            name=trace_root_name(task_key),
            input=span_input,
        ) as root,
    ):
        yield root


@contextmanager
def trace_span(name: str, **kwargs: Any) -> Generator[Any]:
    """Child span or generation observation under the current trace."""
    if not _ENABLED:
        with _noop_context():
            yield None
        return

    with _langfuse.start_as_current_observation(name=name, **kwargs) as span:
        yield span


def flush_trace() -> None:
    """Flush pending Langfuse events (call before process exit)."""
    if _ENABLED and _langfuse is not None:
        _langfuse.flush()


def traced_stage(name: str, **span_kwargs: Any):
    """Decorator: wrap a stage function in a trace_span context."""

    def decorator(fn: Any) -> Any:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with trace_span(name, **span_kwargs):
                return fn(*args, **kwargs)

        return wrapper

    return decorator
