#!/usr/bin/env bash
# End-to-end checks on a kind install. Expects `bun run k8s:kind`
# to have run and `bun run k8s:connect --target devbox.kind.json` to be
# running; the bun run k8s:* steps use devbox.kind.json, the target file
# k8s:kind wrote. Usage:
#   e2e.sh <owner>/<repo>    the only configured repo
# GITHUB_TOKEN must be the token the install used (to prove it is not in the
# sandbox). No agent run: there is no LLM key.
set -euo pipefail

REPO="${1:?usage: e2e.sh <owner>/<repo>}"
NAME="${REPO#*/}"
K=(kubectl --context kind-devbox)
SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." >/dev/null 2>&1 && pwd)"
SNS=devbox-sandboxes
# Same labels as control-plane/src/clients/repoSnapshots.ts.
SNAPSHOTS=app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# 0. Only the local kind cluster, for the bun run k8s:* steps too.
source "$SCRIPT_DIR/kind-guard.sh"
kind_guard

# 1. Everything is ready and a snapshot exists.
"${K[@]}" -n devbox wait --for=condition=Available deployment --all --timeout=5m >/dev/null
ready="$("${K[@]}" -n "$SNS" get volumesnapshot -l "$SNAPSHOTS" \
  -o 'jsonpath={range .items[?(@.status.readyToUse==true)]}{.metadata.name}{"\n"}{end}')"
[ -n "$ready" ] || fail "no ready repo snapshot"
pass "deployments available; snapshots: $(echo "$ready" | tr '\n' ' ')"

# 2. A task gets a sandbox whose workspace is restored from the snapshot.
# `create --json` prints the task itself, so its key is the top-level `key`.
task="$(bun run --silent devbox create "e2e: list the files in the repo" --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).key)')"
pass "created task $task"
pod=""
for _ in $(seq 1 60); do
  pod="$("${K[@]}" -n "$SNS" get pods -l app.kubernetes.io/component=sandbox \
    --field-selector=status.phase=Running -o 'jsonpath={.items[0].metadata.name}' 2>/dev/null || true)"
  [ -n "$pod" ] && break
  sleep 5
done
[ -n "$pod" ] || fail "no running sandbox pod after 5 minutes"
pvc="$("${K[@]}" -n "$SNS" get pod "$pod" -o 'jsonpath={.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}')"
source_kind="$("${K[@]}" -n "$SNS" get pvc "$pvc" -o 'jsonpath={.spec.dataSource.kind}/{.spec.dataSource.name}')"
case "$source_kind" in VolumeSnapshot/repos-*) pass "PVC $pvc restored from $source_kind" ;; *) fail "PVC $pvc source is $source_kind" ;; esac

in_sandbox() { "${K[@]}" -n "$SNS" exec "$pod" -c sandbox -- bash -c "$1"; }
in_sandbox "test -d /workspace/$NAME/.git" && pass "/workspace/$NAME is a git checkout" || fail "/workspace/$NAME missing"

# The pod is Running before the harness entrypoint's bootstrap has added
# iron-proxy's CA to the system bundle, so wait for it before the TLS checks.
ca_line="$(in_sandbox 'sed -n 2p /run/iron-proxy/ca.crt')"
ca_trusted() { in_sandbox "grep -qF '$ca_line' /etc/ssl/certs/ca-certificates.crt"; }
for _ in $(seq 1 30); do ca_trusted && break; sleep 2; done
ca_trusted && pass "iron-proxy CA in the system bundle" || fail "iron-proxy CA not in the system bundle after 60s"

# Git works in the restored repo as the harness runs it (root, after bootstrap):
# the snapshot builder clones as another uid, which git refuses by default.
# bootstrap may still be running, so allow it a few seconds.
git_works() { in_sandbox "git -C /workspace/$NAME status --porcelain=v1 >/dev/null 2>&1"; }
for _ in $(seq 1 10); do git_works && break; sleep 2; done
git_works && pass "git status works in /workspace/$NAME" || fail "git status failed in /workspace/$NAME"

# 3. Egress: allowlisted GitHub reads work through iron-proxy; nothing else does.
# curl sends the dummy bearer token the sandbox holds; iron-proxy swaps it for the real one.
in_sandbox "curl -fsS -o /dev/null -H 'Authorization: Bearer proxy-github-dummy-token' https://api.github.com/repos/$REPO" && pass "allowlisted GitHub read works" || fail "allowlisted GitHub read failed"
in_sandbox "git ls-remote https://github.com/$REPO.git HEAD >/dev/null" && pass "git ls-remote through iron-proxy works" || fail "git ls-remote failed"

# A negative check must prove it ran: the probe prints its exit code inside the
# sandbox, so a failed exec or an exited pod is a FAIL, not a pass.
blocked() { # blocked <description> <probe command>
  local out rc
  out="$(in_sandbox "$2 >/dev/null 2>&1; echo rc=\$?" 2>/dev/null || true)"
  rc="$(grep -o '^rc=[0-9]*$' <<<"$out" | tail -1 || true)"
  [ -n "$rc" ] || fail "could not run the check in the sandbox: $1"
  [ "$rc" != "rc=0" ] && pass "$1" || fail "$1: the probe succeeded"
}
blocked "non-allowlisted host refused" "curl -fsS -m 10 -o /dev/null https://example.com"
blocked "raw IP blocked" "curl -sS -m 5 -o /dev/null http://1.1.1.1"
k8s_ip="$("${K[@]}" -n default get service kubernetes -o 'jsonpath={.spec.clusterIP}')"
blocked "Kubernetes API blocked" "timeout 5 bash -c '</dev/tcp/$k8s_ip/443'"
pg="$("${K[@]}" -n devbox get service devbox-postgres -o 'jsonpath={.spec.clusterIP}')"
blocked "Postgres blocked" "timeout 5 bash -c '</dev/tcp/$pg/5432'"
blocked "cloud metadata blocked" "timeout 5 bash -c '</dev/tcp/169.254.169.254/80'"
in_sandbox "test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token" && pass "no ServiceAccount token" || fail "ServiceAccount token mounted"
# Every process's environment plus the cloned repo's git config.
out="$(in_sandbox 'cat /proc/[0-9]*/environ 2>/dev/null | tr "\0" "\n"; cat /workspace/*/.git/config 2>/dev/null; echo END')"
grep -q '^END$' <<<"$out" || fail "could not read the sandbox environment"
# Kubernetes always injects API discovery variables under KUBERNETES_ even
# when enableServiceLinks is false. They do not come from control-plane
# forwarding; every other Service-link-shaped variable is unexpected.
out_without_kubernetes_api="$(sed '/^KUBERNETES_/d' <<<"$out")"
service_links="$(
  sed -n 's/=.*//p' <<<"$out_without_kubernetes_api" |
    sort -u |
    (cd "$REPO_ROOT" && bun -e 'import { isServiceLinkEnvName } from "./control-plane/src/forwardedEnv.ts";
const names = (await Bun.stdin.text()).split(/\n/).filter(
  (name) => name && isServiceLinkEnvName(name),
);
process.stdout.write(names.join("\n"));')
)"
[ -z "$service_links" ] || fail "unexpected Kubernetes Service-link variables reached the sandbox: $(tr '\n' ' ' <<<"$service_links")"
if grep -qE '^[A-Z0-9_]+_PORT=tcp://' <<<"$out_without_kubernetes_api"; then fail "an unexpected Kubernetes tcp:// Service link reached the sandbox"; fi
pass "no unexpected Kubernetes Service-link variables in sandbox process environments"
if grep -qF "$GITHUB_TOKEN" <<<"$out"; then fail "the real GitHub token is in the sandbox"; fi
pass "no real token in the sandbox env or git config"

# 4. Refresh and purge.
before="$(echo "$ready" | sort | tail -1)"
bun run k8s:refresh-snapshot --target devbox.kind.json
after="$("${K[@]}" -n "$SNS" get volumesnapshot -l "$SNAPSHOTS" \
  --sort-by=.metadata.creationTimestamp -o 'jsonpath={.items[-1:].metadata.name}')"
[ "$after" != "$before" ] && pass "refresh made $after" || fail "refresh made no newer snapshot"
bun run k8s:uninstall --target devbox.kind.json --purge --yes
# Uninstall deletes the namespaces without waiting, so wait for them.
for ns in "$SNS" devbox; do
  "${K[@]}" wait --for=delete "namespace/$ns" --timeout=3m 2>/dev/null || true
  # A missing namespace is the expected NotFound; any other error fails here.
  if err="$("${K[@]}" get namespace "$ns" 2>&1 >/dev/null)"; then fail "namespace $ns left"; fi
  case "$err" in *NotFound*) pass "namespace $ns gone" ;; *) fail "could not check namespace $ns: $err" ;; esac
done
[ -z "$("${K[@]}" get volumesnapshotcontents -o name)" ] && pass "no snapshot contents left" || fail "snapshot contents left"
left_pv="$("${K[@]}" get pv -o 'jsonpath={range .items[*]}{.spec.claimRef.namespace}{"\n"}{end}' | grep -xE "devbox|$SNS" || true)"
[ -z "$left_pv" ] && pass "no PersistentVolume left" || fail "PersistentVolume left for a purged namespace"
[ -z "$(helm --kube-context kind-devbox list -A -q)" ] && pass "no Helm release left" || fail "Helm release left"
echo "all end-to-end checks passed"
