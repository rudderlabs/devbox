# devbox on Kubernetes

devbox runs on Kubernetes from one Helm chart, `deploy/helm/devbox`. Each task
gets a sandbox pod, and its workspace is a volume restored from a snapshot of
your repos. The sandboxes reach GitHub and the LLM endpoint only through
iron-proxy, as in the local stack.

There are two ways to install it:

- **The installer**, `bun run k8s:install`. It reads `devbox.config.json` and
  a target file that names the cluster, checks the cluster, creates the
  Secrets from your environment, the system keychain or a prompt, runs Helm
  and logs the CLI in. Start here.
- **GitOps**: the chart with your own values and Secrets, applied by Helm,
  ArgoCD or Flux. The [GitOps section](#install-with-gitops) lists every step
  the installer would otherwise do.

To try it on your machine, use kind: [kind.md](kind.md).

Other pages:

- Amazon EKS: [eks.md](eks.md).
- [secrets.md](secrets.md): the Secret names and keys, bring-your-own Secrets,
  rotation.
- [customizing.md](customizing.md): an external database, an Ingress, sandbox
  pod settings, integrations, a production example.
- [GitHub](../github.md): connecting devbox to GitHub as an App.
- [Linear](../linear.md): connecting devbox to Linear.
- [harness-image.md](harness-image.md): adding tools to the sandbox image.
- [The chart's values reference](../../deploy/helm/devbox/README.md).
- [The architecture on Kubernetes](../architecture.md#on-kubernetes).

## Prerequisites

The cluster needs:

| Requirement | How to check |
|---|---|
| Kubernetes 1.27 or newer | `kubectl version` |
| A StorageClass backed by a CSI driver | `kubectl get storageclass`: the `PROVISIONER` column names the driver, for example `ebs.csi.aws.com` |
| Volume snapshots: the snapshot CRDs, the snapshot controller and a VolumeSnapshotClass of the same CSI driver | `kubectl get volumesnapshotclass`: the `DRIVER` column must match the StorageClass's provisioner. "the server doesn't have a resource type" means the CRDs are missing. |
| A CNI that enforces NetworkPolicy | See below. |
| Nodes that fit a sandbox (2 CPU and 8Gi by default), with images for their architecture | `kubectl get nodes -L kubernetes.io/arch -o custom-columns=NAME:.metadata.name,CPU:.status.allocatable.cpu,MEMORY:.status.allocatable.memory` |

**NetworkPolicy.** The sandbox egress lockdown is a set of NetworkPolicies. A
cluster whose CNI does not enforce them accepts them and ignores them, so the
lockdown silently does not happen. Which CNI enforces them depends on the
cluster; for EKS, see [eks.md](eks.md#networkpolicy). On the first install the installer checks it: it
starts two test pods (`registry.k8s.io/e2e-test-images/agnhost:2.52`) in a
temporary namespace `devbox-netpol-check-<timestamp>`, applies a policy that
denies all ingress to one of them, and checks the other can no longer reach
it.

**IPv6.** The installer picks iron-proxy's address from an IPv4 Service range.
On an IPv6-only cluster, set `ironProxy.clusterIP` yourself under `values` in
the target file ([step 3 of GitOps](#iron-proxy-address) shows how to choose one).

[eks.md](eks.md) shows how to meet each requirement on Amazon EKS. For a local
cluster, [kind.md](kind.md) sets everything up. On another cluster, your
provider's docs cover the CSI driver, volume snapshots and NetworkPolicy.

The cluster must also be able to pull from Docker Hub (devbox's
`rudderlabs/devbox-*` images, `opensandbox/*`, `ironsh/iron-proxy`, `postgres`)
and `registry.k8s.io` (the NetworkPolicy check). If you mirror the devbox images
into a private registry, set `images.controlPlanePullSecrets` (Secrets in
`devbox` and `devbox-sandboxes`) and `sandbox.imagePullSecrets` (Secrets in
`devbox-sandboxes`).

On your machine you need:

- `kubectl`, with a context for the cluster.
- Helm 3.14 or newer. Helm 4 is supported.
- Bun 1.4.4 or newer.
- A clone of this repo. The installer and the CLI run from it.

## Install with the installer

### 1. Configure

Start from the example, as for the local stack:

```bash
cp devbox.config.example.json devbox.config.json
```

`devbox.config.json` keeps `repos` and the same full `llm` block used by the
local stack ([configuration.md](../configuration.md#llm)): provider, endpoint,
global model/effort and optional per-stage model/effort overrides. The installer
copies those keys into the chart rather than requiring deployed variables.

Where it runs goes in a target file. Create `devbox.k8s.json` (gitignored):

```json
{ "context": "my-eks",
  "profile": "k8s-my-eks",
  "values": {
    "storage": { "storageClass": "gp3", "volumeSnapshotClass": "ebs-snapclass" },
    "sandbox": { "maxConcurrent": 5, "cpu": "2", "memory": "8Gi" } } }
```

Every `bun run k8s:*` command takes it as `--target devbox.k8s.json`. There is
no default and no fallback to kubectl's current context, so a command never
acts on a cluster you did not name. The file has five keys:

| Key | Meaning |
|---|---|
| `context` | Required. The kube context to install into. The installer names it in every `kubectl` and `helm` call. |
| `profile` | The CLI profile to write. Default: `k8s-<context>`, made lower-case with other characters replaced by `-` (an EKS ARN context becomes `k8s-<cluster name>`). |
| `values` | Chart values, passed to Helm as they are. See the [values reference](../../deploy/helm/devbox/README.md). `storage.storageClass` and `storage.volumeSnapshotClass` are required. Set concurrency and per-sandbox limits under `values.sandbox`; Kubernetes ignores the Compose-only `sandbox` block in `devbox.config.json`. `repos`, `llm` and `integrations` are refused: the installer copies repos and the full LLM model/effort/stage configuration from `devbox.config.json`, and integrations from the target's `integrations` key. |
| `integrations` | Linear, Slack and the GitHub App: each one's `enabled` switch and settings ([customizing.md](customizing.md#integrations)). `bun run linear:setup` writes the Linear part ([Linear](../linear.md)), `bun run github:setup` the GitHub App's ([GitHub](../github.md)). |
| `publicUrl` | The public HTTPS URL webhooks reach, shared by Linear and GitHub. Read only by the CLI. |

Any other key is an error. The installer fills these chart values itself:
`repos` and `llm` from `devbox.config.json`, `integrations` from the target
file, `ironProxy.clusterIP` (see [below](#iron-proxy-address)),
`controlPlane.publicBaseUrl`, and `git.name` and `git.email` from the GitHub
token's user when the installer looked the token up itself. A value you set
under `values` always wins.

### 2. Set the secrets

The installer looks the secrets up as `bun run up` does: your environment,
then the system keychain entries for this cluster
(`k8s:<context>/devbox/<NAME>`), then a hidden prompt, after which it offers
to save what you typed ([configuration.md](../configuration.md#secrets)):

| Variable | Secret |
|---|---|
| `GITHUB_TOKEN` | The GitHub token. Falls back to `gh auth token` before the prompt. Not used with the GitHub App. |
| `GITHUB_APP_PRIVATE_KEY_FILE` or `GITHUB_APP_PRIVATE_KEY` | The GitHub App's private key (a path, or the PEM), for devbox tokens. Never prompted for; falls back to the keychain entry `GITHUB_APP_PRIVATE_KEY`. |
| `LLM_API_KEY` | The LLM API key. It must not be empty on Kubernetes. |
| `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `SLACK_BOT_TOKEN`, `GITHUB_WEBHOOK_SECRET` | Only for an integration enabled in the target file ([customizing.md](customizing.md#integrations)); `GITHUB_WEBHOOK_SECRET` for the GitHub App. |

It writes them only to Kubernetes Secrets in the `devbox` namespace, never to
a file or a Helm value. Without a terminal, a missing secret stops the install.
To manage a Secret yourself instead, name it with `existingSecret`
([secrets.md](secrets.md)): the installer then asks for none of its secrets
and never reads it.

### 3. Install

```bash
bun run k8s:install --target devbox.k8s.json
```

It prints seven steps:

1. **Checks.** `kubectl` and `helm` work, Helm is 3.14 or newer, the cluster
   answers and runs Kubernetes 1.27 or newer, and the chart values name a
   StorageClass and a VolumeSnapshotClass and do not blank out either image.
2. **Secrets.** Looks up the values for the Secrets it creates. Checks that
   the token can see, push to and open pull requests in each repo, sends the
   LLM endpoint a one-message request and, with Linear enabled, checks the
   Linear client secret. Every request is listed in
   [what preflight checks](../configuration.md#what-preflight-checks). In a
   terminal, a rejected value that was saved or typed is asked for again
   ([configuration.md](../configuration.md#rejected-values)); otherwise a bad
   value stops the install here, before any probe of the cluster.
   Secrets you named with `existingSecret` are not read or checked: use
   [`k8s:check`](#check-the-secrets).
3. **Cluster.** The StorageClass and VolumeSnapshotClass exist and use the same
   driver, NetworkPolicy is enforced (first install only), a node can fit a
   sandbox, and no other OpenSandbox controller or CRDs are installed.
4. **Namespaces and Secrets.** Creates the namespaces `devbox` and
   `devbox-sandboxes` and the Secrets `devbox-github`, `devbox-llm` and, with
   an integration enabled, `devbox-integrations`. With the GitHub App's devbox
   tokens it also writes the App's key to `devbox-github-app`
   ([secrets.md](secrets.md#the-github-app-key-and-the-minter)).
5. **Chart.** `helm upgrade --install devbox deploy/helm/devbox -n devbox --wait`.
   The first install also builds the first repo snapshot, which can take
   minutes.
6. **Repo snapshot.** Checks a ready snapshot exists. On a re-run, builds a new
   one if the repos changed.
7. **CLI login.** Creates an API token in the control plane and writes the CLI
   profile to `~/.config/devbox/config.json` (or
   `$XDG_CONFIG_HOME/devbox/config.json`), as the current profile.

With Linear enabled, it ends with
`Check Linear with: bun run linear:status --target <file>`.

Flags:

| Flag | Effect |
|---|---|
| `--render <path>` | Writes the chart values to `<path>` and stops. Nothing is installed. The file holds no secrets. See [GitOps](#install-with-gitops). |
| `--skip-push-check` | Skips the checks that the token can push and open pull requests (requests 3 and 4 in [what preflight checks](../configuration.md#what-preflight-checks)). With a read-only token, tasks then fail when they push or open their pull request. |
| `--skip-llm-check` | Skips the request to the LLM endpoint. |
| `--skip-linear-check` | Skips the Linear client-secret check. |
| `--skip-netpol-check` | Skips the NetworkPolicy check. Sandbox egress is not locked down if the CNI does not enforce NetworkPolicy. |
| `--netpol-check` | Runs the NetworkPolicy check on a re-run too. By default it runs only on the first install. |
| `--timeout <duration>` | Helm's `--timeout`. Default `15m`. Raise it if the first snapshot of big repos takes longer. |
| `--no-keychain` | Never reads or writes the system keychain. |

### 4. Connect and run a task

The control plane has no public address by default. Open a port-forward and
leave it running in another terminal:

```bash
bun run k8s:connect --target devbox.k8s.json
```

It forwards `127.0.0.1:<port>` to the control plane's Service. The port is the
one in the CLI profile, the first free port from 13000 at install time, and it
stays the same across re-installs. Then:

```bash
bun run devbox create "Add a /health endpoint to your-org/your-repo"
bun run devbox logs -f <task>
```

With an `api` Ingress ([customizing.md](customizing.md#ingress)), the profile
uses its URL and `k8s:connect` is not needed. With only a `webhooks` Ingress,
the CLI still uses `k8s:connect`.

To use several installs, switch profiles with `bun run devbox profile use
<name>`, or pass `--profile <name>` ([configuration.md](../configuration.md#cli-profiles)).

## Install with GitOps

The chart installs with plain Helm, ArgoCD or Flux. You do in order what the
installer would do.

### 1. Create the namespaces

```bash
kubectl create namespace devbox
kubectl create namespace devbox-sandboxes
```

The names are fixed.

### 2. Create the Secrets

The chart reads the GitHub token and the LLM key from Secrets in `devbox`:

```bash
kubectl -n devbox create secret generic devbox-github --from-literal=token="$GITHUB_TOKEN"
kubectl -n devbox create secret generic devbox-llm --from-literal=api-key="$LLM_API_KEY"
```

Use `--from-literal`, not `echo … | … --from-file`: a trailing newline would
reach GitHub and the LLM endpoint as part of the value. For other names,
integrations and tools such as External Secrets, see [secrets.md](secrets.md).
The integration secrets go in `devbox-integrations`, under their env names:

```bash
kubectl -n devbox create secret generic devbox-integrations \
  --from-literal=LINEAR_CLIENT_SECRET="$LINEAR_CLIENT_SECRET" \
  --from-literal=LINEAR_WEBHOOK_SECRET="$LINEAR_WEBHOOK_SECRET"
```

The chart creates its own Secrets (the OpenSandbox API key, the Postgres
password, the iron-proxy CA) in a pre-install hook.

<a id="iron-proxy-address"></a>

### 3. Choose iron-proxy's address

Sandboxes use iron-proxy as their DNS server, so its Service has a fixed
address, `ironProxy.clusterIP`, in the cluster's Service range. The installer
picks the cluster DNS Service's address plus 10. To do the same:

```bash
kubectl -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}'   # for example 10.96.0.10
# add 10 to the last number: 10.96.0.20
kubectl get svc -A | grep -w 10.96.0.20                                   # must print nothing
```

If the address is taken, add 1 and check again. Keep the address for the life
of the install: sandboxes and iron-proxy's config name it.

### 4. Write the values and apply the chart

A minimal `values.yaml`:

```yaml
storage: { storageClass: <storage-class>, volumeSnapshotClass: <snapshot-class> }
sandbox: { maxConcurrent: 5, cpu: "2", memory: 8Gi }
repos:
  - { url: https://github.com/your-org/your-repo.git, branch: main }
llm:
  provider: openai
  baseUrl: https://api.openai.com/v1
  model: gpt-5.6-sol
  # Optional global effort; it replaces all stage effort defaults.
  reasoningEffort: high
  # Optional per-stage model/effort overrides, using the same keys as devbox.config.json.
  stages:
    orientation: { reasoningEffort: minimal }
    review: { model: gpt-5.6-sol-pro, reasoningEffort: xhigh }
ironProxy: { clusterIP: 10.96.0.20 }
# The agent's commit identity. Default: devbox <devbox@users.noreply.github.com>.
git: { name: Your Name, email: 12345+you@users.noreply.github.com }
# Optional: integrations (customizing.md#integrations) and the trust lists.
# integrations:
#   linear: { enabled: true, clientId: <client-id> }
# github: { trustedOrgs: [your-org] }
```

The GitOps `llm` block uses the same chart keys as the `llm` block read by
Compose, `k8s:install` and `k8s:kind`. Model and effort resolve independently,
stage then global then code default; omit `reasoningEffort` and/or `stages` when
you do not need those overrides.

`bun run k8s:install --target devbox.k8s.json --render values.yaml` writes this
file from `devbox.config.json` and the target file, with an address picked as
above. It needs access to the cluster for that, unless
`values.ironProxy.clusterIP` is set in the target file.

Apply it:

```bash
helm upgrade --install devbox deploy/helm/devbox -n devbox -f values.yaml --wait --timeout 15m
```

The chart has two hooks. A bootstrap Job (`pre-install`, `pre-upgrade`)
creates the generated Secrets when they are missing and the snapshot
builder's scratch volume, so a `WaitForFirstConsumer` StorageClass works: the
claim binds when the builder first mounts it. A snapshot builder Job
(`post-install`) builds the first repo snapshot, and the install waits for it,
so give it time: 15 minutes, more for big repos.

- **ArgoCD** maps the hooks to `PreSync` and `PostSync` and runs them on every
  sync. Raise the sync timeout of your setup so the first snapshot can finish.
- **Flux**: a `HelmRelease` runs the hooks as Helm does. Set its
  `spec.timeout` to `15m` or more.

### 5. Create an API token

```bash
kubectl -n devbox exec deploy/devbox-control-plane -- bun run api-token create <name>
```

It prints the token (`dbx_…`). Treat it like a password.

### 6. Add a CLI profile and connect

```bash
bun run devbox profile add my-cluster --url http://localhost:3000 --token <token> --use
kubectl -n devbox port-forward svc/devbox-control-plane 3000:3000
```

With an `api` Ingress, use its URL instead and skip the port-forward.

Run `bun run k8s:check` ([below](#check-the-secrets)) to check the Secrets
before or after a sync.

### Changing sandbox values

Set `sandbox.maxConcurrent`, `sandbox.cpu` and `sandbox.memory` in the GitOps
values file, or under `values.sandbox` in the installer or kind target file.
See [Sandbox configuration](../configuration.md#sandbox) for formats, defaults
and concurrency behavior.

The OpenSandbox server reads the sandbox pod template once, at start. After
you change any `sandbox.*` value, restart it:

```bash
kubectl -n devbox rollout restart deployment/opensandbox-server
```

The installer does this itself when the template changes. `ironProxy.clusterIP`
cannot change in place: a Service's address is fixed, so keep it for the life
of the install.

## Check the Secrets

```bash
bun run k8s:check --target devbox.k8s.json [--skip-push-check]
```

Optional. It is the only command that reads Secrets, so it needs read access
to Secrets in `devbox`; without it, it prints `k8s:check needs read access to
Secrets in namespace devbox: skip it, or run it with an account that has it`
and exits 1. Run it before or after `k8s:install`, after a GitOps sync, or
after you change a Secret of your own. For every Secret the chart will use
(the installer's name or your `existingSecret`; the database one only with
`postgresql.enabled: false`), it checks:

- that the Secret exists, with its keys present and not empty, and the GitHub
  token and LLM key without a trailing newline. An installer-owned Secret that
  does not exist yet is `not created yet (k8s:install creates it)`, not a
  failure;
- the GitHub token against the repos (`--skip-push-check` skips the push and
  pull request checks; with the GitHub App's devbox tokens, a token minted
  from the key in `devbox-github-app` or your own key Secret, and that the
  installation covers every repo), the LLM key against `llm`, and, with Linear enabled,
  the Linear client secret with `integrations.linear.clientId`
  ([what preflight checks](../configuration.md#what-preflight-checks));
- each enabled integration's keys in the integrations Secret.

It reads which integrations are enabled from the target file's `integrations`
block, not from the cluster, and checks nothing for an integration that is not
enabled there. With GitOps, keep that block in step with the chart values: an
integration enabled only in the chart values is not checked.

It prints one line per check, `ok`, `skip` or `FAIL`, and never a value. It
exits 0 when everything passed, 1 otherwise. It never saves, removes or
prompts.

## Upgrade

With the installer, update your clone and run it again:

```bash
git pull
bun run k8s:install --target devbox.k8s.json
```

A re-run applies config changes, rewrites the Secrets it created from the
secrets it looks up, keeps iron-proxy's address and the CLI profile's port,
restarts the OpenSandbox server if the sandbox template changed, and builds a
fresh snapshot if the repos changed. It does not restart the control plane for
a changed `devbox-integrations`: it prints the `kubectl rollout restart`
command instead ([secrets.md](secrets.md#rotation)).

With GitOps, apply the new chart with the same values. Keep
`ironProxy.clusterIP`. Restart the OpenSandbox server after a change to sandbox
values (see above). After a change to `repos`, build a fresh snapshot:

```bash
bun run k8s:refresh-snapshot --target devbox.k8s.json
# or, without the installer:
kubectl -n devbox-sandboxes create job devbox-snapshot-builder-manual-$(date +%s) --from=cronjob/devbox-snapshot-builder
```

The snapshot builder also runs on a schedule (`snapshotBuilder.schedule`,
every 6 hours by default).

### Database migrations

A new control plane pod migrates the database when it starts, while the old
pods keep serving. The migrations hold short locks on the `tasks` and `inbox`
tables and wait at most 5 seconds for each. If a lock times out, the new pod
fails, restarts and tries again. Postgres may instead break a deadlock between
the migration and a request: then either the pod restarts, or the request
fails with a 500 and, for a webhook, the platform retries it.

Task keys are unique regardless of case. The migration that enforces this
fails with `could not create unique index "tasks_key_lower_uniq"` and
`Key (lower(key))=(…) is duplicated` only if tasks were inserted by hand with
keys that differ only in case: devbox upper-cases Linear keys, and
`API_TASK_KEY_PREFIX` must match `^[A-Z][A-Z0-9-]*-$`. To list them:

```sql
SELECT lower(key) AS key, array_agg(id) AS task_ids
  FROM tasks GROUP BY lower(key) HAVING count(*) > 1;
```

Rename all but one key in each group; the pod migrates on its next start.

While old and new pods overlap, and after a rollback to a release without the
`inbox_source_kind_external_uniq` index, an old pod can answer a webhook that
races its own redelivery with a 500: `duplicate key value violates unique
constraint "inbox_source_kind_external_uniq"`. The other request stored the
round and the platform retries, so nothing is lost. After such a rollback,
dropping the index stops the errors:

```sql
DROP INDEX inbox_source_kind_external_uniq;
```

## Uninstall

`k8s:uninstall` acts on the cluster named in the `--target` file, and on
nothing else.

```bash
bun run k8s:uninstall --target devbox.k8s.json
```

This runs `helm uninstall devbox -n devbox --wait` and removes the CLI
profile. It keeps the namespaces `devbox` and `devbox-sandboxes`, the volumes
(task workspaces, repo snapshots, Postgres) and the Secrets, so a new install
finds its data again.

```bash
bun run k8s:uninstall --target devbox.k8s.json --purge
bun run k8s:uninstall --target devbox.k8s.json --purge --yes   # without a terminal, as in CI
```

`--purge` also deletes:

- the namespace `devbox-sandboxes`, with every task volume and repo snapshot;
- the Secrets the chart generated: `devbox-opensandbox`, `devbox-postgres`,
  `devbox-iron-proxy-ca`;
- the Secrets the installer created, those with the label
  `app.kubernetes.io/managed-by=devbox-installer`;
- the Postgres volume;
- the namespace `devbox`, if no Secret is left in it.

It lists all of this and asks `[y/N]` before it runs anything, the Helm
release included. Enter or Ctrl-D answers no, and nothing is removed. Without
a terminal it refuses unless you pass `--yes`, which also skips the question
in a terminal.

It never deletes another Secret. Secrets you named with `existingSecret` stay,
and then the `devbox` namespace stays too; the command lists what is left.

The OpenSandbox CRDs stay installed in both cases. To remove them:

```bash
kubectl delete crd batchsandboxes.sandbox.opensandbox.io pools.sandbox.opensandbox.io sandboxsnapshots.sandbox.opensandbox.io
```

## The bundled Postgres

`postgresql.enabled: true`, the default, runs a minimal Postgres (one replica,
`postgres:18`, a 10Gi volume) for trying devbox. It has no backups, no high
availability and no automated upgrades. In production, use your own database:
`postgresql.enabled: false` and `database.existingSecret`
([customizing.md](customizing.md#external-database)).

## Webhooks, GitHub and Linear

Linear, Slack and the GitHub App each have an `enabled` switch and settings
in the target file's `integrations` block, or in the chart values with GitOps
([customizing.md](customizing.md#integrations)). Their secrets go in
`devbox-integrations` ([secrets.md](secrets.md)).

For the GitHub App, run `bun run github:setup --target devbox.k8s.json`
**before** `k8s:install`: it registers the App, waits for you to install it,
and writes its settings and the public URL to the target file. Then
`k8s:install` (or `k8s:kind` on kind) applies them, and
`bun run github:status --target devbox.k8s.json` checks them
([GitHub](../github.md)). The chart runs a token minter for it; the installer
needs the App's private key, so keep it where `github:setup` said (the
keychain, or `GITHUB_APP_PRIVATE_KEY_FILE`).

For Linear,
`bun run linear:setup --target devbox.k8s.json` registers the app and writes
its settings, `k8s:install` applies them, and
`bun run linear:status --target devbox.k8s.json` checks them
([Linear](../linear.md)). Webhooks need a public route to `/webhook/`, such
as the `webhooks` Ingress.

## Troubleshooting

**"no ready repo snapshot".** The snapshot builder failed. Read its logs:

```bash
kubectl -n devbox-sandboxes logs job/devbox-snapshot-builder-install
kubectl -n devbox-sandboxes get volumesnapshot
kubectl -n devbox-sandboxes describe volumesnapshot <name>
```

Common causes: the token cannot read a repo, the VolumeSnapshotClass's driver
does not match the StorageClass, or the snapshot controller is not running.
After the fix, run `bun run k8s:refresh-snapshot --target devbox.k8s.json`.

**"the scratch volume devbox-repos-scratch is … but workspace.size is …".**
The builder's scratch volume keeps the size it was created with. To change
`workspace.size`, delete the claim and build a new snapshot:

```bash
kubectl -n devbox-sandboxes delete pvc devbox-repos-scratch
bun run k8s:refresh-snapshot --target devbox.k8s.json
```

**The control plane cannot log in to Postgres** (`password authentication
failed` in its logs). The Secret `devbox-postgres` was deleted while the
database volume remained. The bootstrap Job then generated a new password,
which the existing database does not accept. Two fixes:

- Restore the old Secret `devbox-postgres` (key `password`) from your backup,
  then restart the control plane:
  `kubectl -n devbox rollout restart deployment/devbox-control-plane`.
- Or start over with an empty database, which deletes every task:

  ```bash
  kubectl -n devbox delete pvc data-devbox-postgres-0 --wait=false
  kubectl -n devbox delete pod devbox-postgres-0
  kubectl -n devbox rollout restart deployment/devbox-control-plane
  ```

  If the new pod comes up while the old volume is still being deleted, it
  fails to start; delete the pod `devbox-postgres-0` once more.

**"NetworkPolicy is not enforced in this cluster".** The CNI ignores
NetworkPolicy, so sandboxes would have open egress. Turn on enforcement (for EKS,
see [eks.md](eks.md#networkpolicy)) and run the installer again. `--skip-netpol-check` installs
anyway, without the lockdown; use it only when you know the check is wrong for
your cluster.

**"the API server rejected iron-proxy's address".** The picked address is
outside the Service range or taken. Choose one as in
[step 3 of GitOps](#iron-proxy-address) and set it in the target file under
`values.ironProxy.clusterIP`.

**"port … is in use" from `k8s:connect`.** Another `bun run k8s:connect` for
the same profile is probably still running. Stop it, or free the port
(`lsof -i :13000` shows the process).

**`devbox logs -f` stops after a while through an Ingress.** The event
stream stays open, and Ingress controllers and load balancers close idle
connections. Raise the idle or read timeout, for example
`nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` for ingress-nginx, or
the load balancer's idle timeout. `devbox logs -f` through `k8s:connect` is not
affected.

**"another OpenSandbox controller runs in namespace …"** or **"the OpenSandbox
CRDs belong to Helm release …".** devbox bundles its own OpenSandbox and its
sandbox template is part of the security model. Uninstall the other one first.
