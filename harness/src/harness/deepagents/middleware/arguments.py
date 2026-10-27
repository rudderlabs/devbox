"""Argument types shared by tool schemas.

Rules are runtime validators, never JSON Schema keywords: tools are sent with
``strict: true`` under provider-side structured output, and Azure's strict mode
rejects or ignores string constraints such as ``pattern`` and ``minLength``.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator, ValidationError


def _require_non_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be blank")
    return value


def _strip_non_blank(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError("must not be blank")
    return stripped


NonBlankStr = Annotated[str, AfterValidator(_require_non_blank)]
"""A string that must contain a non-whitespace character; kept exactly as given."""

StrippedNonBlankStr = Annotated[str, AfterValidator(_strip_non_blank)]
"""Like ``NonBlankStr``, but surrounding whitespace is removed."""


def format_validation_error(exc: ValidationError) -> str:
    """One line per error, ``field: message``, without Pydantic's links."""
    parts: list[str] = []
    for err in exc.errors():
        location = ".".join(str(p) for p in err["loc"]) or "arguments"
        message = err["msg"].removeprefix("Value error, ")
        parts.append(f"{location}: {message}")
    return "invalid arguments: " + "; ".join(parts)
