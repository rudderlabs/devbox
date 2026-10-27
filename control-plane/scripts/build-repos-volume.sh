#!/usr/bin/env bash
# Builds/refreshes the local base repos volume (default `devbox-repos`) from
# the `repos` of devbox.config.json. `bun run up` runs it; usage:
#   build-repos-volume.sh [path/to/devbox.config.json] <<< "$GITHUB_TOKEN"
# The control plane (SANDBOX_RUNTIME=docker) copies this volume into a fresh
# per-task volume; sandboxes never mount it.
#
# Clone shape: --depth 1 --single-branch, flat /<repo-name> layout, and
# incremental: existing clones are fetched and hard reset instead of wiped and
# re-cloned. Repos removed from the config are not deleted from the volume.
#
# Token handling: the GitHub token is the first line of stdin; an empty line
# means anonymous clones (public repos only). It reaches the container over
# stdin (never argv, env or `docker inspect`), is applied via GIT_CONFIG_* env
# (never argv or .git/config), and the run fails if any .git/config ends up
# holding it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VOLUME="${REPOS_BASE_VOLUME:-devbox-repos}"
CONFIG_FILE="${1:-$ROOT/../devbox.config.json}"
GIT_IMAGE="alpine/git:v2.49.1"

TOKEN=""
IFS= read -r TOKEN || true
TOKEN="${TOKEN%$'\r'}"

# "<url> <branch>" per line; branch defaults to main.
REPOS="$(bun -e '
  const { repos } = await Bun.file(process.argv[1]).json();
  for (const r of repos) console.log(r.url, r.branch ?? "main");
' "$CONFIG_FILE")"

printf '%s\n' "$TOKEN" | docker run -i --rm \
  -e REPOS="$REPOS" \
  -v "$VOLUME:/repos" \
  --entrypoint sh \
  "$GIT_IMAGE" -c '
set -eu
token=""
read -r token || true
if [ -n "$token" ]; then
  basic="$(printf "x-access-token:%s" "$token" | base64 | tr -d "\n")"
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
  export GIT_CONFIG_VALUE_0="Authorization: Basic $basic"
else
  echo "no GitHub token: cloning anonymously"
fi
unset token
export GIT_TERMINAL_PROMPT=0

echo "$REPOS" | while read -r url branch; do
  [ -n "$url" ] || continue
  # `bun run up` validated the config; still keep a typo from turning into a
  # git option (url starting with "-") or `rm -rf /repos/..`.
  case "$url" in
    https://github.com/*/*.git) ;;
    *) echo "unsupported repo url: $url (expected https://github.com/<org>/<repo>.git)" >&2; exit 1 ;;
  esac
  name="$(basename "$url" .git)"
  case "$name" in ""|.|..|-*) echo "bad repo name in $url" >&2; exit 1 ;; esac
  case "$branch" in ""|-*|*..*) echo "bad branch for $url: $branch" >&2; exit 1 ;; esac
  dir="/repos/$name"
  if [ -d "$dir/.git" ]; then
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

if grep -lsE "x-access-token|github_pat_|gh[opsu]_" /repos/*/.git/config; then
  echo "token found in the git config files above; aborting" >&2
  exit 1
fi
'
echo "Volume $VOLUME is up to date with $CONFIG_FILE"
