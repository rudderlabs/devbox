#!/usr/bin/env bash
# Stops the local stack started by `bun run up` (`bun run down`). Sandboxes are
# OpenSandbox-created containers (not compose services) on the `devbox`
# network, so they go first or compose can't remove the network. Volumes are
# kept: postgres data, the devbox-repos base and per-task workspaces
# (`bun run reset` removes them).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

sandboxes="$(docker ps -aq --filter label=opensandbox.io/id; docker ps -aq --filter label=opensandbox.io/egress-sidecar-for)"
if [ -n "$sandboxes" ]; then
  # shellcheck disable=SC2086
  docker rm -f $sandboxes >/dev/null
  echo "Removed $(echo "$sandboxes" | wc -l | tr -d ' ') sandbox container(s)"
fi
# The profile also stops the GitHub App token minter, which a plain `down`
# leaves running (and the network with it).
docker compose -f "$ROOT/docker-compose.yml" --profile github-app down
