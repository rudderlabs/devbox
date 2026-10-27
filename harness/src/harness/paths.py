"""Module-level path constants for the harness.

All paths derived from WORKSPACE are evaluated at import time so that tests
can control them by setting the WORKSPACE environment variable before
importing this module (or reloading it).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Defaults match production sandbox layout; override for local tests.
WORKSPACE = Path(os.environ.get("WORKSPACE", "/workspace"))
PACKAGE_DIR = Path(__file__).resolve().parent
PROMPTS_DIR = Path(os.environ.get("DEVBOX_PROMPTS_DIR", str(PACKAGE_DIR / "prompts")))
SCRIPTS_DIR = Path(os.environ.get("DEVBOX_SCRIPTS_DIR", str(PACKAGE_DIR / "scripts")))
HARNESS_DIR = Path(os.environ.get("DEVBOX_DIR", str(WORKSPACE / ".harness")))
SHARED_SKILLS_DIR = Path(
    os.environ.get(
        "DEVBOX_SHARED_SKILLS_DIR", str(WORKSPACE / "shared-skills" / "skills")
    )
)
# Pod-local ephemeral scratch — NOT on the PVC. Wiped on container restart and pod
# recreation, so a file here reliably means "a process from THIS pod instance".
# Overridable so tests don't touch real /tmp.
RUNTIME_DIR = Path(os.environ.get("DEVBOX_RUNTIME_DIR", "/tmp"))
# Inbox event loop paths — all derived from HARNESS_DIR ($DEVBOX_DIR, else
# $WORKSPACE/.harness). Single source of truth; the daemon and the harness CLI
# read these directly instead of taking CLI args.
INBOX_DIR = HARNESS_DIR / "inbox"
EVENTS_FILE = HARNESS_DIR / "events.jsonl"
LOCK_FILE = HARNESS_DIR / "inbox.lock"
MEMORY_DIR = HARNESS_DIR / "memory"
# Where the harness writes its dry-run artifacts.
ARTIFACTS_DIR = HARNESS_DIR / "artifacts"

PLAN_JSON = HARNESS_DIR / "plan.json"
PLAN_MD = HARNESS_DIR / "plan.md"
# Write-only debug artifact: the adversarial plan-review verdict. Nothing in
# harness reads it back; it exists so review findings survive the run.
PLAN_REVIEW_JSON = HARNESS_DIR / "plan-review.json"
IMPLEMENTATION_JSON = HARNESS_DIR / "implementation.json"
DISTILLATION_JSON = HARNESS_DIR / "distillation.json"
REVIEW_JSON = HARNESS_DIR / "review.json"
# Review-loop checkpoint: the cross-iteration state the loop holds in memory
# (declined findings, settled repos, the pre-dispatch tree baseline, dispatch
# set and landed agent outputs of an in-flight review or fix pass), written
# at every iteration boundary so a restart resumes the loop there instead of
# re-running from iteration 1. Removed once review.json is written (see
# self_review._run_review_iterations); resume rules in
# self_review._load_review_resume.
REVIEW_STATE_JSON = HARNESS_DIR / "review-state.json"
DISCUSSION_CONTEXT_JSON = HARNESS_DIR / "discussion-context.json"
# Cached trusted-org member ids (numeric, immutable) used to filter which PR
# comment authors may reach the agent prompt. Mirrors the control-plane trigger
# gate so injected discussion history cannot smuggle untrusted instructions.
TRUSTED_MEMBERS_JSON = HARNESS_DIR / "trusted-members.json"
SESSION_JSON = HARNESS_DIR / "session.json"
# DeepAgents SQLite checkpoint DB — owned by the daemon, lives on the PVC.
CHECKPOINTS_DB = HARNESS_DIR / "checkpoints.db"
# Per-session DeepAgents middleware logs — owned by the daemon, lives on the PVC.
DEEPAGENTS_LOGS_DIR = HARNESS_DIR / "deepagents-logs"
# Opt-in event-streaming evaluation captures, one JSONL file per invocation.
DEEPAGENTS_EVENTS_DIR = HARNESS_DIR / "deepagents-events"


# Reviewer scratch space for throwaway repro scripts — outside every repo tree
# so the review exec lane can never dirty a repository's `git status`.
# Rooted in RUNTIME_DIR (pod-local, ephemeral), NOT under .harness: agents are
# handed this path as their sanctioned write location, so its parent chain
# must never contain harness control state (checkpoints.db, trusted-members,
# plan/implementation artifacts).
REVIEW_SCRATCH_DIR = RUNTIME_DIR / "harness-review-scratch"


def script_cmd(name: str) -> str:
    """Exact command the agent runs for a fixed script under SCRIPTS_DIR.

    Prefixes the daemon's own interpreter: in the sandbox, bare ``python3`` is
    the system interpreter and cannot import ``harness`` (no venv on PATH).
    """
    return f"{sys.executable} {SCRIPTS_DIR / name}"


def review_iter_path(n: int) -> Path:
    return HARNESS_DIR / f"review-iter-{n}.json"


def review_fix_iter_path(n: int) -> Path:
    return HARNESS_DIR / f"review-fix-iter-{n}.json"
