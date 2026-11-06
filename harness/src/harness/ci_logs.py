"""Fetch CI failure logs from GitHub Actions runs, and reports from other CI tools.

Deterministic fetchers that use GitHubClient to write what failed to disk for
the agent to analyze.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

from harness.git import GitHubClient

_RUN_URL_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)"
    r"/actions/runs/(?P<run_id>\d+)"
)


REPORTED_CI_SOURCES = frozenset({"check_run", "status"})

_CHECK_RUN_URL_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)"
    r"/runs/(?P<check_run_id>\d+)"
)


def parse_run_url(run_url: str) -> tuple[str, str, int] | None:
    m = _RUN_URL_RE.match(run_url)
    if not m:
        return None
    return m.group("owner"), m.group("repo"), int(m.group("run_id"))


def parse_check_run_url(url: str) -> tuple[str, str, int] | None:
    m = _CHECK_RUN_URL_RE.match(url)
    if not m:
        return None
    return m.group("owner"), m.group("repo"), int(m.group("check_run_id"))


def _safe_filename(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)


def fetch_failed_job_logs(
    owner: str,
    repo: str,
    run_id: int,
    output_dir: Path,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Fetch logs for all failed jobs in a GitHub Actions workflow run.

    Returns a list of {job_name, job_id, log_path} dicts for each failed job
    whose logs were successfully written to output_dir.
    """
    client = GitHubClient()
    output_dir.mkdir(parents=True, exist_ok=True)

    jobs = client.get_workflow_run_jobs(owner, repo, run_id)
    failed_jobs = [j for j in jobs if j.get("conclusion") == "failure"]

    results: list[dict[str, Any]] = []
    errors: list[str] = []
    for job in failed_jobs:
        job_id = job["id"]
        job_name = job.get("name", f"job-{job_id}")
        log_path = output_dir / f"{_safe_filename(job_name)}-{job_id}.log"

        try:
            log_text = client.get_job_logs(owner, repo, job_id)
            log_path.write_text(log_text, encoding="utf-8")
            results.append({
                "job_name": job_name,
                "job_id": job_id,
                "log_path": str(log_path),
            })
        except Exception as exc:
            print(
                f"ci_logs: failed to fetch logs for job {job_name} ({job_id}): {exc}",
                file=sys.stderr,
            )
            errors.append(f"failed to fetch logs for job {job_name} ({job_id}): {exc}")

    return results, errors


def fetch_check_run_report(
    owner: str,
    repo: str,
    check_run_id: int,
    output_dir: Path,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Write a failed check run's output and annotations, in fetch_failed_job_logs' shape."""
    client = GitHubClient()
    output_dir.mkdir(parents=True, exist_ok=True)

    check_run = client.get_check_run(owner, repo, check_run_id)
    name = str(check_run.get("name") or f"check-run-{check_run_id}")
    errors: list[str] = []
    try:
        annotations = client.list_check_run_annotations(owner, repo, check_run_id)
    except Exception as exc:
        print(
            f"ci_logs: failed to fetch annotations for check run {name} "
            f"({check_run_id}): {exc}",
            file=sys.stderr,
        )
        errors.append(
            f"failed to fetch annotations for check run {name} ({check_run_id}): {exc}"
        )
        annotations = []

    report_path = output_dir / f"{_safe_filename(name)}-{check_run_id}.txt"
    report_path.write_text(_check_run_report(check_run, annotations), encoding="utf-8")
    return (
        [{"job_name": name, "job_id": check_run_id, "log_path": str(report_path)}],
        errors,
    )


def _check_run_report(
    check_run: dict[str, Any], annotations: list[dict[str, Any]]
) -> str:
    output = check_run.get("output") or {}
    lines = [
        f"Check run: {check_run.get('name', '')}",
        f"Conclusion: {check_run.get('conclusion', '')}",
        f"Details: {check_run.get('details_url') or 'none'}",
        "",
        f"# Output: {output.get('title') or '(no title)'}",
        "",
    ]
    for part in (output.get("summary"), output.get("text")):
        if part:
            lines += [str(part), ""]
    lines += [f"# Annotations ({len(annotations)})", ""]
    for a in annotations:
        start, end = a.get("start_line"), a.get("end_line")
        where = f"{a.get('path', '')}:{start}" + (
            f"-{end}" if end and end != start else ""
        )
        title = f" {a['title']}:" if a.get("title") else ""
        lines.append(
            f"{where} [{a.get('annotation_level', '')}]{title} {a.get('message', '')}"
        )
        if a.get("raw_details"):
            lines.append(str(a["raw_details"]))
    return "\n".join(lines).rstrip() + "\n"


def write_reported_failure(
    *,
    name: str,
    conclusion: str,
    summary: str,
    details_url: str,
    report_id: str,
    output_dir: Path,
) -> list[dict[str, Any]]:
    """Write what the webhook carried, for a commit status or an unfetchable check run."""
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = (
        output_dir / f"{_safe_filename(name or 'ci')}-{_safe_filename(report_id)}.txt"
    )
    report_path.write_text(
        "\n".join([
            f"Check: {name}",
            f"Conclusion: {conclusion}",
            f"Description: {summary or 'none'}",
            f"Details: {details_url or 'none'}",
            "",
            "This is all the CI tool reported to GitHub. Its logs are not available here.",
            "",
        ]),
        encoding="utf-8",
    )
    return [{"job_name": name, "job_id": report_id, "log_path": str(report_path)}]
