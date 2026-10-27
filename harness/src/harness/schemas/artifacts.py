"""Pydantic contracts for stage artifacts."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class HarnessArtifact(BaseModel):
    """Base contract that preserves future metadata fields."""

    model_config = ConfigDict(extra="allow")


class PlanComponent(HarnessArtifact):
    name: str
    path: str


class PlanRepo(HarnessArtifact):
    name: str
    # Deprecated legacy field kept for schema compatibility. Runtime consumers
    # derive the checkout root from WORKSPACE / name instead of trusting this.
    path: str = Field(
        description="Deprecated legacy path; consumers derive from WORKSPACE / name."
    )
    goal: str
    planned_files_or_areas: list[Any] = Field(default_factory=list)
    implementation_steps: list[Any] = Field(default_factory=list)
    validation_steps: list[Any] = Field(default_factory=list)
    risks: list[Any] = Field(default_factory=list)
    components: list[PlanComponent] = Field(default_factory=list)
    additional_review_lenses: list[str] = Field(default_factory=list)


class Plan(HarnessArtifact):
    stage: Literal["planning"]
    run_id: str
    task: str
    status: str
    repos: list[PlanRepo]
    planning_notes: str
    generated_at: str
    task_key: str | None = None


class ImplementationRepo(HarnessArtifact):
    name: str
    # Deprecated legacy field kept for schema compatibility. The harness emits it
    # as WORKSPACE / name and consumers should not treat it as authoritative.
    path: str = Field(
        description="Deprecated legacy path; emitted from WORKSPACE / name."
    )
    changed_files: list[str] = Field(default_factory=list)
    summary: str
    exercise_hint: str = Field(default_factory=str)
    feature_baseline: str = Field(default_factory=str)
    design_notes: str = Field(default_factory=str)
    commit_message: str
    pr_title: str
    pr_body: str


class Implementation(HarnessArtifact):
    stage: Literal["implementation"]
    run_id: str
    task: str
    status: str
    repos: list[ImplementationRepo]
    generated_at: str
    task_key: str | None = None


class RepoImplementationOutput(ImplementationRepo):
    """Structured output returned by a single per-repo DeepAgents worker."""


class DistillationRepo(HarnessArtifact):
    repo: str
    memory_files_read: list[str] = Field(default_factory=list)
    promoted_count: int
    dropped_count: int
    knowledge_files_updated: list[str] = Field(default_factory=list)
    response_summary: str | None = None
    dropped_examples: list[str] | None = None
    error: str | None = None


class DistillationSkippedRepo(HarnessArtifact):
    repo: str
    skipped: str
    memory_files_present: list[str] = Field(default_factory=list)


class Distillation(HarnessArtifact):
    stage: Literal["distillation"]
    run_id: str
    task: str
    task_key: str
    repos: list[DistillationRepo | DistillationSkippedRepo]
    generated_at: str
