#!/usr/bin/env bash
# Re-downloads the vendored OpenSandbox chart and checks it against the pinned
# sha256. Upstream publishes its chart as a GitHub release asset, not in a Helm
# repository, so the chart keeps a copy under charts/. The server
# and other images are overridden in values.yaml.
set -euo pipefail

VERSION=0.2.2
SHA256=2cab7593551d6887dedd110de1c582152b8139c0ed3390d04597f438d1d6d7c0
CHARTS="$(cd "$(dirname "$0")/.." && pwd)/charts"
URL="https://github.com/opensandbox-group/OpenSandbox/releases/download/helm%2Fopensandbox%2F${VERSION}/opensandbox-${VERSION}.tgz"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL -o "$tmp" "$URL"
echo "${SHA256}  ${tmp}" | shasum -a 256 -c -
mkdir -p "$CHARTS"
mv "$tmp" "$CHARTS/opensandbox-${VERSION}.tgz"
trap - EXIT
echo "vendored opensandbox-${VERSION}.tgz"
