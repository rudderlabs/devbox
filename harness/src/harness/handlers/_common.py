"""Shared helpers for comment/review handlers and assignment commit publish.

`fill_missed_replies_and_complete_round` is the common completion path for
kind='comment' and kind='review': it backfills missing replies and emits a
`completed` marker.

`_commit_and_open_pr` is the per-repo branch-create + commit + push + create-PR
helper used by `handlers.assignment.run_commit_stage`.

The seeded-context block the follow-up rounds send once per thread is
assembled here (`seeded_context_block`); the per-round briefs live in
`followup.py`.

Import direction: pulls git helpers from `git`; `DaemonState` is referenced only
under TYPE_CHECKING. `handlers.assignment` imports *from* this module, not the
other way around.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from harness.env_flags import bool_env
from harness.events import iter_events
from harness.git import (
    GitHubClient,
    commit_one_repo,
    parse_owner_repo_from_git_remote,
)
from harness.paths import (
    ARTIFACTS_DIR,
    IMPLEMENTATION_JSON,
    PLAN_JSON,
    SESSION_JSON,
    WORKSPACE,
)
from harness.plan_utils import repo_checkout_path
from harness.util import load_json_file


def _dry_run_publish() -> bool:
    """True when HARNESS_DRY_RUN_PUBLISH is set.

    Runs the full local publish flow (branch, commit, S3 upload, PR-body
    assembly) but skips the two network writes — `git push` and the GitHub PR
    create/update — so the whole pipeline can be exercised in-sandbox without
    pushing a branch or opening a PR.
    """
    return bool_env("HARNESS_DRY_RUN_PUBLISH")


if TYPE_CHECKING:
    from harness.daemon import DaemonState


# ──── Round env injection ────


def set_round_env(inbox_id: str, target_ids: list[str]) -> None:
    """Set the per-round runtime-only DEVBOX_* env that round-event appends read.

    The daemon is single-threaded and processes inbox files strictly
    sequentially, so mutating os.environ per round is safe — no two rounds
    overlap. Agent-spawned children inherit them.
    """
    os.environ["DEVBOX_INBOX_ID"] = inbox_id
    os.environ["DEVBOX_TARGET_IDS"] = ",".join(target_ids)


# ──── Seeded context ────


def _read_json_or_none(path: Path) -> Any | None:
    try:
        return load_json_file(path)
    except (OSError, json.JSONDecodeError):
        return None


def seeded_context_block() -> str:
    """One-time seed for a follow-up or CI thread: the original task plus the
    plan and implementation summaries.

    Read defensively — any artifact that is missing (a thread may predate the
    assignment pipeline) is simply omitted. Sent only on the thread's first
    round; later rounds continue the thread and rely on this context already
    being present.
    """
    lines = ["<seeded_context>"]
    session = _read_json_or_none(SESSION_JSON)
    task = session.get("task") if isinstance(session, dict) else None
    if task:
        lines.append(f"<task>{task}</task>")
    plan = _read_json_or_none(PLAN_JSON)
    if plan is not None:
        lines += ["", "### Canonical plan.json", _json_block(plan)]
    impl = _read_json_or_none(IMPLEMENTATION_JSON)
    if impl is not None:
        lines += [
            "",
            "### Implementation summary (implementation.json)",
            _json_block(impl),
        ]
    lines.append("</seeded_context>")
    return "\n".join(lines)


def _json_block(data: Any) -> str:
    return "```json\n" + json.dumps(data, indent=2) + "\n```"


# ──── Validators / publish helpers ────


def _require_str(d: Mapping[str, Any], key: str, where: str) -> str:
    if key not in d:
        raise ValueError(f"{where}: missing key {key!r}")
    v = d[key]
    if not isinstance(v, str):
        raise TypeError(f"{where}: {key!r} must be string")
    return v


def require_task_key(payload: Mapping[str, Any], where: str) -> str:
    """The task's human key (`ABC-123`, `DBX-API-42`), from `task_key`."""
    return _require_str(payload, "task_key", where)


# Sources whose user watches the task live: Linear's agent session, and the
# API/CLI event log. GitHub has no live surface; only the reply is shown.
LIVE_CHANNEL_SOURCES: tuple[str, ...] = ("linear", "api")


def is_live_channel(source: str) -> bool:
    return source in LIVE_CHANNEL_SOURCES


def slugify_pr_title(pr_title: str, inbox_id: str, max_len: int = 40) -> str:
    # Deterministic per assignment: the suffix is derived from inbox_id (stable
    # across pod restarts, unique per assignment) so a re-attempt computes the
    # SAME branch and reconciliation can reuse the existing branch/PR.
    suffix = hashlib.sha256(inbox_id.encode("utf-8")).hexdigest()[:8]

    lower = pr_title.lower()
    parts = re.findall(r"[a-z0-9]+", lower)
    slug = "-".join(parts) if parts else "change"

    # Reserve space for "-" separator + 8-char suffix
    body_max = max_len - 9
    if len(slug) > body_max:
        slug = slug[:body_max].rstrip("-")

    return (slug + "-" + suffix) if slug else suffix


def _commit_and_open_pr(
    entry: Mapping[str, Any],
    task_key: str,
    inbox_id: str,
    client: GitHubClient,
) -> dict[str, Any]:
    """Branch-create + commit + push + create PR for one implementation.json
    repo entry — the per-repo happy-path body of run_commit_stage.

    Re-checks the required string fields via `_require_str`, derives the
    `devbox/<ticket>-<slug>` branch from `pr_title`, threads `base` (computed
    by commit_one_repo) into create_pr. Returns {name, pr_url, branch,
    commit_sha}. Raises CommitPublishError on git failure; a create_pr error
    propagates unchanged. Shared with the comment-round finalize path so a
    comment that touches a no-PR repo opens its PR exactly like the assignment flow.

    The branch name is deterministic (keyed on inbox_id) and any already-open
    PR for that head is reused, so a pod restart that re-runs this function
    does not open a duplicate PR.
    """
    name = _require_str(entry, "name", "repo")
    pr_title = _require_str(entry, "pr_title", f"repo {name}")
    commit_message = _require_str(entry, "commit_message", f"repo {name}")
    pr_body = _require_str(entry, "pr_body", f"repo {name}")
    _require_str(entry, "path", f"repo {name}")  # legacy schema compatibility only
    repo_path = repo_checkout_path(name, workspace=WORKSPACE)

    slug = slugify_pr_title(pr_title, inbox_id)
    branch = f"devbox/{task_key}-{slug}"

    if not repo_path.is_dir():
        raise FileNotFoundError(f"Repository path not found: {repo_path}")

    owner, repo_name = parse_owner_repo_from_git_remote(repo_path)
    publish = commit_one_repo(
        repo_path,
        client=client,
        branch_name=branch,
        commit_message=commit_message,
    )
    # Dry-run publish: exercise the full local flow (commit, PR-body assembly)
    # but skip the GitHub create/update network write. The assembled
    # body is written under .harness/artifacts/ for inspection. The git push is
    # skipped separately in commit_one_repo (same env flag).
    if _dry_run_publish():
        out = ARTIFACTS_DIR / f"dry-run-pr-body-{repo_name}.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(pr_body, encoding="utf-8")
        print(f"DRY-RUN: skipping PR create/update; assembled body -> {out}")
        return {
            "name": name,
            "pr_url": None,
            "branch": publish["branch"],
            "commit_sha": publish["commit_sha"],
        }

    # Reuse a PR a prior attempt already opened for this head before creating one.
    url = client.find_open_pr_by_head(owner, repo_name, publish["branch"])
    if not url:
        url = client.create_pr(
            owner,
            repo_name,
            title=pr_title,
            body=pr_body,
            head=publish["branch"],
            base=publish["base"],
            draft=True,
        )
    return {
        "name": name,
        "pr_url": url,
        "branch": publish["branch"],
        "commit_sha": publish["commit_sha"],
    }


# ──── Finalize ────


def _covered_target_ids(events_file: Path, inbox_id: str) -> set[str]:
    """target_ids that already have a user-facing emit for this inbox row.

    Both `agent_response` and `agent_error` count as "covered" — they both
    reach the user. If only `agent_response` were counted, a target that was
    already covered by an agent_error would still trigger the backfill loop's
    "did not post a reply" agent_response, producing contradictory messages.
    """
    return {
        e["target_id"]
        for e in iter_events(events_file)
        if e.get("type") in ("agent_response", "agent_error")
        and e.get("inbox_id") == inbox_id
        and e.get("target_id")
    }


def fill_missed_replies_and_complete_round(
    state: DaemonState,
    inbox_id: str,
    *,
    ordered_target_ids: list[str],
    optional_target_ids: set[str] | None = None,
) -> None:
    """Shared completion path for kind='comment' and kind='review'.

    Publish actions are handled inside the agent flow for comment/review.
    This helper only backfills an agent_response for any target the agent left
    silent and emits the bare completed terminal marker.

    `optional_target_ids` are skipped by the backfill loop — e.g. a review's
    `review_body` target is included in ordered_target_ids (so the agent CAN reply
    on it) but reviewing the summary thread is optional, so a missing reply
    there should NOT trigger the "didn't post a reply" backfill.
    """
    optional = optional_target_ids or set()

    # Backfill any item the agent never replied to, so no thread is left silent.
    # Optional targets (e.g. a review's summary thread) are skipped — silence
    # on those is intentional, not a missing-reply we need to cover for.
    covered = _covered_target_ids(state.events_file, inbox_id)
    for tid in ordered_target_ids:
        if tid in optional or tid in covered:
            continue
        state.append_event({
            "type": "agent_response",
            "inbox_id": inbox_id,
            "target_id": tid,
            "body": "⚠ I finished here but didn't post a reply on this item.",
        })

    state.append_event({"type": "completed", "inbox_id": inbox_id})
