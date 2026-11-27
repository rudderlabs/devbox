"""Tests for the stage hooks: saved results, extensions and PR sections."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, ClassVar
from unittest.mock import patch

import harness.handlers.assignment as assignment_module
from harness.daemon import DaemonState, process_one_inbox_file
from harness.events import RoundEvents
from harness.plugins import (
    HookResult,
    Plugin,
    PluginContext,
    PrSection,
    RoundPlugins,
    TaskInfo,
    hook,
    round_plugins,
)
from harness.plugins.testing import registry_for


def _plan() -> dict[str, Any]:
    return {
        "stage": "planning",
        "run_id": "run-1",
        "task": "Do the thing",
        "status": "completed",
        "task_key": "ABC-1",
        "repos": [],
        "planning_notes": "",
        "generated_at": "2026-01-01T00:00:00Z",
        "inbox_id": "inbox-1",
    }


def _impl() -> dict[str, Any]:
    return {
        "stage": "implementation",
        "run_id": "run-1",
        "task": "Do the thing",
        "status": "completed",
        "task_key": "ABC-1",
        "generated_at": "2026-01-01T00:00:00Z",
        "inbox_id": "inbox-1",
        "repos": [
            {
                "name": "repo-a",
                "path": "/workspace/repo-a",
                "changed_files": ["a.py"],
                "summary": "s",
                "commit_message": "feat: a",
                "pr_title": "A",
                "pr_body": "Body of the change.\n",
            }
        ],
    }


class Recorder(Plugin):
    """Handles every stage hook and records each call."""

    name = "acme.recorder"
    requires_api = 1
    calls: ClassVar[list[tuple[str, Any]]] = []
    planning_result: ClassVar[Any] = None
    implementation_result: ClassVar[Any] = None

    @hook("after_planning")
    def planned(self, ctx: PluginContext, plan: dict[str, Any]) -> Any:
        Recorder.calls.append(("after_planning", ctx.task))
        plan["repos"].append("changed by the plugin")
        if isinstance(Recorder.planning_result, BaseException):
            raise Recorder.planning_result
        return Recorder.planning_result

    @hook("before_implementation")
    def starting(self, ctx: PluginContext, plan: dict[str, Any]) -> None:
        Recorder.calls.append(("before_implementation", plan.get("extensions")))

    @hook("after_implementation")
    def implemented(
        self, ctx: PluginContext, plan: dict[str, Any], implementation: dict[str, Any]
    ) -> Any:
        Recorder.calls.append(("after_implementation", plan.get("extensions")))
        ctx.say("  Checking the change  ")
        return Recorder.implementation_result


class FollowUps(Plugin):
    name = "acme.followups"
    requires_api = 1
    calls: ClassVar[list[tuple[str, Any]]] = []

    @hook("followup_start")
    def starting(self, ctx: PluginContext, kind: str) -> None:
        FollowUps.calls.append((kind, ctx.task))
        ctx.say("Getting ready")


class Second(Plugin):
    name = "acme.second"
    requires_api = 1

    @hook("after_planning")
    def planned(self, ctx: PluginContext, plan: dict[str, Any]) -> Any:
        return {"from": "second"}


class StageTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        Recorder.calls = []
        Recorder.planning_result = None
        Recorder.implementation_result = None
        self.registry = registry_for([Recorder, Second], root=self.root)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def round(self, inbox_id: str = "inbox-1", events=None) -> RoundPlugins:
        plugins = round_plugins(
            self.registry,
            task_key="ABC-1",
            inbox_id=inbox_id,
            run_id="run-1",
            events=events,
        )
        assert plugins is not None
        return plugins

    def called(self, hook_name: str) -> int:
        return sum(1 for name, _ in Recorder.calls if name == hook_name)


class TestAfterPlanning(StageTestCase):
    def test_data_lands_under_the_plugins_name(self) -> None:
        Recorder.planning_result = {"services": ["api"]}
        plan = _plan()
        merged = self.round().after_planning(plan)
        self.assertEqual(
            merged["extensions"],
            {"acme.recorder": {"services": ["api"]}, "acme.second": {"from": "second"}},
        )
        # The hook changed its copy; the harness's plan is untouched.
        self.assertEqual(plan, _plan())
        self.assertEqual(merged["repos"], [])

    def test_the_hook_gets_the_task(self) -> None:
        self.round().after_planning(_plan())
        self.assertEqual(
            Recorder.calls[0][1],
            TaskInfo(task_key="ABC-1", inbox_id="inbox-1", run_id="run-1"),
        )

    def test_no_data_leaves_the_plan_equal(self) -> None:
        registry = registry_for([Recorder], root=self.root / "alone")
        plugins = round_plugins(
            registry, task_key="ABC-1", inbox_id="inbox-1", run_id="r", events=None
        )
        self.assertEqual(plugins.after_planning(_plan()), _plan())

    def test_a_saved_result_is_reused_and_the_hook_not_called_again(self) -> None:
        Recorder.planning_result = {"n": 1}
        first = self.round().after_planning(_plan())
        Recorder.planning_result = {"n": 2}
        # A restarted daemon: a new registry over the same state directory.
        self.registry = registry_for([Recorder, Second], root=self.root)
        second = self.round().after_planning(first)
        self.assertEqual(self.called("after_planning"), 1)
        self.assertEqual(second["extensions"]["acme.recorder"], {"n": 1})
        self.assertEqual(second, first)

    def test_a_none_result_is_saved_too(self) -> None:
        self.round().after_planning(_plan())
        self.round().after_planning(_plan())
        self.assertEqual(self.called("after_planning"), 1)

    def test_another_assignment_calls_the_hook_again(self) -> None:
        Recorder.planning_result = {"n": 1}
        self.round("inbox-1").after_planning(_plan())
        self.round("inbox-2").after_planning(_plan())
        self.assertEqual(self.called("after_planning"), 2)

    def test_a_raising_hook_saves_nothing_and_runs_again(self) -> None:
        Recorder.planning_result = RuntimeError("boom")
        with self.assertLogs("harness.plugins", level="ERROR"):
            merged = self.round().after_planning(_plan())
        # The other plugin's data is still there.
        self.assertEqual(merged["extensions"], {"acme.second": {"from": "second"}})
        Recorder.planning_result = {"n": 1}
        merged = self.round().after_planning(merged)
        self.assertEqual(self.called("after_planning"), 2)
        self.assertEqual(merged["extensions"]["acme.recorder"], {"n": 1})

    def test_a_hook_that_exits_fails_only_itself(self) -> None:
        Recorder.planning_result = SystemExit(3)
        with self.assertLogs("harness.plugins", level="ERROR") as logs:
            merged = self.round().after_planning(_plan())
        self.assertIn("after_planning failed", logs.output[0])
        self.assertEqual(merged["extensions"], {"acme.second": {"from": "second"}})

    def test_a_plugins_own_files_cannot_block_its_saved_results(self) -> None:
        # Everything under state_dir is the plugin's, a file named "results"
        # included, as ctx.spawn(..., log="results") would leave.
        state_dir = self.root / "state" / "acme.recorder"
        state_dir.mkdir(parents=True)
        (state_dir / "results").write_text("a log\n", encoding="utf-8")
        Recorder.planning_result = {"n": 1}
        merged = self.round().after_planning(_plan())
        self.assertEqual(merged["extensions"]["acme.recorder"], {"n": 1})
        self.round().after_planning(_plan())
        self.assertEqual(self.called("after_planning"), 1)
        saved = self.root / "state" / "_results" / "acme.recorder"
        self.assertEqual(
            [p.name for p in saved.iterdir()], ["after_planning-inbox-1.json"]
        )

    def test_results_a_hook_may_not_return_are_dropped(self) -> None:
        bad = {
            "not json": {"when": object()},
            "not a mapping": ["a", "list"],
            "nan": {"rate": float("nan")},
            "infinity": {"nested": [{"rate": float("-inf")}]},
            "pr sections here": HookResult(
                pr_sections=[PrSection(repo="repo-a", title="T", body="b")]
            ),
        }
        for label, value in bad.items():
            with self.subTest(label):
                Recorder.planning_result = value
                with self.assertLogs("harness.plugins", level="ERROR") as logs:
                    merged = self.round(label).after_planning(_plan())
                self.assertNotIn("acme.recorder", merged["extensions"])
                self.assertIn("after_planning result dropped", logs.output[0])

    def test_a_saved_result_of_another_inbox_id_is_not_reused(self) -> None:
        # "a/b" and "a-b" share a file name; the stored id tells them apart.
        Recorder.planning_result = {"n": 1}
        self.round("a/b").after_planning(_plan())
        self.round("a-b").after_planning(_plan())
        self.assertEqual(self.called("after_planning"), 2)


class TestImplementationHooks(StageTestCase):
    def test_before_implementation_sees_the_plans_extensions_every_time(self) -> None:
        plan = {**_plan(), "extensions": {"acme.recorder": {"services": ["api"]}}}
        self.round().before_implementation(plan)
        self.round().before_implementation(plan)
        self.assertEqual(
            Recorder.calls,
            [("before_implementation", {"acme.recorder": {"services": ["api"]}})] * 2,
        )

    def test_data_and_a_pr_section_are_merged(self) -> None:
        Recorder.implementation_result = HookResult(
            data={"passed": True},
            pr_sections=[
                PrSection(repo="repo-a", title="Checked", body="It works.\n\n")
            ],
        )
        merged = self.round().after_implementation(_plan(), _impl())
        self.assertEqual(merged["extensions"], {"acme.recorder": {"passed": True}})
        self.assertEqual(
            merged["repos"][0]["pr_body"],
            "Body of the change.\n\n## Checked\n\nIt works.\n",
        )

    def test_a_section_keeps_its_indentation(self) -> None:
        Recorder.implementation_result = HookResult(
            pr_sections=[
                PrSection(repo="repo-a", title="Checked", body="\n    assert passed\n")
            ]
        )
        merged = self.round().after_implementation(_plan(), _impl())
        self.assertTrue(
            merged["repos"][0]["pr_body"].endswith("## Checked\n\n    assert passed\n")
        )

    def test_a_section_is_not_swallowed_by_unclosed_markdown_above_it(self) -> None:
        Recorder.implementation_result = HookResult(
            pr_sections=[PrSection(repo="repo-a", title="Checked", body="It works.")]
        )
        for label, body, closed in (
            (
                "code fence",
                "Body.\n\n```sh\nmake test\n",
                "make test\n```\n\n## Checked",
            ),
            ("comment", "Body.\n\n<!-- a note", "<!-- a note\n-->\n\n## Checked"),
        ):
            with self.subTest(label):
                impl = _impl()
                impl["repos"][0]["pr_body"] = body
                merged = self.round(label).after_implementation(_plan(), impl)
                self.assertIn(closed, merged["repos"][0]["pr_body"])

    def test_data_may_be_any_mapping(self) -> None:
        from collections import UserDict
        from types import MappingProxyType

        Recorder.implementation_result = MappingProxyType({
            "passed": True,
            "nested": UserDict({"n": 1}),
        })
        merged = self.round().after_implementation(_plan(), _impl())
        self.assertEqual(
            merged["extensions"]["acme.recorder"], {"passed": True, "nested": {"n": 1}}
        )

    def test_merging_twice_adds_the_section_once(self) -> None:
        Recorder.implementation_result = HookResult(
            pr_sections=[PrSection(repo="repo-a", title="Checked", body="It works.")]
        )
        once = self.round().after_implementation(_plan(), _impl())
        twice = self.round().after_implementation(_plan(), once)
        self.assertEqual(twice, once)
        self.assertEqual(self.called("after_implementation"), 1)

    def test_a_section_for_an_unknown_repo_is_dropped(self) -> None:
        Recorder.implementation_result = HookResult(
            pr_sections=[PrSection(repo="nope", title="Checked", body="x")]
        )
        with self.assertLogs("harness.plugins", level="WARNING") as logs:
            merged = self.round().after_implementation(_plan(), _impl())
        self.assertEqual(merged, _impl())
        self.assertIn("'nope'", logs.output[0])

    def test_an_empty_section_drops_the_result(self) -> None:
        Recorder.implementation_result = HookResult(
            pr_sections=[PrSection(repo="repo-a", title=" ", body="x")]
        )
        with self.assertLogs("harness.plugins", level="ERROR"):
            merged = self.round().after_implementation(_plan(), _impl())
        self.assertEqual(merged, _impl())

    def test_say_posts_an_agent_action_to_the_round(self) -> None:
        events_file = self.root / "events.jsonl"
        events = RoundEvents(
            events_file=events_file,
            events_lock=self.root / "events.lock",
            inbox_id="inbox-1",
            target_id="sess-1",
        )
        self.round(events=events).after_implementation(_plan(), _impl())
        (event,) = [json.loads(line) for line in events_file.read_text().splitlines()]
        self.assertEqual(event["type"], "agent_action")
        self.assertEqual(event["body"], "Checking the change")
        self.assertEqual(event["target_id"], "sess-1")

    def test_say_without_a_live_channel_does_nothing(self) -> None:
        self.round(events=None).after_implementation(_plan(), _impl())
        self.assertEqual(self.called("after_implementation"), 1)


class TestRoundPlugins(StageTestCase):
    def test_none_without_a_registry_or_without_plugins(self) -> None:
        kwargs = {"task_key": "K", "inbox_id": "i", "run_id": "r", "events": None}
        self.assertIsNone(round_plugins(None, **kwargs))
        self.assertIsNone(
            round_plugins(registry_for([], root=self.root / "empty"), **kwargs)
        )


class TestAssignmentWiring(StageTestCase):
    """The assignment handler's use of the stage hooks."""

    def setUp(self) -> None:
        super().setUp()
        self.plan_json = self.root / "plan.json"
        self.impl_json = self.root / "implementation.json"
        for patcher in (
            patch.object(assignment_module, "PLAN_JSON", self.plan_json),
            patch.object(assignment_module, "IMPLEMENTATION_JSON", self.impl_json),
            patch.object(assignment_module, "HARNESS_DIR", self.root),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_a_reused_plan_gets_the_plugins_data_written(self) -> None:
        Recorder.planning_result = {"services": ["api"]}
        self.plan_json.write_text(json.dumps(_plan()), encoding="utf-8")
        plan = assignment_module._run_planning_stage(
            "Do the thing",
            "ABC-1",
            "run-1",
            "inbox-1",
            events=None,
            plugins=self.round(),
        )
        self.assertEqual(plan["extensions"]["acme.recorder"], {"services": ["api"]})
        self.assertEqual(json.loads(self.plan_json.read_text()), plan)

    def test_a_reused_plan_without_plugins_is_not_rewritten(self) -> None:
        self.plan_json.write_text(json.dumps(_plan()), encoding="utf-8")
        before = self.plan_json.stat().st_mtime_ns
        plan = assignment_module._run_planning_stage(
            "Do the thing", "ABC-1", "run-1", "inbox-1", events=None
        )
        self.assertEqual(plan, _plan())
        self.assertEqual(self.plan_json.stat().st_mtime_ns, before)

    def test_a_reused_implementation_gets_data_and_section_written(self) -> None:
        Recorder.implementation_result = HookResult(
            data={"passed": True},
            pr_sections=[PrSection(repo="repo-a", title="Checked", body="It works.")],
        )
        self.impl_json.write_text(json.dumps(_impl()), encoding="utf-8")
        impl = assignment_module._run_implementation_stage(
            "ABC-1", "run-1", "inbox-1", _plan(), events=None, plugins=self.round()
        )
        self.assertEqual(impl["extensions"], {"acme.recorder": {"passed": True}})
        self.assertIn("## Checked", impl["repos"][0]["pr_body"])
        self.assertEqual(json.loads(self.impl_json.read_text()), impl)

    def test_a_plan_that_cannot_be_kept_with_plugin_data_is_used_as_it_was(
        self,
    ) -> None:
        Recorder.planning_result = {"services": ["api"]}
        on_disk = json.dumps(_plan())
        failures = {
            "write": patch.object(
                assignment_module, "write_json", side_effect=OSError("disk full")
            ),
            "validate": patch.object(
                assignment_module, "validate_plan", side_effect=ValueError("bad plan")
            ),
            "merge": patch.object(
                RoundPlugins, "after_planning", side_effect=RuntimeError("boom")
            ),
        }
        for label, failure in failures.items():
            with self.subTest(label):
                self.plan_json.write_text(on_disk, encoding="utf-8")
                with failure, self.assertLogs("harness.plugins", "ERROR") as logs:
                    plan = assignment_module._with_plan_plugins(
                        _plan(), self.round(label)
                    )
                self.assertEqual(plan, _plan())
                self.assertEqual(self.plan_json.read_text(encoding="utf-8"), on_disk)
                self.assertIn("after_planning results not kept", logs.output[-1])

    def test_an_implementation_that_cannot_be_kept_with_plugin_data_is_used_as_it_was(
        self,
    ) -> None:
        Recorder.implementation_result = HookResult(
            data={"passed": True},
            pr_sections=[PrSection(repo="repo-a", title="Checked", body="It works.")],
        )
        on_disk = json.dumps(_impl())
        failures = {
            "write": patch.object(
                assignment_module, "write_json", side_effect=OSError("disk full")
            ),
            "validate": patch.object(
                assignment_module,
                "validate_implementation",
                side_effect=ValueError("bad implementation"),
            ),
            "merge": patch.object(
                RoundPlugins, "after_implementation", side_effect=RuntimeError("boom")
            ),
        }
        for label, failure in failures.items():
            with self.subTest(label):
                self.impl_json.write_text(on_disk, encoding="utf-8")
                with failure, self.assertLogs("harness.plugins", "ERROR") as logs:
                    impl = assignment_module._with_implementation_plugins(
                        "inbox-1", _plan(), _impl(), self.round(label)
                    )
                self.assertEqual(impl, _impl())
                self.assertEqual(self.impl_json.read_text(encoding="utf-8"), on_disk)
                self.assertIn("after_implementation results not kept", logs.output[-1])

    def _process(self, impl_reusable: bool) -> None:
        inbox = self.root / "inbox"
        inbox.mkdir()
        state = DaemonState(
            events_file=self.root / "events.jsonl",
            events_lock=self.root / "events.lock",
            processed_dir=inbox / ".processed",
            error_dir=inbox / ".error",
        )
        state.plugins = self.registry
        entry = {
            "id": "inbox-1",
            "kind": "assignment",
            "source": "api",
            "payload": {"title": "Do the thing", "task_key": "ABC-1", "target_id": "t"},
        }
        file = inbox / "inbox-1.json"
        file.write_text(json.dumps(entry), encoding="utf-8")
        if impl_reusable:
            self.impl_json.write_text(json.dumps(_impl()), encoding="utf-8")
        plan = {**_plan(), "repos": [{"name": "repo-a", "path": "/tmp/repo-a"}]}
        with (
            patch.object(assignment_module, "setup_workspace"),
            patch.object(
                assignment_module, "_run_planning_stage", return_value=plan
            ) as planning,
            patch.object(
                assignment_module, "_run_implementation_stage", return_value=_impl()
            ) as implementation,
            patch.object(
                assignment_module, "run_self_review_loop", return_value=({}, _impl())
            ),
            patch.object(
                assignment_module,
                "_repo_names_with_implementation_changes",
                return_value=[],
            ),
            patch.object(
                assignment_module, "run_commit_stage", return_value=("completed", [])
            ),
            patch("harness.implementation.implementation_started", return_value=False),
        ):
            process_one_inbox_file(file, state)
        for stage in (planning, implementation):
            plugins = stage.call_args.kwargs["plugins"]
            self.assertIsInstance(plugins, RoundPlugins)
            self.assertEqual(plugins.task.inbox_id, "inbox-1")
            self.assertEqual(plugins.task.task_key, "ABC-1")

    def test_before_implementation_runs_when_implementation_is_pending(self) -> None:
        self._process(impl_reusable=False)
        self.assertEqual(self.called("before_implementation"), 1)

    def test_before_implementation_is_skipped_once_it_is_complete(self) -> None:
        self._process(impl_reusable=True)
        self.assertEqual(self.called("before_implementation"), 0)


class TestFollowUpStart(unittest.TestCase):
    """followup._run_round tells plugins a follow-up round is starting."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        FollowUps.calls = []
        self.state = DaemonState(
            events_file=self.root / "events.jsonl",
            events_lock=self.root / "events.lock",
            processed_dir=self.root / ".processed",
            error_dir=self.root / ".error",
        )
        self.state.plugins = registry_for([FollowUps], root=self.root)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run_round(self, stage, source: str, order: list[str]) -> None:
        import contextlib

        import harness.followup as followup_module

        def runner(*_args, **_kwargs) -> None:
            order.append(f"agent after {len(FollowUps.calls)} hook call(s)")

        with (
            patch.object(
                followup_module,
                "post_code_round_distillation",
                return_value=contextlib.nullcontext(),
            ),
            patch.object(followup_module, "run_followup_round", side_effect=runner),
            patch.object(followup_module, "seeded_context_block", return_value=""),
        ):
            followup_module._run_round(
                state=self.state,
                inbox_id="inbox-9",
                task_key="ABC-1",
                stage=stage,
                task="t",
                primary_target="target-9",
                source=source,
                pr=None,
                build=lambda _plugin_prompt: None,
                brief=lambda: "",
                targets=["target-9"],
                optional_targets=frozenset(),
                label="followup/ABC-1",
            )

    def _events(self) -> list[dict[str, Any]]:
        file = self.root / "events.jsonl"
        if not file.exists():
            return []
        return [json.loads(line) for line in file.read_text().splitlines()]

    def test_each_kind_reaches_the_hook_before_the_agent_runs(self) -> None:
        from harness.stages import Stage

        order: list[str] = []
        for stage in (Stage.COMMENT, Stage.USER_REVIEW, Stage.CI):
            self._run_round(stage, "github", order)
        self.assertEqual(
            [kind for kind, _ in FollowUps.calls], ["comment", "review", "ci_result"]
        )
        self.assertEqual(order, [f"agent after {n} hook call(s)" for n in (1, 2, 3)])
        task = FollowUps.calls[0][1]
        self.assertEqual((task.task_key, task.inbox_id), ("ABC-1", "inbox-9"))
        # GitHub shows no progress messages, so say posted nothing.
        self.assertEqual(self._events(), [])

    def test_say_posts_on_a_live_channel(self) -> None:
        from harness.stages import Stage

        self._run_round(Stage.COMMENT, "linear", [])
        (event,) = self._events()
        self.assertEqual(
            (event["type"], event["body"], event["target_id"], event["inbox_id"]),
            ("agent_action", "Getting ready", "target-9", "inbox-9"),
        )

    def test_a_finished_round_does_not_call_the_hook(self) -> None:
        from harness.followup import FINISHED_EVENT
        from harness.stages import Stage

        self.state.append_event({"type": FINISHED_EVENT, "inbox_id": "inbox-9"})
        self._run_round(Stage.COMMENT, "github", [])
        self.assertEqual(FollowUps.calls, [])

    def test_no_plugins_changes_nothing(self) -> None:
        from harness.stages import Stage

        self.state.plugins = None
        order: list[str] = []
        self._run_round(Stage.COMMENT, "github", order)
        self.assertEqual(order, ["agent after 0 hook call(s)"])


if __name__ == "__main__":
    unittest.main()
