#!/bin/sh
# Builds a repo snapshot: clones or fetches the configured repos
# into the scratch volume, flushes them to disk, creates a VolumeSnapshot
# repos-<UTC timestamp>, waits until it is ready and deletes all but the
# newest $KEEP. The control plane restores each task's workspace from the
# newest ready snapshot.
#
# Trusted and clone-only: it reads the real GitHub token (from the release
# namespace, through the API, so it is never stored in the sandbox namespace)
# and its egress is open on 443. It must never run repo code.
set -eu

KUBECTL="${KUBECTL:-kubectl}"
GIT="${GIT:-git}"
REPOS_DIR="${REPOS_DIR:-/repos}"
: "${REPOS:?}" "${RELEASE_NAMESPACE:?}" "${SANDBOX_NAMESPACE:?}" "${GITHUB_SECRET:?}"
: "${SCRATCH_PVC:?}" "${SNAPSHOT_CLASS:?}" "${KEEP:?}"

# On its own so that a failed read stops the run (set -e) instead of cloning
# anonymously.
encoded="$("$KUBECTL" get secret "$GITHUB_SECRET" -n "$RELEASE_NAMESPACE" -o 'jsonpath={.data.token}')"
token="$(printf '%s' "$encoded" | base64 -d | tr -d '\r\n')"
unset encoded
if [ -n "$token" ]; then
  # Via GIT_CONFIG_* env: never argv or .git/config.
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
  GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  export GIT_CONFIG_VALUE_0
else
  echo "the GitHub token is empty: cloning anonymously"
fi
unset token
export GIT_TERMINAL_PROMPT=0

echo "$REPOS" | while read -r url branch; do
  [ -n "$url" ] || continue
  case "$url" in
    https://github.com/*/*.git) ;;
    *) echo "unsupported repo url: $url (expected https://github.com/<owner>/<repo>.git)" >&2; exit 1 ;;
  esac
  name="$(basename "$url" .git)"
  case "$name" in "" | . | .. | -*) echo "bad repo name in $url" >&2; exit 1 ;; esac
  case "$branch" in "" | -* | *..*) echo "bad branch for $url: $branch" >&2; exit 1 ;; esac
  dir="$REPOS_DIR/$name"
  if [ -d "$dir/.git" ]; then
    echo "fetch $url ($branch)"
    "$GIT" -C "$dir" -c core.fsync=all fetch -q --depth 1 origin "+refs/heads/$branch:refs/remotes/origin/$branch"
    "$GIT" -C "$dir" checkout -q -f -B "$branch" "origin/$branch"
    "$GIT" -C "$dir" clean -q -ffdx
  else
    echo "clone $url ($branch)"
    rm -rf "$dir"
    "$GIT" -c core.fsync=all clone -q --depth 1 --single-branch --branch "$branch" -- "$url" "$dir"
  fi
done

if grep -lsE "x-access-token|github_pat_|gh[opsu]_" "$REPOS_DIR"/*/.git/config; then
  echo "token found in the git config files above; aborting" >&2
  exit 1
fi
sync

name="repos-${SNAPSHOT_TIMESTAMP:-$(date -u +%Y%m%d%H%M%S)}"
"$KUBECTL" create -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: $name
  namespace: $SANDBOX_NAMESPACE
  labels:
    app.kubernetes.io/part-of: devbox
    app.kubernetes.io/component: repo-snapshot
    app.kubernetes.io/managed-by: devbox-snapshot-builder
spec:
  volumeSnapshotClassName: $SNAPSHOT_CLASS
  source:
    persistentVolumeClaimName: $SCRATCH_PVC
EOF
"$KUBECTL" wait volumesnapshot "$name" -n "$SANDBOX_NAMESPACE" \
  --for='jsonpath={.status.readyToUse}=true' --timeout="${READY_TIMEOUT:-15m}"
echo "snapshot $name is ready"

# Oldest first; delete all but the newest $KEEP of this builder's own
# snapshots: both labels and the repos- name, so a snapshot made by hand in
# this namespace is never pruned. awk instead of `head -n -N`, which BSD head
# rejects. Same labels as control-plane/src/clients/repoSnapshots.ts.
"$KUBECTL" get volumesnapshot -n "$SANDBOX_NAMESPACE" \
  -l app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder \
  --sort-by=.metadata.creationTimestamp -o name \
  | awk -v keep="$KEEP" '/\/repos-[^\/]*$/ { l[++n] = $0 } END { for (i = 1; i <= n - keep; i++) print l[i] }' \
  | while read -r old; do
  "$KUBECTL" delete -n "$SANDBOX_NAMESPACE" "$old" --wait=false
done
