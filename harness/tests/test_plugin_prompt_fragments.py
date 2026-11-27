"""Tests for the prompt_fragments hook and where its text reaches agents."""

from __future__ import annotations

import contextlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, ClassVar
from unittest.mock import MagicMock, patch

import harness.followup as followup_module
import harness.handlers.assignment as assignment_module
from harness.daemon import DaemonState
from harness.deepagents.middleware.plugin_prompt import (
    PluginPromptMiddleware,
    plugin_prompt_middleware,
)
from harness.plugins import (
    PROMPT_STAGES,
    Plugin,
    PluginContext,
    RoundPlugins,
    hook,
    round_plugins,
)
from harness.plugins._stages import MAX_PROMPT_FRAGMENT_CHARS
from harness.plugins.testing import registry_for
from harness.stages import Stage


class Stack(Plugin):
    name = "acme.stack"
    requires_api = 1
    calls: ClassVar[list[tuple[str, Any]]] = []
    result: ClassVar[Any] = None

    @hook("prompt_fragments")
    def fragments(self, ctx: PluginContext, stage: str) -> Any:
        Stack.calls.append((stage, ctx.task))
        if isinstance(Stack.result, Exception):
            raise Stack.result
        return Stack.result


class Search(Plugin):
    name = "acme.search"
    requires_api = 1

    @hook("prompt_fragments")
    def fragments(self, ctx: PluginContext, stage: str) -> str | None:
        return "Use `websearch` to search the web." if stage == "planning" else None


class Quiet(Plugin):
    """Handles another hook only."""

    name = "acme.quiet"
    requires_api = 1

    @hook("followup_start")
    def starting(self, ctx: PluginContext, kind: str) -> None:
        pass


class FragmentTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        Stack.calls = []
        Stack.result = None
        self.registry = registry_for([Stack, Search, Quiet], root=self.root)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def round(self) -> RoundPlugins:
        plugins = round_plugins(
            self.registry,
            task_key="ABC-1",
            inbox_id="inbox-1",
            run_id="run-1",
            events=None,
        )
        assert plugins is not None
        return plugins


class TestPromptFragments(FragmentTestCase):
    def test_each_plugins_text_is_wrapped_and_named_in_plugin_order(self) -> None:
        Stack.result = "  The stack is starting.  "
        self.assertEqual(
            self.round().prompt_fragments("planning"),
            '<plugin_instructions plugin="acme.stack">\n'
            "The stack is starting.\n"
            "</plugin_instructions>\n\n"
            '<plugin_instructions plugin="acme.search">\n'
            "Use `websearch` to search the web.\n"
            "</plugin_instructions>",
        )

    def test_the_hook_is_told_the_stage_and_the_task(self) -> None:
        self.round().prompt_fragments("ci_result")
        ((stage, task),) = Stack.calls
        self.assertEqual(stage, "ci_result")
        self.assertEqual((task.task_key, task.inbox_id), ("ABC-1", "inbox-1"))

    def test_no_text_from_any_plugin_is_none(self) -> None:
        for empty in (None, "", "   ", [], ["", " "]):
            with self.subTest(repr(empty)):
                Stack.result = empty
                self.assertIsNone(self.round().prompt_fragments("implementation"))

    def test_a_list_is_joined_with_blank_lines(self) -> None:
        Stack.result = ["First.", "", "Second."]
        self.assertEqual(
            self.round().prompt_fragments("implementation"),
            '<plugin_instructions plugin="acme.stack">\nFirst.\n\nSecond.\n'
            "</plugin_instructions>",
        )

    def test_the_text_is_not_saved_between_calls(self) -> None:
        Stack.result = "one"
        self.round().prompt_fragments("implementation")
        Stack.result = "two"
        text = self.round().prompt_fragments("implementation")
        assert text is not None
        self.assertIn("two", text)
        self.assertEqual(len(Stack.calls), 2)

    def test_values_a_hook_may_not_return_are_dropped(self) -> None:
        bad = {
            "not text": {"text": "x"},
            "a list of other things": ["ok", 3],
            "too long": "x" * (MAX_PROMPT_FRAGMENT_CHARS + 1),
        }
        for label, value in bad.items():
            with self.subTest(label):
                Stack.result = value
                with self.assertLogs("harness.plugins", level="ERROR") as logs:
                    text = self.round().prompt_fragments("planning")
                # The other plugin's text is still there.
                assert text is not None
                self.assertNotIn('plugin="acme.stack"', text)
                self.assertIn('plugin="acme.search"', text)
                self.assertIn(
                    "prompt_fragments text for planning dropped", logs.output[0]
                )

    def test_text_at_the_limit_is_kept(self) -> None:
        Stack.result = "x" * MAX_PROMPT_FRAGMENT_CHARS
        self.assertIsNotNone(self.round().prompt_fragments("implementation"))

    def test_a_raising_hook_costs_only_its_own_text(self) -> None:
        Stack.result = RuntimeError("boom")
        with self.assertLogs("harness.plugins", level="ERROR"):
            text = self.round().prompt_fragments("planning")
        assert text is not None
        self.assertNotIn('plugin="acme.stack"', text)
        self.assertIn('plugin="acme.search"', text)

    def test_an_unknown_stage_is_a_harness_bug(self) -> None:
        with self.assertRaises(ValueError):
            self.round().prompt_fragments("orientation")
        self.assertEqual(Stack.calls, [])

    def test_the_stages_are_the_documented_ones(self) -> None:
        self.assertEqual(
            PROMPT_STAGES,
            (
                "planning",
                "implementation",
                "review_fix",
                "comment",
                "review",
                "ci_result",
            ),
        )


class TestPluginPromptMiddleware(unittest.TestCase):
    def test_no_text_builds_no_middleware(self) -> None:
        self.assertEqual(plugin_prompt_middleware(None), [])
        self.assertEqual(plugin_prompt_middleware(""), [])

    def test_text_is_appended_to_the_system_message(self) -> None:
        (middleware,) = plugin_prompt_middleware("Plugin text.")
        self.assertIsInstance(middleware, PluginPromptMiddleware)
        request = MagicMock()
        request.system_message = None
        seen: list[Any] = []
        middleware.wrap_model_call(request, seen.append)
        (overridden,) = seen
        self.assertIs(overridden, request.override.return_value)
        message = request.override.call_args.kwargs["system_message"]
        self.assertIn("Plugin text.", str(message.content))


class TestAgentWiring(unittest.TestCase):
    """The runners and presets put the text into the agents they build."""

    def _plugin_middleware(self, middleware: Any) -> list[Any]:
        return [m for m in middleware if isinstance(m, PluginPromptMiddleware)]

    def test_each_implementation_worker_gets_it(self) -> None:
        from harness import implementation
        from harness.schemas import PlanRepo

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(implementation, "ImplementationAgent") as agent,
            patch.object(implementation, "repo_checkout_path", return_value=Path(tmp)),
            patch.object(
                implementation._retry,
                "run_agent_with_retries",
                side_effect=lambda build, *_a, **_k: build(),
            ),
            patch.object(implementation, "_canonical_repo_output") as canonical,
        ):
            canonical.return_value.model_dump.return_value = {}
            for text, expected in (("Plugin text.", ["Plugin text."]), (None, [])):
                with self.subTest(text):
                    implementation._run_one_repo_with_retries(
                        model=object(),
                        task="change",
                        task_key="ABC-1",
                        inbox_id=f"inbox-{text}",
                        repo=PlanRepo(name="repo-a", path="/legacy", goal="change"),
                        markers_dir=Path(tmp) / "markers",
                        max_retries=0,
                        events=None,
                        plugin_prompt=text,
                    )
                    self.assertEqual(
                        [m.system_prompt for m in agent.call_args.kwargs["middleware"]],
                        expected,
                    )

    def test_the_review_fix_agent_gets_it(self) -> None:
        from harness import self_review
        from harness.deepagents.agents import review as agents

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(
                agents.DeepAgentSession, "__init__", return_value=None
            ) as init,
            patch.object(
                self_review._retry,
                "run_agent_with_retries",
                side_effect=lambda build, *_a, **_k: build() and MagicMock(),
            ),
        ):
            for text, expected in (("Plugin text.", ["Plugin text."]), (None, [])):
                with self.subTest(text):
                    self_review._run_repo_fix_agent(
                        model=object(),
                        repo_name="repo-a",
                        repo_path=Path(tmp),
                        thread_id="thread-1",
                        knowledge_subpaths=(),
                        brief="fix it",
                        events=None,
                        plugin_prompt=text,
                    )
                    middleware = init.call_args.kwargs["middleware"] or []
                    self.assertEqual(
                        [m.system_prompt for m in self._plugin_middleware(middleware)],
                        expected,
                    )

    def test_follow_up_and_ci_agents_get_it_after_their_own_middleware(self) -> None:
        from harness.deepagents.agents import followup as agents
        from harness.deepagents.middleware.ci_rerun import WorkflowRunRef
        from harness.deepagents.middleware.reply import ReplyTarget

        shared: dict[str, Any] = {
            "model": object(),
            "thread_id": "thread-1",
            "events": MagicMock(),
            "prs": [],
            "memory_repos": [],
            "memory": MagicMock(),
            "github": MagicMock(),
        }
        builders = {
            "follow-up": lambda text: agents.FollowUpAgent(
                **shared,
                targets=[ReplyTarget("target-1", "the comment")],
                plugin_prompt=text,
            ),
            "ci": lambda text: agents.CiAgent(
                **shared,
                run=WorkflowRunRef("o", "r", 1),
                plugin_prompt=text,
            ),
        }
        for label, build in builders.items():
            with (
                self.subTest(label),
                patch.object(
                    agents.DeepAgentSession, "__init__", return_value=None
                ) as init,
            ):
                build("Plugin text.")
                middleware = init.call_args.kwargs["middleware"]
                self.assertIsInstance(middleware[-1], PluginPromptMiddleware)
                self.assertEqual(middleware[-1].system_prompt, "Plugin text.")
                build(None)
                self.assertEqual(
                    self._plugin_middleware(init.call_args.kwargs["middleware"]), []
                )


class TestAssignmentWiring(FragmentTestCase):
    """The assignment handler hands each stage's text to that stage's runner."""

    def setUp(self) -> None:
        super().setUp()
        Stack.result = "Stack text."
        for patcher in (
            patch.object(assignment_module, "PLAN_JSON", self.root / "plan.json"),
            patch.object(assignment_module, "PLAN_MD", self.root / "plan.md"),
            patch.object(
                assignment_module, "IMPLEMENTATION_JSON", self.root / "impl.json"
            ),
            patch.object(assignment_module, "HARNESS_DIR", self.root),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _plan(self) -> dict[str, Any]:
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

    def test_planning_gets_the_planning_text(self) -> None:
        from harness.schemas import Plan

        with patch(
            "harness.planning.run_planning",
            return_value=Plan.model_validate(self._plan()),
        ) as run_planning:
            assignment_module._run_planning_stage(
                "Do the thing",
                "ABC-1",
                "run-1",
                "inbox-1",
                events=None,
                plugins=self.round(),
            )
        text = run_planning.call_args.kwargs["plugin_prompt"]
        self.assertIn("Stack text.", text)
        self.assertIn("websearch", text)
        self.assertEqual([stage for stage, _ in Stack.calls], ["planning"])

    def test_a_reused_plan_asks_for_no_text(self) -> None:
        (self.root / "plan.json").write_text(json.dumps(self._plan()), "utf-8")
        assignment_module._run_planning_stage(
            "Do the thing",
            "ABC-1",
            "run-1",
            "inbox-1",
            events=None,
            plugins=self.round(),
        )
        self.assertEqual(Stack.calls, [])

    def test_planning_without_plugins_passes_none(self) -> None:
        from harness.schemas import Plan

        with patch(
            "harness.planning.run_planning",
            return_value=Plan.model_validate(self._plan()),
        ) as run_planning:
            assignment_module._run_planning_stage(
                "Do the thing", "ABC-1", "run-1", "inbox-1", events=None
            )
        self.assertIsNone(run_planning.call_args.kwargs["plugin_prompt"])

    def test_implementation_gets_the_implementation_text(self) -> None:
        impl = {
            "stage": "implementation",
            "run_id": "run-1",
            "task": "Do the thing",
            "status": "completed",
            "task_key": "ABC-1",
            "generated_at": "2026-01-01T00:00:00Z",
            "inbox_id": "inbox-1",
            "repos": [],
        }

        def fake_run(**kwargs: Any) -> None:
            kwargs["impl_out"].write_text(json.dumps(impl), "utf-8")

        with patch(
            "harness.implementation.run_implementation", side_effect=fake_run
        ) as run_implementation:
            assignment_module._run_implementation_stage(
                "ABC-1",
                "run-1",
                "inbox-1",
                self._plan(),
                events=None,
                plugins=self.round(),
            )
        text = run_implementation.call_args.kwargs["plugin_prompt"]
        self.assertIn("Stack text.", text)
        self.assertNotIn("websearch", text)
        self.assertEqual([stage for stage, _ in Stack.calls], ["implementation"])


class TestFollowUpWiring(FragmentTestCase):
    """followup._run_round builds the round's agent with the round's text."""

    def _run_round(self, stage: Stage) -> list[Any]:
        state = DaemonState(
            events_file=self.root / "events.jsonl",
            events_lock=self.root / "events.lock",
            processed_dir=self.root / ".processed",
            error_dir=self.root / ".error",
        )
        state.plugins = self.registry
        built: list[Any] = []

        def runner(build_agent: Any, **_kwargs: Any) -> None:
            build_agent()
            build_agent()

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
                state=state,
                inbox_id="inbox-1",
                task_key="ABC-1",
                stage=stage,
                task="t",
                primary_target="target-1",
                source="github",
                pr=None,
                build=built.append,
                brief=lambda: "",
                targets=["target-1"],
                optional_targets=frozenset(),
                label="followup/ABC-1",
            )
        return built

    def test_each_kind_asks_once_and_every_attempt_gets_the_text(self) -> None:
        Stack.result = "Stack text."
        for stage, kind in (
            (Stage.COMMENT, "comment"),
            (Stage.USER_REVIEW, "review"),
            (Stage.CI, "ci_result"),
        ):
            with self.subTest(kind):
                Stack.calls = []
                first, second = self._run_round(stage)
                self.assertEqual([s for s, _ in Stack.calls], [kind])
                self.assertIn("Stack text.", first)
                self.assertEqual(first, second)

    def test_no_text_builds_the_agent_with_none(self) -> None:
        self.assertEqual(self._run_round(Stage.COMMENT), [None, None])


if __name__ == "__main__":
    unittest.main()
