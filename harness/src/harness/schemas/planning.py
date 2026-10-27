"""Strict Pydantic contracts for DeepAgents planning model outputs.

All models extend `schemas.common.StrictOutputModel` (OpenAI provider-strict).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field, model_validator

from harness.schemas.common import OptionalReviewLens, StrictOutputModel

Confidence = Literal["low", "medium", "high"]


class OrientedComponent(StrictOutputModel):
    """Repository component identified during planning orientation."""

    name: str
    path: str
    confidence: Confidence = "medium"
    rationale: str = ""


class OrientedRepo(StrictOutputModel):
    """Repository candidate identified by classification or orientation."""

    name: str
    confidence: Confidence
    rationale: str = ""
    components: list[OrientedComponent] = Field(default_factory=list)


class OrientationOutput(StrictOutputModel):
    """Structured output from the orientation/classification step."""

    repos: list[OrientedRepo] = Field(default_factory=list)
    orientation_notes: str = ""
    cross_repo_assumptions: list[str] = Field(default_factory=list)


class PlannedComponent(StrictOutputModel):
    """Repository-relative component returned by a planning worker."""

    name: str
    path: str


class RepoPlanOutput(StrictOutputModel):
    """Structured output returned by one per-repository planning worker."""

    name: str | None = None
    goal: str
    planned_files_or_areas: list[str] = Field(default_factory=list)
    implementation_steps: list[str] = Field(default_factory=list)
    validation_steps: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    components: list[PlannedComponent] = Field(default_factory=list)
    # Planner-selected adversarial review lenses for this repo's diff, on top
    # of the always-on `code-review` lens (roster: schemas.common).
    additional_review_lenses: list[OptionalReviewLens] = Field(default_factory=list)
    planning_notes: str = ""
    cross_repo_assumptions: list[str] = Field(default_factory=list)


class PlanIssue(StrictOutputModel):
    """One adversarial review issue against a draft plan."""

    repo: str | None = None
    severity: Literal["low", "medium", "high"] = "medium"
    summary: str
    details: str = ""
    suggested_revision: str = ""


class PlanReviewOutput(StrictOutputModel):
    """Structured output from adversarial plan review."""

    status: Literal["approved", "needs_revision"]
    issues: list[PlanIssue] = Field(default_factory=list)
    review_notes: str = ""

    @model_validator(mode="after")
    def _needs_revision_has_issue_or_notes(self) -> PlanReviewOutput:
        if (
            self.status == "needs_revision"
            and not self.issues
            and not self.review_notes
        ):
            raise ValueError(
                "needs_revision requires at least one issue or review_notes"
            )
        return self
