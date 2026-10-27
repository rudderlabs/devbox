"""Shared builders for evaluation tests (not collected: no ``test_`` prefix)."""

import copy
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Any

import yaml

from harness.evaluation import EvidenceFile, summarize_events
from harness.evaluation.report import build_report

LEDGER_PATH = "data/harness-artifacts/events.jsonl"
INVOCATION_ID = "11111111-1111-4111-8111-111111111111"
SDK_PATH = f"data/harness-artifacts/deepagents-events/{INVOCATION_ID}.jsonl"
SDK_FIXTURE = (
    Path(__file__).parents[1] / f"fixtures/deepagents-v1/{INVOCATION_ID}.jsonl"
)
INBOX_ID = "fixture-inbox"
METADATA = {
    "image": {"reference": "harness-evaluator:test", "id": "sha256:" + "a" * 64},
    "source": None,
}
LEDGER = [
    {
        "seq": 1,
        "ts": "2026-09-21T00:00:00Z",
        "type": "agent_action",
        "inbox_id": INBOX_ID,
        "body": "work",
    },
    {
        "seq": 2,
        "ts": "2026-09-21T00:00:10Z",
        "type": "completed",
        "inbox_id": INBOX_ID,
        "status": "completed",
    },
]


# DeepAgents event evidence


def jsonl(records: list[dict[str, Any]], *, trailing: bool = True) -> bytes:
    content = "\n".join(
        json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        for record in records
    )
    return (content + ("\n" if trailing else "")).encode()


def fixture_records() -> list[dict[str, Any]]:
    return [json.loads(line) for line in SDK_FIXTURE.read_bytes().splitlines()]


def fixture_with(index: int, **changes: Any) -> list[dict[str, Any]]:
    """Return a fresh copy of the fixture with *changes* applied to one record."""
    records = fixture_records()
    records[index].update(copy.deepcopy(changes))
    return records


def fixture_for_inbox(inbox_id: str) -> list[dict[str, Any]]:
    """Return the fixture as if it had been recorded for another inbox."""
    return [record | {"inbox_id": inbox_id} for record in fixture_records()]


def resequence(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [record | {"seq": index} for index, record in enumerate(records, 1)]


def sdk_record(seq: int, event: str, *, minute: int = 0, **fields: Any) -> dict:
    """Build an SDK record for the fixture invocation at 18:<minute>:00.<seq>."""
    start = fixture_records()[0]
    return {
        "version": 1,
        "invocation_id": start["invocation_id"],
        "thread_id": start["thread_id"],
        "inbox_id": start["inbox_id"],
        "seq": seq,
        "ts": f"2026-09-21T18:{minute:02}:00.{seq:03}Z",
        "elapsed_ms": seq + 2,
        "namespace": [],
        "source_timestamp_ms": None,
        "event": event,
        **fields,
    }


def terminal_record(seq: int, *, minute: int = 0) -> dict[str, Any]:
    """Return the fixture's finished terminal renumbered to *seq*."""
    return fixture_records()[-1] | {
        "seq": seq,
        "ts": f"2026-09-21T18:{minute:02}:00.{seq:03}Z",
    }


def summarize(records: list[dict[str, Any]], path: str = SDK_PATH) -> dict:
    return summarize_events([EvidenceFile(path, jsonl(records))], INBOX_ID)


# Saved captures


def write_archive(path: Path, members: list[dict[str, Any]]) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for member in members:
            info = tarfile.TarInfo(member["name"])
            kind = member.get("type", "file")
            if kind == "file":
                content = member.get("content", b"")
                data = content.encode() if isinstance(content, str) else content
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            else:
                info.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                info.linkname = member.get("linkname", "")
                archive.addfile(info)


def default_members(events: bytes | None = None) -> list[dict[str, Any]]:
    return [
        {"name": LEDGER_PATH, "content": events or jsonl(LEDGER)},
        {"name": SDK_PATH, "content": SDK_FIXTURE.read_bytes()},
    ]


def edit_manifest(capture_dir: Path, change: Callable[[dict], None]) -> None:
    path = capture_dir / "capture.json"
    manifest = json.loads(path.read_text())
    change(manifest)
    path.write_text(json.dumps(manifest, indent=2) + "\n")


def update_archive_hash(capture_dir: Path) -> None:
    content = (capture_dir / "harness-artifacts.tar.gz").read_bytes()

    def change(manifest):
        archive = next(
            entry
            for entry in manifest["archives"]
            if entry["filename"] == "harness-artifacts.tar.gz"
        )
        archive["size"] = len(content)
        archive["sha256"] = hashlib.sha256(content).hexdigest()

    edit_manifest(capture_dir, change)


def set_harness_archive(capture_dir: Path, **fields: Any) -> None:
    """Overwrite harness-archive manifest fields without touching the archive."""
    edit_manifest(capture_dir, lambda manifest: manifest["archives"][0].update(fields))


def replace_archive(capture_dir: Path, members: list[dict[str, Any]]) -> None:
    write_archive(capture_dir / "harness-artifacts.tar.gz", members)
    update_archive_hash(capture_dir)


def update_input_hash(capture_dir: Path, name: str) -> None:
    content = (capture_dir.parents[1] / name).read_bytes()

    def change(manifest):
        manifest["inputs"][name] = hashlib.sha256(content).hexdigest()

    edit_manifest(capture_dir, change)


def set_manifest_terminal(capture_dir: Path, terminal: dict[str, Any]) -> None:
    edit_manifest(capture_dir, lambda manifest: manifest.update(terminal=terminal))


def edit_input(capture_dir: Path, name: str, change: Callable[[str], str]) -> None:
    """Rewrite a saved run input and record its new hash in the manifest."""
    path = capture_dir.parents[1] / name
    path.write_text(change(path.read_text()))
    update_input_hash(capture_dir, name)


def edit_json_input(
    capture_dir: Path, name: str, change: Callable[[dict], None]
) -> None:
    """Mutate a saved JSON run input in place and record its new hash."""

    def rewrite(text: str) -> str:
        value = json.loads(text)
        change(value)
        return json.dumps(value)

    edit_input(capture_dir, name, rewrite)


def write_ledger(
    capture_dir: Path, records: list[dict[str, Any]], *, tail: bytes = b""
) -> None:
    """Replace the assignment ledger; the last record becomes the capture terminal."""
    replace_archive(capture_dir, default_members(jsonl(records) + tail))
    set_manifest_terminal(capture_dir, records[-1])


def make_capture(root: Path) -> Path:
    run_dir = root / "run-one"
    capture_dir = run_dir / "captures/capture-one"
    capture_dir.mkdir(parents=True)
    inputs = {
        "run.json": json.dumps({
            "version": 1,
            "id": "run-one",
            "task_id": "ABC-1",
            "created_at": "2026-09-20T23:59:00Z",
            "phase": "started",
            "namespace": "fixture-namespace",
            "snapshot": "fixture-snapshot",
            "pvc_name": "fixture-pvc",
            "sandbox_id": "fixture-sandbox",
            "inbox_id": INBOX_ID,
            "harness": {
                "worktree": "/source/widgets",
                "commit": "a" * 40,
                "source_sha256": "b" * 64,
                "image": "devbox-dev@sha256:fixture",
            },
            "environment": {"HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING": "true"},
        }),
        "assignment.json": json.dumps({
            "id": INBOX_ID,
            "kind": "assignment",
            "external_id": "run-one",
            "payload": {"task_key": "ABC-1"},
        }),
        "task.yaml": yaml.safe_dump(
            {
                "version": 1,
                "id": "ABC-1",
                "assignment": {
                    "title": "Fixture task",
                    "task_key": "ABC-1",
                    "description_file": "task.md",
                },
                "reference_prs": ["https://github.com/acme/app/pull/1"],
            },
            sort_keys=False,
        ),
        "task.md": "Offline report fixture",
        "workspace.yaml": yaml.safe_dump(
            {
                "version": 1,
                "task_id": "ABC-1",
                "repositories": {
                    "app": {
                        "url": "https://github.com/acme/app.git",
                        "branch": "main",
                        "sha": "1" * 40,
                    }
                },
                "specifications": [],
            },
            sort_keys=False,
        ),
    }
    for name, content in inputs.items():
        (run_dir / name).write_text(content)
    write_archive(capture_dir / "harness-artifacts.tar.gz", default_members())
    archive_bytes = (capture_dir / "harness-artifacts.tar.gz").read_bytes()
    manifest = {
        "version": 1,
        "id": "capture-one",
        "run_id": "run-one",
        "task_id": "ABC-1",
        "sandbox_id": "fixture-sandbox",
        "namespace": "fixture-namespace",
        "inbox_id": INBOX_ID,
        "capture_started_at": "2026-09-21T00:00:11Z",
        "capture_finished_at": "2026-09-21T00:00:12Z",
        "started_at": "2026-09-21T00:00:10Z",
        "finished_at": "2026-09-21T00:00:11Z",
        "terminal": LEDGER[1],
        "sources": [{"path": "/workspace/.harness", "present": True}],
        "repositories": [],
        "archives": [
            {
                "filename": "harness-artifacts.tar.gz",
                "size": len(archive_bytes),
                "sha256": hashlib.sha256(archive_bytes).hexdigest(),
            },
            {"filename": "repositories.tar.gz", "size": 0, "sha256": "0" * 64},
        ],
        "inputs": {
            name: hashlib.sha256(content.encode()).hexdigest()
            for name, content in inputs.items()
        },
    }
    (capture_dir / "capture.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return capture_dir


class CaptureTestCase(unittest.TestCase):
    """Provides ``self.capture_dir``: a fresh valid capture, removed after the test."""

    def setUp(self) -> None:
        self.capture_dir = self.new_capture()
        self.root = self.capture_dir.parents[2]

    def new_capture(self) -> Path:
        """Create another independent capture (e.g. one per subTest)."""
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return make_capture(Path(directory.name))

    def report(self, capture_dir: Path | None = None, metadata=METADATA) -> dict:
        return build_report(capture_dir or self.capture_dir, metadata)

    def assert_rejected(
        self, pattern: str, capture_dir: Path | None = None, metadata=METADATA
    ) -> None:
        with self.assertRaisesRegex(ValueError, pattern):
            build_report(capture_dir or self.capture_dir, metadata)
