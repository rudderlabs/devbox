"""Shared helper: build a preset for real and read the progress it attaches."""

from __future__ import annotations

import contextlib
import tempfile
import unittest
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from langchain_core.language_models import BaseChatModel

from harness.deepagents.file_logging import setup_session_file_logging
from harness.deepagents.middleware.progress_emit import ProgressEmitMiddleware
from harness.events import RoundEvents


def attached_progress(
    testcase: unittest.TestCase,
    build: Callable[[Any, RoundEvents, Path], Any],
) -> ProgressEmitMiddleware:
    """Build a preset via ``build(model, events, tmp)`` with a mocked graph.

    Returns the single ``ProgressEmitMiddleware`` handed to ``create_deep_agent``.
    """
    with tempfile.TemporaryDirectory() as raw_tmp:
        tmp = Path(raw_tmp)
        events = RoundEvents(
            events_file=tmp / "events.jsonl",
            events_lock=tmp / "events.lock",
            inbox_id="inbox-1",
            target_id="t",
        )
        with (
            patch("harness.deepagents.session.create_deep_agent") as create,
            patch(
                "harness.deepagents.session.setup_session_file_logging",
                side_effect=lambda thread_id: setup_session_file_logging(
                    thread_id, tmp / "logs"
                ),
            ),
        ):
            session = build(MagicMock(spec=BaseChatModel), events, tmp)
            try:
                middleware = create.call_args.kwargs["middleware"]
            finally:
                session.close()
    progress = [m for m in middleware if isinstance(m, ProgressEmitMiddleware)]
    testcase.assertEqual(len(progress), 1)
    testcase.assertIs(progress[0].events, events)
    testcase.assertEqual(progress[0].events.target_id, "t")
    return progress[0]


@contextlib.contextmanager
def round_events(target_id: str = "t-1") -> Iterator[RoundEvents]:
    """A real ``RoundEvents`` writing into a temp dir, for forwarding tests."""
    with tempfile.TemporaryDirectory() as raw_tmp:
        tmp = Path(raw_tmp)
        yield RoundEvents(
            events_file=tmp / "events.jsonl",
            events_lock=tmp / "events.lock",
            inbox_id="inbox-1",
            target_id=target_id,
        )


def assert_agent_wired(
    testcase: unittest.TestCase,
    agent_cls: MagicMock,
    events: RoundEvents,
    target_id: str = "t-1",
) -> None:
    """Assert every construction of ``agent_cls`` got this client and target.

    The target travels inside the client, never as a separate argument.
    """
    testcase.assertGreater(agent_cls.call_count, 0)
    for call in agent_cls.call_args_list:
        testcase.assertIs(call.kwargs["events"], events)
        testcase.assertEqual(call.kwargs["events"].target_id, target_id)
        testcase.assertFalse([key for key in call.kwargs if key.endswith("_target")])
