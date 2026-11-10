#!/bin/sh
# Builds a repo snapshot: clones or fetches the configured repos
# into the scratch volume, flushes them to disk, creates a VolumeSnapshot
# repos-<UTC timestamp>, waits until it is ready and deletes all but the
# newest $KEEP. The control plane restores each task's workspace from the
# newest ready snapshot.
#
# Trusted and clone-only: it reads the real GitHub token, and the GitLab
# token when gitlab.baseUrl is set (from the release namespace, through the
# API, so they are never stored in the sandbox namespace), and its egress is
# open on 443. It must never run repo code.
set -eu

KUBECTL="${KUBECTL:-kubectl}"
GIT="${GIT:-git}"
REPOS_DIR="${REPOS_DIR:-/repos}"
: "${REPOS:?}" "${RELEASE_NAMESPACE:?}" "${SANDBOX_NAMESPACE:?}" "${GITHUB_SECRET:?}"
: "${SCRATCH_PVC:?}" "${SNAPSHOT_CLASS:?}" "${KEEP:?}"

GITLAB_BASE_URL="${GITLAB_BASE_URL:-}"
GITLAB_BASE_URL="${GITLAB_BASE_URL%/}"

# One http.<url>.extraheader per host, via GIT_CONFIG_* env: never argv or
# .git/config. $1 is the URL prefix, $2 the Basic credential.
GIT_CONFIG_COUNT=0
add_auth_header() {
  eval "export GIT_CONFIG_KEY_$GIT_CONFIG_COUNT=\"http.\$1.extraheader\""
  eval "export GIT_CONFIG_VALUE_$GIT_CONFIG_COUNT=\"Authorization: Basic \$2\""
  GIT_CONFIG_COUNT=$((GIT_CONFIG_COUNT + 1))
}
# On its own so that a failed read stops the run (set -e) instead of cloning
# anonymously.
encoded="$("$KUBECTL" get secret "$GITHUB_SECRET" -n "$RELEASE_NAMESPACE" -o 'jsonpath={.data.token}')"
token="$(printf '%s' "$encoded" | base64 -d | tr -d '\r\n')"
unset encoded
if [ -n "$token" ]; then
  add_auth_header "https://github.com/" "$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
else
  echo "the GitHub token is empty: cloning anonymously"
fi
unset token
if [ -n "$GITLAB_BASE_URL" ]; then
  : "${GITLAB_SECRET:?}"
  encoded="$("$KUBECTL" get secret "$GITLAB_SECRET" -n "$RELEASE_NAMESPACE" -o 'jsonpath={.data.token}')"
  token="$(printf '%s' "$encoded" | base64 -d | tr -d '\r\n')"
  unset encoded
  if [ -n "$token" ]; then
    # GitLab takes any user name with an access token as the password.
    add_auth_header "$GITLAB_BASE_URL/" "$(printf 'oauth2:%s' "$token" | base64 | tr -d '\n')"
  else
    echo "the GitLab token is empty: cloning anonymously"
  fi
  unset token
fi
export GIT_CONFIG_COUNT
export GIT_TERMINAL_PROMPT=0

# A private CA for the GitLab instance (ironProxy.caBundle, a Secret in the
# release namespace, read like the tokens). git's CA file replaces the system
# store rather than adding to it, so the two are concatenated: GitHub keeps
# working. A failed read stops the run (set -e) rather than cloning unverified.
if [ -n "${GITLAB_CA_SECRET:-}" ]; then
  bundle="${TMPDIR:-/tmp}/devbox-ca-bundle.crt"
  encoded="$("$KUBECTL" get secret "$GITLAB_CA_SECRET" -n "$RELEASE_NAMESPACE" -o 'jsonpath={.data.ca\.crt}')"
  { cat "${SYSTEM_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"; printf '%s' "$encoded" | base64 -d; echo; } > "$bundle"
  unset encoded
  export GIT_SSL_CAINFO="$bundle"
fi

echo "$REPOS" | while read -r url branch; do
  [ -n "$url" ] || continue
  supported=
  case "$url" in https://github.com/*/*.git) supported=1 ;; esac
  if [ -n "$GITLAB_BASE_URL" ]; then
    case "$url" in "$GITLAB_BASE_URL"/*/*.git) supported=1 ;; esac
  fi
  if [ -z "$supported" ]; then
    echo "unsupported repo url: $url (expected https://github.com/<owner>/<repo>.git${GITLAB_BASE_URL:+ or $GITLAB_BASE_URL/<group>/<project>.git})" >&2
    exit 1
  fi
  name="$(basename "$url" .git)"
  case "$name" in "" | . | .. | -*) echo "bad repo name in $url" >&2; exit 1 ;; esac
  case "$branch" in "" | -* | *..*) echo "bad branch for $url: $branch" >&2; exit 1 ;; esac
  dir="$REPOS_DIR/$name"
  if [ -d "$dir/.git" ]; then
    # A checkout of the same name from another URL (an instance moved, or a
    # project renamed) is re-pointed, never fetched from its old remote.
    if [ "$("$GIT" -C "$dir" config --get remote.origin.url)" != "$url" ]; then
      echo "origin of $name changed; pointing it at $url"
      "$GIT" -C "$dir" remote set-url origin "$url"
    fi
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

if grep -lsE "x-access-token|github_pat_|gh[opsu]_|oauth2:|glpat-" "$REPOS_DIR"/*/.git/config; then
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
