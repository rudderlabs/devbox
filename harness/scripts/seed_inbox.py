#!/usr/bin/env python3
"""Local test helper that fabricates harness inbox messages.

The control plane normally delivers work by dropping a JSON message into the
harness inbox directory; the daemon polls that directory and picks it up. This
script writes messages of the exact same shape so you can exercise the daemon
locally WITHOUT a control plane.

It is intentionally stdlib-only and self-contained: it re-implements the inbox
path resolution from `src/harness/paths.py` instead of importing the harness
package, so it runs with plain `python3` and a minimal environment.

Inbox location (matching paths.py):
    WORKSPACE   env var, default /workspace
    DEVBOX_DIR  env var, default ${WORKSPACE}/.harness
    inbox dir = ${DEVBOX_DIR}/inbox

Supported inbox kinds:
    assignment  seed a full task assignment
    comment     seed a follow-up comment round
    review      seed a submitted PR review round
    ci_result   seed a CI-failure round

Usage:
    python3 scripts/seed_inbox.py assignment "Fix the login bug" \
        --description "Steps: ..." --task-key ABC-123

    python3 scripts/seed_inbox.py assignment "Add a flag" \
        --source api --task-key DBX-API-42

    python3 scripts/seed_inbox.py comment "Please tweak the copy." \
        --pr-repo acme/widgets \
        --pr-url https://github.com/acme/widgets/pull/1

    python3 scripts/seed_inbox.py review "LGTM but a few nits" \
        --inline 'src/main.py:12:rename this variable' \
        --inline 'src/util.py:44:unused import' \
        --pr-repo acme/widgets \
        --pr-url https://github.com/acme/widgets/pull/1

    python3 scripts/seed_inbox.py ci_result \
        --run-url https://github.com/acme/widgets/actions/runs/123 \
        --pr-repo acme/widgets \
        --pr-url https://github.com/acme/widgets/pull/1

    # Point at a local (non-/workspace) inbox via WORKSPACE:
    WORKSPACE=/tmp/ws python3 scripts/seed_inbox.py assignment "Try something"

Exit codes:
    0  message written (or, with --dry-run, printed)
"""

from __future__ import annotations

import argparse
import json
import os
import uuid
from pathlib import Path
from typing import Any

SOURCE_CHOICES = ("linear", "github", "api")
# Sources the control plane actually sends per kind. review and ci_result are
# GitHub-driven in production (no agent-session UI, never source='api'); the
# 'linear' default is kept so existing local invocations keep working.
KIND_SOURCES = {
    "assignment": ("linear", "github", "api"),
    "comment": ("linear", "github", "api"),
    "review": ("linear", "github"),
    "ci_result": ("linear", "github"),
}
# Fixed namespace so a task key always maps to the same default task id.
TASK_ID_NAMESPACE = uuid.UUID("6f1c2b0e-7a43-4d5e-9c1a-3b8e5d2f4a10")
LOCAL_TARGET_ID = "local-session"
DEFAULT_TICKET_ID = "TEST-1"


def resolve_inbox_dir() -> Path:
    """Resolve the inbox directory from the environment, mirroring paths.py."""
    workspace = Path(os.environ.get("WORKSPACE", "/workspace"))
    harness_dir = Path(os.environ.get("DEVBOX_DIR", str(workspace / ".harness")))
    return harness_dir / "inbox"


def _default_task_id(task_key: str) -> str:
    """Deterministic task UUID derived from the task key, standing in for CP's
    tasks.id (stable per task, so all rows for one key share it)."""
    return str(uuid.uuid5(TASK_ID_NAMESPACE, task_key))


def _task_identity(args: argparse.Namespace) -> dict[str, str]:
    """task_key and task_id. task_id defaults to a UUID derived from the task
    key unless --task-id is given."""
    key = getattr(args, "task_key", None) or getattr(args, "ticket", DEFAULT_TICKET_ID)
    task_id = getattr(args, "task_id", None) or _default_task_id(key)
    return {"task_key": key, "task_id": task_id}


def _build_pr_metadata(args: argparse.Namespace) -> dict:
    """Return PR metadata, omitting it entirely when neither field was supplied."""
    repo = getattr(args, "pr_repo", None)
    pr_url = getattr(args, "pr_url", None)
    if repo is None and pr_url is None:
        return {}
    return {"pr": {"repo": repo or "", "pr_url": pr_url or ""}}


def build_assignment_payload(args: argparse.Namespace) -> dict[str, Any]:
    """Build a kind='assignment' payload."""
    payload: dict[str, Any] = {
        "title": args.title,
        "target_id": getattr(args, "target", LOCAL_TARGET_ID),
    }
    payload.update(_task_identity(args))
    # Omit description entirely when not provided (do not write an empty string).
    if args.description is not None:
        payload["description"] = args.description
    return payload


def build_comment_payload(args: argparse.Namespace) -> dict[str, Any]:
    """Build a kind='comment' payload."""
    payload: dict[str, Any] = {
        "target_id": getattr(args, "target", LOCAL_TARGET_ID),
        "body": args.body,
    }
    payload.update(_task_identity(args))
    payload.update(_build_pr_metadata(args))
    return payload


def build_review_payload(args: argparse.Namespace) -> dict[str, Any]:
    """Build a kind='review' payload."""
    payload: dict[str, Any] = {
        "review_body": {
            "target_id": f"tgt-rb-{uuid.uuid4().hex[:8]}",
            "body": args.review_body,
        },
        "inline_comments": [],
    }
    payload.update(_task_identity(args))
    for inline in args.inline or []:
        comment: dict[str, Any] = {
            "target_id": f"tgt-il-{uuid.uuid4().hex[:8]}",
            "path": inline["path"],
        }
        if "line" in inline:
            comment["line"] = inline["line"]
        comment["body"] = inline["body"]
        payload["inline_comments"].append(comment)
    payload.update(_build_pr_metadata(args))
    return payload


def build_ci_result_payload(args: argparse.Namespace) -> dict[str, Any]:
    """Build a kind='ci_result' payload."""
    payload: dict[str, Any] = {
        "target_id": getattr(args, "target", LOCAL_TARGET_ID),
        "workflow_name": args.workflow_name,
        "conclusion": args.conclusion,
        "run_url": args.run_url,
        "head_sha": args.head_sha,
        "head_branch": args.head_branch,
    }
    payload.update(_task_identity(args))
    if args.workflow_path is not None:
        payload["workflow_path"] = args.workflow_path
    payload.update(_build_pr_metadata(args))
    return payload


BUILDERS = {
    "assignment": build_assignment_payload,
    "comment": build_comment_payload,
    "review": build_review_payload,
    "ci_result": build_ci_result_payload,
}


def build_entry(
    args: argparse.Namespace,
    inbox_id: str,
    _parser: argparse.ArgumentParser | None = None,
) -> dict[str, Any]:
    """Build the inbox message in the canonical key order."""
    return {
        "id": inbox_id,
        "kind": args.kind,
        "source": getattr(args, "source", "linear"),
        "payload": BUILDERS[args.kind](args),
    }


def parse_inline_comment(value: str) -> dict[str, Any]:
    """Parse an inline review comment encoded as PATH:LINE:BODY."""
    parts = value.split(":", 2)
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("expected PATH:LINE:BODY")

    path, line_raw, body = parts
    if not path:
        raise argparse.ArgumentTypeError("inline comment path must not be empty")

    inline: dict[str, Any] = {"path": path}
    if line_raw:
        try:
            inline["line"] = int(line_raw)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(
                "inline comment line must be an integer when present"
            ) from exc
    inline["body"] = body
    return inline


def add_pr_metadata_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--pr-repo",
        "--repo",
        dest="pr_repo",
        default=None,
        help="GitHub repository slug for PR metadata, e.g. acme/widgets",
    )
    parser.add_argument(
        "--pr-url",
        default=None,
        help="GitHub pull request URL; include with --pr-repo to populate payload.pr",
    )


def build_parser() -> argparse.ArgumentParser:
    envelope = argparse.ArgumentParser(add_help=False)
    envelope.add_argument(
        "--source",
        choices=SOURCE_CHOICES,
        default="linear",
        help="top-level message source; default %(default)r",
    )
    envelope.add_argument(
        "--id",
        default=None,
        help="inbox message id and file basename; auto-generated if omitted",
    )
    envelope.add_argument(
        "--inbox-dir",
        default=None,
        help="explicit inbox directory (overrides WORKSPACE/DEVBOX_DIR derivation)",
    )
    envelope.add_argument(
        "--dry-run",
        action="store_true",
        help="print the target path and JSON instead of writing any file",
    )
    envelope.add_argument(
        "--task-key",
        "--ticket",
        dest="task_key",
        default=DEFAULT_TICKET_ID,
        help=(
            "task key (payload.task_key); "
            "--ticket is the old spelling; default %(default)r"
        ),
    )
    envelope.add_argument(
        "--task-id",
        default=None,
        help=(
            "task UUID (payload.task_id); derived deterministically from the "
            "task key if omitted, so rows for one key share an id"
        ),
    )
    envelope.add_argument(
        "--target",
        default=LOCAL_TARGET_ID,
        help=(
            "primary reply target id (payload.target_id); ignored for review, "
            "where item target ids are generated"
        ),
    )

    parser = argparse.ArgumentParser(
        prog="seed_inbox.py",
        description="Write fake harness inbox messages for local testing.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            '  python3 scripts/seed_inbox.py assignment "Fix the login bug" '
            '--description "Steps: ..." --task-key ABC-123\n'
            '  python3 scripts/seed_inbox.py assignment "Add a flag" '
            "--source api --task-key DBX-API-42\n"
            '  python3 scripts/seed_inbox.py comment "Please tweak the copy." '
            "--pr-repo acme/widgets "
            "--pr-url https://github.com/acme/widgets/pull/1\n"
            '  python3 scripts/seed_inbox.py review "LGTM but a few nits" '
            "--inline 'src/main.py:12:rename this variable' "
            "--inline 'src/util.py:44:unused import' "
            "--pr-repo acme/widgets "
            "--pr-url https://github.com/acme/widgets/pull/1\n"
            "  python3 scripts/seed_inbox.py ci_result "
            "--run-url https://github.com/acme/widgets/actions/runs/123 "
            "--pr-repo acme/widgets "
            "--pr-url https://github.com/acme/widgets/pull/1\n"
            "  WORKSPACE=/tmp/ws python3 scripts/seed_inbox.py assignment "
            '"Try something"\n'
        ),
    )
    subparsers = parser.add_subparsers(dest="kind", required=True)

    assignment = subparsers.add_parser(
        "assignment",
        parents=[envelope],
        help="seed a full task assignment",
    )
    assignment.add_argument("title", help="task title (payload.title)")
    assignment.add_argument(
        "--description",
        default=None,
        help="extended task description; omitted from the payload if not given",
    )
    comment = subparsers.add_parser(
        "comment",
        parents=[envelope],
        help="seed a follow-up comment round",
    )
    comment.add_argument("body", help="comment text (payload.body)")
    add_pr_metadata_arguments(comment)

    review = subparsers.add_parser(
        "review",
        parents=[envelope],
        help="seed a submitted PR review round",
    )
    review.add_argument(
        "review_body",
        help="review summary body (payload.review_body.body)",
    )
    review.add_argument(
        "--inline",
        action="append",
        type=parse_inline_comment,
        default=[],
        metavar="PATH:LINE:BODY",
        help=(
            "inline review comment; repeatable. LINE may be empty to omit it, "
            "and BODY may be empty."
        ),
    )
    add_pr_metadata_arguments(review)

    ci_result = subparsers.add_parser(
        "ci_result",
        parents=[envelope],
        help="seed a CI-failure round",
    )
    ci_result.add_argument(
        "--run-url",
        required=True,
        help="GitHub Actions run URL (required)",
    )
    ci_result.add_argument(
        "--workflow-name",
        "--workflow",
        dest="workflow_name",
        default="CI",
        help="workflow display name (payload.workflow_name); default %(default)r",
    )
    ci_result.add_argument(
        "--workflow-path",
        default=None,
        help="workflow file path; omitted from the payload if not given",
    )
    ci_result.add_argument(
        "--conclusion",
        choices=("failure", "success"),
        default="failure",
        help="workflow conclusion (payload.conclusion); default %(default)r",
    )
    ci_result.add_argument(
        "--head-sha",
        default="",
        help="head commit SHA (payload.head_sha)",
    )
    ci_result.add_argument(
        "--head-branch",
        default="",
        help="head branch name (payload.head_branch)",
    )
    add_pr_metadata_arguments(ci_result)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    allowed = KIND_SOURCES[args.kind]
    if args.source not in allowed:
        parser.error(
            f"--source {args.source} is not valid for kind {args.kind!r}; "
            f"allowed: {', '.join(allowed)}"
        )

    inbox_id = args.id or f"inbox-local-{uuid.uuid4().hex[:8]}"

    if args.inbox_dir is not None:
        inbox_dir = Path(args.inbox_dir)
    else:
        inbox_dir = resolve_inbox_dir()

    entry = build_entry(args, inbox_id, parser)
    text = json.dumps(entry, indent=2, ensure_ascii=False)
    target = inbox_dir / f"{inbox_id}.json"

    if args.dry_run:
        print(f"[dry-run] would write {target}")
        print(text)
        return 0

    inbox_dir.mkdir(parents=True, exist_ok=True)

    # Atomic write: the daemon polls and reads any *.json file, so a partial read
    # would corrupt a message. Write to a dotfile temp in the SAME directory (the
    # daemon ignores dotfiles), then os.replace() it onto the final name.
    tmp = inbox_dir / f".{inbox_id}.json.tmp"
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)

    print(f"wrote {target.resolve()}")
    print(f"inbox id: {inbox_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
