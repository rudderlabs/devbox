"""Build version-1 reports from saved evaluation captures."""

import argparse
import hashlib
import importlib.metadata
import json
import os
import re
import sys
import tempfile
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .archive import LEDGER_PATH, read_evidence
from .capture import ARCHIVE_NAME, INPUT_NAMES, load_capture
from .event_summary import summarize_events
from .ledger import MISSING, capture_terminal, summarize_execution
from .parsing import (
    COMMIT,
    parse_json,
    require_commit,
    require_object,
    require_sha256,
    require_text,
)


def _execution_metadata(value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {"image", "source"}:
        raise ValueError("Execution metadata must contain only image and source")
    image = value["image"]
    if not isinstance(image, Mapping) or set(image) != {"reference", "id"}:
        raise ValueError("Execution metadata image is invalid")
    reference = image["reference"]
    image_id = image["id"]
    if not isinstance(reference, str) or not reference.strip():
        raise ValueError("Evaluator image reference must be nonempty")
    if not isinstance(image_id, str) or not re.fullmatch(
        r"sha256:[0-9a-f]{64}", image_id, re.ASCII
    ):
        raise ValueError("Evaluator image ID must be sha256:<64 lowercase hex>")
    source = value["source"]
    if source is not None:
        if not isinstance(source, Mapping) or set(source) != {"commit", "sha256"}:
            raise ValueError("Evaluator source metadata is invalid")
        # Launcher metadata must already be canonical; captured inputs normalize.
        if not isinstance(source["commit"], str) or not COMMIT.fullmatch(
            source["commit"]
        ):
            raise ValueError("Evaluator source commit must be 40 lowercase hex")
        require_sha256(source["sha256"], "evaluator source hash")
        source = dict(source)
    return {"image": dict(image), "source": source}


def build_report(
    capture_dir: Path, execution_metadata: Mapping[str, Any]
) -> dict[str, Any]:
    """Build the version-1 report with provenance.evaluator."""
    metadata = _execution_metadata(execution_metadata)
    inputs = load_capture(capture_dir)
    run = inputs.run
    capture = inputs.capture
    harness = require_object(run.get("harness"), "run harness")
    commit = require_commit(harness.get("commit"))
    source_sha256 = require_sha256(
        harness.get("source_sha256"), "harness declared source hash"
    )
    image = require_text(harness.get("image"), "harness image")
    environment = require_object(run.get("environment"), "run environment")
    streaming = environment.get("HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING")
    if "HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING" in environment and not isinstance(
        streaming, str
    ):
        raise ValueError("Recorded DeepAgents streaming flag must be a string")

    files = read_evidence(inputs.archive_path)
    ledger = next((file for file in files if file.path == LEDGER_PATH), None)
    sdk_files = [file for file in files if file.path != LEDGER_PATH]
    manifest_terminal = capture_terminal(
        capture.get("terminal", MISSING), run["inbox_id"]
    )
    execution = summarize_execution(ledger, run["inbox_id"], manifest_terminal)
    deepagents = summarize_events(sdk_files, run["inbox_id"])
    generated_at = (
        datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )
    provenance = {
        "task_id": inputs.task["id"],
        "run_id": run["id"],
        "capture_id": capture["id"],
        "inbox_id": run["inbox_id"],
        "generated_at": generated_at,
        "evaluator": {
            "package": "devbox-harness",
            "version": importlib.metadata.version("devbox-harness"),
            "image": metadata["image"],
            "source": metadata["source"],
        },
        "capture_manifest": {
            "filename": "capture.json",
            "sha256": hashlib.sha256(inputs.capture_bytes).hexdigest(),
        },
        "inputs": {
            name: {"sha256": hashlib.sha256(inputs.input_bytes[name]).hexdigest()}
            for name in INPUT_NAMES
        },
        "archive": {
            "filename": ARCHIVE_NAME,
            "size": inputs.archive_size,
            "sha256": inputs.archive_sha256,
        },
        "harness": {
            "commit": commit,
            "source_sha256": source_sha256,
            "image": image,
            "deepagents_event_streaming": streaming,
            "source": "declared",
        },
        "deepagents_files": [
            {
                "path": file["path"],
                "sha256": file["sha256"],
                "version": file["version"],
                "stream_version": file["stream_version"],
                "packages": file["packages"],
            }
            for file in deepagents["evidence"]["included"]
        ],
    }
    return {
        "version": 1,
        "provenance": provenance,
        "execution": execution,
        "deepagents": deepagents,
    }


def generate_report(
    capture_dir: Path,
    output_dir: Path,
    execution_metadata: Mapping[str, Any],
) -> Path:
    """Atomically write output_dir/report.json and return its path."""
    report = build_report(capture_dir, execution_metadata)
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / "report.json"
    descriptor, temporary = tempfile.mkstemp(prefix=".report-", dir=output_dir)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return output


def main(argv: list[str] | None = None) -> int:
    """Run the standalone capture reporter."""
    parser = argparse.ArgumentParser(description="Generate a golden-task report")
    parser.add_argument("--capture-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--execution-metadata", required=True, type=Path)
    arguments = parser.parse_args(argv)
    try:
        metadata = parse_json(
            arguments.execution_metadata.read_bytes(), "execution metadata"
        )
        path = generate_report(arguments.capture_dir, arguments.output_dir, metadata)
    except Exception as error:
        message = str(error)[:500]
        print(f"evaluation: {message}", file=sys.stderr)
        return 1
    print(path)
    return 0
