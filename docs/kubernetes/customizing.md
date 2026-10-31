# Customizing the chart

Everything here is a chart value. With the installer, put values under
`values` in the [target file](README.md#1-configure); with GitOps, in your
values file.
The [values reference](../../deploy/helm/devbox/README.md) lists them all.

Some parts are fixed on purpose. OpenSandbox is always the bundled one: the
sandbox pod template that sends DNS to iron-proxy, mounts its CA, sets the
NetworkPolicy label and drops the service account token lives in that
server's config, and an external OpenSandbox would run sandboxes with open
egress. The namespaces are fixed too, `devbox` and `devbox-sandboxes`.

## External database

The bundled Postgres has no backups, high availability or automated upgrades.
In production, use your own Postgres:

```yaml
postgresql:
  enabled: false
database:
  existingSecret: devbox-database
```

The Secret holds one key, `DATABASE_URL`:

```bash
kubectl -n devbox create secret generic devbox-database \
  --from-literal=DATABASE_URL='postgres://<user>:<password>@<host>:5432/<db>'
```

The control plane migrates the schema at start. The database must be reachable
from the `devbox` namespace.

## Ingress

The control plane has a ClusterIP Service, `devbox-control-plane` on port
3000, and no public address by default. The chart has two optional Ingresses.
They take the same fields: `enabled`, `className`, `host`, `annotations` and
`tls`.

- `ingress.webhooks` routes `/webhook/` only, for GitHub and Linear.
- `ingress.api` routes `/`, webhooks included, for the API, the CLI and event
  streams. The API requires an API token.

The control plane caps each webhook body at 1 MiB and returns HTTP 413 before
signature verification when that limit is exceeded. Bun also enforces a 2 MiB
process-wide safety backstop; it is deliberately higher so the webhook route can
return its documented JSON error. Configure the Ingress controller or upstream
load balancer with a body limit no larger than 1 MiB so oversized requests are
rejected before consuming control-plane resources. A lower proxy limit can drop
otherwise valid provider deliveries; an omitted or higher proxy limit still
leaves the control-plane limits in effect.

Three setups:

- `api` alone: everything on one public host.
- `webhooks` alone: webhooks are public, and the API stays behind
  `bun run k8s:connect` or a port-forward.
- Both: public webhooks and a VPN-only API.

Kubernetes has no standard field for "internal": whether an Ingress is public
or VPN-only depends on the controller and load balancer behind its class. The
third setup therefore has the same shape on any controller: a class and
annotations per Ingress.

```yaml
ingress:
  webhooks:
    enabled: true
    className: public        # a class your cluster exposes to the internet
    host: hooks.example.com
    tls:
      - { hosts: [hooks.example.com], secretName: devbox-hooks-tls }
  api:
    enabled: true
    className: internal      # a class reachable only over your VPN
    host: devbox.example.com
    annotations: {}          # your controller's settings, such as the idle timeout
    tls:
      - { hosts: [devbox.example.com], secretName: devbox-tls }
```

#### Example: AWS Load Balancer Controller (ALB)

This example is specific to the
[AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
and its `alb` class. Other controllers use other annotations. Each Ingress gets
its own ALB: an internet-facing one for webhooks, and an internal one (private
addresses in the VPC, reachable over a VPN that routes to it) for the API. TLS
ends at the ALBs with ACM certificates, so `tls` stays empty and
`controlPlane.publicBaseUrl` names the https URL.

```yaml
ingress:
  webhooks:
    enabled: true
    className: alb
    host: hooks.example.com
    annotations:
      alb.ingress.kubernetes.io/scheme: internet-facing
      alb.ingress.kubernetes.io/target-type: ip          # the Service is ClusterIP
      alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
      alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:<region>:<account>:certificate/<id>
      alb.ingress.kubernetes.io/healthcheck-path: /health
  api:
    enabled: true
    className: alb
    host: devbox.example.com
    annotations:
      alb.ingress.kubernetes.io/scheme: internal
      alb.ingress.kubernetes.io/target-type: ip
      alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
      alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:<region>:<account>:certificate/<id>
      alb.ingress.kubernetes.io/healthcheck-path: /health
      alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=3600   # event streams
controlPlane:
  publicBaseUrl: https://devbox.example.com
```

- Point DNS for both hosts at their ALBs, by hand or with external-dns.
- The chart prints a warning for each Ingress without `tls`. Here TLS ends at
  the ALB, so you can ignore it.

- Task links use `controlPlane.publicBaseUrl`, else the `api` Ingress URL. They
  never use the `webhooks` URL, so with a VPN-only API the links need the VPN.
  This is intended.
- Without `tls`, the chart installs and prints a warning per Ingress: terminate
  TLS in front of the Ingress, at the load balancer or the controller.
- Raise the controller's idle timeout for event streams
  ([Troubleshooting](README.md#troubleshooting)).

When TLS is terminated in front of the Ingress (a load balancer certificate),
`tls` stays empty. Set `controlPlane.publicBaseUrl: https://<api host>`. The
chart, its notes and the installer's CLI profile then use that https URL.

With the installer, the CLI profile uses the `api` Ingress URL when there is
one (`https://<host>`, or `http://` without `tls`). The install machine must
reach that URL, so be on the VPN. Without an `api` Ingress, the profile stays on
`http://localhost:<port>` for `k8s:connect`.

With GitOps and no `api` Ingress, create a token and a localhost profile
yourself, and reach the API through a port-forward:

```bash
kubectl -n devbox exec deploy/devbox-control-plane -- bun run api-token create <name>
bun run devbox profile add my-cluster --url http://localhost:3000 --token <token> --use
kubectl -n devbox port-forward svc/devbox-control-plane 3000:3000
```

### Gateway API

The chart has no Gateway API template. Add an `HTTPRoute` through
`extraManifests`:

```yaml
extraManifests:
  - apiVersion: gateway.networking.k8s.io/v1
    kind: HTTPRoute
    metadata:
      name: devbox-control-plane
      namespace: "{{ .Release.Namespace }}"
    spec:
      parentRefs: [{ name: <gateway>, namespace: <gateway-namespace> }]
      hostnames: [devbox.example.com]
      rules:
        - matches: [{ path: { type: PathPrefix, value: / } }]
          backendRefs: [{ name: devbox-control-plane, port: 3000 }]
controlPlane:
  publicBaseUrl: https://devbox.example.com
```

`controlPlane.publicBaseUrl` must be a host that routes `/api`, since task
links point there.

## Sandbox pods

These values go into the sandbox pod template as they are:

| Value | Pod field |
|---|---|
| `sandbox.runtimeClassName` | `runtimeClassName`, for example Kata Containers or gVisor |
| `sandbox.tolerations` | `tolerations` |
| `sandbox.nodeSelector` | `nodeSelector` |
| `sandbox.imagePullSecrets` | `imagePullSecrets`, Secrets in `devbox-sandboxes` |
| `sandbox.extraVolumes` | `volumes` |
| `sandbox.extraVolumeMounts` | the sandbox container's `volumeMounts` |

`sandbox.cpu`, `sandbox.memory` and `sandbox.maxConcurrent` size the sandboxes
and limit how many run at once; their formats, defaults and concurrency behavior
are described in [Sandbox configuration](../configuration.md#sandbox).
`workspace.size` sizes each task's volume.

The OpenSandbox server reads the template only at start. The installer
restarts it when the template changes; with GitOps, restart it yourself
([README.md](README.md#changing-sandbox-values)).

## Extra environment

`extraEnv` adds env entries to the control plane:

```yaml
extraEnv:
  - { name: HARNESS_REVIEW_MAX_ITERATIONS, value: "3" }
  - { name: HARNESS_TRUSTED_BOT_IDS, value: "12345678" }
```

Only `HARNESS_*` names in the explicit forwarding contract reach sandboxes
([configuration.md](../configuration.md#what-reaches-the-sandbox)); the prefix
alone is not enough. Never put a real secret in a forwarded name or fill one
from a Secret.

Configure model and reasoning effort normally with the chart's `llm.model`,
`llm.reasoningEffort` and `llm.stages` keys, not `extraEnv`. The chart derives
the corresponding global and stage `HARNESS_*` entries. An `extraEnv` entry with
one of those names replaces the entry the chart would derive, so the container
gets the variable once. The chart does not validate an `extraEnv` value; the
harness checks it only when that stage runs. For each variable the order is
`extraEnv`, then `llm.stages.<stage>` or `llm.reasoningEffort` / `llm.model`,
then the code default.

The integrations and the org/user trust lists have their own values
([below](#integrations)). Don't also set their variables in `extraEnv`: for
`GITHUB_TRUSTED_ORGS` and `GITHUB_TRUSTED_USERS` that gives the control plane
the variable twice. `HARNESS_TRUSTED_BOT_IDS` is different: it has no chart
value, so `extraEnv` is its supported Kubernetes configuration path. There is
no supported Compose path for trusted bot IDs.

## Extra manifests

`extraManifests` is a list of manifests, as objects or strings. Each is
rendered with Helm's `tpl`, so `{{ .Release.Namespace }}` and other template
expressions work. Use it for resources the chart has no template for: an
`HTTPRoute`, `ExternalSecret`s, a StorageClass, Cilium policies.

## Integrations

Each integration has a switch, `enabled`, and its settings as chart values.
Only `enabled: true` turns one on: its secrets alone, in a Secret or in your
shell, never do. With the installer, set them in the target file's top-level
`integrations` block, which the installer copies into these values (`values`
refuses `integrations`); `bun run linear:setup` writes the Linear part. With
GitOps, set the values directly, and keep the target file's `integrations`
block in step with them: `bun run k8s:check` reads which integrations are
enabled from that block ([Check the Secrets](README.md#check-the-secrets)).

| Value | Meaning |
|---|---|
| `integrations.linear.enabled` | Turns Linear on. See [docs/linear.md](../linear.md). |
| `integrations.linear.clientId` | The Linear app's client ID. Required when enabled. |
| `integrations.slack.enabled` | Turns on Slack notifications when a task finishes. |
| `integrations.slack.channelId` | The Slack channel ID. Required when enabled. |
| `integrations.slack.notifySources` | The task sources whose finished tasks post, from `linear` and `api`. Default: `linear`. |
| `integrations.githubApp.enabled` | Turns on the GitHub App: webhooks at `/webhook/github` (`@<botLogin>` mentions, reviews and failed CI runs reach the agent) and, with `tokens: devbox`, the token minter. See [docs/github.md](../github.md). |
| `integrations.githubApp.appId`, `integrations.githubApp.installationId`, `integrations.githubApp.botUserId` | The App's ID, its installation's ID and the bot's numeric GitHub user ID. Required when enabled. |
| `integrations.githubApp.botLogin` | The App's slug. The installer copies it from `slug` in the target file's block. Required when enabled. |
| `integrations.githubApp.tokens` | `devbox`: the minter keeps the Secret `devbox-github` fresh with the App's private key. `external`: your tooling keeps `secrets.github.existingSecret` fresh. Required when enabled. |
| `integrations.githubApp.tokenScope` | `repos` (default) narrows each token to the repos in `repos`; `installation` covers every repo the App is installed on. |
| `integrations.githubApp.ciResults` | Default `true`: failed CI runs on the agent's pull requests reach the agent. |
| `secrets.githubApp.existingSecret` | Your own Secret for the App's private key (key `private-key`), instead of `devbox-github-app` ([secrets.md](secrets.md#the-github-app-key-and-the-minter)). |
| `github.trustedOrgs`, `github.trustedUsers` | Lists of GitHub orgs and logins whose pull request discussion the agent reads ([trust settings](../configuration.md#trust-settings)). One is required with the GitHub App enabled; they apply without it too. |

For example, in a target file:

```json
{ "context": "my-eks",
  "values": { "github": { "trustedOrgs": ["example-org"] } },
  "integrations": {
    "linear": { "enabled": true, "clientId": "…" },
    "slack": { "enabled": true, "channelId": "C0123456789" },
    "githubApp": { "enabled": true, "appId": 123456, "slug": "example-devbox",
                   "installationId": 7890123, "botUserId": 1234567,
                   "tokens": "devbox", "tokenScope": "repos", "ciResults": true } } }
```

`bun run github:setup --target <file>` writes the `githubApp` block, and the
trust list when none is set ([docs/github.md](../github.md)). The installer
copies the block into the chart values, with `slug` as `botLogin`. `org` and
`pending`, which setup also writes, are not chart values. `publicUrl` stays in
the target file, and Linear and GitHub share it.

The chart refuses to render an enabled integration with a required setting
missing, for example `integrations.slack.enabled is true:
integrations.slack.channelId is required`, so a GitOps sync fails instead of
the control plane. For the GitHub App it also refuses:

- no trust list: `github.trustedOrgs or github.trustedUsers is required`;
- external tokens without your own token Secret:
  `tokens: external needs secrets.github.existingSecret: the Secret your tooling keeps fresh`;
- devbox tokens with one:
  `tokens: devbox writes the token Secret itself: remove secrets.github.existingSecret, or use tokens: external`;
- `tokenScope: repos` with no `repos`:
  `tokenScope: repos needs at least one entry in repos (or use tokenScope: installation)`.

Each message starts with `integrations.githubApp.enabled is true: `.

- **The secrets** go in the Secret `devbox-integrations`, or your own with
  `secrets.integrations.existingSecret`, under their env names:
  `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `SLACK_BOT_TOKEN`,
  `GITHUB_WEBHOOK_SECRET` ([secrets.md](secrets.md)). The installer writes
  only those of the enabled integrations.
- **Webhooks** need a public route to `/webhook/`: the `webhooks` or `api`
  Ingress, or an `HTTPRoute`.
- **Egress.** With an egress policy on the control plane, allow
  `api.linear.app` for Linear and `slack.com` for Slack. The GitHub App's
  minter has its own NetworkPolicy: DNS, port 443 and the Kubernetes API.
- **Slack is Kubernetes-only** for now; the local stack refuses it. Linear and
  the GitHub App run on both.

**Restarting the control plane.** It reads the integrations Secret as env at
start, so a changed Secret takes effect only after a restart. `k8s:install`
prints the command when it changed `devbox-integrations` without Helm rolling
the control plane. With your own Secret or with GitOps, restart it yourself
after you change the Secret:

```bash
kubectl --context <context> -n devbox rollout restart deploy/devbox-control-plane
bun run k8s:check --target devbox.k8s.json
```

**Upgrading.** Integrations used to turn on when their variables were set,
with their settings in `extraEnv`. Now a variable or a Secret key does nothing
on its own: move the settings to these values and set `enabled: true`.

## A production example

[examples/production-values.yaml](examples/production-values.yaml) is a values
file for a production-style install:

- sandboxes in Kata Containers VMs (`sandbox.runtimeClassName`), on their own
  nodes;
- Cilium FQDN egress policies, through `extraManifests`, that let iron-proxy
  reach only GitHub and the LLM host, and the control plane only what it uses;
- External Secrets for every Secret;
- an external database;
- a StorageClass tuned for snapshot restores (on EBS, restored volumes load
  lazily; see [eks.md](eks.md#notes));
- two replicas of the control plane and iron-proxy, each with a
  PodDisruptionBudget.

Replace every `<…>` and adjust it to your cluster before you use it.

## Docker in sandboxes

Not yet available. A later profile will let the agent run Docker inside its
sandbox. It will need a VM-grade or Sysbox runtime class, a privileged sandbox
container and a harness image with `dockerd`; the chart will refuse
`privileged` without a runtime class, because on plain runc a privileged
sandbox is root on the node. Today only `sandbox.runtimeClassName` exists,
which is useful on its own for Kata Containers or gVisor.
