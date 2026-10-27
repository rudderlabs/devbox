#!/usr/bin/env bash
set -uo pipefail

cd /workspace

/usr/local/bin/bootstrap
rc=$?
if [ "$rc" -ne 0 ]; then
  # Bootstrap failed (proxy CA install, registry creds, etc). The daemon never
  # starts — log and exit non-zero so the pod terminates. CP's sandbox-liveness
  # check sees the Failed/Terminated sandbox and fails the task via the reaper
  # path; no synthetic events.jsonl marker is emitted here.
  echo "harness-entrypoint: bootstrap failed (rc=$rc); exiting" >&2
  exit "$rc"
fi

exec /opt/harness/.venv/bin/harness daemon
