"""Schema parity tests for canonical Pydantic artifact contracts."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.handlers.assignment import validate_implementation, validate_plan
from harness.schemas import (
    DistillationRepo,
    Implementation,
    ImplementationRepo,
    MergedFindingsOutput,
    OrientationOutput,
    Plan,
    PlanIssue,
    PlanRepo,
    PlanReviewOutput,
    RepoImplementationOutput,
    RepoPlanOutput,
    RepoReviewFixOutput,
    ReviewLensOutput,
)

# Every Pydantic model passed through provider-native strict structured output
# (see ProviderStrategy(..., strict=True) in harness/deepagents/session.py).
# OpenAI's strict structured-output API validates the compiled JSON schema
# server-side and rejects any schema node lacking a `type` key (or `$ref`,
# `anyOf`, `oneOf`); local helpers -- including langchain's client-side
# `_convert_to_openai_response_format` and openai's own
# `to_strict_json_schema` -- accept the broken schema, so only a live 400
# from OpenAI or a test that walks the compiled schema catches this. Keep
# this tuple in sync with `response_format=` call sites.
STRUCTURED_OUTPUT_MODELS = (
    DistillationRepo,
    MergedFindingsOutput,
    OrientationOutput,
    PlanReviewOutput,
    RepoImplementationOutput,
    RepoPlanOutput,
    RepoReviewFixOutput,
    ReviewLensOutput,
)
# Models that extend StrictOutputModel (planning and review stages); the
# normalization they inherit is asserted directly.
STRICT_PLANNING_OUTPUT_MODELS = (
    MergedFindingsOutput,
    OrientationOutput,
    PlanReviewOutput,
    RepoPlanOutput,
    RepoReviewFixOutput,
    ReviewLensOutput,
)


def _find_typeless_items(schema: object, path: str = "$") -> list[str]:
    """Recursively find `items` schema nodes that lack a discriminating key.

    Pydantic emits `items: {}` (no `type`/`$ref`/`anyOf`/`oneOf`) for
    `list[Any]` fields. That empty schema node is the construct OpenAI's
    strict structured-output validation rejects server-side.
    """
    offenders: list[str] = []
    if isinstance(schema, dict):
        items = schema.get("items")
        if isinstance(items, dict) and not (
            {"type", "$ref", "anyOf", "oneOf"} & items.keys()
        ):
            offenders.append(f"{path}.items")
        for key, value in schema.items():
            offenders.extend(_find_typeless_items(value, f"{path}.{key}"))
    elif isinstance(schema, list):
        for index, value in enumerate(schema):
            offenders.extend(_find_typeless_items(value, f"{path}[{index}]"))
    return offenders


def _find_strict_schema_violations(schema: object, path: str = "$") -> list[str]:
    """Find object/default/$ref constructs rejected by OpenAI strict schemas."""
    violations: list[str] = []
    if isinstance(schema, dict):
        if "default" in schema:
            violations.append(f"{path}.default")
        # Strict mode rejects any keyword beside `$ref` (e.g. a field
        # `description` on a nested-model field): "$ref cannot have keywords".
        if "$ref" in schema and len(schema) > 1:
            violations.append(f"{path}.$ref")
        properties = schema.get("properties")
        if isinstance(properties, dict):
            if schema.get("additionalProperties") is not False:
                violations.append(f"{path}.additionalProperties")
            if set(schema.get("required", [])) != set(properties):
                violations.append(f"{path}.required")
        for key, value in schema.items():
            violations.extend(_find_strict_schema_violations(value, f"{path}.{key}"))
    elif isinstance(schema, list):
        for index, value in enumerate(schema):
            violations.extend(_find_strict_schema_violations(value, f"{path}[{index}]"))
    return violations


def _plan() -> dict:
    return {
        "stage": "planning",
        "run_id": "r1",
        "task": "do work",
        "task_key": "ABC-1",
        "status": "completed",
        "repos": [
            {
                "name": "repo-a",
                "path": "/workspace/repo-a",
                "goal": "change repo a",
                "planned_files_or_areas": ["src"],
                "implementation_steps": ["edit"],
                "validation_steps": ["test"],
                "risks": ["risk"],
                "components": [{"name": "api", "path": "services/api"}],
                "extra_repo_field": {"kept": True},
            }
        ],
        "planning_notes": "notes",
        "extra_plan_field": {"kept": True},
        "generated_at": "2026-06-25T00:00:00Z",
    }


def _implementation() -> dict:
    return {
        "stage": "implementation",
        "run_id": "r1",
        "task": "do work",
        "task_key": "ABC-1",
        "status": "completed",
        "repos": [
            {
                "name": "repo-a",
                "path": "/workspace/repo-a",
                "changed_files": ["src/a.py"],
                "summary": "changed a",
                "exercise_hint": "GET /repo-a and verify the changed banner.",
                "feature_baseline": "The repo-a landing page layout remains unchanged.",
                "commit_message": "feat: change a",
                "pr_title": "feat: change a",
                "pr_body": "## Summary\n- changed a\n\n## Validation\n- test",
                "extra_repo_field": {"kept": True},
            }
        ],
        "generated_at": "2026-06-25T00:00:00Z",
    }


class TestSchemas(unittest.TestCase):
    def test_plan_schema_round_trips_and_validator_accepts(self) -> None:
        data = _plan()
        model = Plan.model_validate(data)
        dumped = model.model_dump(mode="json", exclude_none=True)
        self.assertEqual(dumped["repos"][0]["extra_repo_field"], {"kept": True})
        self.assertEqual(dumped["extra_plan_field"], {"kept": True})
        validate_plan(dumped)

    def test_plan_schema_properties_are_exactly_the_planning_fields(self) -> None:
        # The planning output carries no integration-verification hint.
        self.assertEqual(
            sorted(Plan.model_json_schema()["properties"]),
            [
                "generated_at",
                "planning_notes",
                "repos",
                "run_id",
                "stage",
                "status",
                "task",
                "task_key",
            ],
        )

    def test_implementation_schema_round_trips_and_validator_accepts(self) -> None:
        data = _implementation()
        model = Implementation.model_validate(data)
        dumped = model.model_dump(mode="json", exclude_none=True)
        self.assertEqual(dumped["repos"][0]["extra_repo_field"], {"kept": True})
        self.assertEqual(
            dumped["repos"][0]["exercise_hint"],
            "GET /repo-a and verify the changed banner.",
        )
        self.assertEqual(
            dumped["repos"][0]["feature_baseline"],
            "The repo-a landing page layout remains unchanged.",
        )
        validate_implementation(dumped)

    def test_repo_implementation_output_has_no_ready_to_commit_field(self) -> None:
        self.assertNotIn("ready_to_commit", ImplementationRepo.model_fields)
        self.assertNotIn("ready_to_commit", RepoImplementationOutput.model_fields)

    def test_implementation_metadata_fields_are_default_empty_without_schema_defaults(
        self,
    ) -> None:
        repo = ImplementationRepo.model_validate({
            "name": "repo-a",
            "path": "/workspace/repo-a",
            "summary": "changed a",
            "commit_message": "feat: change a",
            "pr_title": "feat: change a",
            "pr_body": "## Summary\n- changed a",
        })
        self.assertEqual(repo.exercise_hint, "")
        self.assertEqual(repo.feature_baseline, "")

        schema_properties = RepoImplementationOutput.model_json_schema()["properties"]
        self.assertNotIn("default", schema_properties["exercise_hint"])
        self.assertNotIn("default", schema_properties["feature_baseline"])

    def test_distillation_repo_response_summary_round_trips(self) -> None:
        repo = DistillationRepo.model_validate({
            "repo": "repo-a",
            "memory_files_read": ["feedback.md"],
            "promoted_count": 1,
            "dropped_count": 0,
            "knowledge_files_updated": ["feedback.md"],
            "response_summary": "- `feedback`: Captured reviewer preference.",
        })
        self.assertEqual(
            repo.model_dump(mode="json", exclude_none=True)["response_summary"],
            "- `feedback`: Captured reviewer preference.",
        )

    def test_repo_path_fields_remain_required_but_marked_legacy(self) -> None:
        self.assertIn(
            "Deprecated legacy path", PlanRepo.model_fields["path"].description
        )
        self.assertIn(
            "Deprecated legacy path",
            ImplementationRepo.model_fields["path"].description,
        )

    def test_deepagents_planning_schemas_round_trip(self) -> None:
        orientation = OrientationOutput.model_validate({
            "repos": [
                {
                    "name": "repo-a",
                    "confidence": "high",
                    "components": [{"name": "api", "path": "services/api"}],
                }
            ],
            "orientation_notes": "notes",
            "cross_repo_assumptions": ["api compatible"],
        })
        self.assertEqual(orientation.repos[0].components[0].path, "services/api")

        repo_plan = RepoPlanOutput.model_validate({
            "goal": "change repo a",
            "components": [{"name": "api", "path": "services/api"}],
        })
        self.assertEqual(repo_plan.goal, "change repo a")
        self.assertEqual(repo_plan.components[0].path, "services/api")

        review = PlanReviewOutput.model_validate({
            "status": "needs_revision",
            "issues": [{"repo": "repo-a", "summary": "missing contract"}],
        })
        self.assertIsInstance(review.issues[0], PlanIssue)

    def test_plan_review_needs_revision_requires_signal(self) -> None:
        with self.assertRaises(ValueError):
            PlanReviewOutput.model_validate({"status": "needs_revision"})

    def test_planning_outputs_are_openai_strict_schemas(self) -> None:
        violations: list[str] = []
        for model in STRICT_PLANNING_OUTPUT_MODELS:
            for path in _find_strict_schema_violations(model.model_json_schema()):
                violations.append(f"{model.__name__}: {path}")
        self.assertEqual(violations, [])

    def test_planning_outputs_reject_unknown_fields(self) -> None:
        with self.assertRaises(ValueError):
            OrientationOutput.model_validate({"unexpected": True})

    def test_structured_output_models_have_no_typeless_items(self) -> None:
        offenders: list[str] = []
        for model in STRUCTURED_OUTPUT_MODELS:
            schema = model.model_json_schema()
            for path in _find_typeless_items(schema):
                offenders.append(f"{model.__name__}: {path}")
        self.assertEqual(
            offenders,
            [],
            f"Found type-less 'items' schema nodes (from Any/list[Any] fields) "
            f"that OpenAI strict response_format validation rejects: {offenders}",
        )


if __name__ == "__main__":
    unittest.main()
