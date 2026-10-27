"""Stage timing around the assignment's planning and implementation stages.

Each stage emits exactly one `harness.stage_duration` event when it does work,
and none when it reuses an artifact from a prior attempt.
"""

from __future__ import annotations

import unittest
from typing import Any
from unittest.mock import MagicMock, patch

import harness.handlers.assignment as assignment_module
import harness.planning as planning_module
import harness.schemas as schemas_module
from harness import obs

_PLAN = {"run_id": "run-1", "task_key": "ABC-1", "repos": []}
_IMPL = {"run_id": "run-1", "repos": [{"name": "r"}]}


class _Capture:
    """Collects the stage-duration events and the order of stage work."""

    def __init__(self) -> None:
        self.order: list[str] = []
        self.events: list[dict[str, Any]] = []
        self.raised: Exception | None = None

    def log_event(self, event: str, **fields: Any) -> None:
        if event == obs.STAGE_DURATION_EVENT:
            self.order.append("timed")
            self.events.append(fields)

    def work(self, name: str, result: Any = None, exc: Exception | None = None):
        def _side_effect(*_args: Any, **_kwargs: Any) -> Any:
            self.order.append(name)
            if exc is not None:
                raise exc
            return result

        return _side_effect


class TestPlanningStageTiming(unittest.TestCase):
    def _run(
        self,
        *,
        reusable: bool = False,
        planning_error: Exception | None = None,
    ) -> _Capture:
        cap = _Capture()
        plan = MagicMock()
        plan.model_dump.return_value = dict(_PLAN)
        with (
            patch.object(
                assignment_module,
                "_assignment_artifact_reusable",
                return_value=reusable,
            ),
            patch.object(assignment_module, "load_json_file", return_value=dict(_PLAN)),
            patch.object(
                planning_module,
                "run_planning",
                side_effect=cap.work("deepagents", plan, planning_error),
            ),
            patch.object(assignment_module, "validate_plan"),
            patch.object(assignment_module, "write_json"),
            patch.object(assignment_module, "_atomic_write"),
            patch.object(assignment_module, "plan_json_to_markdown", return_value=""),
            patch.object(obs, "log_event", side_effect=cap.log_event),
        ):
            try:
                assignment_module._run_planning_stage(
                    "task",
                    "ABC-1",
                    "run-1",
                    "inbox-1",
                    events=None,
                )
            except RuntimeError as exc:
                cap.raised = exc
        return cap

    def test_deepagents_planning_emits_one_event(self) -> None:
        cap = self._run()
        self.assertEqual(cap.order, ["deepagents", "timed"])
        [event] = cap.events
        self.assertEqual(event["harness_stage"], "planning")
        self.assertEqual(event["outcome"], "ok")
        self.assertEqual(event["harness_run_id"], "run-1")
        self.assertEqual(event["harness_task_key"], "ABC-1")

    def test_reused_plan_emits_nothing(self) -> None:
        cap = self._run(reusable=True)
        self.assertEqual(cap.events, [])

    def test_failed_planning_emits_error_and_reraises(self) -> None:
        cap = self._run(planning_error=RuntimeError("boom"))
        self.assertIsNotNone(cap.raised)
        self.assertEqual([e["outcome"] for e in cap.events], ["error"])


class TestPlanningStageOutcome(unittest.TestCase):
    """Validation and persistence are planning work: their failures are errors."""

    def _run(self, plan_data: dict[str, Any], *, write_error: Exception | None = None):
        events: list[dict[str, Any]] = []

        def record(event: str, **fields: Any) -> None:
            if event == obs.STAGE_DURATION_EVENT:
                events.append(fields)

        plan = MagicMock()
        plan.model_dump.return_value = plan_data
        with (
            patch.object(
                assignment_module, "_assignment_artifact_reusable", return_value=False
            ),
            patch.object(planning_module, "run_planning", return_value=plan),
            patch.object(assignment_module, "write_json", side_effect=write_error),
            patch.object(assignment_module, "_atomic_write"),
            patch.object(obs, "log_event", side_effect=record),
            self.assertRaises(Exception) as raised,
        ):
            assignment_module._run_planning_stage(
                "task", "ABC-1", "run-1", "inbox-1", events=None
            )
        return raised.exception, events

    def test_invalid_plan_emits_one_error_event(self) -> None:
        # The real validator rejects the planner's artifact.
        exc, events = self._run({"run_id": "run-1"})
        self.assertIsInstance(exc, (TypeError, ValueError))
        self.assertEqual([e["outcome"] for e in events], ["error"])
        self.assertEqual(events[0]["harness_stage"], "planning")

    def test_failed_plan_write_emits_one_error_event(self) -> None:
        with patch.object(assignment_module, "validate_plan"):
            exc, events = self._run(dict(_PLAN), write_error=OSError("disk full"))
        self.assertIsInstance(exc, OSError)
        self.assertEqual([e["outcome"] for e in events], ["error"])


class TestImplementationStageTiming(unittest.TestCase):
    def _run(
        self,
        *,
        reusable: bool,
        worker_error: Exception | None = None,
    ) -> _Capture:
        cap = _Capture()
        impl = dict(_IMPL)
        with (
            patch.object(
                assignment_module,
                "_assignment_artifact_reusable",
                return_value=reusable,
            ),
            patch.object(assignment_module, "load_json_file", return_value=impl),
            patch(
                "harness.implementation.run_implementation",
                side_effect=cap.work("workers", exc=worker_error),
            ),
            patch.object(schemas_module, "Plan"),
            patch.object(
                assignment_module,
                "_finalize_implementation_artifact",
                side_effect=cap.work("finalize", impl),
            ),
            patch.object(obs, "log_event", side_effect=cap.log_event),
        ):
            try:
                assignment_module._run_implementation_stage(
                    "ABC-1",
                    "run-1",
                    "inbox-1",
                    dict(_PLAN),
                    events=None,
                )
            except RuntimeError as exc:
                cap.raised = exc
        return cap

    def test_fresh_implementation_times_the_workers(self) -> None:
        cap = self._run(reusable=False)
        self.assertEqual(cap.order, ["workers", "finalize", "timed"])
        [event] = cap.events
        self.assertEqual(event["harness_stage"], "implementation")
        self.assertEqual(event["outcome"], "ok")
        self.assertEqual(event["harness_run_id"], "run-1")
        self.assertEqual(event["harness_task_key"], "ABC-1")

    def test_failed_workers_emit_error_and_reraise(self) -> None:
        cap = self._run(reusable=False, worker_error=RuntimeError("boom"))
        self.assertIsNotNone(cap.raised)
        self.assertEqual([e["outcome"] for e in cap.events], ["error"])

    def test_reused_artifact_emits_nothing(self) -> None:
        cap = self._run(reusable=True)
        self.assertEqual(cap.order, ["finalize"])


if __name__ == "__main__":
    unittest.main()
