"""Flag-on durable follow-up rounds end to end.

The real handler, runner, preset, DeepAgents graph, ``reply`` tool and SQLite
checkpointer run; only inference, the distillation, the discussion fetch and
the GitHub and memory clients are replaced. Each test compares the
whole ``events.jsonl``.
"""

from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

import harness.handlers.ci_result as ci_result_module
import harness.handlers.comment as comment_module
import harness.handlers.user_review as user_review_module
from harness import followup as fu
from harness.daemon import DaemonState
from harness.deepagents.agents import followup as fa
from harness.deepagents.checkpointer import _reset_checkpointer, init_checkpointer
from harness.deepagents.registry import _reset as _reset_registry
from harness.events import iter_events
from tests.test_sessions_deepagent import (
    _patch_session_file_logging,
    _scrub_harness_env,
)

TS = "2026-10-07T00:00:00Z"
PR = {"repo": "acme-webapp", "pr_url": "https://github.com/o/acme-webapp/pull/1"}


class _PodDied(BaseException):
    """The process dies mid-round (not an ``Exception``: nothing may swallow it)."""


def _replying_model(
    replies: list[dict[str, Any]],
    *,
    seen: list[list[Any]] | None = None,
    dies: bool = False,
) -> BaseChatModel:
    """Calls ``reply`` once per entry of ``replies`` in one turn, then answers.

    ``seen`` records every prompt; ``dies`` kills the process on the first call.
    """

    class ReplyingModel(BaseChatModel):
        @property
        def _llm_type(self) -> str:
            return "replying"

        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if seen is not None:
                seen.append(list(messages))
            if dies:
                raise _PodDied()
            if any(isinstance(m, ToolMessage) for m in messages):
                message = AIMessage(content="done")
            else:
                message = AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "reply",
                            "args": args,
                            "id": f"call-{i}",
                            "type": "tool_call",
                        }
                        for i, args in enumerate(replies)
                    ],
                )
            return ChatResult(generations=[ChatGeneration(message=message)])

    return ReplyingModel()


class FollowupE2E(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        workspace = self.tmp / "workspace"
        workspace.mkdir()
        for name in (".processed", ".error"):
            (self.tmp / name).mkdir()
        self.state = DaemonState(
            events_file=self.tmp / "events.jsonl",
            events_lock=self.tmp / "events.lock",
            processed_dir=self.tmp / ".processed",
            error_dir=self.tmp / ".error",
        )
        _scrub_harness_env(self)
        _patch_session_file_logging(self, self.tmp / "logs")
        init_checkpointer(self.tmp / "cp.db")
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(_reset_checkpointer)
        self.addCleanup(_reset_registry)

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(fa, "WORKSPACE", workspace))
        stack.enter_context(patch("harness.events.iso_now", return_value=TS))
        self.distilled: list[str] = []

        @contextlib.contextmanager
        def distill(**kwargs):
            self.distilled.append(kwargs["inbox_id"])
            yield

        stack.enter_context(
            patch.object(fu, "post_code_round_distillation", side_effect=distill)
        )
        self.discussion = stack.enter_context(
            patch.object(fu, "fetch_discussion_context_for_pr", return_value="")
        )
        stack.enter_context(patch.object(fu, "_read_json_or_none", return_value={}))
        stack.enter_context(patch.object(fu, "seeded_context_block", return_value=""))
        stack.enter_context(patch.object(fu, "GitHubClient", return_value=MagicMock()))
        stack.enter_context(patch.object(fu, "MemoryStore", return_value=MagicMock()))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def _model(self, replies: list[dict[str, Any]], **kwargs: Any) -> Any:
        return patch.object(
            fu, "_model", return_value=_replying_model(replies, **kwargs)
        )

    def _events(self) -> list[dict[str, Any]]:
        return list(iter_events(self.state.events_file))

    @staticmethod
    def _numbered(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{"seq": i, "ts": TS, **e} for i, e in enumerate(events, start=1)]

    def test_comment_round(self) -> None:
        entry = {
            "id": "inbox-c",
            "kind": "comment",
            "source": "github",
            "payload": {
                "target_id": "c-1",
                "body": "Please tweak the copy.",
                "task_key": "XYZ-1",
                "pr": PR,
            },
        }
        with (
            self._model([{"body": "Tweaked the copy."}]),
        ):
            comment_module.process_comment(entry, self.state)
        self.assertEqual(
            self._events(),
            self._numbered([
                {
                    "type": "agent_response",
                    "inbox_id": "inbox-c",
                    "target_id": "c-1",
                    "body": "Tweaked the copy.",
                },
                {
                    "type": "followup_agent_finished",
                    "inbox_id": "inbox-c",
                    "thread_id": "followup:XYZ-1",
                },
                {"type": "completed", "inbox_id": "inbox-c"},
            ]),
        )

    def test_review_round_backfills_a_silent_inline_but_not_the_summary(self) -> None:
        entry = {
            "id": "inbox-r",
            "kind": "review",
            "source": "github",
            "payload": {
                "review_body": {"target_id": "rb-1", "body": "Please fix."},
                "inline_comments": [
                    {"target_id": "il-1", "path": "x.py", "line": 3, "body": "nit"},
                    {"target_id": "il-2", "path": "y.py", "line": 9, "body": "typo"},
                ],
                "task_key": "XYZ-1",
                "pr": PR,
            },
        }
        with (
            self._model([{"body": "Fixed the nit.", "target": "il-1"}]),
        ):
            user_review_module.process_user_review(entry, self.state)
        self.assertEqual(
            self._events(),
            self._numbered([
                {
                    "type": "agent_response",
                    "inbox_id": "inbox-r",
                    "target_id": "il-1",
                    "body": "Fixed the nit.",
                },
                {
                    "type": "followup_agent_finished",
                    "inbox_id": "inbox-r",
                    "thread_id": "followup:XYZ-1",
                },
                {
                    "type": "agent_response",
                    "inbox_id": "inbox-r",
                    "target_id": "il-2",
                    "body": "⚠ I finished here but didn't post a reply on this item.",
                },
                {"type": "completed", "inbox_id": "inbox-r"},
            ]),
        )

    @staticmethod
    def _ci_entry() -> dict[str, Any]:
        return {
            "id": "inbox-ci",
            "kind": "ci_result",
            "source": "github",
            "payload": {
                "target_id": "tgt-ci",
                "task_key": "XYZ-1",
                "workflow_name": "CI",
                "conclusion": "failure",
                "run_url": "https://github.com/acme/acme-server/actions/runs/42",
                "pr": PR,
            },
        }

    def test_ci_round(self) -> None:
        entry = self._ci_entry()
        jobs = [{"job_name": "test", "job_id": 1, "log_path": "/tmp/logs/test.log"}]
        with (
            patch.object(
                ci_result_module, "fetch_failed_job_logs", return_value=(jobs, [])
            ),
            self._model([{"body": "Fixed the failing test."}]),
        ):
            ci_result_module.process_ci_result(entry, self.state)
        self.assertEqual(
            self._events(),
            self._numbered([
                {
                    "type": "agent_response",
                    "inbox_id": "inbox-ci",
                    "target_id": "tgt-ci",
                    "body": "Fixed the failing test.",
                },
                {
                    "type": "followup_agent_finished",
                    "inbox_id": "inbox-ci",
                    "thread_id": "ci:XYZ-1",
                },
                {"type": "completed", "inbox_id": "inbox-ci"},
            ]),
        )

    # ---- Restarts: a started round must not be re-briefed or short-circuited ----

    def test_finished_ci_round_restarted_without_logs_only_completes(self) -> None:
        entry = self._ci_entry()
        self.state.append_event({
            "type": "agent_response",
            "inbox_id": "inbox-ci",
            "target_id": "tgt-ci",
            "body": "Fixed and pushed.",
        })
        self.state.append_event({
            "type": "followup_agent_finished",
            "inbox_id": "inbox-ci",
            "thread_id": "ci:XYZ-1",
        })
        with (
            patch.object(
                ci_result_module,
                "fetch_failed_job_logs",
                return_value=([], ["HTTP 503"]),
            ) as fetch,
            patch.object(fu, "CiAgent", side_effect=AssertionError("agent built")),
            self._model([]),
        ):
            ci_result_module.process_ci_result(entry, self.state)
        fetch.assert_not_called()
        self.assertEqual(self.distilled, ["inbox-ci"])
        self.assertEqual(
            self._events(),
            self._numbered([
                {
                    "type": "agent_response",
                    "inbox_id": "inbox-ci",
                    "target_id": "tgt-ci",
                    "body": "Fixed and pushed.",
                },
                {
                    "type": "followup_agent_finished",
                    "inbox_id": "inbox-ci",
                    "thread_id": "ci:XYZ-1",
                },
                {"type": "completed", "inbox_id": "inbox-ci"},
            ]),
        )

    def test_interrupted_ci_round_after_a_rerun_resumes_with_the_nudge(self) -> None:
        entry = self._ci_entry()
        jobs = [{"job_name": "test", "job_id": 1, "log_path": "/tmp/logs/test.log"}]
        with (
            patch.object(
                ci_result_module, "fetch_failed_job_logs", return_value=(jobs, [])
            ),
            self._model([], dies=True),
            self.assertRaises(_PodDied),
        ):
            ci_result_module.process_ci_result(entry, self.state)
        self.assertEqual(self._events(), [])

        seen: list[list[Any]] = []
        with (
            patch.object(
                ci_result_module, "fetch_failed_job_logs", return_value=([], [])
            ) as fetch,
            self._model([{"body": "Fixed the failing test."}], seen=seen),
        ):
            ci_result_module.process_ci_result(entry, self.state)
        fetch.assert_not_called()
        self.assertEqual(
            seen[0][-1].content,
            fu.continue_nudge(replied=[], pending=["tgt-ci"], optional=[]),
        )
        self.assertEqual(
            self._events(),
            self._numbered([
                {
                    "type": "agent_response",
                    "inbox_id": "inbox-ci",
                    "target_id": "tgt-ci",
                    "body": "Fixed the failing test.",
                },
                {
                    "type": "followup_agent_finished",
                    "inbox_id": "inbox-ci",
                    "thread_id": "ci:XYZ-1",
                },
                {"type": "completed", "inbox_id": "inbox-ci"},
            ]),
        )

    # ---- Discussion is fetched only when a brief is actually sent ----

    @staticmethod
    def _comment_entry(inbox_id: str, target_id: str) -> dict[str, Any]:
        return {
            "id": inbox_id,
            "kind": "comment",
            "source": "github",
            "payload": {
                "target_id": target_id,
                "body": "Please tweak the copy.",
                "task_key": "XYZ-1",
                "pr": PR,
                "created_at": TS,
            },
        }

    @staticmethod
    def _review_entry() -> dict[str, Any]:
        return {
            "id": "inbox-r",
            "kind": "review",
            "source": "github",
            "payload": {
                "review_body": {"target_id": "rb-1", "body": "Please fix."},
                "inline_comments": [
                    {"target_id": "il-1", "path": "x.py", "line": 3, "body": "nit"}
                ],
                "task_key": "XYZ-1",
                "pr": PR,
            },
        }

    def _comment(self, entry: dict[str, Any], **model_kwargs: Any) -> None:
        with (
            self._model([{"body": "Tweaked the copy."}], **model_kwargs),
        ):
            comment_module.process_comment(entry, self.state)

    def _review(self, entry: dict[str, Any], **model_kwargs: Any) -> None:
        with (
            self._model([{"body": "Fixed the nit.", "target": "il-1"}], **model_kwargs),
        ):
            user_review_module.process_user_review(entry, self.state)

    def test_fresh_comment_round_fetches_the_discussion_once(self) -> None:
        self.discussion.return_value = "EARLIER"
        seen: list[list[Any]] = []
        entry = self._comment_entry("inbox-c", "c-1")
        self._comment(entry, seen=seen)
        self.discussion.assert_called_once_with(
            PR,
            "followup:XYZ-1",
            TS,
            fu.comment_own_items("c-1", "Please tweak the copy."),
        )
        self.assertEqual(
            seen[0][-1].content,
            "\n\nEARLIER\n\n"
            + fu.comment_brief(body="Please tweak the copy.", channel="github", pr=PR),
        )

    def test_new_comment_round_fetches_the_discussion_once(self) -> None:
        self._comment(self._comment_entry("inbox-1", "c-1"))
        self.discussion.reset_mock()
        self.discussion.return_value = "EARLIER"
        seen: list[list[Any]] = []
        self._comment(self._comment_entry("inbox-2", "c-2"), seen=seen)
        self.discussion.assert_called_once_with(
            PR,
            "followup:XYZ-1",
            TS,
            fu.comment_own_items("c-2", "Please tweak the copy."),
        )
        self.assertEqual(
            seen[0][-1].content,
            "EARLIER\n\n"
            + fu.comment_brief(body="Please tweak the copy.", channel="github", pr=PR),
        )

    def test_interrupted_comment_round_does_not_fetch_the_discussion(self) -> None:
        entry = self._comment_entry("inbox-c", "c-1")
        with self.assertRaises(_PodDied):
            self._comment(entry, dies=True)
        self.discussion.reset_mock()
        seen: list[list[Any]] = []
        self._comment(entry, seen=seen)
        self.discussion.assert_not_called()
        self.assertEqual(
            seen[0][-1].content,
            fu.continue_nudge(replied=[], pending=["c-1"], optional=[]),
        )

    def test_finished_comment_round_does_not_fetch_the_discussion(self) -> None:
        entry = self._comment_entry("inbox-c", "c-1")
        self.state.append_event({
            "type": "followup_agent_finished",
            "inbox_id": "inbox-c",
            "thread_id": "followup:XYZ-1",
        })
        with patch.object(fu, "FollowUpAgent", side_effect=AssertionError("built")):
            self._comment(entry)
        self.discussion.assert_not_called()
        self.assertEqual(self.distilled, ["inbox-c"])
        self.assertEqual(
            self._events(),
            self._numbered([
                {
                    "type": "followup_agent_finished",
                    "inbox_id": "inbox-c",
                    "thread_id": "followup:XYZ-1",
                },
                {
                    "type": "agent_response",
                    "inbox_id": "inbox-c",
                    "target_id": "c-1",
                    "body": "⚠ I finished here but didn't post a reply on this item.",
                },
                {"type": "completed", "inbox_id": "inbox-c"},
            ]),
        )

    def test_interrupted_review_round_does_not_fetch_the_discussion(self) -> None:
        entry = self._review_entry()
        with self.assertRaises(_PodDied):
            self._review(entry, dies=True)
        self.discussion.reset_mock()
        seen: list[list[Any]] = []
        self._review(entry, seen=seen)
        self.discussion.assert_not_called()
        self.assertEqual(
            seen[0][-1].content,
            fu.continue_nudge(replied=[], pending=["il-1"], optional=["rb-1"]),
        )

    def test_finished_review_round_does_not_fetch_the_discussion(self) -> None:
        entry = self._review_entry()
        self.state.append_event({
            "type": "followup_agent_finished",
            "inbox_id": "inbox-r",
            "thread_id": "followup:XYZ-1",
        })
        with patch.object(fu, "FollowUpAgent", side_effect=AssertionError("built")):
            self._review(entry)
        self.discussion.assert_not_called()
        self.assertEqual(self.distilled, ["inbox-r"])
        self.assertEqual(
            self._events(),
            self._numbered([
                {
                    "type": "followup_agent_finished",
                    "inbox_id": "inbox-r",
                    "thread_id": "followup:XYZ-1",
                },
                {
                    "type": "agent_response",
                    "inbox_id": "inbox-r",
                    "target_id": "il-1",
                    "body": "⚠ I finished here but didn't post a reply on this item.",
                },
                {"type": "completed", "inbox_id": "inbox-r"},
            ]),
        )

    def _review_brief(self) -> str:
        payload = self._review_entry()["payload"]
        return fu.review_brief(
            review_body=payload["review_body"],
            inlines=payload["inline_comments"],
            channel="github",
            pr=PR,
        )

    def _review_own_items(self) -> Any:
        payload = self._review_entry()["payload"]
        return fu.review_own_items(payload["review_body"], payload["inline_comments"])

    def test_fresh_review_round_fetches_the_discussion_once(self) -> None:
        self.discussion.return_value = "EARLIER"
        seen: list[list[Any]] = []
        self._review(self._review_entry(), seen=seen)
        self.discussion.assert_called_once_with(
            PR, "followup:XYZ-1", None, self._review_own_items()
        )
        self.assertEqual(seen[0][-1].content, "\n\nEARLIER\n\n" + self._review_brief())

    def test_new_review_round_fetches_the_discussion_once(self) -> None:
        self._comment(self._comment_entry("inbox-1", "c-1"))
        self.discussion.reset_mock()
        self.discussion.return_value = "EARLIER"
        seen: list[list[Any]] = []
        self._review(self._review_entry(), seen=seen)
        self.discussion.assert_called_once_with(
            PR, "followup:XYZ-1", None, self._review_own_items()
        )
        self.assertEqual(seen[0][-1].content, "EARLIER\n\n" + self._review_brief())


if __name__ == "__main__":
    unittest.main()
