"""Shared helper: check a tool schema stays inside the strict-mode subset."""

from __future__ import annotations

import unittest
from typing import Any

from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool

# Keywords Azure's strict mode rejects or ignores.
FORBIDDEN_SCHEMA_KEYWORDS = frozenset({
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "multipleOf",
    "minItems",
    "maxItems",
    "uniqueItems",
})


def forbidden_keywords(node: Any, path: str = "$") -> list[str]:
    """Return the path of every forbidden keyword used as a schema keyword."""
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "properties" and isinstance(value, dict):
                # Property names are data, not keywords: recurse into their schemas.
                for name, sub in value.items():
                    found += forbidden_keywords(sub, f"{path}.properties.{name}")
                continue
            if key in FORBIDDEN_SCHEMA_KEYWORDS:
                found.append(f"{path}.{key}")
            found += forbidden_keywords(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, item in enumerate(node):
            found += forbidden_keywords(item, f"{path}[{index}]")
    return found


def strict_object_violations(node: Any, path: str = "$") -> list[str]:
    """Return each object node whose required/additionalProperties break strict mode."""
    found: list[str] = []
    if isinstance(node, dict):
        props = node.get("properties")
        if isinstance(props, dict):
            if set(node.get("required", [])) != set(props):
                found.append(f"{path}: required != properties")
            if node.get("additionalProperties") is not False:
                found.append(f"{path}: additionalProperties is not false")
            for name, sub in props.items():
                found += strict_object_violations(sub, f"{path}.properties.{name}")
        for key, value in node.items():
            if key != "properties":
                found += strict_object_violations(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, item in enumerate(node):
            found += strict_object_violations(item, f"{path}[{index}]")
    return found


def assert_strict_compatible(testcase: unittest.TestCase, tool: BaseTool) -> None:
    schema = tool.tool_call_schema.model_json_schema()
    testcase.assertEqual(forbidden_keywords(schema), [])
    converted = convert_to_openai_tool(tool, strict=True)
    testcase.assertTrue(converted["function"]["strict"])
    testcase.assertEqual(
        strict_object_violations(converted["function"]["parameters"]), []
    )
