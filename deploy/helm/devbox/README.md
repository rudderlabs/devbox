# The devbox chart

Runs devbox tasks on Kubernetes: the control plane, iron-proxy, the repo
snapshot builder, a bundled OpenSandbox and, optionally, a minimal Postgres.
Sandboxes run in the namespace `devbox-sandboxes`; install the release as
`devbox` in the namespace `devbox`.

How to install it, with the installer or with GitOps:
[docs/kubernetes/README.md](../../../docs/kubernetes/README.md). Secrets never
go in values: see [docs/kubernetes/secrets.md](../../../docs/kubernetes/secrets.md).

This file is generated from `values.yaml` by
[helm-docs](https://github.com/norwoodj/helm-docs):

```bash
docker run --rm -v "$PWD/deploy/helm/devbox:/helm-docs" jnorwood/helm-docs:v1.14.2
```

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| controlPlane.publicBaseUrl | string | `""` | Base URL in task links. Defaults to the api Ingress URL, else http://localhost:3000. |
| controlPlane.replicas | int | `1` | More than one adds a PodDisruptionBudget. |
| controlPlane.resources.limits.memory | string | `"1Gi"` |  |
| controlPlane.resources.requests.cpu | string | `"100m"` |  |
| controlPlane.resources.requests.memory | string | `"256Mi"` |  |
| controlPlane.terminationGracePeriodSeconds | int | `150` | Seconds between SIGTERM and SIGKILL. At least one task's reconcile (up to 110s when platforms are slow, plus 50s per extra PR opened in that reconcile) plus SHUTDOWN_DRAIN_MS (10s) for in-flight provisions and integration hooks; raise it with SHUTDOWN_DRAIN_MS. |
| database.existingSecret | string | `""` | With postgresql.enabled false: a Secret with key `DATABASE_URL`. |
| extraEnv | list | `[]` | Extra control-plane env. Only explicitly allowlisted HARNESS_* settings reach sandboxes; never put a real secret in a forwarded name. |
| extraManifests | list | `[]` | Extra manifests, rendered with tpl. |
| git.email | string | `"devbox@users.noreply.github.com"` |  |
| git.name | string | `"devbox"` | Commit identity for the agent's commits. `bun run k8s:install` sets the GitHub user's. |
| github.trustedOrgs | list | `[]` | GitHub orgs whose members may drive devbox. Required with trustedUsers (either) when the GitHub App is enabled. |
| github.trustedUsers | list | `[]` | GitHub users who may drive devbox. Required with trustedOrgs (either) when the GitHub App is enabled. |
| images.controlPlane | string | `"rudderlabs/devbox-control-plane"` | Control-plane image repository. Required; the default is the published image. |
| images.controlPlanePullSecrets | list | `[]` | Pull Secrets for the control-plane image, for a private registry. Create each Secret in the release namespace and in devbox-sandboxes; harness sandbox pulls use sandbox.imagePullSecrets. |
| images.harness | string | `"rudderlabs/devbox-harness"` | The harness image sandboxes run. Required; see docs/kubernetes/harness-image.md to extend it. |
| images.pullPolicy | string | `"IfNotPresent"` | Pull policy for both images. |
| images.tag | string | `""` | Tag for both images. Defaults to the chart's appVersion. |
| ingress.api.annotations | object | `{}` | Ingress annotations, for example the controller's timeouts. |
| ingress.api.className | string | `""` | The Ingress class. |
| ingress.api.enabled | bool | `false` | Ingress for / (API, CLI, event streams; webhooks included). Off: reach it with `bun run k8s:connect`. |
| ingress.api.host | string | `""` | Required when enabled. |
| ingress.api.tls | list | `[]` | Standard Ingress TLS entries. Without TLS the chart prints a warning. |
| ingress.webhooks.annotations | object | `{}` | Ingress annotations, for example the controller's timeouts. |
| ingress.webhooks.className | string | `""` | The Ingress class. |
| ingress.webhooks.enabled | bool | `false` | Public Ingress for /webhook/ only (GitHub, Linear). |
| ingress.webhooks.host | string | `""` | Required when enabled. |
| ingress.webhooks.tls | list | `[]` | Standard Ingress TLS entries. Without TLS the chart prints a warning. |
| integrations.githubApp.appId | int | `0` | Required when enabled: the App's numeric ID (0 means unset). |
| integrations.githubApp.botLogin | string | `""` | Required when enabled: the App's slug, which users @-mention (bun run k8s:install copies it). |
| integrations.githubApp.botUserId | int | `0` | Required when enabled: the App bot's numeric GitHub user ID (0 means unset). |
| integrations.githubApp.ciResults | bool | `true` | Posts CI failures on the agent's pull requests back to the agent (GITHUB_CI_RESULT_ENABLED). |
| integrations.githubApp.enabled | bool | `false` | Turns the GitHub App on: webhooks at /webhook/github (GITHUB_WEBHOOKS_ENABLED) and, with `tokens: devbox`, the token minter. GITHUB_WEBHOOK_SECRET goes in the integrations Secret. Set by bun run github:setup through bun run k8s:install. |
| integrations.githubApp.installationId | int | `0` | Required when enabled: the App installation's numeric ID (0 means unset). |
| integrations.githubApp.tokenScope | string | `"repos"` | `repos` narrows each token to the repos above; `installation` covers every repo the App is installed on. |
| integrations.githubApp.tokens | string | `""` | Required when enabled: `devbox` (a minter Deployment keeps the `devbox-github` Secret fresh with the App's private key) or `external` (your tooling keeps secrets.github.existingSecret fresh). |
| integrations.linear.clientId | string | `""` | Required when enabled: the Linear app's client ID; set by bun run linear:setup. |
| integrations.linear.enabled | bool | `false` | Turns Linear on (LINEAR_ENABLED). Its secrets go in the integrations Secret. |
| integrations.slack.channelId | string | `""` | Required when enabled: the Slack channel ID. |
| integrations.slack.enabled | bool | `false` | Turns Slack on (SLACK_ENABLED). SLACK_BOT_TOKEN goes in the integrations Secret. |
| integrations.slack.notifySources | list | `[]` | Task sources whose finished tasks post (SLACK_NOTIFY_SOURCES): `linear`, `api`. Empty: `linear`. |
| ironProxy.clusterIP | string | `""` | Required. A free address in the cluster's Service range; sandboxes use it as their DNS server. `bun run k8s:install` picks one. |
| ironProxy.extraAllowlist | list | `[]` | Extra allowlist rules ({host, methods, paths}), appended as-is. |
| ironProxy.image.repository | string | `"ironsh/iron-proxy"` |  |
| ironProxy.image.tag | string | `"0.45.0"` |  |
| ironProxy.replicas | int | `1` | More than one adds a PodDisruptionBudget. |
| ironProxy.resources.limits.memory | string | `"512Mi"` |  |
| ironProxy.resources.requests.cpu | string | `"100m"` |  |
| ironProxy.resources.requests.memory | string | `"128Mi"` |  |
| llm.baseUrl | string | `""` | Required. For openai, the base URL with /v1; for anthropic, the API root without /v1. It must use the default port (80 or 443), because iron-proxy intercepts only those (same rule as devbox.config.json). `bun run k8s:install` fills llm from devbox.config.json. |
| llm.model | string | `""` | Required. Model name. |
| llm.provider | string | `"openai"` | `openai` (the Responses API of OpenAI or Azure OpenAI) or `anthropic` (Claude through the Messages API). |
| llm.reasoningEffort | string | `""` | Default reasoning effort. OpenAI: none, minimal, low, medium, high, xhigh. Anthropic: low, medium, high, xhigh, max. Empty uses each stage's default. |
| llm.stages | object | `{}` | Per-stage model and reasoning-effort overrides. Keys: orientation, planning, planReview, implementation, distillation, review, followup. |
| opensandbox | object | see values.yaml | The vendored OpenSandbox chart. Change with care: the sandbox template and its namespace are part of devbox's security model. |
| postgresql.enabled | bool | `true` | A minimal bundled Postgres for trying devbox: no backups, HA or automated upgrades. |
| postgresql.image | string | `"postgres:18"` |  |
| postgresql.size | string | `"10Gi"` | Size of the database volume. |
| repos | list | `[]` | Required. Repos the agent works on: [{url: "https://github.com/<owner>/<repo>.git", branch: main}]. `bun run k8s:install` fills this from devbox.config.json. |
| sandbox.cpu | string | `"2"` | CPU of each sandbox. |
| sandbox.extraVolumeMounts | list | `[]` | Extra mounts for the sandbox container. |
| sandbox.extraVolumes | list | `[]` | Extra volumes for sandbox pods. |
| sandbox.imagePullSecrets | list | `[]` | For a private harness image: [{name: <Secret in devbox-sandboxes>}]. |
| sandbox.maxConcurrent | int | `5` | Most sandboxes running at once. |
| sandbox.memory | string | `"8Gi"` | Memory of each sandbox. |
| sandbox.nodeSelector | object | `{}` | Node selector for sandbox pods. |
| sandbox.runtimeClassName | string | `""` | Runtime class for sandbox pods (for example Kata or gVisor). |
| sandbox.tolerations | list | `[]` | Tolerations for sandbox pods. |
| secrets.github | object | `{"existingSecret":""}` | Name your own Secret instead of the installer's `devbox-github` (key `token`). Only with integrations.githubApp.tokens external, or without the App. Every key in it reaches the control plane, iron-proxy and the snapshot builder: put only `token` (and `expires-at`) in it, never the App's private key. |
| secrets.githubApp | object | `{"existingSecret":""}` | Name your own Secret instead of the installer's `devbox-github-app` (key `private-key`, the GitHub App's private key), for integrations.githubApp.tokens devbox. |
| secrets.integrations | object | `{"existingSecret":""}` | Optional Secret instead of `devbox-integrations`; its keys become control-plane env. |
| secrets.llm | object | `{"existingSecret":""}` | Name your own Secret instead of `devbox-llm` (key `api-key`). |
| snapshotBuilder.keep | int | `3` | Number of repo snapshots kept. |
| snapshotBuilder.schedule | string | `"0 */6 * * *"` | When the snapshot builder refreshes the repo snapshot (cron syntax). |
| snapshotBuilder.suspend | bool | `false` | Pauses the scheduled runs; `bun run k8s:refresh-snapshot` still works. |
| storage.storageClass | string | `""` | Required. StorageClass for task workspaces, the snapshot builder's scratch volume and the bundled Postgres. |
| storage.volumeSnapshotClass | string | `""` | Required. VolumeSnapshotClass of the same CSI driver. |
| workspace.size | string | `"15Gi"` | Size of each task's workspace and of the snapshot builder's scratch volume. |
