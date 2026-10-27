#!/bin/sh
# Creates the chart's generated secrets when they are missing:
# the OpenSandbox API key, the Postgres password, the iron-proxy CA and, with
# the GitHub token minter, an empty token Secret for it to fill, and
# copies the CA's public certificate into a ConfigMap in the sandbox
# namespace. Never replaces an existing value, so every install and upgrade
# can run it. Runs as a Helm pre-install/pre-upgrade hook (ArgoCD: PreSync).
# Kubernetes RBAC cannot limit `create` by name; this Job's Role allows
# creating Secrets in the release namespace and reading only the named ones.
set -eu

KUBECTL="${KUBECTL:-kubectl}"
NS="${RELEASE_NAMESPACE:?}"
SANDBOX_NS="${SANDBOX_NAMESPACE:?}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SCRATCH_PVC="${SCRATCH_PVC:?}"
STORAGE_CLASS="${STORAGE_CLASS:?}"
WORKSPACE_SIZE="${WORKSPACE_SIZE:?}"

missing() { ! "$KUBECTL" get secret "$1" -n "$NS" -o name >/dev/null 2>&1; }
random_hex() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

if missing devbox-opensandbox; then
  random_hex >"$WORK/api-key"
  "$KUBECTL" create secret generic devbox-opensandbox -n "$NS" --from-file="api-key=$WORK/api-key"
  echo "created secret devbox-opensandbox"
fi

if [ "${POSTGRES_ENABLED:-false}" = true ] && missing devbox-postgres; then
  random_hex >"$WORK/password"
  "$KUBECTL" create secret generic devbox-postgres -n "$NS" --from-file="password=$WORK/password"
  echo "created secret devbox-postgres"
fi

if missing devbox-iron-proxy-ca; then
  (
    umask 077
    openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 3650 \
      -subj "/CN=devbox iron-proxy CA" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -keyout "$WORK/tls.key" -out "$WORK/tls.crt" 2>/dev/null
  )
  "$KUBECTL" create secret generic devbox-iron-proxy-ca -n "$NS" \
    --from-file="tls.crt=$WORK/tls.crt" --from-file="tls.key=$WORK/tls.key"
  echo "created secret devbox-iron-proxy-ca"
fi

# The GitHub token minter may only update its Secret (RBAC cannot limit
# create by name), so it starts empty here when the installer did not write
# one. Readers treat an empty token as not yet minted.
if [ -n "${GITHUB_TOKEN_SECRET:-}" ] && missing "$GITHUB_TOKEN_SECRET"; then
  : >"$WORK/token"
  "$KUBECTL" create secret generic "$GITHUB_TOKEN_SECRET" -n "$NS" --from-file="token=$WORK/token"
  echo "created secret $GITHUB_TOKEN_SECRET (empty until the minter writes a token)"
fi

# The public certificate for sandboxes, rewritten from the Secret on every
# run, so a deleted or stale ConfigMap heals without a new CA. The private
# key never leaves the release namespace.
"$KUBECTL" get secret devbox-iron-proxy-ca -n "$NS" -o 'jsonpath={.data.tls\.crt}' | base64 -d >"$WORK/ca.crt"
"$KUBECTL" create configmap iron-proxy-ca-cert -n "$SANDBOX_NS" \
  --from-file="ca.crt=$WORK/ca.crt" --dry-run=client -o json | "$KUBECTL" apply -f -
echo "CA certificate published to $SANDBOX_NS"

# The snapshot builder's scratch volume is created here, not by the chart:
# on a WaitForFirstConsumer StorageClass a claim binds only once a pod mounts
# it, and `helm --wait` (ArgoCD and Flux too) waits for every chart PVC to
# bind before the post-install hook that would mount this one. A claim made
# by a hook is outside that wait. Its size is fixed at creation: most classes
# cannot shrink, so a changed workspace.size is refused rather than ignored.
# The requested size is kept in an annotation: the API server stores 1024Mi
# as 1Gi, so the claim's own size cannot be compared with workspace.size.
if size="$("$KUBECTL" get pvc "$SCRATCH_PVC" -n "$SANDBOX_NS" -o 'jsonpath={.metadata.annotations.devbox\.io/workspace-size}' 2>/dev/null)"; then
  if [ -z "$size" ]; then
    echo "the scratch volume $SCRATCH_PVC was not created by devbox: its size is not checked"
  elif [ "$size" != "$WORKSPACE_SIZE" ]; then
    echo "the scratch volume $SCRATCH_PVC is $size but workspace.size is $WORKSPACE_SIZE: delete it to resize (kubectl -n $SANDBOX_NS delete pvc $SCRATCH_PVC), then run bun run k8s:refresh-snapshot --target <file>" >&2
    exit 1
  fi
else
  "$KUBECTL" create -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $SCRATCH_PVC
  namespace: $SANDBOX_NS
  labels:
    app.kubernetes.io/part-of: devbox
    app.kubernetes.io/component: snapshot-builder
  annotations:
    devbox.io/workspace-size: "$WORKSPACE_SIZE"
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: $STORAGE_CLASS
  resources: { requests: { storage: $WORKSPACE_SIZE } }
EOF
  echo "created the scratch volume $SCRATCH_PVC ($WORKSPACE_SIZE)"
fi
