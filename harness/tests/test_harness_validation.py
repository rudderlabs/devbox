"""Unit tests for harness validators and helpers."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harness.stages import Stage

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_harness():
    from harness import cli

    return cli


harness = _load_harness()
from harness import self_review as _review_module
from harness.handlers import _common, assignment
from harness.plan_utils import repo_checkout_path


class TestSlugify(unittest.TestCase):
    def test_slug_basic(self) -> None:
        title = "Add retry logging for warehouse sync failures"
        s = _common.slugify_pr_title(title, "inbox-x")
        self.assertTrue(s.startswith("add-retry-logging"))
        self.assertLessEqual(len(s), 40)

    def test_slug_max_40(self) -> None:
        long = "A" * 50
        s = _common.slugify_pr_title(long, "inbox-x")
        self.assertLessEqual(len(s), 40)


class TestValidatePlan(unittest.TestCase):
    def test_valid_minimal_empty_repos(self) -> None:
        assignment.validate_plan(
            {
                "stage": "planning",
                "run_id": "x",
                "task": "t",
                "task_key": "ABC-1",
                "status": "completed",
                "repos": [],
                "planning_notes": "n",
                "generated_at": "2026-01-01T00:00:00Z",
            },
        )

    def test_requires_linear_when_expected(self) -> None:
        with self.assertRaises(ValueError):
            assignment.validate_plan(
                {
                    "stage": "planning",
                    "run_id": "x",
                    "task": "t",
                    "status": "completed",
                    "repos": [],
                    "planning_notes": "n",
                    "generated_at": "2026-01-01T00:00:00Z",
                },
            )

    def _repo(self, **extra: object) -> dict[str, object]:
        return {
            "name": "repo-a",
            "path": "/workspace/repo-a",
            "goal": "g",
            "planned_files_or_areas": [],
            "implementation_steps": [],
            "validation_steps": [],
            "risks": [],
            **extra,
        }

    def _plan(self, repos: list[dict[str, object]]) -> dict[str, object]:
        return {
            "stage": "planning",
            "run_id": "x",
            "task": "t",
            "task_key": "ABC-1",
            "status": "completed",
            "repos": repos,
            "planning_notes": "n",
            "generated_at": "2026-01-01T00:00:00Z",
        }

    def test_accepts_optional_components(self) -> None:
        assignment.validate_plan(
            self._plan([
                self._repo(components=[{"name": "api", "path": "services/api"}])
            ])
        )

    def test_accepts_optional_review_lenses(self) -> None:
        assignment.validate_plan(
            self._plan([
                self._repo(
                    additional_review_lenses=[
                        "bug-hunter",
                        "bird-eye",
                        "security",
                        "code-quality",
                    ]
                )
            ])
        )

    def test_accepts_empty_review_lenses(self) -> None:
        assignment.validate_plan(self._plan([self._repo(additional_review_lenses=[])]))

    def test_drops_unknown_review_lens_instead_of_raising(self) -> None:
        """The field is an advisory planner hint; a stray name (the default
        planner echoing `code-review`, a typo, a non-string) must be
        normalized away, never fail the assignment."""
        plan = self._plan([
            self._repo(
                additional_review_lenses=["code-review", "made-up-lens", 42, "security"]
            )
        ])
        with contextlib.redirect_stderr(io.StringIO()) as err:
            assignment.validate_plan(plan)
        self.assertEqual(plan["repos"][0]["additional_review_lenses"], ["security"])
        self.assertIn("dropping unknown/duplicate", err.getvalue())

    def test_dedupes_duplicate_review_lens(self) -> None:
        plan = self._plan([
            self._repo(additional_review_lenses=["security", "security", "bird-eye"])
        ])
        with contextlib.redirect_stderr(io.StringIO()):
            assignment.validate_plan(plan)
        self.assertEqual(
            plan["repos"][0]["additional_review_lenses"], ["security", "bird-eye"]
        )

    def test_rejects_non_array_review_lenses(self) -> None:
        with self.assertRaises(TypeError):
            assignment.validate_plan(
                self._plan([self._repo(additional_review_lenses="security")])
            )

    def test_rejects_duplicate_repo_names(self) -> None:
        with self.assertRaises(ValueError):
            assignment.validate_plan(
                self._plan([
                    self._repo(path="/workspace/repo-a"),
                    self._repo(path="/workspace/repo-b"),
                ])
            )

    def test_accepts_duplicate_legacy_repo_paths_for_distinct_names(self) -> None:
        assignment.validate_plan(
            self._plan([
                self._repo(name="repo-a", path="/wrong/shared"),
                self._repo(name="repo-b", path="/wrong/shared"),
            ])
        )

    def test_rejects_non_bare_repo_names(self) -> None:
        for name in (
            "",
            ".",
            "..",
            "/tmp/repo-a",
            "../repo-a",
            "team/repo-a",
            "repo\\a",
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                assignment.validate_plan(self._plan([self._repo(name=name)]))

    def test_component_duplicate_paths_are_resolved_from_repo_name(self) -> None:
        with self.assertRaises(ValueError):
            assignment.validate_plan(
                self._plan([
                    self._repo(
                        name="repo-a",
                        path="/wrong/legacy-path",
                        components=[
                            {"name": "api", "path": "services/api"},
                            {
                                "name": "api-again",
                                "path": str(
                                    (
                                        assignment.WORKSPACE / "repo-a" / "services/api"
                                    ).resolve()
                                ),
                            },
                        ],
                    )
                ])
            )


class TestRepoCheckoutPath(unittest.TestCase):
    def test_resolves_direct_workspace_child(self) -> None:
        self.assertEqual(
            repo_checkout_path("repo-a"),
            (assignment.WORKSPACE / "repo-a").resolve(),
        )

    def test_rejects_names_that_escape_workspace(self) -> None:
        for name in (
            "",
            ".",
            "..",
            "/tmp/repo-a",
            "../repo-a",
            "team/repo-a",
            "repo\\a",
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                repo_checkout_path(name)


class TestValidateImplementation(unittest.TestCase):
    def test_valid(self) -> None:
        assignment.validate_implementation(
            {
                "stage": "implementation",
                "run_id": "x",
                "task": "t",
                "task_key": "ABC-1",
                "status": "completed",
                "repos": [
                    {
                        "name": "r",
                        "path": "/workspace/r",
                        "changed_files": [],
                        "summary": "s",
                        "exercise_hint": "GET /r and verify the changed element.",
                        "feature_baseline": "The existing layout still renders unchanged.",
                        "commit_message": "c",
                        "pr_title": "p",
                        "pr_body": "b",
                    }
                ],
                "generated_at": "2026-01-01T00:00:00Z",
            },
        )

    def test_rejects_non_string_implementation_metadata(self) -> None:
        for field in ("exercise_hint", "feature_baseline"):
            payload = {
                "stage": "implementation",
                "run_id": "x",
                "task": "t",
                "task_key": "ABC-1",
                "status": "completed",
                "repos": [
                    {
                        "name": "r",
                        "path": "/workspace/r",
                        "changed_files": [],
                        "summary": "s",
                        "exercise_hint": "GET /r",
                        "feature_baseline": "baseline",
                        field: ["bad"],
                        "commit_message": "c",
                        "pr_title": "p",
                        "pr_body": "b",
                    }
                ],
                "generated_at": "2026-01-01T00:00:00Z",
            }
            with self.subTest(field=field), self.assertRaises(TypeError):
                assignment.validate_implementation(payload)


class TestValidateDistillation(unittest.TestCase):
    def _base(self) -> dict[str, object]:
        return {
            "stage": "distillation",
            "run_id": "x",
            "task": "t",
            "task_key": "ABC-1",
            "repos": [],
            "generated_at": "2026-01-01T00:00:00Z",
        }

    def test_valid_empty_repos(self) -> None:
        harness.validate_distillation(self._base())

    def test_valid_eligible_only(self) -> None:
        payload = self._base()
        payload["repos"] = [
            {
                "repo": "r",
                "memory_files_read": ["inspection.md"],
                "promoted_count": 2,
                "dropped_count": 1,
                "knowledge_files_updated": ["patterns.md", "feedback.md"],
                "response_summary": "- `patterns`: Captured durable behavior.",
            }
        ]
        harness.validate_distillation(
            payload,
        )

    def test_valid_skipped_only(self) -> None:
        payload = self._base()
        payload["repos"] = [{"repo": "r", "skipped": "no .agents/knowledge/ bootstrap"}]
        harness.validate_distillation(payload)

    def test_rejects_response_summary_on_skipped_repo(self) -> None:
        payload = self._base()
        payload["repos"] = [
            {
                "repo": "r",
                "skipped": "no .agents/knowledge/ bootstrap",
                "response_summary": "- `patterns`: should not be here",
            }
        ]
        with self.assertRaises(ValueError):
            harness.validate_distillation(payload)

    def test_valid_mixed(self) -> None:
        payload = self._base()
        payload["repos"] = [
            {
                "repo": "r1",
                "memory_files_read": ["implementation.md"],
                "promoted_count": 1,
                "dropped_count": 0,
                "knowledge_files_updated": ["mistakes.md"],
            },
            {"repo": "r2", "skipped": "no .agents/knowledge/ bootstrap"},
        ]
        harness.validate_distillation(payload)

    def test_rejects_wrong_stage(self) -> None:
        payload = self._base()
        payload["stage"] = "implementation"
        with self.assertRaises(ValueError):
            harness.validate_distillation(payload)

    def test_rejects_missing_top_level_field(self) -> None:
        for field in ("stage", "run_id", "task", "repos", "generated_at"):
            payload = self._base()
            del payload[field]
            with self.assertRaises(ValueError, msg=field):
                harness.validate_distillation(payload)

    def test_rejects_repo_entry_missing_required_keys(self) -> None:
        with self.assertRaises(ValueError):
            harness.validate_distillation(
                {
                    **self._base(),
                    "repos": [{"repo": "r"}],
                },
            )
        with self.assertRaises(ValueError):
            harness.validate_distillation(
                {
                    **self._base(),
                    "repos": [{"skipped": "no bootstrap"}],
                },
            )

    def test_requires_linear_when_expected(self) -> None:
        payload = self._base()
        del payload["task_key"]
        with self.assertRaises(ValueError):
            harness.validate_distillation(payload)


class TestValidateReviewIteration(unittest.TestCase):
    def _base(self) -> dict[str, object]:
        return {
            "iteration": 1,
            "verdict": "approve",
            "summary": "looks fine",
            "findings": [],
            "next_steps": [],
            "generated_at": "2026-01-01T00:00:00Z",
        }

    def _critical_finding(self) -> dict[str, object]:
        return {
            "repo": "r",
            "severity": "critical",
            "confidence": 0.9,
            "title": "t",
            "body": "b",
            "recommendation": "r",
            "file": "src/x.ts",
            "line_start": 10,
        }

    def test_valid_empty_findings_approve(self) -> None:
        _review_module.validate_self_review_iteration(self._base())

    def test_accepts_merge_and_dispatch_metadata(self) -> None:
        payload = self._base()
        payload["merge_strategy"] = "agent"
        payload["reports"] = {"r": "## Findings\n- x"}
        payload["lens_dispatch"] = {"r": ["code-review", "security"]}
        payload["findings_truncated"] = 2
        _review_module.validate_self_review_iteration(payload)

    def test_rejects_non_string_merge_strategy(self) -> None:
        payload = self._base()
        payload["merge_strategy"] = 3
        with self.assertRaises(TypeError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_non_string_report_value(self) -> None:
        payload = self._base()
        payload["reports"] = {"r": ["not", "a", "string"]}
        with self.assertRaises(TypeError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_lens_dispatch_non_list(self) -> None:
        payload = self._base()
        payload["lens_dispatch"] = {"r": "code-review"}
        with self.assertRaises(TypeError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_bool_findings_truncated(self) -> None:
        payload = self._base()
        payload["findings_truncated"] = True
        with self.assertRaises(TypeError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_lenses_not_string_array(self) -> None:
        payload = self._base()
        payload["verdict"] = "needs-attention"
        finding = self._critical_finding()
        finding["lenses"] = ["code-review", 7]
        payload["findings"] = [finding]
        with self.assertRaises(TypeError):
            _review_module.validate_self_review_iteration(payload)

    def test_valid_with_critical(self) -> None:
        payload = self._base()
        payload["verdict"] = "needs-attention"
        payload["findings"] = [self._critical_finding()]
        _review_module.validate_self_review_iteration(payload)

    def test_iteration_optional(self) -> None:
        payload = self._base()
        del payload["iteration"]
        _review_module.validate_self_review_iteration(payload)

    def test_rejects_bad_verdict(self) -> None:
        payload = self._base()
        payload["verdict"] = "ship-it"
        with self.assertRaises(ValueError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_bad_severity(self) -> None:
        payload = self._base()
        payload["verdict"] = "needs-attention"
        bad = self._critical_finding()
        bad["severity"] = "spicy"
        payload["findings"] = [bad]
        with self.assertRaises(ValueError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_critical_without_grounding(self) -> None:
        payload = self._base()
        payload["verdict"] = "needs-attention"
        bad = self._critical_finding()
        del bad["file"]
        payload["findings"] = [bad]
        with self.assertRaises(ValueError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_high_without_line_start(self) -> None:
        payload = self._base()
        payload["verdict"] = "needs-attention"
        bad = self._critical_finding()
        bad["severity"] = "high"
        del bad["line_start"]
        payload["findings"] = [bad]
        with self.assertRaises(ValueError):
            _review_module.validate_self_review_iteration(payload)

    def test_medium_finding_does_not_require_grounding(self) -> None:
        payload = self._base()
        payload["verdict"] = "needs-attention"
        f = {
            "repo": "r",
            "severity": "medium",
            "confidence": 0.5,
            "title": "t",
            "body": "b",
            "recommendation": "r",
        }
        payload["findings"] = [f]
        _review_module.validate_self_review_iteration(payload)

    def test_rejects_confidence_out_of_range(self) -> None:
        payload = self._base()
        payload["verdict"] = "needs-attention"
        bad = self._critical_finding()
        bad["confidence"] = 1.5
        payload["findings"] = [bad]
        with self.assertRaises(ValueError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_critical_with_approve_verdict(self) -> None:
        payload = self._base()
        payload["verdict"] = "approve"
        payload["findings"] = [self._critical_finding()]
        with self.assertRaises(ValueError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_empty_findings_with_needs_attention(self) -> None:
        payload = self._base()
        payload["verdict"] = "needs-attention"
        with self.assertRaises(ValueError):
            _review_module.validate_self_review_iteration(payload)

    def test_rejects_missing_top_level_field(self) -> None:
        for field in ("verdict", "summary", "findings", "next_steps", "generated_at"):
            payload = self._base()
            del payload[field]
            with self.assertRaises(ValueError, msg=field):
                _review_module.validate_self_review_iteration(payload)


class TestValidateReview(unittest.TestCase):
    def _iter(self) -> dict[str, object]:
        return {
            "iteration": 1,
            "verdict": "approve",
            "summary": "ok",
            "findings": [],
            "next_steps": [],
            "generated_at": "2026-01-01T00:00:00Z",
        }

    def _base(self) -> dict[str, object]:
        return {
            "stage": "review",
            "run_id": "r",
            "task": "t",
            "task_key": "ABC-1",
            "iterations": [self._iter()],
            "final_verdict": "approved",
            "termination_reason": "approved",
            "iterations_run": 1,
            "max_iterations": 3,
            "unresolved_findings": [],
            "fix_iterations": [],
            "generated_at": "2026-01-01T00:00:00Z",
        }

    def _crit(self) -> dict[str, object]:
        return {
            "repo": "r",
            "severity": "critical",
            "confidence": 0.9,
            "title": "t",
            "body": "b",
            "recommendation": "r",
            "file": "x",
            "line_start": 1,
        }

    def test_valid_approved(self) -> None:
        _review_module.validate_self_review(self._base())

    def test_valid_disabled(self) -> None:
        payload = self._base()
        payload["iterations"] = []
        payload["iterations_run"] = 0
        payload["final_verdict"] = "disabled"
        payload["termination_reason"] = "disabled"
        _review_module.validate_self_review(payload)

    def test_valid_loop_exhausted_with_unresolved(self) -> None:
        crit = self._crit()
        payload = self._base()
        payload["iterations"] = [
            {**self._iter(), "verdict": "needs-attention", "findings": [crit]}
        ]
        payload["final_verdict"] = "loop_exhausted"
        payload["termination_reason"] = "max_iterations"
        payload["unresolved_findings"] = [{**crit, "disposition": "not_attempted"}]
        _review_module.validate_self_review(payload)

    def test_valid_declined_with_reason_and_fix_iterations(self) -> None:
        crit = self._crit()
        payload = self._base()
        payload["iterations"] = [
            {**self._iter(), "verdict": "needs-attention", "findings": [crit]}
        ]
        payload["final_verdict"] = "approved_with_warnings"
        payload["termination_reason"] = "declined_all"
        payload["unresolved_findings"] = [
            {**crit, "disposition": "declined", "decline_reason": "intended"}
        ]
        payload["fix_iterations"] = [
            {
                "iteration": 1,
                "decisions": [
                    {
                        "finding_id": "iter1-f1",
                        "decision": "declined",
                        "reason": "intended",
                    }
                ],
                "tree_changed": False,
                "synthesized": False,
            }
        ]
        _review_module.validate_self_review(payload)

    def test_accepts_optional_inbox_id(self) -> None:
        payload = self._base()
        payload["inbox_id"] = "inbox-1"
        _review_module.validate_self_review(payload)
        payload["inbox_id"] = 7
        with self.assertRaises(TypeError):
            _review_module.validate_self_review(payload)

    def test_rejects_wrong_stage(self) -> None:
        payload = self._base()
        payload["stage"] = "implementation"
        with self.assertRaises(ValueError):
            _review_module.validate_self_review(payload)

    def test_rejects_bad_final_verdict(self) -> None:
        payload = self._base()
        payload["final_verdict"] = "ship_it_anyway"
        with self.assertRaises(ValueError):
            _review_module.validate_self_review(payload)

    def test_rejects_bad_termination_reason(self) -> None:
        payload = self._base()
        payload["termination_reason"] = "gave_up"
        with self.assertRaises(ValueError):
            _review_module.validate_self_review(payload)

    def test_rejects_unresolved_without_disposition(self) -> None:
        crit = self._crit()
        payload = self._base()
        payload["iterations"] = [
            {**self._iter(), "verdict": "needs-attention", "findings": [crit]}
        ]
        payload["final_verdict"] = "loop_exhausted"
        payload["termination_reason"] = "max_iterations"
        payload["unresolved_findings"] = [crit]
        with self.assertRaises(ValueError):
            _review_module.validate_self_review(payload)

    def test_rejects_bad_disposition(self) -> None:
        crit = self._crit()
        payload = self._base()
        payload["iterations"] = [
            {**self._iter(), "verdict": "needs-attention", "findings": [crit]}
        ]
        payload["final_verdict"] = "loop_exhausted"
        payload["termination_reason"] = "max_iterations"
        payload["unresolved_findings"] = [{**crit, "disposition": "meh"}]
        with self.assertRaises(ValueError):
            _review_module.validate_self_review(payload)

    def test_rejects_declined_without_decline_reason(self) -> None:
        crit = self._crit()
        payload = self._base()
        payload["iterations"] = [
            {**self._iter(), "verdict": "needs-attention", "findings": [crit]}
        ]
        payload["final_verdict"] = "approved_with_warnings"
        payload["termination_reason"] = "declined_all"
        payload["unresolved_findings"] = [{**crit, "disposition": "declined"}]
        with self.assertRaises(ValueError):
            _review_module.validate_self_review(payload)

    def test_rejects_missing_top_level_field(self) -> None:
        for field in (
            "stage",
            "run_id",
            "task",
            "iterations",
            "final_verdict",
            "termination_reason",
            "iterations_run",
            "max_iterations",
            "unresolved_findings",
            "fix_iterations",
            "generated_at",
        ):
            payload = self._base()
            del payload[field]
            with self.assertRaises(ValueError, msg=field):
                _review_module.validate_self_review(payload)

    def test_requires_linear_when_expected(self) -> None:
        payload = self._base()
        del payload["task_key"]
        with self.assertRaises(ValueError):
            _review_module.validate_self_review(payload)

    def test_rejects_iterations_not_list(self) -> None:
        payload = self._base()
        payload["iterations"] = "nope"
        with self.assertRaises(TypeError):
            _review_module.validate_self_review(payload)

    def test_rejects_fix_iterations_not_list(self) -> None:
        payload = self._base()
        payload["fix_iterations"] = "nope"
        with self.assertRaises(TypeError):
            _review_module.validate_self_review(payload)


class TestValidateReviewFixIteration(unittest.TestCase):
    def _base(self) -> dict[str, object]:
        return {
            "stage": "review-fix",
            "iteration": 1,
            "decisions": [
                {
                    "finding_id": "iter1-f1",
                    "decision": "fixed",
                    "reason": "swapped exec for execFile",
                    "files_changed": ["src/x.ts"],
                },
                {
                    "finding_id": "iter1-f2",
                    "decision": "declined",
                    "reason": "intended per plan",
                },
            ],
            "generated_at": "2026-01-01T00:00:00Z",
        }

    def _ids(self) -> set[str]:
        return {"iter1-f1", "iter1-f2"}

    def test_valid(self) -> None:
        _review_module.validate_review_fix_iteration(self._base(), self._ids())

    def test_rejects_missing_finding_id_coverage(self) -> None:
        payload = self._base()
        payload["decisions"] = payload["decisions"][:1]
        with self.assertRaises(ValueError):
            _review_module.validate_review_fix_iteration(payload, self._ids())

    def test_rejects_unknown_finding_id(self) -> None:
        payload = self._base()
        payload["decisions"][1]["finding_id"] = "iter9-f9"
        with self.assertRaises(ValueError):
            _review_module.validate_review_fix_iteration(payload, self._ids())

    def test_rejects_duplicate_finding_id(self) -> None:
        payload = self._base()
        payload["decisions"][1]["finding_id"] = "iter1-f1"
        with self.assertRaises(ValueError):
            _review_module.validate_review_fix_iteration(payload, self._ids())

    def test_rejects_bad_decision(self) -> None:
        payload = self._base()
        payload["decisions"][0]["decision"] = "punted"
        with self.assertRaises(ValueError):
            _review_module.validate_review_fix_iteration(payload, self._ids())

    def test_rejects_empty_reason(self) -> None:
        payload = self._base()
        payload["decisions"][1]["reason"] = "  "
        with self.assertRaises(ValueError):
            _review_module.validate_review_fix_iteration(payload, self._ids())

    def test_rejects_decisions_not_list(self) -> None:
        payload = self._base()
        payload["decisions"] = "nope"
        with self.assertRaises(TypeError):
            _review_module.validate_review_fix_iteration(payload, self._ids())

    def test_rejects_missing_top_level_field(self) -> None:
        for field in ("iteration", "decisions", "generated_at"):
            payload = self._base()
            del payload[field]
            with self.assertRaises(ValueError, msg=field):
                _review_module.validate_review_fix_iteration(payload, self._ids())


class TestPlanMarkdown(unittest.TestCase):
    def test_empty_repos(self) -> None:
        md = assignment.plan_json_to_markdown({
            "repos": [],
            "planning_notes": "none",
            "run_id": "r",
            "task": "t",
        })
        self.assertIn("No repository changes", md)


class TestStageNames(unittest.TestCase):
    def test_stage_enum_values_match_observability_contract(self) -> None:
        self.assertEqual(Stage.PLANNING, "planning")
        self.assertEqual(Stage.IMPLEMENTATION, "implementation")
        self.assertEqual(Stage.DISTILLATION, "distillation")
        self.assertEqual(Stage.REVIEW, "review")
        self.assertEqual(Stage.REVIEW_FIX, "review-fix")
        self.assertEqual(Stage.COMMENT, "comment")
        self.assertEqual(Stage.USER_REVIEW, "user-review")


def _load_harness_with_workspace(workspace: Path, module_name: str):
    """Reload handlers.assignment with WORKSPACE pointed at *workspace*.

    The module-level constants (WORKSPACE, HARNESS_DIR, ...) are captured at
    import time, so we must re-import with a controlled env each time. The
    assignment-pipeline helpers (setup_workspace, implementation prompt assembly, ...)
    live in harness.handlers.assignment,
    so the returned module is a fresh copy of it. Clears
    harness.paths/util/memory/distillation/cli/handlers.assignment from
    sys.modules first so harness.paths picks up the new WORKSPACE on its fresh
    import.
    """
    env = {"WORKSPACE": str(workspace)}
    with patch.dict(os.environ, env, clear=False):
        for mod_name in (
            "harness.paths",
            "harness.util",
            "harness.memory",
            "harness.distillation",
            "harness.cli",
            "harness.handlers.assignment",
        ):
            sys.modules.pop(mod_name, None)
        path = REPO_ROOT / "src" / "harness" / "handlers" / "assignment.py"
        spec = importlib.util.spec_from_file_location(module_name, path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = mod
        spec.loader.exec_module(mod)
        return mod


class TestSetupWorkspace(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_syncs_repos_before_writing_session(self) -> None:
        h = _load_harness_with_workspace(self.ws, "harness_sync_repos")
        events: list[str] = []

        def sync_all(_workspace):
            events.append("sync")
            return []

        def write_session(*_args):
            events.append("write_session")

        with (
            patch.object(h, "SYNC_REPOS_BEFORE_PLANNING", True),
            patch.object(h, "sync_all_repos_from_origin", side_effect=sync_all) as sync,
            patch.object(h, "write_session", side_effect=write_session),
        ):
            h.setup_workspace(task_key=None, run_id="r1", task="t")
        sync.assert_called_once_with(h.WORKSPACE)
        self.assertEqual(events, ["sync", "write_session"])

    def test_skips_repo_sync_when_flag_disabled(self) -> None:
        h = _load_harness_with_workspace(self.ws, "harness_sync_repos_off")
        with (
            patch.object(h, "SYNC_REPOS_BEFORE_PLANNING", False),
            patch.object(h, "sync_all_repos_from_origin") as sync_all,
        ):
            h.setup_workspace(task_key=None, run_id="r1", task="t")
        sync_all.assert_not_called()


class TestReviewPromptGuidance(unittest.TestCase):
    def test_review_lens_agent_rejects_unknown_lens(self) -> None:
        from unittest.mock import MagicMock

        from harness.deepagents.agents.review import ReviewLensAgent

        with self.assertRaises(ValueError):
            ReviewLensAgent(
                model=MagicMock(),
                repo_path=Path("/tmp/nope"),
                thread_id="t",
                lens="made-up",
                events=None,
            )

    def test_severity_roster_is_single_sourced(self) -> None:
        from harness.schemas.common import (
            GROUNDING_SEVERITIES,
            REVIEW_LENSES,
            REVIEW_SEVERITIES,
        )

        self.assertEqual(REVIEW_SEVERITIES, ("critical", "high", "medium", "low"))
        self.assertTrue(GROUNDING_SEVERITIES <= set(REVIEW_SEVERITIES))
        self.assertEqual(set(_review_module._VALID_SEVERITIES), set(REVIEW_SEVERITIES))
        self.assertEqual(
            _review_module._SEVERITY_RANK["critical"],
            len(REVIEW_SEVERITIES) - 1,
        )
        self.assertEqual(REVIEW_LENSES[0], "code-review")

    def test_review_lens_prompt_forbids_quality_gates(self) -> None:
        """Lenses must not re-run the repo's gates: the implementation stage
        already ran them on the same diff, and parallel lenses each re-running
        jest/tsc has OOM-killed and TTL-expired sandboxes."""
        from harness.deepagents.agents.review import (
            REVIEW_FIX_SYSTEM_PROMPT,
            REVIEW_SYSTEM_PROMPT_TEMPLATE,
        )

        lens = REVIEW_SYSTEM_PROMPT_TEMPLATE.format(read_discipline="")
        self.assertIn("Do not run the repository's test suite", lens)
        for gate in (
            "`npm test`",
            "`jest`",
            "`tsc`",
            "`npm run typecheck`",
            "`eslint`",
        ):
            self.assertIn(gate, lens)
        self.assertIn("throwaway repro script", lens)
        # The fixer keeps its narrower rule: no full gates, targeted checks ok.
        self.assertIn("Do not re-run full quality gates", REVIEW_FIX_SYSTEM_PROMPT)
        self.assertIn(
            "If a finding asks for a human decision rather than a code change",
            REVIEW_FIX_SYSTEM_PROMPT,
        )

    def test_lens_mandates_cover_all_lenses(self) -> None:
        """LENS_MANDATES must define exactly the base + optional lens roster
        the harness can dispatch (drift guard against schemas.review)."""
        from harness.deepagents.agents.review import LENS_MANDATES
        from harness.schemas.review import (
            BASE_REVIEW_LENSES,
            OPTIONAL_REVIEW_LENSES,
        )

        self.assertEqual(
            set(LENS_MANDATES),
            set(BASE_REVIEW_LENSES) | set(OPTIONAL_REVIEW_LENSES),
        )

    def test_code_review_lens_prioritizes_visual_layout_regressions(self) -> None:
        from harness.deepagents.agents.review import LENS_MANDATES

        mandate = LENS_MANDATES["code-review"]
        self.assertIn("visual / layout regression", mandate)
        self.assertIn("shifts,", mandate)
        self.assertIn("collapses, hides, or repositions", mandate)

    def test_lens_mandates_keep_depth_and_proof_requirements(self) -> None:
        from harness.deepagents.agents.review import LENS_MANDATES

        bug_hunter = LENS_MANDATES["bug-hunter"]
        self.assertIn("Decorators/annotations", bug_hunter)
        self.assertIn("Tests are claims, not evidence", bug_hunter)
        bird_eye = LENS_MANDATES["bird-eye"]
        self.assertIn("Second hop", bird_eye)
        security = LENS_MANDATES["security"]
        self.assertIn("attacker-controllable entry point", security)
        code_quality = LENS_MANDATES["code-quality"]
        self.assertIn("structural problems with a concrete blast radius", code_quality)

    def test_review_system_prompt_keeps_read_only_constraint(self) -> None:
        from harness.deepagents.agents.review import (
            REVIEW_SYSTEM_PROMPT_TEMPLATE,
        )

        self.assertIn(
            "any command that dirties `git status`", REVIEW_SYSTEM_PROMPT_TEMPLATE
        )
        self.assertIn("THROUGH YOUR ASSIGNED LENS ONLY", REVIEW_SYSTEM_PROMPT_TEMPLATE)
        self.assertIn("{read_discipline}", REVIEW_SYSTEM_PROMPT_TEMPLATE)
        self.assertIn("strongest 5 findings", REVIEW_SYSTEM_PROMPT_TEMPLATE)
        # Concur-or-escalate contract for previously declined findings.
        self.assertIn("prior_finding_id", REVIEW_SYSTEM_PROMPT_TEMPLATE)

    def test_fix_brief_has_no_severity_gate_language(self) -> None:
        """The fix pass triages every actionable finding without instructing
        the implementer to skip medium or low findings."""
        from harness.self_review import assemble_fix_brief

        brief = assemble_fix_brief(
            task="t",
            task_key="ABC-1",
            run_id="r1",
            iteration=1,
            repo_name="config-backend",
            findings=[],
            current_summary="s",
        )
        self.assertNotIn("Do not fix `medium`", brief)
        self.assertNotIn("loop-trigger", brief.lower())
        self.assertIn("Do not decline on severity alone", brief)
        self.assertIn("Triage each one on its merits", brief)
        self.assertNotIn("fresh session", brief)
        self.assertIn("exactly one entry per finding `id`", brief)
        self.assertIn("declined", brief)


class TestDeterministicSlug(unittest.TestCase):
    def test_suffix_is_stable_for_same_inbox_id(self) -> None:
        from harness.handlers._common import slugify_pr_title

        a = slugify_pr_title("Add thing", "inbox-1")
        b = slugify_pr_title("Add thing", "inbox-1")
        self.assertEqual(a, b)

    def test_suffix_differs_for_different_inbox_id(self) -> None:
        from harness.handlers._common import slugify_pr_title

        a = slugify_pr_title("Add thing", "inbox-1")
        b = slugify_pr_title("Add thing", "inbox-2")
        self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main()
