#!/usr/bin/env bash
# Builds/refreshes the local base repos volume (default `devbox-repos`) from
# the `repos` of devbox.config.json. `bun run up` runs it; usage:
#   build-repos-volume.sh [path/to/devbox.config.json] <<< "$GITHUB_TOKEN"$'\n'"$GITLAB_TOKEN"
# The control plane (SANDBOX_RUNTIME=docker) copies this volume into a fresh
# per-task volume; sandboxes never mount it.
#
# Clone shape: --depth 1 --single-branch, flat /<repo-name> layout, and
# incremental: existing clones are fetched and hard reset instead of wiped and
# re-cloned; a checkout whose remote URL changed is re-pointed first. Repos
# removed from the config are not deleted from the volume.
#
# Token handling: the GitHub token is the first line of stdin and the GitLab
# token (repos under gitlab.baseUrl) the second; an empty line means anonymous
# clones (public repos only). They reach the container over stdin (never argv,
# env or `docker inspect`), are applied via GIT_CONFIG_* env (never argv or
# .git/config), and the run fails if any .git/config ends up holding one.
#
# A GitLab instance with a private CA: GITLAB_CA_FILE names the PEM on this
# machine; it is mounted read-only and appended to the system bundle for git
# (git's CA file replaces the store rather than adding to it).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VOLUME="${REPOS_BASE_VOLUME:-devbox-repos}"
CONFIG_FILE="${1:-$ROOT/../devbox.config.json}"
GIT_IMAGE="alpine/git:v2.49.1"

TOKEN=""
GITLAB_TOKEN_IN=""
IFS= read -r TOKEN || true
IFS= read -r GITLAB_TOKEN_IN || true
TOKEN="${TOKEN%$'\r'}"
GITLAB_TOKEN_IN="${GITLAB_TOKEN_IN%$'\r'}"

# "<url> <branch>" per line; branch defaults to main. The GitLab base URL, no
# trailing slash, or empty.
REPOS="$(bun -e '
  const { repos } = await Bun.file(process.argv[1]).json();
  for (const r of repos) console.log(r.url, r.branch ?? "main");
' "$CONFIG_FILE")"
GITLAB_BASE_URL="$(bun -e '
  const { gitlab } = await Bun.file(process.argv[1]).json();
  console.log((gitlab?.baseUrl ?? "").replace(/\/+$/, ""));
' "$CONFIG_FILE")"

CA_MOUNT=()
if [ -n "${GITLAB_CA_FILE:-}" ]; then
  [ -s "$GITLAB_CA_FILE" ] || { echo "GITLAB_CA_FILE $GITLAB_CA_FILE: not a readable, non-empty file" >&2; exit 1; }
  CA_MOUNT=(-v "$GITLAB_CA_FILE:/run/gitlab-ca.crt:ro" -e GITLAB_CA=/run/gitlab-ca.crt)
fi

printf '%s\n%s\n' "$TOKEN" "$GITLAB_TOKEN_IN" | docker run -i --rm \
  -e REPOS="$REPOS" \
  -e GITLAB_BASE_URL="$GITLAB_BASE_URL" \
  ${CA_MOUNT[@]+"${CA_MOUNT[@]}"} \
  -v "$VOLUME:/repos" \
  --entrypoint sh \
  "$GIT_IMAGE" -c '
set -eu
token=""
gitlab_token=""
read -r token || true
read -r gitlab_token || true
export GIT_CONFIG_COUNT=0
# Scopes a Basic Authorization header to one URL prefix.
add_auth_header() {
  eval "export GIT_CONFIG_KEY_$GIT_CONFIG_COUNT=\"http.$1.extraheader\""
  eval "export GIT_CONFIG_VALUE_$GIT_CONFIG_COUNT=\"Authorization: Basic $2\""
  GIT_CONFIG_COUNT=$((GIT_CONFIG_COUNT + 1))
}
if [ -n "$token" ]; then
  add_auth_header "https://github.com/" "$(printf "x-access-token:%s" "$token" | base64 | tr -d "\n")"
else
  echo "no GitHub token: cloning anonymously"
fi
if [ -n "$GITLAB_BASE_URL" ]; then
  if [ -n "$gitlab_token" ]; then
    # GitLab takes any user name with an access token as the password.
    add_auth_header "$GITLAB_BASE_URL/" "$(printf "oauth2:%s" "$gitlab_token" | base64 | tr -d "\n")"
  else
    echo "no GitLab token: cloning anonymously"
  fi
fi
unset token gitlab_token
export GIT_TERMINAL_PROMPT=0
if [ -n "${GITLAB_CA:-}" ]; then
  { cat /etc/ssl/certs/ca-certificates.crt; cat "$GITLAB_CA"; echo; } > /tmp/ca-bundle.crt
  export GIT_SSL_CAINFO=/tmp/ca-bundle.crt
fi

echo "$REPOS" | while read -r url branch; do
  [ -n "$url" ] || continue
  # `bun run up` validated the config; still keep a typo from turning into a
  # git option (url starting with "-") or `rm -rf /repos/..`.
  supported=
  case "$url" in https://github.com/*/*.git) supported=1 ;; esac
  if [ -n "$GITLAB_BASE_URL" ]; then
    case "$url" in "$GITLAB_BASE_URL"/*/*.git) supported=1 ;; esac
  fi
  if [ -z "$supported" ]; then
    echo "unsupported repo url: $url (expected https://github.com/<org>/<repo>.git${GITLAB_BASE_URL:+ or $GITLAB_BASE_URL/<group>/<project>.git})" >&2
    exit 1
  fi
  name="$(basename "$url" .git)"
  case "$name" in ""|.|..|-*) echo "bad repo name in $url" >&2; exit 1 ;; esac
  case "$branch" in ""|-*|*..*) echo "bad branch for $url: $branch" >&2; exit 1 ;; esac
  dir="/repos/$name"
  if [ -d "$dir/.git" ]; then
    # A checkout of the same name from another URL (an instance moved, a
    # project renamed) is re-pointed, never fetched from its old remote.
    if [ "$(git -C "$dir" config --get remote.origin.url)" != "$url" ]; then
      echo "origin of $name changed; pointing it at $url"
      git -C "$dir" remote set-url origin "$url"
    fi
    echo "fetch $url ($branch)"
    git -C "$dir" fetch --depth 1 origin "+refs/heads/$branch:refs/remotes/origin/$branch"
    git -C "$dir" checkout -q -f -B "$branch" "origin/$branch"
    git -C "$dir" clean -q -ffdx
  else
    echo "clone $url ($branch)"
    rm -rf "$dir"
    git clone -q --depth 1 --single-branch --branch "$branch" -- "$url" "$dir"
  fi
done

if grep -lsE "x-access-token|oauth2:|github_pat_|gh[opsu]_|glpat-" /repos/*/.git/config; then
  echo "token found in the git config files above; aborting" >&2
  exit 1
fi
'
echo "Volume $VOLUME is up to date with $CONFIG_FILE"
