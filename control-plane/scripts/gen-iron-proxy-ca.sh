#!/usr/bin/env bash
# Generates the local iron-proxy CA into infra/local/certs (gitignored).
# iron-proxy signs per-host leaf certs with it; the harness image trusts it via
# `make build IRON_PROXY_CA=.../ca.crt`. No-op when the CA already exists, so
# re-running never invalidates an image built against the current CA.
set -euo pipefail

CERTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/infra/local/certs"
if [ -f "$CERTS_DIR/ca.crt" ] && [ -f "$CERTS_DIR/ca.key" ]; then
  echo "iron-proxy CA already exists at $CERTS_DIR"
  exit 0
fi

mkdir -p "$CERTS_DIR"
(
  umask 077
  openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 3650 \
    -subj "/CN=harness-local iron-proxy CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$CERTS_DIR/ca.key" -out "$CERTS_DIR/ca.crt" 2>/dev/null
)
# The cert is public (baked into the harness image); the key stays owner-only.
chmod 644 "$CERTS_DIR/ca.crt"
echo "Generated iron-proxy CA at $CERTS_DIR (rebuild the harness image with IRON_PROXY_CA=$CERTS_DIR/ca.crt)"
