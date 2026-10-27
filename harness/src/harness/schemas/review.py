"""Strict contracts for DeepAgents review lens and review-fix outputs."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from harness.schemas.common import (  # noqa: F401 — re-exported roster
    BASE_REVIEW_LENSES,
    OPTIONAL_REVIEW_LENSES,
    OptionalReviewLens,
    ReviewLens,
    ReviewSeverity,
    StrictOutputModel,
)


class ReviewLensFinding(StrictOutputModel):
    """One material finding returned by a (repository, lens) review agent.

    `repo`, `lens`, and `id` are stamped by the harness after the merge — the
    agent never sets identity fields.
    """

    severity: ReviewSeverity
    confidence: float = Field(ge=0.0, le=1.0)
    title: str
    body: str
    recommendation: str
    file: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    prior_finding_id: str | None = None


class ReviewLensOutput(StrictOutputModel):
    """Structured output returned by one (repository, lens) review agent."""

    findings: list[ReviewLensFinding] = Field(default_factory=list)
    summary: str = ""


class ReviewFixDecision(StrictOutputModel):
    """Triage decision for one harness-assigned finding id."""

    finding_id: str
    decision: Literal["fixed", "declined"]
    reason: str
    files_changed: list[str] = Field(default_factory=list)


class RepoReviewFixOutput(StrictOutputModel):
    """Structured output returned by one per-repo review-fix agent.

    `summary` is the repository's updated implementation summary (carrying a
    "review-fix: ..." note when fixes landed); the harness recomputes
    `changed_files` from the working tree itself.
    """

    decisions: list[ReviewFixDecision] = Field(default_factory=list)
    summary: str = ""


class MergedFinding(ReviewLensFinding):
    """One finding after cross-lens merge.

    `lenses` names every lens that reported the underlying issue (the merge
    agent folds duplicates into one entry). The harness clamps it to the
    lenses actually dispatched for the repo.
    """

    lenses: list[ReviewLens] = Field(default_factory=list)


class RepoMergedFindings(StrictOutputModel):
    """Merged findings plus a fixer-facing report for one repository."""

    repo: str
    findings: list[MergedFinding] = Field(default_factory=list)
    report: str = ""


class MergedFindingsOutput(StrictOutputModel):
    """Structured output of the merge-findings agent for one iteration."""

    repos: list[RepoMergedFindings] = Field(default_factory=list)
    summary: str = ""
