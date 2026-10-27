"""Shared schema building blocks used across schema modules."""

from __future__ import annotations

from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict
from pydantic.json_schema import GetJsonSchemaHandler, JsonSchemaValue


class StrictOutputModel(BaseModel):
    """OpenAI provider-strict base for every structured model output.

    Closed schema (`extra="forbid"`) plus a JSON-schema normalization that
    drops defaults, sets `additionalProperties: false`, and marks every
    property required — the shape OpenAI strict structured outputs demand.
    Stage-agnostic: planning, review, and any future structured output
    extend it.
    """

    model_config = ConfigDict(extra="forbid")

    @classmethod
    def __get_pydantic_json_schema__(
        cls,
        core_schema: object,
        handler: GetJsonSchemaHandler,
    ) -> JsonSchemaValue:
        json_schema = handler(core_schema)

        def normalize(node: object) -> None:
            if isinstance(node, dict):
                node.pop("default", None)
                properties = node.get("properties")
                if isinstance(properties, dict):
                    node["additionalProperties"] = False
                    node["required"] = list(properties)
                for value in node.values():
                    normalize(value)
            elif isinstance(node, list):
                for value in node:
                    normalize(value)

        normalize(json_schema)
        return json_schema


# ---------------------------------------------------------------------------
# Review lens roster
# ---------------------------------------------------------------------------

BaseReviewLens = Literal["code-review"]

OptionalReviewLens = Literal["bug-hunter", "bird-eye", "security", "code-quality"]

# Every dispatchable lens (base + optional) — the value space of a merged
# finding's `lenses`.
ReviewLens = Literal[BaseReviewLens, OptionalReviewLens]

BASE_REVIEW_LENSES: tuple[str, ...] = get_args(BaseReviewLens)
OPTIONAL_REVIEW_LENSES: tuple[str, ...] = get_args(OptionalReviewLens)
REVIEW_LENSES: tuple[str, ...] = get_args(ReviewLens)


# ---------------------------------------------------------------------------
# Finding severity
# ---------------------------------------------------------------------------

# Ordered strongest-first; the harness derives its rank from this order.
ReviewSeverity = Literal["critical", "high", "medium", "low"]
REVIEW_SEVERITIES: tuple[str, ...] = get_args(ReviewSeverity)

# Severities whose findings must carry `file` + `line_start`; the harness
# demotes ungrounded ones and the artifact validator rejects them.
GROUNDING_SEVERITIES: frozenset[str] = frozenset({"critical", "high"})
