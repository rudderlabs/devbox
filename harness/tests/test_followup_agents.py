"""FollowUpAgent and CiAgent preset wiring."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from harness.deepagents.agents import followup as fa
from harness.deepagents.checkpointer import _reset_checkpointer, init_checkpointer
from harness.deepagents.middleware.ci_rerun import CiRerunMiddleware, WorkflowRunRef
from harness.deepagents.middleware.memory_writing import (
    MemoryWritingMiddleware,
    RepoScope,
)
from harness.deepagents.middleware.pull_request import (
    PullRequestMiddleware,
    PullRequestRef,
)
from harness.deepagents.middleware.reply import ReplyMiddleware, ReplyTarget
from harness.deepagents.middleware.tool_exclusion import ToolExclusionMiddleware
from harness.deepagents.registry import _reset as _reset_registry
from harness.deepagents.session import DeepAgentSession
from harness.paths import WORKSPACE
from tests.progress_support import round_events

PR_A = PullRequestRef("acme-server", "https://github.com/acme/acme-server/pull/1")
PR_B = PullRequestRef("acme-webapp", "https://github.com/acme/acme-webapp/pull/2")
REPO_A = RepoScope("acme-server")
REPO_B = RepoScope("acme-webapp", ("src/app",))
RUN = WorkflowRunRef("acme", "acme-server", 42)
BUILTINS = {
    "edit_file",
    "execute",
    "glob",
    "grep",
    "ls",
    "read_file",
    "write_file",
    "write_todos",
}


def _followup(events, **overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "model": MagicMock(spec=BaseChatModel),
        "thread_id": "followup:XYZ-1",
        "events": events,
        "targets": [ReplyTarget("c-1", "the comment")],
        "prs": [PR_A],
        "memory_repos": [REPO_A],
        "memory": MagicMock(),
        "github": MagicMock(),
    }
    kwargs.update(overrides)
    return kwargs


def _ci(events, **overrides: Any) -> dict[str, Any]:
    kwargs = _followup(events, thread_id="ci:XYZ-1", run=RUN)
    del kwargs["targets"]
    kwargs.update(overrides)
    return kwargs


class TestPresetWiring(unittest.TestCase):
    def _init_kwargs(self, cls: type, kwargs: dict[str, Any]) -> dict[str, Any]:
        with patch.object(DeepAgentSession, "__init__", return_value=None) as init:
            cls(**kwargs)
        out = dict(init.call_args.kwargs)
        out.pop("model")
        return out

    def test_followup_wiring(self) -> None:
        with round_events("c-1") as events:
            kwargs = _followup(events)
            got = self._init_kwargs(fa.FollowUpAgent, kwargs)
        middleware = got.pop("middleware")
        self.assertEqual(
            got,
            {
                "events": events,
                "thread_id": "followup:XYZ-1",
                "workspace_dir": WORKSPACE,
                "system_prompt": fa.FOLLOWUP_SYSTEM_PROMPT,
                "durable": True,
                "emit_progress": True,
            },
        )
        self.assertEqual(
            [type(m) for m in middleware],
            [
                ToolExclusionMiddleware,
                ReplyMiddleware,
                MemoryWritingMiddleware,
                PullRequestMiddleware,
            ],
        )
        exclusion, reply, memory, prs = middleware
        self.assertEqual(exclusion.excluded, frozenset({"task"}))
        self.assertIs(reply.events, events)
        self.assertEqual(reply.targets, (ReplyTarget("c-1", "the comment"),))
        self.assertEqual(memory.stage, "review")
        self.assertEqual(memory.repos, [REPO_A])
        self.assertIs(memory.events, events)
        self.assertEqual(prs.prs, (PR_A,))

    def test_ci_wiring(self) -> None:
        with round_events("t-ci") as events:
            got = self._init_kwargs(fa.CiAgent, _ci(events))
        middleware = got.pop("middleware")
        self.assertEqual(
            got,
            {
                "events": events,
                "thread_id": "ci:XYZ-1",
                "workspace_dir": WORKSPACE,
                "system_prompt": fa.CI_SYSTEM_PROMPT,
                "durable": True,
                "emit_progress": False,
            },
        )
        self.assertEqual(
            [type(m) for m in middleware],
            [
                ToolExclusionMiddleware,
                ReplyMiddleware,
                MemoryWritingMiddleware,
                PullRequestMiddleware,
                CiRerunMiddleware,
            ],
        )
        reply, memory, rerun = middleware[1], middleware[2], middleware[4]
        self.assertEqual(reply.targets, (ReplyTarget("t-ci", "the CI failure"),))
        self.assertEqual(memory.stage, "ci")
        self.assertEqual(rerun.run, RUN)

    def test_optional_middleware_is_left_out(self) -> None:
        with round_events("c-1") as events:
            got = self._init_kwargs(
                fa.FollowUpAgent, _followup(events, prs=[], memory_repos=[])
            )
        self.assertEqual(
            [type(m) for m in got["middleware"]],
            [ToolExclusionMiddleware, ReplyMiddleware],
        )


class TestOfferedTools(unittest.TestCase):
    """A real graph: the exact tool names the model is offered per round shape."""

    def setUp(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp = tempfile.TemporaryDirectory()
        init_checkpointer(Path(self._tmp.name) / "c.db")

    def tearDown(self) -> None:
        _reset_registry()
        _reset_checkpointer()
        self._tmp.cleanup()

    def _offered(self, cls: type, kwargs: dict[str, Any]) -> dict[str, dict]:
        offered: list[dict[str, dict]] = []

        class RecordingModel(BaseChatModel):
            @property
            def _llm_type(self) -> str:
                return "recording"

            def bind_tools(self, tools, **kw):
                schemas = {}
                for t in tools:
                    if isinstance(t, dict):
                        name = t.get("name") or t["function"]["name"]
                        schemas[name] = t
                    else:
                        schemas[t.name] = t.tool_call_schema.model_json_schema()
                offered.append(schemas)
                return self

            def _generate(self, messages, stop=None, run_manager=None, **kw):
                return ChatResult(
                    generations=[ChatGeneration(message=AIMessage(content="done"))]
                )

        kwargs = dict(kwargs, model=RecordingModel())
        with cls(**kwargs) as agent:
            agent.run("Round brief.")
        return offered[0]

    def test_github_comment_round(self) -> None:
        with round_events("c-1") as events:
            tools = self._offered(fa.FollowUpAgent, _followup(events))
        self.assertEqual(
            set(tools),
            BUILTINS
            | {"reply", "emit_progress", "record_memory", "update_pull_request"},
        )
        reply_fields = set(tools["reply"]["properties"])
        self.assertEqual(reply_fields, {"body"})
        self.assertNotIn("pr", tools["update_pull_request"]["properties"])
        self.assertNotIn("repo", tools["record_memory"]["properties"])

    def test_review_round_offers_a_target_enum(self) -> None:
        targets = [
            ReplyTarget("r-1", "review summary"),
            ReplyTarget("i-1", "inline comment on src/x.go:3"),
        ]
        with round_events("r-1") as events:
            tools = self._offered(fa.FollowUpAgent, _followup(events, targets=targets))
        self.assertEqual(tools["reply"]["properties"]["target"]["enum"], ["r-1", "i-1"])

    def test_several_prs_and_repos_offer_choices(self) -> None:
        with round_events("c-1") as events:
            tools = self._offered(
                fa.FollowUpAgent,
                _followup(events, prs=[PR_A, PR_B], memory_repos=[REPO_A, REPO_B]),
            )
        self.assertEqual(
            tools["update_pull_request"]["properties"]["pr"]["enum"],
            ["acme-server", "acme-webapp"],
        )
        self.assertEqual(
            tools["record_memory"]["properties"]["repo"]["enum"],
            ["acme-server", "acme-webapp"],
        )

    def test_no_prs_offers_no_update_pull_request(self) -> None:
        with round_events("c-1") as events:
            tools = self._offered(fa.FollowUpAgent, _followup(events, prs=[]))
        self.assertNotIn("update_pull_request", tools)

    def test_ci_round(self) -> None:
        with round_events("t-ci") as events:
            tools = self._offered(fa.CiAgent, _ci(events))
        self.assertEqual(
            set(tools),
            BUILTINS
            | {"reply", "record_memory", "update_pull_request", "rerun_failed_ci_jobs"},
        )


if __name__ == "__main__":
    unittest.main()
