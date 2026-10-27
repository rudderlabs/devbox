"""Follow-up entry points for comment, review, and CI rounds."""

from __future__ import annotations

import contextlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from harness import followup as fu
from harness.daemon import DaemonState
from harness.deepagents.middleware.ci_rerun import WorkflowRunRef
from harness.deepagents.middleware.reply import ReplyTarget
from harness.stages import Stage

PR = {"repo": "acme-server", "pr_url": "https://github.com/o/acme-server/pull/7"}


def _state(tmp: Path) -> DaemonState:
    for name in (".processed", ".error"):
        (tmp / name).mkdir(exist_ok=True)
    return DaemonState(
        events_file=tmp / "events.jsonl",
        events_lock=tmp / "events.lock",
        processed_dir=tmp / ".processed",
        error_dir=tmp / ".error",
    )


class TestEntryPoints(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.state = _state(Path(self._tmp.name))
        self.order: list[str] = []
        self.config = fu.RoundConfig(prs=(), memory_repos=())
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.addCleanup(self._tmp.cleanup)

        @contextlib.contextmanager
        def distill(**kwargs):
            self.distill_kwargs = kwargs
            yield
            self.order.append("distill")

        @contextlib.contextmanager
        def timed(stage, **kwargs):
            self.timed = (stage, kwargs)
            yield

        @contextlib.contextmanager
        def span(name, **kwargs):
            self.span = (name, kwargs)
            yield

        self.run_round = stack.enter_context(
            patch.object(
                fu,
                "run_followup_round",
                side_effect=lambda *a, **k: self.order.append("agent"),
            )
        )
        stack.enter_context(
            patch.object(fu, "post_code_round_distillation", side_effect=distill)
        )
        stack.enter_context(patch.object(fu, "timed_stage", side_effect=timed))
        stack.enter_context(patch.object(fu, "trace_span", side_effect=span))

        def init_trace(**kwargs):
            self.init_trace_kwargs = kwargs
            return contextlib.nullcontext()

        stack.enter_context(patch.object(fu, "init_trace", side_effect=init_trace))
        stack.enter_context(patch.object(fu, "new_run_id", return_value="run-1"))
        self.model = object()
        self.github = object()
        self.memory = object()
        self.events = object()
        stack.enter_context(patch.object(fu, "_model", return_value=self.model))
        stack.enter_context(patch.object(fu, "GitHubClient", return_value=self.github))
        stack.enter_context(patch.object(fu, "MemoryStore", return_value=self.memory))
        self.round_events = MagicMock(return_value=self.events)
        stack.enter_context(patch.object(self.state, "round_events", self.round_events))
        stack.enter_context(patch.object(fu, "flush_trace"))
        stack.enter_context(patch.object(fu, "round_config", return_value=self.config))
        stack.enter_context(patch.object(fu, "_read_json_or_none", return_value={}))
        stack.enter_context(
            patch.object(fu, "seeded_context_block", return_value="SEED")
        )
        self.discussion = stack.enter_context(
            patch.object(
                fu, "with_discussion", side_effect=lambda brief, **k: f"DISC\n\n{brief}"
            )
        )

    def _preset_kwargs(self, thread_id: str, **extra) -> dict:
        return {
            "model": self.model,
            "thread_id": thread_id,
            "events": self.events,
            "prs": (),
            "memory_repos": (),
            "memory": self.memory,
            "github": self.github,
            **extra,
        }

    def _distill(self, **overrides) -> dict:
        return {
            "state": self.state,
            "inbox_id": "inbox-1",
            "repo_slugs": ["acme-server"],
            "run_id": "run-1",
            "task_key": "XYZ-1",
            "target_id": "555",
            **overrides,
        }

    def _span(self, stage: Stage) -> tuple:
        return (
            "agent-run",
            {
                "as_type": "generation",
                "model": "deepagents-followup",
                "input": {"stage": str(stage), "task_key": "XYZ-1"},
            },
        )

    def test_github_comment(self) -> None:
        entry = {
            "id": "inbox-1",
            "kind": "comment",
            "source": "github",
            "payload": {
                "target_id": "555",
                "body": "Rename it.",
                "task_key": "XYZ-1",
                "pr": PR,
                "created_at": "2026-10-01T00:00:00Z",
            },
        }
        fu.run_followup_comment(entry, self.state)

        self.assertEqual(self.order, ["agent", "distill"])
        self.discussion.assert_not_called()
        kwargs = self.run_round.call_args.kwargs
        brief = kwargs.pop("brief")
        self.assertEqual(
            brief(),
            "DISC\n\n" + fu.comment_brief(body="Rename it.", channel="github", pr=PR),
        )
        self.discussion.assert_called_once_with(
            fu.comment_brief(body="Rename it.", channel="github", pr=PR),
            pr=PR,
            session_key="followup:XYZ-1",
            before="2026-10-01T00:00:00Z",
            own_items=fu.comment_own_items("555", "Rename it."),
        )
        self.assertEqual(
            {k: v for k, v in kwargs.items() if k != "state"},
            {
                "inbox_id": "inbox-1",
                "seed": "SEED",
                "targets": ["555"],
                "optional_targets": frozenset(),
                "label": "followup/XYZ-1",
            },
        )
        self.assertEqual(self.distill_kwargs, self._distill())
        self.assertEqual(
            self.init_trace_kwargs,
            {
                "run_id": "run-1",
                "task": "Rename it.",
                "task_key": "XYZ-1",
                "agent": "deepagents",
            },
        )
        self.assertEqual(self.span, self._span(Stage.COMMENT))
        self.assertEqual(
            self.timed,
            (Stage.COMMENT, {"run_id": "run-1", "task_key": "XYZ-1"}),
        )
        self.round_events.assert_called_once_with("inbox-1", "555")

        build = self.run_round.call_args.args[0]
        with patch.object(fu, "FollowUpAgent") as agent_cls:
            build()
        agent_cls.assert_called_once_with(
            **self._preset_kwargs(
                "followup:XYZ-1", targets=[ReplyTarget("555", "the comment")]
            )
        )

    def test_linear_comment_has_no_discussion(self) -> None:
        entry = {
            "id": "inbox-1",
            "kind": "comment",
            "source": "linear",
            "payload": {
                "target_id": "lin-1",
                "body": "Status?",
                "task_key": "XYZ-1",
            },
        }
        fu.run_followup_comment(entry, self.state)
        self.discussion.assert_not_called()
        self.assertEqual(
            self.distill_kwargs,
            self._distill(repo_slugs=[], target_id="lin-1"),
        )
        self.assertEqual(
            self.run_round.call_args.kwargs["brief"](),
            fu.comment_brief(body="Status?", channel="linear", pr=None),
        )
        self.discussion.assert_not_called()

    def test_api_comment_reads_task_key(self) -> None:
        entry = {
            "id": "inbox-1",
            "kind": "comment",
            "source": "api",
            "payload": {
                "target_id": "api-1",
                "body": "Status?",
                "task_key": "DBX-API-42",
                "task_id": "task-uuid-1",
            },
        }
        fu.run_followup_comment(entry, self.state)
        self.discussion.assert_not_called()
        self.assertEqual(
            self.distill_kwargs,
            self._distill(repo_slugs=[], target_id="api-1", task_key="DBX-API-42"),
        )
        self.assertEqual(
            self.run_round.call_args.kwargs["label"], "followup/DBX-API-42"
        )

    def test_review(self) -> None:
        review_body = {"target_id": "900", "body": "Close."}
        inlines = [{"target_id": "901", "path": "a.go", "line": 3, "body": "Rename."}]
        entry = {
            "id": "inbox-2",
            "kind": "review",
            "source": "github",
            "payload": {
                "review_body": review_body,
                "inline_comments": inlines,
                "task_key": "XYZ-1",
                "pr": PR,
            },
        }
        fu.run_followup_review(entry, self.state)
        self.discussion.assert_not_called()
        kwargs = self.run_round.call_args.kwargs
        brief = kwargs.pop("brief")
        self.assertEqual(
            brief(),
            "DISC\n\n"
            + fu.review_brief(
                review_body=review_body, inlines=inlines, channel="github", pr=PR
            ),
        )
        self.assertEqual(
            {k: v for k, v in kwargs.items() if k != "state"},
            {
                "inbox_id": "inbox-2",
                "seed": "SEED",
                "targets": ["900", "901"],
                "optional_targets": frozenset({"900"}),
                "label": "followup/XYZ-1",
            },
        )
        self.discussion.assert_called_once_with(
            fu.review_brief(
                review_body=review_body, inlines=inlines, channel="github", pr=PR
            ),
            pr=PR,
            session_key="followup:XYZ-1",
            before=None,
            own_items=fu.review_own_items(review_body, inlines),
        )
        self.assertEqual(
            self.distill_kwargs,
            self._distill(inbox_id="inbox-2", target_id="900"),
        )
        self.assertEqual(
            self.init_trace_kwargs,
            {
                "run_id": "run-1",
                "task": "Close.",
                "task_key": "XYZ-1",
                "agent": "deepagents",
            },
        )
        self.assertEqual(self.span, self._span(Stage.USER_REVIEW))
        self.assertEqual(
            self.timed,
            (Stage.USER_REVIEW, {"run_id": "run-1", "task_key": "XYZ-1"}),
        )
        self.round_events.assert_called_once_with("inbox-2", "900")
        build = self.run_round.call_args.args[0]
        with patch.object(fu, "FollowUpAgent") as agent_cls:
            build()
        agent_cls.assert_called_once_with(
            **self._preset_kwargs(
                "followup:XYZ-1", targets=fu.review_targets(review_body, inlines)
            )
        )

    def test_ci(self) -> None:
        payload = {
            "target_id": "t-ci",
            "task_key": "XYZ-1",
            "workflow_name": "tests",
            "run_url": "https://github.com/acme/acme-server/actions/runs/42",
            "pr": PR,
        }
        jobs = [{"job_name": "unit", "log_path": "/l/unit.log"}]
        fu.run_followup_ci(
            {
                "id": "inbox-3",
                "kind": "ci_result",
                "source": "github",
                "payload": payload,
            },
            self.state,
            failed_jobs=jobs,
            errors=[],
        )
        kwargs = self.run_round.call_args.kwargs
        self.assertEqual(
            kwargs.pop("brief")(),
            fu.ci_brief(payload=payload, failed_jobs=jobs, errors=[]),
        )
        self.assertEqual(
            {k: v for k, v in kwargs.items() if k != "state"},
            {
                "inbox_id": "inbox-3",
                "seed": "SEED",
                "targets": ["t-ci"],
                "optional_targets": frozenset(),
                "label": "ci/XYZ-1",
            },
        )
        self.assertEqual(
            self.distill_kwargs,
            self._distill(inbox_id="inbox-3", target_id="t-ci"),
        )
        self.assertEqual(
            self.init_trace_kwargs,
            {
                "run_id": "run-1",
                "task": "CI failure: tests",
                "task_key": "XYZ-1",
                "agent": "deepagents",
            },
        )
        self.assertEqual(self.span, self._span(Stage.CI))
        self.assertEqual(
            self.timed,
            (Stage.CI, {"run_id": "run-1", "task_key": "XYZ-1"}),
        )
        self.round_events.assert_called_once_with("inbox-3", "t-ci")
        build = self.run_round.call_args.args[0]
        with patch.object(fu, "CiAgent") as agent_cls:
            build()
        agent_cls.assert_called_once_with(
            **self._preset_kwargs(
                "ci:XYZ-1", run=WorkflowRunRef("acme", "acme-server", 42)
            )
        )

    def test_finished_round_skips_trace_and_timing_but_distills(self) -> None:
        self.state.append_event({
            "type": fu.FINISHED_EVENT,
            "inbox_id": "inbox-1",
            "thread_id": "followup:XYZ-1",
        })
        entry = {
            "id": "inbox-1",
            "kind": "comment",
            "source": "linear",
            "payload": {
                "target_id": "lin-1",
                "body": "x",
                "task_key": "XYZ-1",
            },
        }
        with patch.object(fu, "init_trace") as init_trace:
            fu.run_followup_comment(entry, self.state)
        init_trace.assert_not_called()
        self.assertFalse(hasattr(self, "timed"))
        self.assertFalse(hasattr(self, "span"))
        self.run_round.assert_not_called()
        self.assertEqual(self.order, ["distill"])

    def test_agent_failure_skips_distillation_and_propagates(self) -> None:
        self.run_round.side_effect = RuntimeError("boom")
        entry = {
            "id": "inbox-1",
            "kind": "comment",
            "source": "linear",
            "payload": {
                "target_id": "lin-1",
                "body": "x",
                "task_key": "XYZ-1",
            },
        }
        with self.assertRaises(RuntimeError):
            fu.run_followup_comment(entry, self.state)
        self.assertNotIn("distill", self.order)
