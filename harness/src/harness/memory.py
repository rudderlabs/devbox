"""Memory CLI surface for the harness."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from harness.paths import MEMORY_DIR, SESSION_JSON
from harness.util import iso_now

MEMORY_ENTRY_TYPES = {
    "note",
    "decision",
    "feedback",
    "question",
    "mistake",
    "pattern",
    "concern",
}

EMOJI_BY_MEMORY_ENTRY_TYPE = {
    "note": "📝",
    "decision": "🧭",
    "feedback": "🧑",
    "question": "❓",
    "mistake": "⚠️",
    "pattern": "🧩",
    "concern": "🚩",
}


def _sanitize_stage_slug(stage: str) -> str:
    value = stage.strip().lower()
    if not value:
        raise ValueError("--stage cannot be empty")
    if any(token in value for token in ("/", "\\", "..")):
        raise ValueError("--stage must not contain path separators")
    if any(ord(ch) < 32 for ch in value):
        raise ValueError("--stage must not contain non-printable characters")
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"[^a-z0-9._-]", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    if not value:
        raise ValueError("--stage must contain at least one filename-safe character")
    return value


def _sanitize_repo_name(repo: str) -> str:
    value = repo.strip()
    if not value:
        raise ValueError("--repo cannot be empty")
    if any(token in value for token in ("/", "\\", "..")):
        raise ValueError("--repo must be a repo directory name without separators")
    if any(ord(ch) < 32 for ch in value):
        raise ValueError("--repo must not contain non-printable characters")
    return value


def _sanitize_memory_text(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    clean = "\n".join(line.rstrip() for line in lines).strip()
    if not clean:
        raise ValueError("text input cannot be empty")
    return clean


def _read_task_key_from_session() -> str | None:
    if not SESSION_JSON.is_file():
        return None
    try:
        data = json.loads(SESSION_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    ticket = data.get("task_key")
    return ticket if isinstance(ticket, str) and ticket.strip() else None


def normalize_component_subpath(component: str) -> str | None:
    """Normalize a repo-relative component subpath, or return None if unsafe.

    Returns the normalized POSIX subpath (e.g. ``services/api``), or ``None``
    when the value is empty, contains a backslash or control character, is
    absolute, traverses outside the repo (``..``), or resolves to the repo
    root. This is the single source of truth for component-path validation;
    callers that need a hard failure should wrap it (see
    ``_sanitize_component_subpath``).
    """
    value = component.strip()
    if not value or "\\" in value:
        return None
    if any(ord(ch) < 32 for ch in value):
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or any(part == ".." for part in path.parts):
        return None
    normalized = str(path)
    if normalized in ("", "."):
        return None
    return normalized


def _sanitize_component_subpath(component: str) -> Path:
    normalized = normalize_component_subpath(component)
    if normalized is None:
        raise ValueError(
            "component must be a repo-relative POSIX subpath within the repo"
        )
    return Path(normalized)


def _memory_file_path(repo: str, stage: str, component: str | None = None) -> Path:
    repo_memory_dir = (MEMORY_DIR / repo).resolve()
    if component is None:
        return repo_memory_dir / f"{stage}.md"

    component_path = _sanitize_component_subpath(component)
    component_dir = (repo_memory_dir / component_path).resolve()
    try:
        component_dir.relative_to(repo_memory_dir)
    except ValueError as exc:
        raise ValueError(
            "component must stay within the repo memory directory"
        ) from exc
    return component_dir / f"{stage}.md"


def _memory_header(repo: str, stage: str) -> str:
    lines = [
        f"# Memory — {repo} · {stage}",
        "",
    ]
    task_key = _read_task_key_from_session()
    if task_key:
        lines.append(f"**Task key:** {task_key}")
    lines += [
        f"**Created:** {iso_now()}",
        "",
        "> Append-only. Each entry must be self-contained — the distillation",
        "> subagent does NOT read source code to expand context. Be explicit.",
        "",
        "---",
        "",
    ]
    return "\n".join(lines)


def memory_heartbeat_body(
    *,
    entry_type: str,
    stage: str,
    repo: str,
    text: str,
    context: str | None,
    component: str | None,
) -> str:
    tags = [f"`{stage}`", f"`{repo}`"]
    if component is not None:
        tags.append(f"`{component}`")

    emoji = EMOJI_BY_MEMORY_ENTRY_TYPE.get(entry_type, "🧠")
    lines = [f"{emoji} **{entry_type}** {' '.join(tags)}", "", text]
    if entry_type in ("decision", "feedback") and context:
        lines += ["", f"**Why:** {context}"]
    return "\n".join(lines)


def append_memory_entry(
    *,
    entry_type: str,
    stage: str,
    repo: str,
    text: str,
    context: str | None,
    component: str | None = None,
) -> Path:
    if entry_type not in MEMORY_ENTRY_TYPES:
        raise ValueError(
            f"--add must be one of: {', '.join(sorted(MEMORY_ENTRY_TYPES))}"
        )
    if context and entry_type not in {"decision", "feedback"}:
        raise ValueError("--context is only valid when --add is decision or feedback")

    clean_stage = _sanitize_stage_slug(stage)
    clean_repo = _sanitize_repo_name(repo)
    clean_text = _sanitize_memory_text(text)
    clean_context = None
    if context:
        clean_context = _sanitize_memory_text(context)

    output_path = _memory_file_path(clean_repo, clean_stage, component)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    entry_lines = [
        f"### {entry_type}  [{datetime.now(UTC).strftime('%H:%M:%S')}]",
        "",
        clean_text,
    ]
    if clean_context:
        entry_lines += [
            "",
            f"**Why:** {clean_context}",
        ]
    entry_lines += [
        "",
        "---",
        "",
    ]
    payload = "\n".join(entry_lines)

    file_exists = output_path.exists()
    with os.fdopen(
        os.open(output_path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600),
        "a",
        encoding="utf-8",
    ) as handle:
        if not file_exists or output_path.stat().st_size == 0:
            handle.write(_memory_header(clean_repo, clean_stage))
        handle.write(payload)

    return output_path


def _memory_main_impl(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Append a harness memory entry",
        epilog="Memory text body is always read from stdin.",
    )
    parser.add_argument(
        "--add",
        choices=sorted(MEMORY_ENTRY_TYPES),
        required=True,
        help="Entry type",
    )
    parser.add_argument("--stage", required=True, help="Stage slug (e.g. inspection)")
    parser.add_argument("--repo", required=True, help="Repository directory name")
    parser.add_argument(
        "--context",
        default=None,
        help="Decision rationale (only valid with --add decision)",
    )
    ns = parser.parse_args(argv)

    if ns.context and ns.add not in {"decision", "feedback"}:
        parser.error("--context may only be used with --add decision or feedback")

    text_value = sys.stdin.read()

    try:
        path = append_memory_entry(
            entry_type=ns.add,
            stage=ns.stage,
            repo=ns.repo,
            text=text_value,
            context=ns.context,
        )
    except ValueError as exc:
        parser.error(str(exc))

    try:
        from harness.emit import append_agent_thought

        append_agent_thought(
            memory_heartbeat_body(
                entry_type=ns.add,
                stage=ns.stage,
                repo=ns.repo,
                text=text_value,
                context=ns.context,
                component=None,
            )
        )
    except Exception:  # noqa: S110 — heartbeat failure must not block memory writes
        pass

    print(f"memory written: {path}")
    return 0


def memory_main(argv: list[str]) -> int:
    try:
        return _memory_main_impl(argv)
    except SystemExit as exc:
        code = exc.code
        return code if isinstance(code, int) else (0 if code is None else 2)


class MemoryStore:
    """Appends entries to the harness memory directory (``paths.MEMORY_DIR``)."""

    def append(
        self,
        *,
        entry_type: str,
        stage: str,
        repo: str,
        text: str,
        context: str | None,
        component: str | None = None,
    ) -> Path:
        return append_memory_entry(
            entry_type=entry_type,
            stage=stage,
            repo=repo,
            text=text,
            context=context,
            component=component,
        )
