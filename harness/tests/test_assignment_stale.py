"""Reassignment stale-artifact cleanup.

A workspace persists across reassignments (same Linear ticket, new inbox_id), so
artifacts from a prior assignment can linger on disk. `_assignment_artifact_reusable`
must discard a stamped-for-another-inbox artifact AND every downstream artifact —
or a later stage reuses a previous assignment's review or distillation.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import harness.handlers.assignment as a
from harness.paths import (
    DISTILLATION_JSON,
    IMPLEMENTATION_JSON,
    REVIEW_JSON,
    REVIEW_STATE_JSON,
)
from harness.util import write_json


class TestStalePathConstants(unittest.TestCase):
    """Every downstream artifact must be in the cleanup sets, so none of them
    survives a reassignment."""

    def test_post_impl_covers_downstream_artifacts(self) -> None:
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(a, "HARNESS_DIR", Path(tmp)),
        ):
            post_impl = a._post_impl_stale()
        self.assertEqual(post_impl, (REVIEW_JSON, REVIEW_STATE_JSON, DISTILLATION_JSON))

    def test_post_impl_covers_review_iteration_artifacts(self) -> None:
        """Per-iteration review and fix-decision files must be discarded on
        reassignment too — they are globbed at call time, not constants."""
        with tempfile.TemporaryDirectory() as tmp:
            td = Path(tmp)
            iter_files = [
                td / "review-iter-1.json",
                td / "review-iter-2.json",
                td / "review-fix-iter-1.json",
            ]
            for p in iter_files:
                p.write_text("{}")
            with patch.object(a, "HARNESS_DIR", td):
                post_impl = a._post_impl_stale()
            for p in iter_files:
                self.assertIn(p, post_impl)

    def test_post_plan_extends_post_impl_with_implementation(self) -> None:
        post_plan = a._post_plan_stale()
        self.assertIn(IMPLEMENTATION_JSON, post_plan)
        for p in a._post_impl_stale():
            self.assertIn(p, post_plan)


class TestAssignmentArtifactReusable(unittest.TestCase):
    def test_stale_inbox_unlinks_all_downstream(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            td = Path(tmp)
            plan = td / "plan.json"
            downstream = [td / name for name in ("impl.json", "review.json", "fv.json")]
            fingerprint = td / "fp.txt"
            for p in downstream:
                write_json(p, {"k": 1})
            fingerprint.write_text("deadbeef")
            # plan stamped for a DIFFERENT inbox -> stale reassignment state.
            write_json(plan, {"inbox_id": "OLD", "stage": "planning"})

            reusable = a._assignment_artifact_reusable(
                plan,
                "NEW",
                lambda d: None,
                stale_paths=(*downstream, fingerprint),
            )

            self.assertFalse(reusable)
            self.assertFalse(plan.exists())
            for p in (*downstream, fingerprint):
                self.assertFalse(p.exists(), f"{p.name} should have been unlinked")

    def test_rejected_unstamped_artifact_unlinks_all_downstream(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            td = Path(tmp)
            impl = td / "implementation.json"
            downstream = [td / name for name in ("review.json", "distillation.json")]
            fingerprint = td / "inner-verify-fingerprint.txt"
            write_json(impl, {"stage": "implementation"})
            for p in downstream:
                write_json(p, {"k": 1})
            fingerprint.write_text("deadbeef")

            reusable = a._assignment_artifact_reusable(
                impl,
                "CURRENT",
                lambda d: None,
                stale_paths=(*downstream, fingerprint),
            )

            self.assertFalse(reusable)
            self.assertFalse(impl.exists())
            for p in (*downstream, fingerprint):
                self.assertFalse(p.exists(), f"{p.name} should have been unlinked")

    def test_same_inbox_keeps_everything(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            td = Path(tmp)
            plan = td / "plan.json"
            fv = td / "fv.json"
            write_json(fv, {"k": 1})
            write_json(plan, {"inbox_id": "SAME", "stage": "planning"})

            reusable = a._assignment_artifact_reusable(
                plan, "SAME", lambda d: None, stale_paths=(fv,)
            )

            self.assertTrue(reusable)
            self.assertTrue(plan.exists())
            self.assertTrue(fv.exists())


if __name__ == "__main__":
    unittest.main()
