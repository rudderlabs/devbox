# devbox on kind

[kind](https://kind.sigs.k8s.io/) runs a Kubernetes cluster in Docker. It is
the quickest way to try devbox on Kubernetes, and what CI tests on. It is for
your machine only: the storage driver keeps volumes on the one node.

## What you need

- Docker, running.
- kind v0.24 or newer. Its default network, kindnet, enforces NetworkPolicy
  from v0.24.
- `kubectl`, Helm 3.14 or newer, Bun 1.4.4 or newer, `git` and `make`.
- A `devbox.config.json` with `repos` and `llm`
  ([configuration.md](../configuration.md#devboxconfigjson)).
- `GITHUB_TOKEN` (or `gh` logged in) and a non-empty `LLM_API_KEY`, as for
  [the installer](README.md#2-set-the-secrets).

Docker needs room for the cluster, the images and the volumes. Plan for about
8 GB of memory and 30 GB of free disk. With too little disk, etcd fails with
"no space left on device" and the cluster does not come up.

## Install

```bash
bun run k8s:kind
```

It writes its own [target file](../configuration.md#the-target-file---target),
`devbox.kind.json`, with context `kind-devbox` and profile `k8s-kind-devbox`,
and installs from it. If the file exists, its `values` and `integrations` are
kept and its `context` and `profile` are rewritten to kind's. The other
commands take it like any target file: `--target devbox.kind.json`. To install
from it, run `bun run k8s:kind` again, not `k8s:install`, which lacks kind's
settings. The next steps `linear:setup`, `linear:status` and `linear:disable`
print for it say so.

It:

1. Creates a kind cluster named `devbox` (context `kind-devbox`), unless one
   with that name exists.
2. Installs the CSI snapshot CRDs and the snapshot controller from
   [external-snapshotter](https://github.com/kubernetes-csi/external-snapshotter)
   v8.7.0.
3. Installs the [CSI hostpath driver](https://github.com/kubernetes-csi/csi-driver-host-path)
   v1.18.0 with its StorageClass `csi-hostpath-sc` and VolumeSnapshotClass
   `csi-hostpath-snapclass`. Its deploy script acts on kubectl's current
   context, so this step switches it to `kind-devbox` and switches back to
   yours when the script ends.
4. Builds the control-plane and harness images from this checkout
   (`devbox-control-plane:kind`, `devbox-harness:kind`) and loads them into the
   cluster. This takes several minutes the first time.
5. Runs `bun run k8s:install` against `kind-devbox`, with smaller defaults:
   sandboxes of 1 CPU and 2Gi, at most 5 at once, 2Gi workspaces and a 1Gi
   Postgres volume. Values under `values` in `devbox.kind.json` still win.

It takes the [installer's flags](README.md#3-install), for example
`bun run k8s:kind --skip-push-check`. Run it again after you change the code
or the config: it reuses the cluster, rebuilds and loads the images, and
upgrades the release. The image tag stays `kind`, so running pods keep the old
image until they restart:

```bash
kubectl --context kind-devbox -n devbox rollout restart deployment/devbox-control-plane
```

New sandboxes use the new harness image.

After the install:

```bash
bun run k8s:connect --target devbox.kind.json   # in another terminal; keep it running
bun run devbox create "Add a /health endpoint to your-org/your-repo"
bun run devbox logs -f <task>
```

## Without /dev/kmsg

In some VMs and sandboxed environments, Docker has no `/dev/kmsg`, and the
kubelet in the kind node fails with
`open /dev/kmsg: no such file or directory`. Create the cluster yourself with
`/dev/null` mounted in its place, then run `k8s:kind`, which reuses it:

```yaml
# kind-devbox.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: /dev/null
        containerPath: /dev/kmsg
```

```bash
kind create cluster --name devbox --config kind-devbox.yaml --wait 120s
bun run k8s:kind
```

## Clean up

```bash
bun run k8s:uninstall --target devbox.kind.json --purge   # devbox, its volumes and Secrets, and the CLI profile
kind delete cluster --name devbox
```

`kind delete cluster` alone removes everything in the cluster; the CLI
profile `k8s-kind-devbox` then stays in `~/.config/devbox/config.json`.
