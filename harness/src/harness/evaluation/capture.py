"""Load a saved capture and verify its inputs, identities, and harness archive."""

import hashlib
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .parsing import (
    parse_json,
    parse_yaml,
    require_object,
    require_sha256,
    require_text,
    safe_integer,
)

INPUT_NAMES = (
    "run.json",
    "assignment.json",
    "task.yaml",
    "task.md",
    "workspace.yaml",
)
ARCHIVE_NAME = "harness-artifacts.tar.gz"


@dataclass(frozen=True)
class CaptureInputs:
    capture_dir: Path
    capture_bytes: bytes
    capture: dict[str, Any]
    run: dict[str, Any]
    task: dict[str, Any]
    input_bytes: dict[str, bytes]
    archive_path: Path
    archive_size: int
    archive_sha256: str


def parse_task(raw: bytes | str) -> dict[str, Any]:
    """Parse the task.yaml fields the evaluator consumes.

    The version gates how the task is interpreted, so an unsupported version fails
    early. Other fields belong to the control plane's authoring format; the
    evaluator neither reads nor validates them, so additive fields stay compatible.
    """
    value = parse_yaml(raw, "task")
    version = safe_integer(value.get("version"), "task.version")
    if version != 1:
        raise ValueError(f"Unsupported task.version {version}; supported: 1")
    return {"version": version, "id": require_text(value.get("id"), "task.id")}


def _archive_entry(capture: dict[str, Any]) -> dict[str, Any]:
    archives = capture.get("archives")
    if not isinstance(archives, list):
        raise ValueError("Capture archives must be an array")  # noqa: TRY004
    matches = []
    for entry in archives:
        archive = require_object(entry, "capture archive")
        if archive.get("filename") == ARCHIVE_NAME:
            matches.append(archive)
    if len(matches) != 1:
        raise ValueError(f"Capture must contain one {ARCHIVE_NAME} entry")
    return matches[0]


def _verify_input_hashes(
    capture: dict[str, Any], input_bytes: dict[str, bytes]
) -> None:
    input_hashes = require_object(capture.get("inputs"), "capture input hashes")
    for name, content in input_bytes.items():
        expected = require_sha256(
            input_hashes.get(name), f"capture input hash for {name}"
        )
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError(f"Input hash mismatch: {name}")


def _verify_identities(
    capture_id: str,
    capture: dict[str, Any],
    run: dict[str, Any],
    task: dict[str, Any],
    assignment: dict[str, Any],
) -> None:
    run_id = require_text(run.get("id"), "run ID")
    inbox_id = require_text(run.get("inbox_id"), "run inbox ID")
    sandbox_id = require_text(run.get("sandbox_id"), "run sandbox ID")
    namespace = require_text(run.get("namespace"), "run namespace")
    manifest_id = require_text(capture.get("id"), "capture ID")
    payload = require_object(assignment.get("payload"), "assignment payload")
    payload_task_key = payload.get("task_key")
    if (
        safe_integer(run.get("version"), "run version") != 1
        or run.get("task_id") != task["id"]
        or manifest_id != capture_id
        or capture.get("run_id") != run_id
        or capture.get("task_id") != task["id"]
        or capture.get("inbox_id") != inbox_id
        or capture.get("sandbox_id") != sandbox_id
        or capture.get("namespace") != namespace
        or assignment.get("id") != inbox_id
        or assignment.get("kind") != "assignment"
        or assignment.get("external_id") != run_id
        or payload_task_key != task["id"]
    ):
        raise ValueError(
            "Capture, run, task, workspace, and assignment identities must match"
        )


def _verify_archive(capture_dir: Path, capture: dict[str, Any]) -> tuple[int, str]:
    archive = _archive_entry(capture)
    if archive.get("filename") != ARCHIVE_NAME:
        raise ValueError("Invalid harness archive metadata")
    size = safe_integer(archive.get("size"), "harness archive size")
    archive_sha = require_sha256(archive.get("sha256"), "harness archive hash")
    archive_path = capture_dir / ARCHIVE_NAME
    archive_stat = archive_path.lstat()
    if not stat.S_ISREG(archive_stat.st_mode) or archive_stat.st_size != size:
        raise ValueError(f"Archive size mismatch: {ARCHIVE_NAME}")
    with archive_path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != archive_sha:
            raise ValueError(f"Archive checksum mismatch: {ARCHIVE_NAME}")
    return size, archive_sha


def load_capture(capture_dir: Path) -> CaptureInputs:
    """Validate saved input hashes/identities and harness archive size/hash."""
    resolved = capture_dir.resolve(strict=True)
    if resolved.parent.name != "captures":
        raise ValueError("Capture directory must be under a run's captures directory")
    run_dir = resolved.parents[1]
    capture_bytes = (resolved / "capture.json").read_bytes()
    capture = parse_json(capture_bytes, "capture.json")
    if safe_integer(capture.get("version"), "capture.json version") != 1:
        raise ValueError("capture.json version must be 1")
    input_bytes = {name: (run_dir / name).read_bytes() for name in INPUT_NAMES}
    _verify_input_hashes(capture, input_bytes)

    task = parse_task(input_bytes["task.yaml"])
    run = parse_json(input_bytes["run.json"], "run.json")
    assignment = parse_json(input_bytes["assignment.json"], "assignment.json")
    _verify_identities(resolved.name, capture, run, task, assignment)

    size, archive_sha = _verify_archive(resolved, capture)
    return CaptureInputs(
        capture_dir=resolved,
        capture_bytes=capture_bytes,
        capture=capture,
        run=run,
        task=task,
        input_bytes=input_bytes,
        archive_path=resolved / ARCHIVE_NAME,
        archive_size=size,
        archive_sha256=archive_sha,
    )
