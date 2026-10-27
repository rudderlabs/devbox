"""Always-on inbox event-loop daemon for the harness.

Polls a `.harness/inbox/` directory for task files written by the control
plane and appends typed progress/terminal events to an append-only
`.harness/events.jsonl`. Three inbox kinds are dispatched: `assignment` (the
full 5-stage Setup -> Planning -> Implementation -> Distillation -> Commit
pipeline), `comment` (a single PR-comment reply round), and `review` (a
batched reply to a submitted review's inline + summary comments).

This module holds the daemon machinery — the poll loop, `DaemonState`, the
single-instance flock, inbox-file archiving, and the `process_one_inbox_file`
dispatcher. The per-`kind` handlers live in the `handlers/` package, one file
per inbox row `kind`; `process_assignment` (the `kind='assignment'` handler) is
imported from `handlers.assignment`.

Import direction: `handlers.assignment` imports stage helpers from `harness.py` at
module top, and `daemon` imports `process_assignment` from `handlers.assignment` at
module top. `harness.py` must NOT import `daemon` (or `handlers.*`) at module
top — its `main()` `daemon` arm imports `run_daemon` lazily. `handlers.assignment`
references the `DaemonState` type only under `TYPE_CHECKING`, so no import
cycle forms.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import shutil
import signal
import sys
import time
from pathlib import Path
from typing import Any

from harness.events import (
    RETRYABLE_ASSIGNMENT_ERROR_EVENT_FIELD,
    RoundEvents,
    append_event,
    iter_events,
)
from harness.git import setup_git_signing
from harness.handlers.assignment import process_assignment
from harness.handlers.ci_result import process_ci_result
from harness.handlers.comment import process_comment
from harness.handlers.user_review import process_user_review
from harness.paths import EVENTS_FILE, INBOX_DIR, LOCK_FILE


def _poll_interval_seconds() -> float:
    """Inbox poll cadence, in seconds.

    Override with the HARNESS_POLL_INTERVAL_SECONDS env var. Must parse to a
    positive number; an unset, unparseable, or non-positive value falls back to
    the 1.0s default.
    """
    raw = os.environ.get("HARNESS_POLL_INTERVAL_SECONDS")
    if raw is None:
        return 1.0
    try:
        value = float(raw)
    except ValueError:
        return 1.0
    return value if value > 0 else 1.0


POLL_INTERVAL_SECONDS = _poll_interval_seconds()


def _maybe_init_checkpointer() -> None:
    """Initialize the DeepAgents checkpointer for the default runtime path.

    Failure is loud — init_checkpointer's exception propagates and the daemon
    refuses to start, surfacing a misconfigured DeepAgents setup immediately
    rather than silently degrading. The checkpointer import remains lazy so the
    deepagents/langchain stack is pulled in only during daemon startup.
    """
    from harness.deepagents.checkpointer import init_checkpointer
    from harness.paths import CHECKPOINTS_DB as checkpoints_db

    init_checkpointer(checkpoints_db)


def _maybe_configure_deepagents_logging() -> None:
    """Configure Python logging for the DeepAgents runtime path.

    The rest of the harness logs via print(); the DeepAgents LoggingMiddleware
    instead emits INFO records on the `deepagents.middleware.logging` logger.
    Without a configured handler Python's default last-resort handler drops
    everything below WARNING, so those INFO records are silenced. Install a
    basicConfig at INFO and quiet the noisy httpx logger.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-5s %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)


class DaemonState:
    """Inbox-round state: event-log paths + the append-write delegate.

    `events.jsonl` has two writers (the daemon and the short-lived
    `harness memory` CLI), so `seq` is derived from the file tail under
    `events.lock` by the shared writer in `events.py`. DaemonState just holds
    the paths and delegates.
    """

    def __init__(
        self,
        *,
        events_file: Path,
        events_lock: Path,
        processed_dir: Path,
        error_dir: Path,
    ) -> None:
        self.events_file = events_file
        # events.lock — a SEPARATE lock from inbox.lock. inbox.lock is the
        # daemon's lifetime single-instance guard; events.lock is grabbed
        # briefly, blocking, per append, shared with the `harness memory` CLI.
        self.events_lock = events_lock
        # A cleanly-processed inbox file is archived to processed_dir; a file
        # that errored (malformed/unreadable, an exception during dispatch, or
        # an unsupported kind) goes to error_dir — so an operator can triage
        # failures separately. Both are passed in by run_daemon.
        self.processed_dir = processed_dir
        self.error_dir = error_dir

    def append_event(self, payload: dict[str, Any]) -> None:
        # Delegates to the shared flock-guarded writer (events.py): seq is
        # derived from the file tail under events.lock, monotonic across the
        # daemon and the `harness memory` CLI without a shared counter.
        append_event(self.events_file, self.events_lock, payload)

    def round_events(self, inbox_id: str, target_id: str) -> RoundEvents:
        """The events client for one round and its target, on this daemon's log."""
        return RoundEvents(
            events_file=self.events_file,
            events_lock=self.events_lock,
            inbox_id=inbox_id,
            target_id=target_id,
        )

    def has_event_for(self, *, inbox_id: str, type_: str) -> bool:
        # Defensive check used to avoid duplicate completion events when the
        # daemon restarts mid-round. Linear scan; cheap for typical log sizes.
        return self._scan_events(inbox_id=inbox_id, type_=type_)

    def opened_repo_names(self, *, inbox_id: str) -> set[str]:
        # Repos with a pr_opened event for this inbox_id — used on restart to
        # avoid re-emitting pr_opened for a PR a prior attempt already recorded.
        return {
            e["repo"]
            for e in iter_events(self.events_file)
            if e.get("type") == "pr_opened"
            and e.get("inbox_id") == inbox_id
            and isinstance(e.get("repo"), str)
        }

    def action_bodies(self, *, inbox_id: str) -> set[str]:
        # agent_action bodies already emitted for this inbox_id — used on restart
        # to avoid re-posting a stage announcement (Reviewing/Distilling/...) the
        # user already saw. Body-keyed, not type-keyed: every announcement is an
        # agent_action, so a coarse type check would suppress later distinct ones.
        return {
            e["body"]
            for e in iter_events(self.events_file)
            if e.get("type") == "agent_action"
            and e.get("inbox_id") == inbox_id
            and isinstance(e.get("body"), str)
        }

    def _scan_events(self, *, inbox_id: str, type_: str | None) -> bool:
        # Linear scan of the event log for a row matching inbox_id (and type_,
        # if given). type_=None matches any event for the inbox_id.
        return any(
            e.get("inbox_id") == inbox_id and (type_ is None or e.get("type") == type_)
            for e in iter_events(self.events_file)
        )


def acquire_flock(lock_file: Path) -> int | None:
    """Single-instance guard. Returns the held fd, or None on contention.

    The fd is intentionally leaked for the daemon's lifetime — closing it
    would release the lock.
    """
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    # 0o600 — owner-only. The lock file is a single-process runtime guard;
    # no other user needs to read or write it.
    fd = os.open(str(lock_file), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def install_signal_traps() -> None:
    """Install the SIGTERM handler.

    The daemon runs as PID 1, and Linux ignores a signal sent to PID 1 that
    has no handler, so without this a pod shutdown (kubectl delete, idle
    reaper) would wait out the K8s SIGKILL grace period.
    """
    signal.signal(signal.SIGTERM, _on_sigterm)


def _on_sigterm(_signum: int, _frame: Any) -> None:
    # Exit cleanly. The daemon emits NO event here: the pod is dying, and CP's
    # sandbox-liveness reaper already handles a dead sandbox; a terminal event
    # written as the pod dies would only be read on a later recreate (stale,
    # consumed by nothing).
    sys.exit(0)


def _archive_inbox_file(file: Path, dest_dir: Path) -> None:
    """Move a finished inbox file to dest_dir (`.processed/` or `.error/`).

    Best-effort: an FS error here must NOT escape into run_daemon's poll loop —
    that would crash the pod into CrashLoopBackOff and re-read this same file
    forever. Creates dest_dir if missing so a direct caller (tests) need not
    pre-create it.
    """
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(file), str(dest_dir / file.name))
    except OSError as exc:
        print(
            f"daemon: could not archive {file.name} to {dest_dir.name}/: {exc}",
            file=sys.stderr,
        )


def _emit_assignment_failure_error(
    state: DaemonState, entry: dict[str, Any], exc: BaseException
) -> None:
    """Emit the user-visible assignment error before crashing for CP retry.

    Assignment handler failures are fatal to the daemon: emitting a terminal
    completed marker would make the control plane mark the inbox row responded
    and abandon the preserved checkpoint. Keep the inbox file in place and let
    process exit restart recovery re-read it.
    """
    payload = entry.get("payload") or {}
    target_id = payload.get("target_id")
    if target_id:
        state.append_event({
            "type": "agent_error",
            "inbox_id": entry["id"],
            "target_id": target_id,
            "body": f"{type(exc).__name__}: {exc}",
            RETRYABLE_ASSIGNMENT_ERROR_EVENT_FIELD: True,
        })


def _emit_round_failure(
    state: DaemonState, entry: dict[str, Any], exc: BaseException
) -> None:
    """Turn a non-assignment handler exception into a terminal round failure.

    comment / review / ci_result → ONE coarse agent_error to the primary reply
    target, then the bare completed marker (no status) so the inbox row
    unsticks. Assignment failures use _emit_assignment_failure_error and then
    exit non-zero so the control plane can restart from the preserved inbox.
    """
    inbox_id = entry["id"]
    err = f"{type(exc).__name__}: {exc}"
    payload = entry.get("payload") or {}

    # comment / review — the round died before (or part-way through) the agent
    # posting its replies. Derive the primary target_id from `payload` (the
    # daemon's inbox file carries no reply_targets — that is a CP-only column).
    # Failures ride on agent_error (not agent_response): CP routes them to the
    # Linear session via emitError, the same lane the assignment-stage terminal
    # failure uses — keeps "this round broke" as a structured error block
    # rather than masquerading as a normal reply.
    if entry["kind"] == "review":
        primary_target_id = (payload.get("review_body") or {}).get("target_id")
    else:  # comment / ci_result
        primary_target_id = payload.get("target_id")
    if primary_target_id:
        state.append_event({
            "type": "agent_error",
            "inbox_id": inbox_id,
            "target_id": primary_target_id,
            "body": f"⚠ Something went wrong — {err}",
        })
    state.append_event({"type": "completed", "inbox_id": inbox_id})


def process_one_inbox_file(file: Path, state: DaemonState) -> None:
    """Read one inbox file, dispatch on kind, capture errors, then archive.

    A cleanly-processed file (ran to a normal terminal event) is moved to
    `.processed/`; a file that errored — malformed/unreadable, or an exception
    during dispatch — is moved to `.error/`. An unsupported kind is
    unrecoverable: the daemon logs and exits (the file is left in place).
    """
    # Parse defensively: a malformed / unreadable inbox file must NOT crash the
    # poll loop. Crashing here would propagate out of run_daemon, the pod would
    # restart, re-read the same bad file (never archived — the move below lives
    # in a `finally` that wouldn't run), and CrashLoopBackOff forever.
    try:
        entry = json.loads(file.read_text(encoding="utf-8"))
        inbox_id = entry["id"]
        kind = entry["kind"]
        if not isinstance(inbox_id, str) or not isinstance(kind, str):
            raise TypeError("inbox file 'id' and 'kind' must be strings")
    except (OSError, json.JSONDecodeError, KeyError, TypeError, AttributeError) as exc:
        # No usable inbox_id → can't emit an event. Archive + log so the loop
        # moves on instead of spinning on the bad file.
        print(
            f"daemon: skipping unreadable inbox file {file.name}: "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        # Malformed/unreadable → an error: route to .error/, not .processed/.
        _archive_inbox_file(file, state.error_dir)
        return

    if kind not in ("assignment", "comment", "review", "ci_result"):
        # An unexpected kind means a daemon image version-skewed behind CP —
        # unrecoverable for this sandbox. Log and exit so the pod terminates;
        # CP's sandbox-liveness reaper then fails the task. Exit BEFORE the try
        # below — `except Exception` would not catch the SystemExit, but the
        # check is clearer here.
        print(
            f"daemon: unsupported inbox kind {kind!r} (inbox {inbox_id}); exiting",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        if kind == "assignment":
            process_assignment(entry, state)

        elif kind == "comment":
            process_comment(entry, state)

        elif kind == "ci_result":
            process_ci_result(entry, state)

        else:
            process_user_review(entry, state)
        # Cleanly-processed files archive only after dispatch returns normally.
        # BaseException interruptions (SystemExit, KeyboardInterrupt) must
        # unwind without moving the inbox file so daemon restart can resume it.
        _archive_inbox_file(file, state.processed_dir)
    except Exception as exc:
        # `except Exception` (not BaseException) is deliberate: the SIGTERM
        # handler raises SystemExit for a clean shutdown — that must propagate
        # uncaught, not be swallowed into a spurious terminal event.
        if kind == "assignment":
            # Assignment handler failure breaks the daemon's purpose. Emit only
            # the user-visible error, leave the inbox file in place, and exit
            # non-zero so CP restarts the sandbox from the preserved PVC and
            # checkpoint. A completed marker here would make CP give up.
            _emit_assignment_failure_error(state, entry, exc)
            print(
                f"daemon: assignment {inbox_id} failed; exiting for retry: {exc}",
                file=sys.stderr,
            )
            sys.exit(1)

        # Non-assignment handler exception → a user-visible failure + terminal
        # marker so the reply-target inbox row never stays stuck pre-terminal.
        _emit_round_failure(state, entry, exc)
        print(f"daemon: process {inbox_id} ({kind}) failed: {exc}", file=sys.stderr)
        # Handler failures are terminal for this inbox row after emitting the
        # failure/completed events, so route the file to .error/.
        _archive_inbox_file(file, state.error_dir)


def run_daemon(
    *,
    inbox_dir: Path = INBOX_DIR,
    events_file: Path = EVENTS_FILE,
    lock_file: Path = LOCK_FILE,
) -> int:
    """Poll the inbox directory and process task files one at a time."""
    # events.lock lives alongside events.jsonl — both are on the PVC, both
    # accessed by the daemon + the `harness memory` CLI. Deriving it here drops
    # the redundant CLI/entrypoint plumbing.
    events_lock = events_file.with_name("events.lock")
    inbox_dir.mkdir(parents=True, exist_ok=True)
    # Two archive dirs, created here and passed explicitly to DaemonState:
    # cleanly-processed files → processed_dir, errored files → error_dir.
    processed_dir = inbox_dir / ".processed"
    processed_dir.mkdir(parents=True, exist_ok=True)
    error_dir = inbox_dir / ".error"
    error_dir.mkdir(parents=True, exist_ok=True)
    events_file.parent.mkdir(parents=True, exist_ok=True)

    # Single-instance guard. Defensive — entrypoint single-mode shouldn't
    # double-launch, but a remount could land us here twice.
    lock_fd = acquire_flock(lock_file)
    if lock_fd is None:
        print(
            f"daemon already running (lock {lock_file} held); exiting 0",
            file=sys.stderr,
        )
        return 0

    state = DaemonState(
        events_file=events_file,
        events_lock=events_lock,
        processed_dir=processed_dir,
        error_dir=error_dir,
    )

    # DEVBOX_EVENTS_FILE / DEVBOX_EVENTS_LOCK are constant for the daemon's
    # lifetime — set once here so the `harness memory` CLI, run from an
    # agent's shell, can find the log.
    os.environ["DEVBOX_EVENTS_FILE"] = str(events_file)
    os.environ["DEVBOX_EVENTS_LOCK"] = str(events_lock)

    # Exit on SIGTERM at pod shutdown — the daemon is PID 1.
    install_signal_traps()

    # Git signing is global config — set it up ONCE at daemon startup, not per
    # round. setup_workspace (called only by process_assignment) also calls it,
    # but a comment/review round on a recreated-from-PVC sandbox never runs
    # process_assignment — without this line its update_existing_branch commit
    # would be unsigned or fail. setup_git_signing is idempotent.
    #
    # Best-effort here: setup_git_signing can raise even with required=False —
    # partial signing env vars (RuntimeError), a missing/empty key file
    # (FileNotFoundError/RuntimeError), or a failing gpg/git subprocess
    # (CalledProcessError). An unguarded raise escapes run_daemon, exits the
    # process into CrashLoopBackOff, and emits no task_failed event so CP never
    # learns why. Swallow + log instead: setup_workspace re-invokes
    # setup_git_signing per process_assignment round (so a transient startup
    # failure self-heals on the first task), and a comment/review round that
    # genuinely needs signing still surfaces its own failure.
    try:
        setup_git_signing(required=False)
    except Exception as exc:
        print(
            f"daemon: startup setup_git_signing failed (ignored): "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )

    # DeepAgents checkpointer — initialized once at startup for the default
    # implementation/distillation path. Fail-loud so a misconfigured setup stops
    # the daemon rather than limping.
    _maybe_init_checkpointer()

    # DeepAgents logging — configures Python logging at INFO so the
    # LoggingMiddleware's inner-loop records aren't dropped by the default
    # WARNING last-resort handler.
    _maybe_configure_deepagents_logging()

    while True:
        files = sorted(
            p
            for p in inbox_dir.iterdir()
            if p.is_file() and p.suffix == ".json" and not p.name.startswith(".")
        )
        if not files:
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        for file in files:
            # Belt-and-suspenders: process_one_inbox_file already guards its
            # own error paths, but wrap the call too so no single file can ever
            # kill the poll loop. A persistently-failing file then degrades to
            # a slow poll rather than a busy-loop or a pod crash.
            try:
                process_one_inbox_file(file, state)
            except Exception as exc:
                print(
                    f"daemon: unexpected error processing {file.name}: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                time.sleep(POLL_INTERVAL_SECONDS)
