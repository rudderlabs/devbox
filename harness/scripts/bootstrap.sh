#!/bin/bash
set -e

# ── Feature gate ─────────────────────────────────────────────────────────────
# IRON_PROXY_EGRESS defaults to off so the image runs cleanly outside a
# proxied environment (laptop / CI). When egress is routed through iron-proxy,
# set it to true: that enables the CA install and the GitHub HTTPS auth below.
# The local stack bakes it in via `make build IRON_PROXY_CA=...`.
IRON_PROXY_EGRESS="${IRON_PROXY_EGRESS:-false}"

# ── iron-proxy CA trust ──────────────────────────────────────────────────────
# The proxy CA is mounted at /run/iron-proxy/ca.crt. The plain image has no
# cert baked in; only the local-stack layer (`make build IRON_PROXY_CA=...`)
# does.
IRON_PROXY_CA="/run/iron-proxy/ca.crt"
if [ "$IRON_PROXY_EGRESS" = "true" ] && [ -f "$IRON_PROXY_CA" ]; then
  # System trust store — used by curl, git, Node TLS, etc.
  cp "$IRON_PROXY_CA" /usr/local/share/ca-certificates/iron-proxy.crt
  update-ca-certificates >/dev/null 2>&1
fi

# ── GitHub HTTPS auth via iron-proxy ────────────────────────────────────────
# Native git clone/fetch/push inside the sandbox talks to github.com over
# HTTPS. We install a dummy Basic auth header here; iron-proxy swaps the token
# for a real GitHub token at egress, so no live credential is written into git
# config inside the sandbox. Skip outside iron-proxy — the dummy token would
# break real git pushes.
if [ "$IRON_PROXY_EGRESS" = "true" ]; then
  GITHUB_GIT_TOKEN="${GITHUB_TOKEN:-${GITHUB_PROXY_TOKEN:-proxy-github-dummy-token}}"
  GITHUB_BASIC="$(printf 'x-access-token:%s' "$GITHUB_GIT_TOKEN" | base64 | tr -d '\n')"
  git config --global --unset-all url."https://github.com/".insteadOf >/dev/null 2>&1 || true
  git config --global --add url."https://github.com/".insteadOf "git@github.com:"
  git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
  git config --global --add url."https://github.com/".insteadOf "git://github.com/"
  git config --global --unset-all http.https://github.com/.extraHeader >/dev/null 2>&1 || true
  git config --global http.https://github.com/.extraHeader "Authorization: Basic $GITHUB_BASIC"
fi

# ── Repo ownership ──────────────────────────────────────────────────────────
# On Kubernetes the workspace is restored from a snapshot the builder cloned as
# uid 1000, but the harness runs as root, so git refuses the repos as "dubious
# ownership" (exit 128). The sandbox owns all of /workspace, so trust every
# directory. --system: the setting holds whatever HOME a git call runs with.
# Not '/workspace/*': git before 2.46 (such as bookworm's 2.39) does not
# support a trailing /* and still refuses the repos, and derived images may
# still use such a base.
git config --system --replace-all safe.directory '*'
