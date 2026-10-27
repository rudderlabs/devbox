"""DeepAgentSession — a resumable, checkpoint-aware agent session.

Wraps the deepagents SDK's ``create_deep_agent`` into a lifecycle-managed
session that handles backend creation, checkpointing, and thread_id
conflict detection.
"""

from __future__ import annotations

import types
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends.local_shell import LocalShellBackend
from deepagents.graph import DeepAgentState
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AnyMessage
from langchain_core.tools import BaseTool

from harness.deepagents.checkpointer import (
    ROUND_TAG_KEY,
    get_checkpointer,
    round_tag_of,
)
from harness.deepagents.file_logging import (
    SessionFileLogHandle,
    setup_session_file_logging,
)
from harness.deepagents.middleware.logging import LoggingMiddleware
from harness.deepagents.middleware.progress_emit import ProgressEmitMiddleware
from harness.deepagents.registry import claim, release
from harness.env_flags import deepagents_event_streaming_enabled
from harness.events import RoundEvents
from harness.paths import DEEPAGENTS_EVENTS_DIR


def _strict_response_format(response_format: Any) -> Any:
    """Request provider-side strict structured-output validation for raw schemas."""
    if response_format is None:
        return None
    try:
        from langchain.agents.structured_output import (
            AutoStrategy,
            ProviderStrategy,
            ToolStrategy,
        )
    except Exception:
        return response_format

    if isinstance(response_format, (AutoStrategy, ProviderStrategy, ToolStrategy)):
        return response_format
    if isinstance(response_format, (dict, type)):
        return ProviderStrategy(response_format, strict=True)
    return response_format


class DeepAgentSession[T]:
    """A resumable agent session backed by deepagents.

    Parameters
    ----------
    model:
        A LangChain ``BaseChatModel`` instance.  Caller builds it.
    thread_id:
        Deterministic session identity.  Used for checkpoint scoping and
        conflict detection.
    workspace_dir:
        Root directory for the ``LocalShellBackend``.  The agent gets
        filesystem and shell access rooted here.
    system_prompt:
        Prepended to deepagents' default system prompt.
    tools:
        Additional tools merged with deepagents builtins.
    middleware:
        Additional middleware inserted into the deepagents stack. A session-bound
        ``LoggingMiddleware`` is prepended unless this sequence already contains
        one. A progress-emitting middleware is appended when progress is enabled
        and ``events`` is given.
    response_format:
        Pydantic model class for structured output.  When set, ``run()``
        returns a parsed instance of this type.
    durable:
        When ``True`` (default), enables SQLite checkpointing via the
        module singleton.  ``init_checkpointer()`` must have been called.
    in_memory:
        When ``durable=False`` and ``in_memory=True``, use LangGraph's in-memory
        checkpointer so a non-durable session can retain state across multiple
        prompts in the same process. The ``MemorySaver`` import is lazy and the
        default path leaves checkpointing disabled.
    inherit_env:
        When ``True`` (default), the shell backend inherits the process
        environment, so the agent's commands see the sandbox toolchain and
        proxy configuration (``PATH``, ``GOPATH``/``GOPROXY``, CA-cert vars,
        …).  ``LocalShellBackend``
        otherwise defaults to an empty environment, which breaks toolchains
        that need those vars (e.g. ``go``/``make`` reaching the module proxy).
    events:
        The round's events client, required and keyword-only. ``None`` means
        the session has no round to report to. It is the only source of
        progress and of the inbox id recorded in stream metrics; the
        environment is never consulted.
    emit_progress:
        When ``True`` (default), attach a best-effort ``emit_progress`` tool
        posting to the round's target through ``events``. Nothing is attached
        without ``events``, or when the caller already supplies a
        ``ProgressEmitMiddleware``.
    emit_identifier:
        Optional worker label included in progress events and prefixed in their
        bodies so parallel repository workers can be distinguished.
    shell_env:
        Extra environment variables for the agent's shell, layered over the
        inherited environment when ``inherit_env`` is true.
    """

    def __init__(
        self,
        *,
        model: BaseChatModel,
        thread_id: str,
        workspace_dir: Path,
        system_prompt: str | None = None,
        tools: Sequence[BaseTool | Callable] | None = None,
        middleware: Sequence[Any] | None = None,
        response_format: type[T] | None = None,
        durable: bool = True,
        in_memory: bool = False,
        inherit_env: bool = True,
        events: RoundEvents | None,
        emit_progress: bool = True,
        emit_identifier: str | None = None,
        shell_env: Mapping[str, str] | None = None,
    ) -> None:
        self._thread_id = thread_id
        self._inbox_id = events.inbox_id if events is not None else None
        self._response_format = response_format
        self._closed = False
        self._file_log_handle: SessionFileLogHandle | None = None

        # Claim thread_id — fails fast on conflict.
        claim(thread_id)
        self._claimed = True

        try:
            self._file_log_handle = setup_session_file_logging(thread_id)
            effective_middleware = list(middleware or [])
            if not any(
                isinstance(item, LoggingMiddleware) for item in effective_middleware
            ):
                effective_middleware.insert(
                    0, LoggingMiddleware(logger=self._file_log_handle.logger)
                )
            if (
                emit_progress
                and events is not None
                and not any(
                    isinstance(item, ProgressEmitMiddleware)
                    for item in effective_middleware
                )
            ):
                effective_middleware.append(
                    ProgressEmitMiddleware(
                        events=events,
                        worker_label=emit_identifier,
                    )
                )

            # Backend: real filesystem + shell at workspace_dir. inherit_env
            # passes the sandbox environment (toolchain + proxy/CA vars) to the
            # agent's shell; the LocalShellBackend default of an empty env
            # breaks go/make and similar.
            backend = LocalShellBackend(
                root_dir=workspace_dir.resolve(),
                virtual_mode=False,
                env=dict(shell_env) if shell_env else None,
                inherit_env=inherit_env,
            )

            # Checkpointer: singleton SQLite when durable; optional in-memory
            # saver for multi-prompt non-durable sessions; None otherwise.
            if durable:
                checkpointer = get_checkpointer()
            elif in_memory:
                from langgraph.checkpoint.memory import MemorySaver

                checkpointer = MemorySaver()
            else:
                checkpointer = None

            # Build the agent graph.
            kwargs: dict[str, Any] = {
                "model": model,
                "backend": backend,
                "state_schema": DeepAgentState,
                "checkpointer": checkpointer,
            }
            if system_prompt is not None:
                kwargs["system_prompt"] = system_prompt
            if tools is not None:
                kwargs["tools"] = list(tools)
            if effective_middleware:
                kwargs["middleware"] = effective_middleware
            if response_format is not None:
                kwargs["response_format"] = _strict_response_format(response_format)

            self._agent = create_deep_agent(**kwargs)
            self._checkpointer = checkpointer
        except BaseException:
            # Construction failed — release the claim and close the session log so
            # the thread_id and file descriptor are not permanently locked.
            if self._file_log_handle is not None:
                self._file_log_handle.close()
                self._file_log_handle = None
            release(thread_id)
            self._claimed = False
            raise

    @property
    def thread_id(self) -> str:
        """The session's deterministic identity."""
        return self._thread_id

    def _config(self, round_tag: str | None = None) -> dict[str, Any]:
        config: dict[str, Any] = {"configurable": {"thread_id": self._thread_id}}
        if round_tag is not None:
            # LangGraph copies string run-config metadata into every checkpoint
            # the run (or an update_state) writes.
            config["metadata"] = {ROUND_TAG_KEY: round_tag}
        return config

    @property
    def progress_marker(self) -> object:
        """Best-effort stable marker for the latest durable thread checkpoint.

        Callers use this as an opaque progress token. Checkpointer APIs and tuple
        internals can vary across LangGraph versions, so checkpoint-specific
        extraction stays inside the DeepAgents session layer and degrades to
        ``None`` when inspection is unavailable.
        """
        if self._checkpointer is None:
            return None
        with suppress(Exception):
            checkpoint_tuple = self._checkpointer.get_tuple(self._config())
            if checkpoint_tuple is None:
                return None
            checkpoint = getattr(checkpoint_tuple, "checkpoint", None) or {}
            metadata = getattr(checkpoint_tuple, "metadata", None) or {}
            checkpoint_id = checkpoint.get("id")
            if checkpoint_id is not None:
                return (checkpoint_id, repr(metadata))
            pending_writes = getattr(checkpoint_tuple, "pending_writes", None)
            parent_config = getattr(checkpoint_tuple, "parent_config", None)
            config = getattr(checkpoint_tuple, "config", None)
            return (
                repr(checkpoint),
                repr(metadata),
                repr(pending_writes),
                repr(parent_config),
                repr(config),
            )
        return None

    @property
    def has_prior_state(self) -> bool:
        """``True`` if the checkpointer has a checkpoint for this thread_id.

        Returns ``False`` when ``durable=False`` or when no checkpoint
        exists (fresh session).  Queries the checkpointer at read time.
        """
        if self._checkpointer is None:
            return False
        checkpoint = self._checkpointer.get_tuple(self._config())
        return checkpoint is not None

    @property
    def latest_round_tag(self) -> str | None:
        """The round tag of the thread's latest checkpoint, or ``None``."""
        if self._checkpointer is None:
            return None
        return round_tag_of(self._checkpointer, self._thread_id)

    def run(self, prompt: str, *, round_tag: str | None = None) -> T | list[AnyMessage]:
        """Send a message to the agent and return the result.

        If the session has prior checkpoint state, the conversation resumes
        automatically. ``round_tag`` tags every checkpoint this run writes
        (``ROUND_TAG_KEY``).

        Returns the parsed ``response_format`` instance when one was
        provided at construction, otherwise the raw message list.
        """
        if self._closed:
            raise RuntimeError(f"Session {self._thread_id!r} is closed")

        config = self._config(round_tag)
        inputs = {"messages": [{"role": "user", "content": prompt}]}
        if deepagents_event_streaming_enabled():
            from harness.deepagents.stream_metrics import invoke_with_metrics

            result = invoke_with_metrics(
                self._agent,
                inputs,
                config,
                thread_id=self._thread_id,
                directory=DEEPAGENTS_EVENTS_DIR,
                inbox_id=self._inbox_id,
            )
        else:
            result = self._agent.invoke(inputs, config=config)

        if self._response_format is not None:
            return result["structured_response"]
        return result.get("messages", [])

    def resume_from_restart(self) -> T | list[AnyMessage]:
        """Resume a checkpointed thread after daemon restart.

        Precondition: the caller invokes this only when ``has_prior_state`` is
        true — a checkpoint exists but the worker was interrupted mid-run.
        Calling without prior state raises ``RuntimeError`` (the precondition is
        enforced, not merely assumed). The prior brief and all partial work
        already live in the checkpoint, so we only repair the tool-call tail and
        nudge the graph forward; we never re-send the brief (that would invite a
        re-implementation on top of the partial edits).

        If the prior checkpoint ends with assistant tool calls that have no
        matching tool messages, inject neutral tool results before nudging the
        graph. This lets structured ``response_format`` runs complete instead of
        failing on a dangling tool-call tail.
        """
        if not self.has_prior_state:
            raise RuntimeError(
                "resume_from_restart() requires prior checkpoint state; "
                "use run() for a fresh thread"
            )
        self._repair_dangling_tool_calls()
        return self.run(
            "The harness daemon restarted. Continue from the prior checkpoint "
            "and return the required structured response."
        )

    def repair_dangling_tool_calls(self, *, round_tag: str | None = None) -> None:
        """Repair a dangling assistant tool-call tail on this thread, if any.

        Called by `retry.run_agent_with_retries` when a worker that expected
        a fresh thread finds prior checkpoint state: if that prior turn crashed
        mid tool-call, the tail must be repaired before the provider will accept
        the brief as a new message. Also commits results of tasks that finished
        but whose checkpoint was lost, so the next run keeps them. No-op on a
        clean tail or fresh thread.

        ``round_tag`` tags the checkpoints the repair writes. A multi-round
        caller passes the tag of the checkpoint being repaired, so a crash
        right after the repair still reads as the same round.
        """
        self._repair_dangling_tool_calls(round_tag)

    def _commit_finished_task_writes(self, config: Any) -> None:
        """Commit writes of tasks that finished but whose checkpoint was lost.

        If the pod dies after a task ran (a tool, or the final model call) but
        before the post-task checkpoint is committed, its result survives only
        as a pending write. ``get_state()`` shows it, but the next ``run()``
        discards unfinished tasks of the prior checkpoint, so the work would be
        re-run or reported as cancelled. ``update_state(None, as_node=END)``
        applies those writes, but it also clears every next task, including
        ones that never ran, so it is gated on real pending writes: a clean
        checkpoint is left untouched. Error and interrupt writes do not count;
        the harness uses no LangGraph interrupts.
        """
        from langgraph._internal._constants import ERROR, INTERRUPT
        from langgraph.graph import END

        saved = self._checkpointer.get_tuple(config)
        if saved is None or not any(
            channel not in (ERROR, INTERRUPT)
            for _task_id, channel, _value in saved.pending_writes or []
        ):
            return
        self._agent.update_state(config, None, as_node=END)

    def _repair_dangling_tool_calls(self, round_tag: str | None = None) -> None:
        """Commit finished-but-uncommitted task writes, then answer lost calls."""
        if self._checkpointer is None:
            return
        config = self._config(round_tag)
        self._commit_finished_task_writes(config)
        # Read through the state API: DeepAgentState keeps messages in a
        # DeltaChannel, so the raw checkpoint's channel_values has no messages.
        messages = self._agent.get_state(config).values.get("messages") or []
        if not messages:
            return
        latest_tool_index: int | None = None
        tool_calls: list[Any] = []
        for i in range(len(messages) - 1, -1, -1):
            calls = getattr(messages[i], "tool_calls", None) or []
            if calls:
                latest_tool_index = i
                tool_calls = calls
                break
        if not tool_calls:
            return
        existing_ids = {
            getattr(m, "tool_call_id", None)
            for m in messages[latest_tool_index + 1 :]
            if getattr(m, "type", None) == "tool"
        }
        calls = [
            (call.get("id"), call.get("name"))
            if isinstance(call, dict)
            else (getattr(call, "id", None), getattr(call, "name", None))
            for call in tool_calls
        ]
        missing = [
            (tool_id, name)
            for tool_id, name in calls
            if tool_id and tool_id not in existing_ids
        ]
        if not missing:
            return
        from langchain_core.messages import ToolMessage

        repairs = [
            ToolMessage(
                content=(
                    "The harness restarted while this tool call was in flight; "
                    "its effect on disk is UNKNOWN. Verify the current state "
                    "before re-issuing it."
                ),
                tool_call_id=tool_id,
                name=name,
            )
            for tool_id, name in missing
        ]
        self._agent.update_state(config, {"messages": repairs})

    def close(self) -> None:
        """Release the thread_id and mark the session as closed.

        Idempotent — safe to call multiple times.
        """
        if self._file_log_handle is not None:
            self._file_log_handle.close()
            self._file_log_handle = None
        if self._claimed:
            release(self._thread_id)
            self._claimed = False
        self._closed = True

    def __enter__(self) -> DeepAgentSession[T]:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: types.TracebackType | None,
    ) -> None:
        self.close()
