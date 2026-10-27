"""The durable follow-up round runner."""

from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any
from unittest.mock import patch

from harness import followup as fu
from harness.daemon import DaemonState
from harness.deepagents import retry
from harness.events import iter_events


def _state(tmp: Path) -> DaemonState:
    for name in (".processed", ".error"):
        (tmp / name).mkdir(exist_ok=True)
    return DaemonState(
        events_file=tmp / "events.jsonl",
        events_lock=tmp / "events.lock",
        processed_dir=tmp / ".processed",
        error_dir=tmp / ".error",
    )


class FakeSession:
    """Records what the runner does; ``fail`` raises on ``run``."""

    def __init__(self, log: list, *, prior: bool, tag: str | None, fail=None) -> None:
        self.log = log
        self.has_prior_state = prior
        self.latest_round_tag = tag
        self.thread_id = "followup:XYZ-1"
        self.fail = fail
        self.marker = 0

    @property
    def progress_marker(self) -> int:
        return self.marker

    def repair_dangling_tool_calls(self, *, round_tag: str | None = None) -> None:
        self.log.append(("repair", round_tag))

    def run(self, prompt: str, *, round_tag: str | None = None) -> list:
        self.log.append(("run", prompt, round_tag))
        if self.fail is not None:
            exc, progress = self.fail
            if progress:
                self.marker += 1
            raise exc
        return []

    def close(self) -> None:
        self.log.append(("close",))


class Transient(Exception):
    pass


class TestContinueNudge(unittest.TestCase):
    def test_lists(self) -> None:
        self.assertEqual(
            fu.continue_nudge(replied=["901"], pending=["902"], optional=["900"]),
            (
                "This round was interrupted. Continue from where you "
                "left off; your earlier work in this round is above.\n"
                "Already replied to: `901`.\n"
                "Still to reply to: `902`.\n"
                "Optional: `900`."
            ),
        )

    def test_empty_lists(self) -> None:
        self.assertEqual(
            fu.continue_nudge(replied=[], pending=["c-1"], optional=[]),
            (
                "This round was interrupted. Continue from where you "
                "left off; your earlier work in this round is above.\n"
                "Already replied to: none.\n"
                "Still to reply to: `c-1`."
            ),
        )


class TestRoundStarted(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.state = _state(Path(self._tmp.name))
        self.addCleanup(self._tmp.cleanup)

    def _started(self, tag: str | None) -> bool:
        with patch.object(fu, "latest_round_tag", return_value=tag) as latest:
            started = fu.round_started(self.state, "inbox-2", "ci:XYZ-1")
        latest.assert_called_once_with("ci:XYZ-1")
        return started

    def test_not_started_without_a_checkpoint(self) -> None:
        self.assertFalse(self._started(None))

    def test_not_started_when_the_latest_tag_is_another_round(self) -> None:
        self.assertFalse(self._started("inbox-1"))

    def test_started_when_the_latest_tag_is_this_round(self) -> None:
        self.assertTrue(self._started("inbox-2"))

    def test_started_when_the_agent_finished_without_reading_the_checkpoint(
        self,
    ) -> None:
        self.state.append_event({
            "type": fu.FINISHED_EVENT,
            "inbox_id": "inbox-2",
            "thread_id": "ci:XYZ-1",
        })
        with patch.object(fu, "latest_round_tag", return_value=None):
            self.assertTrue(fu.round_started(self.state, "inbox-2", "ci:XYZ-1"))

    def test_another_rounds_finished_event_does_not_count(self) -> None:
        self.state.append_event({
            "type": fu.FINISHED_EVENT,
            "inbox_id": "inbox-1",
            "thread_id": "ci:XYZ-1",
        })
        self.assertFalse(self._started(None))


class TestRunFollowupRound(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.state = _state(Path(self._tmp.name))
        self.log: list[Any] = []
        self.briefs = 0

        def brief() -> str:
            self.briefs += 1
            return "BRIEF"

        self.brief = brief

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, sessions: list[FakeSession], **kw: Any) -> None:
        it = iter(sessions)
        args = {
            "state": self.state,
            "inbox_id": "inbox-2",
            "brief": self.brief,
            "seed": "SEED",
            "targets": ["c-1"],
            "label": "followup/XYZ-1",
        }
        args.update(kw)
        self.out = io.StringIO()
        with (
            patch.object(
                retry,
                "is_transient_model_exception",
                side_effect=lambda e: isinstance(e, Transient),
            ),
            patch.object(retry, "retry_sleep_seconds", return_value=0.0),
            patch.object(retry.time, "sleep"),
            redirect_stdout(self.out),
        ):
            fu.run_followup_round(lambda: next(it), **args)

    def _finished(self) -> list[dict]:
        return [
            {k: v for k, v in e.items() if k not in ("seq", "ts")}
            for e in iter_events(self.state.events_file)
            if e.get("type") == fu.FINISHED_EVENT
        ]

    def test_fresh_thread_gets_seed_and_brief(self) -> None:
        self._run([FakeSession(self.log, prior=False, tag=None)])
        self.assertEqual(self.log, [("run", "SEED\n\nBRIEF", "inbox-2"), ("close",)])
        self.assertEqual(self.briefs, 1)
        self.assertEqual(
            self._finished(),
            [
                {
                    "type": fu.FINISHED_EVENT,
                    "inbox_id": "inbox-2",
                    "thread_id": "followup:XYZ-1",
                }
            ],
        )

    def test_finished_event_is_appended_before_the_session_closes(self) -> None:
        class Recording(FakeSession):
            def close(inner) -> None:
                inner.log.append(("events", len(self._finished())))
                super().close()

        self._run([Recording(self.log, prior=False, tag=None)])
        self.assertEqual(
            self.log,
            [("run", "SEED\n\nBRIEF", "inbox-2"), ("events", 1), ("close",)],
        )
        self.assertEqual(len(self._finished()), 1)

    def test_new_round_repairs_under_the_old_tag_then_sends_the_brief(self) -> None:
        self._run([FakeSession(self.log, prior=True, tag="inbox-1")])
        self.assertEqual(
            self.log,
            [("repair", "inbox-1"), ("run", "BRIEF", "inbox-2"), ("close",)],
        )
        self.assertEqual(self.briefs, 1)

    def test_crashed_round_repairs_and_nudges(self) -> None:
        self.state.append_event({
            "type": "agent_response",
            "inbox_id": "inbox-2",
            "target_id": "901",
            "body": "x",
        })
        self._run(
            [FakeSession(self.log, prior=True, tag="inbox-2")],
            targets=["900", "901", "902"],
            optional_targets=frozenset({"900"}),
        )
        self.assertEqual(
            self.log,
            [
                ("repair", "inbox-2"),
                (
                    "run",
                    fu.continue_nudge(
                        replied=["901"], pending=["902"], optional=["900"]
                    ),
                    "inbox-2",
                ),
                ("close",),
            ],
        )
        self.assertEqual(self.briefs, 0)

    def test_crashed_round_counts_an_agent_error_as_replied(self) -> None:
        self.state.append_event({
            "type": "agent_error",
            "inbox_id": "inbox-2",
            "target_id": "c-1",
            "body": "x",
        })
        self._run(
            [FakeSession(self.log, prior=True, tag="inbox-2")],
            targets=["c-1", "c-2"],
        )
        self.assertEqual(
            self.log,
            [
                ("repair", "inbox-2"),
                (
                    "run",
                    fu.continue_nudge(replied=["c-1"], pending=["c-2"], optional=[]),
                    "inbox-2",
                ),
                ("close",),
            ],
        )

    def test_finished_round_skips_the_agent(self) -> None:
        self.state.append_event({
            "type": fu.FINISHED_EVENT,
            "inbox_id": "inbox-2",
            "thread_id": "followup:XYZ-1",
        })
        self._run([])
        self.assertEqual(self.log, [])
        self.assertEqual(self.briefs, 0)
        self.assertEqual(len(self._finished()), 1)

    def test_retry_without_progress_resends_the_brief(self) -> None:
        self._run(
            [
                FakeSession(
                    self.log, prior=True, tag="inbox-1", fail=(Transient(), False)
                ),
                FakeSession(self.log, prior=True, tag="inbox-1"),
            ],
            max_retries=2,
        )
        self.assertEqual(
            self.log,
            [
                ("repair", "inbox-1"),
                ("run", "BRIEF", "inbox-2"),
                ("close",),
                ("repair", "inbox-1"),
                ("run", "BRIEF", "inbox-2"),
                ("close",),
            ],
        )
        self.assertEqual(self.briefs, 1)
        self.assertEqual(
            self.out.getvalue(),
            "warning: transient model error in DeepAgents worker followup/XYZ-1; retrying after attempt 1/7; consecutive no-progress failures 1/2; sleeping 0.0s: Transient: \n",
        )

    def test_retry_after_progress_nudges(self) -> None:
        self._run(
            [
                FakeSession(
                    self.log, prior=True, tag="inbox-1", fail=(Transient(), True)
                ),
                FakeSession(self.log, prior=True, tag="inbox-2"),
            ],
            max_retries=2,
        )
        self.assertEqual(
            self.log[3:],
            [
                ("repair", "inbox-2"),
                (
                    "run",
                    fu.continue_nudge(replied=[], pending=["c-1"], optional=[]),
                    "inbox-2",
                ),
                ("close",),
            ],
        )
        self.assertEqual(
            self.out.getvalue(),
            "warning: transient model error in DeepAgents worker followup/XYZ-1; retrying after attempt 1/7 after checkpoint progress; consecutive no-progress failures 0/2; sleeping 0.0s: Transient: \n",
        )

    def test_retry_after_progress_never_builds_the_brief(self) -> None:
        self._run(
            [
                FakeSession(
                    self.log, prior=True, tag="inbox-2", fail=(Transient(), True)
                ),
                FakeSession(self.log, prior=True, tag="inbox-2"),
            ],
            max_retries=2,
        )
        self.assertEqual(self.briefs, 0)

    def test_the_brief_is_built_once_across_a_fresh_retry(self) -> None:
        self._run(
            [
                FakeSession(self.log, prior=False, tag=None, fail=(Transient(), False)),
                FakeSession(self.log, prior=False, tag=None),
            ],
            max_retries=2,
        )
        self.assertEqual(
            [e for e in self.log if e[0] == "run"],
            [
                ("run", "SEED\n\nBRIEF", "inbox-2"),
                ("run", "SEED\n\nBRIEF", "inbox-2"),
            ],
        )
        self.assertEqual(self.briefs, 1)

    def test_non_transient_error_propagates_without_finishing(self) -> None:
        with self.assertRaises(ValueError):
            self._run([
                FakeSession(
                    self.log, prior=False, tag=None, fail=(ValueError("bad"), False)
                )
            ])
        self.assertEqual(self._finished(), [])

    def test_consecutive_failures_without_progress_are_bounded(self) -> None:
        sessions = [
            FakeSession(self.log, prior=False, tag=None, fail=(Transient(), False))
            for _ in range(3)
        ]
        with self.assertRaises(Transient):
            self._run(sessions, max_retries=2)
        self.assertEqual(sum(1 for e in self.log if e[0] == "run"), 3)
        self.assertEqual(
            self.out.getvalue(),
            "warning: transient model error in DeepAgents worker followup/XYZ-1; retrying after attempt 1/7; consecutive no-progress failures 1/2; sleeping 0.0s: Transient: \nwarning: transient model error in DeepAgents worker followup/XYZ-1; retrying after attempt 2/7; consecutive no-progress failures 2/2; sleeping 0.0s: Transient: \n",
        )
        self.assertEqual(self._finished(), [])

    def test_progress_resets_the_budget_but_the_hard_cap_holds(self) -> None:
        # Every attempt makes progress, so only the hard cap (max_retries*3+1) stops it.
        sessions = [
            FakeSession(self.log, prior=True, tag="inbox-2", fail=(Transient(), True))
            for _ in range(4)
        ]
        with self.assertRaises(Transient):
            self._run(sessions, max_retries=1)
        self.assertEqual(sum(1 for e in self.log if e[0] == "run"), 4)
        self.assertEqual(
            self.out.getvalue(),
            "warning: transient model error in DeepAgents worker followup/XYZ-1; retrying after attempt 1/4 after checkpoint progress; consecutive no-progress failures 0/1; sleeping 0.0s: Transient: \nwarning: transient model error in DeepAgents worker followup/XYZ-1; retrying after attempt 2/4 after checkpoint progress; consecutive no-progress failures 0/1; sleeping 0.0s: Transient: \nwarning: transient model error in DeepAgents worker followup/XYZ-1; retrying after attempt 3/4 after checkpoint progress; consecutive no-progress failures 0/1; sleeping 0.0s: Transient: \n",
        )


if __name__ == "__main__":
    unittest.main()
