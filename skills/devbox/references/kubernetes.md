# devbox on Kubernetes

devbox runs on Kubernetes from the Helm chart in `deploy/helm/devbox`: each
task in its own pod, its workspace restored from a volume snapshot of the
repos, and the same egress proxy. Overview and prerequisites:
[docs/kubernetes/README.md](../../../docs/kubernetes/README.md).

## Which path

| Path | For | Doc |
|---|---|---|
| `bun run k8s:kind` | trying it on this machine | [kind.md](../../../docs/kubernetes/kind.md) |
| `bun run k8s:install --target <file>` | a real cluster, installed from a checkout | [README.md](../../../docs/kubernetes/README.md#install-with-the-installer) |
| GitOps (Argo CD, Flux, `helm upgrade`) | clusters managed from git | [README.md](../../../docs/kubernetes/README.md#install-with-gitops) |
| Amazon EKS | storage, snapshots and NetworkPolicy on EKS | [eks.md](../../../docs/kubernetes/eks.md) |

## What the cluster needs

- Kubernetes 1.27 or newer, NetworkPolicy enforced (the installer checks it),
  and a CSI StorageClass with a VolumeSnapshotClass of the same driver.
- `kubectl`, Helm 3.14 or newer, Bun, and a `devbox.config.json` with `repos`
  and `llm`.

## The target file

`--target <file>` names the cluster: `context` (required), `profile`,
`values` (Helm values), `integrations` and `publicUrl`. There is no fallback
to the current kube context
([docs/configuration.md](../../../docs/configuration.md#the-target-file---target)).
kind's is `devbox.kind.json`, written by `k8s:kind`.

## Secrets

The installer finds secrets as `bun run up` does (environment, keychain
entries for that cluster, `gh auth token`, a hidden prompt) and writes them
only to Kubernetes Secrets in namespace `devbox`. `existingSecret` makes it
use a Secret the user manages instead
([docs/kubernetes/secrets.md](../../../docs/kubernetes/secrets.md)).
`bun run k8s:check --target <file>` checks the Secrets and the credentials in
them, without printing a value.

## Day to day

```bash
bun run k8s:connect --target <file>            # port-forward for the CLI; keep it running
bun run k8s:install --target <file>            # apply config changes, or upgrade after git pull
bun run k8s:refresh-snapshot --target <file>   # after a change to repos
```

A re-run of the installer applies config changes, rewrites the Secrets it
created, and builds a fresh snapshot when the repos changed. It prints the
`kubectl rollout restart` command when the integrations' Secret changed
([upgrade](../../../docs/kubernetes/README.md#upgrade)).

Chart values (Ingress, external database, sandbox pods, extra environment,
Docker in sandboxes): [customizing.md](../../../docs/kubernetes/customizing.md).

## Uninstall

`bun run k8s:uninstall --target <file>` removes the release;
`--purge` also deletes the volumes, Secrets and the CLI profile. Ask first.
On kind, `kind delete cluster --name devbox` removes everything else
([docs/kubernetes/README.md](../../../docs/kubernetes/README.md#uninstall)).
