"""Tests for the shared tool argument types."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from pydantic import BaseModel, ValidationError, model_validator

from harness.deepagents.middleware.arguments import (
    NonBlankStr,
    StrippedNonBlankStr,
    format_validation_error,
)
from tests.schema_support import forbidden_keywords


class _Model(BaseModel):
    kept: NonBlankStr
    stripped: StrippedNonBlankStr


class TestToolArguments(unittest.TestCase):
    def test_non_blank_keeps_value_exactly(self) -> None:
        m = _Model(kept="  hi \n", stripped="x")
        self.assertEqual(m.kept, "  hi \n")

    def test_stripped_removes_surrounding_whitespace(self) -> None:
        m = _Model(kept="x", stripped="  hi \n")
        self.assertEqual(m.stripped, "hi")

    def test_blank_values_are_rejected_naming_the_field(self) -> None:
        for field in ("kept", "stripped"):
            for blank in ("", "   ", "\n\t"):
                values = {"kept": "x", "stripped": "x", field: blank}
                with self.assertRaises(ValidationError) as ctx:
                    _Model(**values)
                self.assertIn(field, str(ctx.exception))
                self.assertIn("must not be blank", str(ctx.exception))

    def test_types_add_no_schema_keywords(self) -> None:
        self.assertEqual(forbidden_keywords(_Model.model_json_schema()), [])

    def test_keyword_walk_detects_keywords_and_ignores_property_names(self) -> None:
        schema = {"properties": {"pattern": {"type": "string", "minLength": 1}}}
        self.assertEqual(forbidden_keywords(schema), ["$.properties.pattern.minLength"])


class _Item(BaseModel):
    path: StrippedNonBlankStr


class _Outer(BaseModel):
    body: NonBlankStr
    items: list[_Item]

    @model_validator(mode="after")
    def _check(self) -> _Outer:
        raise ValueError("nothing goes")


class TestFormatValidationError(unittest.TestCase):
    def _error(self, **values) -> ValidationError:
        with self.assertRaises(ValidationError) as ctx:
            _Outer(**values)
        return ctx.exception

    def test_field_error_has_no_value_error_prefix_or_links(self) -> None:
        exc = self._error(body="  ", items=[])
        self.assertEqual(
            format_validation_error(exc), "invalid arguments: body: must not be blank"
        )

    def test_nested_location_is_dotted_and_errors_are_joined(self) -> None:
        exc = self._error(body="", items=[{"path": " "}, {"path": "ok"}])
        self.assertEqual(
            format_validation_error(exc),
            "invalid arguments: body: must not be blank; "
            "items.0.path: must not be blank",
        )

    def test_model_level_error_uses_arguments_location(self) -> None:
        exc = self._error(body="x", items=[])
        self.assertEqual(
            format_validation_error(exc), "invalid arguments: arguments: nothing goes"
        )

    def test_non_value_error_message_is_kept(self) -> None:
        exc = self._error(body="x", items="nope")
        self.assertEqual(
            format_validation_error(exc),
            "invalid arguments: items: Input should be a valid list",
        )


if __name__ == "__main__":
    unittest.main()
