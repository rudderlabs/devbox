"""Fetch CI failure logs from GitHub Actions runs.

Deterministic log fetcher that uses GitHubClient to download logs for failed
jobs in a workflow run, writing them to disk for the agent to analyze.
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


def parse_run_url(run_url: str) -> tuple[str, str, int] | None:
    m = _RUN_URL_RE.match(run_url)
    if not m:
        return None
    return m.group("owner"), m.group("repo"), int(m.group("run_id"))


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
        safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in job_name)
        log_path = output_dir / f"{safe_name}-{job_id}.log"

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
