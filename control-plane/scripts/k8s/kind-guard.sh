# Sourced by e2e.sh before it touches a cluster. kind_guard refuses unless the
# kind-devbox context reaches the API server of the local kind node, then
# points KUBECONFIG at a copy holding only that context. The `bun run k8s:*`
# steps (refresh, purge) act on the target file they are given; the guard
# still keeps a wrong file from reaching another cluster through this
# kubeconfig.

KIND_GUARD_CONTEXT=kind-devbox
KIND_GUARD_NODE=devbox-control-plane

kind_guard() {
  local server port only
  server="$(kubectl config view --minify --context "$KIND_GUARD_CONTEXT" -o 'jsonpath={.clusters[0].cluster.server}')"
  if ! port="$(docker port "$KIND_GUARD_NODE" 6443/tcp 2>/dev/null | head -n 1)" || [ -z "$port" ]; then
    echo "FAIL no kind node $KIND_GUARD_NODE: run \`bun run k8s:kind\` first" >&2
    return 1
  fi
  if [ "$server" != "https://$port" ]; then
    echo "FAIL context $KIND_GUARD_CONTEXT points at $server, not the kind node's API server https://$port" >&2
    return 1
  fi
  only="$(mktemp)"
  # Expanded now: $only is gone by the time the shell exits. The caller's EXIT
  # trap, if any, is replaced; e2e.sh sets none.
  trap "rm -f $(printf '%q' "$only")" EXIT
  kubectl config view --minify --flatten --context "$KIND_GUARD_CONTEXT" >"$only"
  export KUBECONFIG="$only"
}
