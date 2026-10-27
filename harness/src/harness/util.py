"""Shared runtime helpers for the harness."""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from harness.paths import (
    PACKAGE_DIR,
    PROMPTS_DIR,
    SESSION_JSON,
)


def iso_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_run_id() -> str:
    day = datetime.now(UTC).strftime("%Y%m%d")
    return f"{day}-{secrets.token_hex(3)}"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _prompt_text(name: str) -> str:
    primary = PROMPTS_DIR / name
    if primary.exists():
        return read_text(primary)
    return read_text(PACKAGE_DIR / "prompts" / name)


def _atomic_write(path: Path, content: str) -> None:
    """Write *content* to *path* atomically with an fsync barrier.

    Writes to a temp file in the same directory, fsyncs, then renames.
    On any failure the original file is left untouched.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, str(path))
    except BaseException:
        os.unlink(tmp)
        raise


def write_json(path: Path, data: Any) -> None:
    _atomic_write(path, json.dumps(data, indent=2, sort_keys=True) + "\n")


def load_json_file(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_session(run_id: str, task: str, task_key: str | None) -> None:
    print(f"writing session for run: {run_id} with task key: {task_key}")
    write_json(
        SESSION_JSON,
        {
            "run_id": run_id,
            "task": task,
            "task_key": task_key,
            "started_at": iso_now(),
        },
    )


_HARNESS_TAG_RE = re.compile(r"<(/?)(harness_context|task)(?=[\s>/])", re.IGNORECASE)


def defang(text: str) -> str:
    """Neutralize harness framing tags inside agent-authored text.

    Briefs delimit trusted context with `<harness_context>` / `<task>`; an
    attacker-influenced finding or report must not be able to close them.
    """
    return _HARNESS_TAG_RE.sub(lambda m: f"&lt;{m.group(1)}{m.group(2)}", text)


def fenced(text: str, lang: str) -> list[str]:
    """Wrap `text` in a code fence longer than any backtick run it contains."""
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return [f"{fence}{lang}", text, fence]


# HTML closes a comment on `-->` and also on the non-conforming `--!>`; both
# must be neutralized or a bullet could terminate/open comment framing.
_PR_BODY_COMMENT_CLOSE = re.compile(r"--!?>")
_PR_BODY_COMMENT_FRAMING = re.compile(r"<!--|--!?>")


def neutralize_comment_framing(text: str) -> str:
    """Escape HTML-comment framing (`<!--`, `-->`, `--!>`) in agent-authored text."""
    return _PR_BODY_COMMENT_FRAMING.sub(
        lambda m: m.group(0).replace("<", "&lt;").replace(">", "&gt;"), text
    )


# A fence line: indented at most 3 spaces, then a run of 3+ backticks or tildes.
_FENCE_LINE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def close_unterminated_markdown(body: str) -> str:
    """Close an unterminated HTML comment or code fence at the end of `body`.

    The annotation is appended after agent-authored text; an unclosed `<!--`
    or ``` there would swallow it on GitHub and hide the unresolved findings
    from the human reviewer.
    """
    out = body.rstrip()
    if out.count("<!--") > len(_PR_BODY_COMMENT_CLOSE.findall(out)):
        out += "\n-->"
    # Track the open fence rather than counting markers: a `~~~` line inside
    # an open ``` block is content, and a fence closes only on the same
    # character at least as long (CommonMark).
    open_fence: str | None = None
    for line in out.splitlines():
        m = _FENCE_LINE.match(line)
        if not m:
            continue
        marker, rest = m.group(1), m.group(2)
        if open_fence is None:
            # An opening fence may carry an info string, but a backtick
            # fence's info string cannot contain a backtick.
            if marker[0] == "`" and "`" in rest:
                continue
            open_fence = marker
        elif (
            marker[0] == open_fence[0]
            and len(marker) >= len(open_fence)
            and not rest.strip(" \t")
        ):
            open_fence = None
    if open_fence is not None:
        out += "\n" + open_fence
    return out


def safe_marker_fragment(value: str) -> str:
    """Make *value* safe to embed in a marker file name."""
    return "".join(c if c.isalnum() or c in "-._" else "-" for c in value)
