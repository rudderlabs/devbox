# Configuration

devbox has three places for settings:

- `devbox.config.json`: your repos and LLM endpoint, the trust lists, and the
  local stack's integrations. No secrets. On Kubernetes, a
  [target file](#the-target-file---target) names the cluster and holds its
  integrations.
- The secrets, such as `GITHUB_TOKEN` and `LLM_API_KEY`: from your shell, the
  system keychain, `gh` or a prompt. Never from a plain file.
- Environment variables, in three namespaces: one for the control plane, one
  for the agent in the sandbox, one for the CLI.

## `devbox.config.json`

`bun run up` and `bun run k8s:install` read `devbox.config.json` at the repo
root. Start from the example:

```bash
cp devbox.config.example.json devbox.config.json
```

```json
{
  "repos": [{ "url": "https://github.com/your-org/your-repo.git", "branch": "main" }],
  "llm": { "provider": "openai", "baseUrl": "https://api.openai.com/v1", "model": "gpt-5.6-sol" }
}
```

The file is gitignored. `up` checks it before it touches Docker, and an error
names the field that is wrong. The checks are in
`control-plane/scripts/up/config.ts`. Run `bun run up` again after you change
the file.

### `repos`

Required. A non-empty list of the repos the agent works on. It works on no
other repo.

| Field | Required | Meaning |
|---|---|---|
| `url` | yes | `https://github.com/<owner>/<repo>.git`. No other form is accepted. |
| `branch` | no, default `main` | The branch that is cloned, and the base of the agent's pull requests. |

Each repo is cloned to `/workspace/<repo>` in the sandbox, so two repos can't
have the same name.

The list drives three things:

- **The repos volume.** `up` clones each repo's branch, with `--depth 1`, into
  the `devbox-repos` Docker volume. Each task starts from a copy of it. The
  agent fetches the latest commits before it plans. A repo you remove from the
  list stays in the volume until `bun run reset`.
- **The iron-proxy allowlist** (see [below](#what-iron-proxy-allows)).
- **The token checks.** `up` and `k8s:install` check that the GitHub token can
  push to each repo and open pull requests in it
  ([what preflight checks](#what-preflight-checks)).

A task has no repo field. The agent picks a repo while planning, from the repos
in its workspace. With more than one repo, name the one to change in the task.

### `llm`

Required. The endpoint every agent stage uses: OpenAI's Responses API, or
Anthropic's Messages API.

| Field | Required | Meaning |
|---|---|---|
| `provider` | no, default `openai` | `openai` (the Responses API of OpenAI or Azure OpenAI) or `anthropic` (Claude through the Messages API). |
| `baseUrl` | yes | The endpoint's base URL, for example `https://api.openai.com/v1`. With `openai` the agent calls `<baseUrl>/responses`; with `anthropic` it calls `<baseUrl>/v1/messages`. |
| `model` | yes | The global model. It replaces the provider's code-default model for every stage that does not set its own model. |
| `reasoningEffort` | no | The global reasoning effort. When set, it replaces **all seven stage effort defaults** except explicit per-stage efforts. |
| `stages` | no | Per-stage `model` and/or `reasoningEffort`, keyed by the exact camelCase stage names below. |

With global and per-stage settings:

```json
{
  "llm": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5.6-sol",
    "reasoningEffort": "high",
    "stages": {
      "review": { "model": "gpt-5.6-sol-pro", "reasoningEffort": "xhigh" },
      "orientation": { "reasoningEffort": "minimal" }
    }
  }
}
```

Here `review` uses its own model and effort, `orientation` keeps the global
model at `minimal`, and the other five stages run at the global `high`. Because a
global `reasoningEffort` replaces every stage default, set a per-stage
`reasoningEffort` for each stage you want to keep lower. Any other key in `llm`
or in a stage is an error.

The seven stage keys, deployed environment variables and code-default efforts
are:

| Stage key (camelCase) | Model variable | Effort variable | Code-default effort |
|---|---|---|---|
| `orientation` | `HARNESS_ORIENTATION_MODEL` | `HARNESS_ORIENTATION_REASONING_EFFORT` | `low` |
| `planning` | `HARNESS_PLANNING_MODEL` | `HARNESS_PLANNING_REASONING_EFFORT` | `medium` |
| `planReview` | `HARNESS_PLAN_REVIEW_MODEL` | `HARNESS_PLAN_REVIEW_REASONING_EFFORT` | `low` |
| `implementation` | `HARNESS_IMPLEMENTATION_MODEL` | `HARNESS_IMPLEMENTATION_REASONING_EFFORT` | `medium` |
| `distillation` | `HARNESS_DISTILLATION_MODEL` | `HARNESS_DISTILLATION_REASONING_EFFORT` | `medium` |
| `review` | `HARNESS_REVIEW_MODEL` | `HARNESS_REVIEW_REASONING_EFFORT` | `high` |
| `followup` | `HARNESS_FOLLOWUP_MODEL` | `HARNESS_FOLLOWUP_REASONING_EFFORT` | `high` |

Model and effort resolve **independently** for each stage:

1. that stage's `llm.stages.<stage>.model` or `reasoningEffort`;
2. global `llm.model` or `llm.reasoningEffort`;
3. the provider/stage code default.

Thus a stage may use its own model with the global effort, or the global model
with its own effort. The code-default models are `gpt-5.6-sol` for `openai` and
`claude-opus-5-5` for `anthropic`; they matter only to a standalone harness
run that has no deployed `llm.model`. `llm.model` is required in deployment
configuration.

The accepted effort values are exactly:

- `openai`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `anthropic`: `low`, `medium`, `high`, `xhigh`, `max`.

`baseUrl` must:

- use `http` or `https`;
- have a DNS name as its host, not an IP address;
- use the default port (80 for `http`, 443 for `https`). iron-proxy only
  intercepts those two ports, so `up` rejects a URL with any other port. An
  endpoint on another port, such as a model server on your own machine, needs
  something in front of it on port 80 or 443 with a DNS name;
- have no query, fragment or credentials.

**`openai`.** The agent calls the Responses API with a reasoning effort and
summary, `store: false`, and `include: ["reasoning.encrypted_content"]`, so
the model needs reasoning support. For Azure OpenAI, `baseUrl` is the
resource's v1 URL, `https://<resource>.openai.azure.com/openai/v1`, and model
names are deployment names. iron-proxy replaces the dummy key in the
`Authorization` header and in Azure's `api-key` header.

**`anthropic`.** Set `baseUrl` to the API root without `/v1`, for example
`{ "provider": "anthropic", "baseUrl": "https://api.anthropic.com", "model": "claude-opus-5-5" }`.
The agent runs with adaptive thinking, so the model must support it (Claude
Opus 4.6, Sonnet 4.6 and later). The resolved reasoning effort becomes Claude's
effort; `none` and `minimal` are rejected. iron-proxy replaces the dummy key in Anthropic's `x-api-key` header.

Before it starts the stack, `up` sends the endpoint a one-message request with
the parameters the agent sends (reasoning for `openai`; adaptive thinking and
an effort for `anthropic`), and stops if it fails.

The same `llm` block drives the local Compose stack (`bun run up`),
`bun run k8s:install`, and `bun run k8s:kind`. GitOps uses the same keys under
the chart's top-level `llm` value; do not maintain a separate set of model or
effort variables. The deployment derives `HARNESS_MODEL`, optional `HARNESS_REASONING_EFFORT`, and
stage variables from those keys; they are not settings to hand-set in a
deployment. A value you leave out is unset for the harness (on Compose, `up`
passes it as empty), so it falls through the resolution order to the code
default.

The deployment also passes `HARNESS_LLM_PROVIDER` and `HARNESS_LLM_BASE_URL` to
the control plane, which forwards them with the other listed `HARNESS_*`
settings to every sandbox. The
host of `baseUrl` becomes an iron-proxy network alias, and iron-proxy allows
only `POST` to the one endpoint the agent calls on that host.

### `sandbox`

Optional. Sizes sandboxes and limits how many the local Compose stack runs at once:

```json
"sandbox": { "maxConcurrent": 5, "cpu": "2", "memory": "4Gi" }
```

| Field | Validation | Compose default |
|---|---|---|
| `maxConcurrent` | Integer greater than or equal to 1. | `5` |
| `cpu` | Positive Kubernetes CPU quantity: whole or decimal cores (`"2"`, `"1.5"`) or millicores (`"500m"`). | `"2"` |
| `memory` | Positive integer binary memory quantity (`Ki`, `Mi`, `Gi` or `Ti`), for example `"512Mi"` or `"4Gi"`. | `"4Gi"` |

The block and all its fields are optional. Unknown keys and invalid values stop
`bun run up` before Docker starts. `cpu` and `memory` are limits for each
sandbox, not reservations. At the Compose defaults, five busy sandboxes can use
up to 20 GiB, more than Docker Desktop's default 8 GB VM. Increase Docker
Desktop's memory limit, or lower `maxConcurrent`, `cpu` or `memory`.

The concurrency limit counts running sandboxes, not task records. Work for a
task without a sandbox waits when every slot is occupied, and queued work starts
in FIFO order. A task that already holds a sandbox remains claimable at the
limit; it reuses its existing slot. After 15 minutes with no open work, an idle
sandbox is removed and frees its slot. The task's workspace volume is retained,
so later work resumes from it. With multiple control-plane replicas this is a
soft cap: replicas can briefly exceed it while they claim different tasks.

This block is **Compose only**. Kubernetes commands ignore it, even if it is
invalid, because sandbox sizing remains a chart value:

- For `bun run k8s:install`, put the same keys under `values.sandbox` in the
  [target file](#the-target-file---target).
- For `bun run k8s:kind`, put them under `values.sandbox` in
  `devbox.kind.json`. The command preserves those values when run again.
- For GitOps or plain Helm, put them under `sandbox` in the chart values file.

After changing any Kubernetes `sandbox.*` value, restart OpenSandbox as described
in [Changing sandbox values](kubernetes/README.md#changing-sandbox-values). The
deployment defaults are:

| Deployment | `maxConcurrent` | `cpu` | `memory` |
|---|---:|---:|---:|
| Compose | `5` | `"2"` | `"4Gi"` |
| Helm / installer | `5` | `"2"` | `"8Gi"` |
| kind | `5` | `"1"` | `"2Gi"` |
| Control plane when the environment is unset | `50` | `"2"` | `"8Gi"` |

### `integrations`

Optional. The local stack's integrations: Linear and the GitHub App.

```json
"publicUrl": "https://…",
"github": { "trustedOrgs": ["example-org"] },
"integrations": {
  "linear": { "enabled": true, "clientId": "…" },
  "githubApp": { "enabled": true, "appId": 123456, "slug": "example-devbox",
                 "installationId": 7890123, "botUserId": 1234567,
                 "tokens": "devbox", "tokenScope": "repos", "ciResults": true } }
```

**`integrations.linear`**

| Field | Required | Meaning |
|---|---|---|
| `enabled` | yes | `true` turns Linear on, `false` turns it off and keeps the other fields. |
| `clientId` | when `enabled` is `true` | The Linear app's client ID. |

**`integrations.githubApp`** turns on the GitHub App and its webhooks
together ([docs/github.md](github.md)). `bun run github:setup` writes it.

| Field | Required | Meaning |
|---|---|---|
| `enabled` | yes | `true` turns the App and its webhooks on, `false` turns them off (GitHub then uses `GITHUB_TOKEN`) and keeps the other fields. |
| `appId`, `installationId`, `botUserId` | when `enabled` is `true` | Positive integers: the App, its installation, and the bot's GitHub user ID. |
| `slug` | when `enabled` is `true` | The App's slug. The bot's login is `<slug>[bot]`, and users `@<slug>` to mention it. |
| `tokens` | when `enabled` is `true` | `"devbox"`: a minter keeps the token fresh. `"external"`: your own tooling does. |
| `tokenScope` | no, default `"repos"` | `"repos"` narrows each minted token to the repos in `repos`; `"installation"` covers every repo the App is installed on. |
| `ciResults` | no, default `true` | Failed CI runs on the agent's pull requests reach the task (`GITHUB_CI_RESULT_ENABLED`). |
| `tokenFile` | with `tokens: "external"` on Compose | The absolute path of the token file your tooling keeps fresh. In a directory of its own: the directory is mounted read-only. Refused on Kubernetes. |
| `org` | no | The organization that owns the App; `github:setup` writes it, and the settings links use it. Not a chart value. |
| `pending` | no | A new App waiting for its install while the current one keeps working (`appId`, `slug`, `org`). Only `github:setup` reads it. |

**`github`** is a top-level key: `trustedOrgs` and `trustedUsers`, lists of
strings ([Trust settings](#trust-settings)). With `integrations.githubApp`
enabled, one of them must be set.

`publicUrl` is a top-level key, not part of a block: the public HTTPS URL
webhooks reach. One tunnel or Ingress serves every integration, so Linear and
GitHub share it. Only the CLI (`linear:setup`, `github:setup` and the
`*:status` commands) reads it.

`bun run linear:setup` writes this block ([docs/linear.md](linear.md)); you may
also edit it. Unknown keys are refused. Only `enabled: true` turns Linear on: a
`LINEAR_*` variable in your shell or a saved secret never does. With
`enabled: true`, `up` needs the two Linear secrets
([Secrets](#secrets)), checks the client secret with Linear, and passes
`LINEAR_ENABLED`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and
`LINEAR_WEBHOOK_SECRET` to the control plane. Otherwise it passes all four
empty.

With `integrations.githubApp.enabled: true`, `up` needs the App's private key
(unless `tokens` is `"external"`) and `GITHUB_WEBHOOK_SECRET`
([Secrets](#secrets)), checks the App and its installation with GitHub, starts
the token minter (devbox tokens) or reads `tokenFile` (external tokens), and
turns on the control plane's webhooks. Otherwise `GITHUB_TOKEN` is the token.

Slack is Kubernetes-only for now: `up` refuses an `integrations.slack` block
with `integrations.slack: supported on Kubernetes only (the target file)`. The
old `integrations.githubWebhooks` block is gone, and is refused with
`integrations.githubWebhooks: replaced by integrations.githubApp; run bun run github:setup`.
The Kubernetes commands ignore `devbox.config.json`'s `integrations` block and
read the target file's.

### The target file (`--target`)

A target file names one deployment of the setup in `devbox.config.json`: the
cluster, the CLI profile and the chart values. Every `bun run k8s:*` command
takes `--target <file>`; there is no default and no fallback to the current
kube context, so a command never acts on a cluster you did not name.
`bun run k8s:kind` writes `devbox.kind.json` itself. Name yours
`devbox.k8s.json`; both names are gitignored.

```json
{
  "context": "my-eks",
  "profile": "k8s-my-eks",
  "values": {
    "storage": { "storageClass": "gp3", "volumeSnapshotClass": "ebs-snapclass" },
    "sandbox": { "maxConcurrent": 5, "cpu": "2", "memory": "8Gi" }
  }
}
```

| Key | Required | Meaning |
|---|---|---|
| `context` | yes | The kube context of the cluster. |
| `profile` | no, default `k8s-<context>` | The CLI profile the installer writes. Lower-case letters, digits and `-`; the default is the context made lower-case with other characters replaced by `-`. |
| `values` | no | Helm values for the chart, passed as they are. `storage.storageClass` and `storage.volumeSnapshotClass` are required by the chart. Sandbox sizing goes under `values.sandbox`; the Compose-only `devbox.config.json` block is ignored. `repos` and `llm` are refused: the installer copies the full `llm` block, including effort and stage overrides, from `devbox.config.json`. `integrations` is refused: it goes at the top level. |
| `integrations` | no | The deployment's integrations: `linear` (`enabled`, `clientId`), `slack` (`enabled`, `channelId`) and `githubApp` (the fields [above](#integrations) except `tokenFile`; `slug` is copied as `botLogin`), with the same `enabled` rule. The installer copies them into the chart values. The top-level `publicUrl` (the public HTTPS URL webhooks reach, shared by all integrations) is read only by the CLI, never copied ([customizing.md](kubernetes/customizing.md#integrations)). The trust lists go under `values.github`. |

Any other key is an error: chart values go under `values`. The installer adds
`repos`, `llm`, `integrations`, `ironProxy.clusterIP`,
`controlPlane.publicBaseUrl` and, from a GitHub token it resolved itself, the
commit identity to the values; a value you set wins. See
[docs/kubernetes/README.md](kubernetes/README.md).

### `bun run up --dns-resolver <host:port>`

Default `1.1.1.1:53`. The DNS server iron-proxy uses for its own lookups in
the local stack. Docker's DNS would resolve the aliased hosts (`github.com`,
the LLM host) back to the proxy itself, so the proxy needs a resolver outside
Docker. On networks that block public DNS (some corporate networks and VPNs),
pass a DNS server that works there. Kubernetes installs ignore it: iron-proxy
uses the cluster's DNS.

## Secrets

`bun run up` and `bun run k8s:install` look for each secret in this order:

```
your environment → the system keychain → gh auth token (GITHUB_TOKEN only) → a hidden prompt
```

| Secret | Variable | Needed |
|---|---|---|
| GitHub token | `GITHUB_TOKEN` | without the GitHub App (or with it disabled) |
| GitHub App private key | `GITHUB_APP_PRIVATE_KEY_FILE` (a path) or `GITHUB_APP_PRIVATE_KEY` (the PEM) | with `integrations.githubApp.enabled: true` and `tokens: "devbox"` |
| LLM API key | `LLM_API_KEY` | always |
| Linear client secret, webhook signing secret | `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` | with `integrations.linear.enabled: true` |
| Slack bot token | `SLACK_BOT_TOKEN` | Kubernetes, with `integrations.slack.enabled: true` |
| GitHub webhook secret | `GITHUB_WEBHOOK_SECRET` | with `integrations.githubApp.enabled: true` |

An integration that is off has its secrets ignored: none is looked up, even
when the variable is set.

- **It says where each value comes from:** `<NAME>: from your environment`,
  `<NAME>: from the system keychain (<scope>)` or `GITHUB_TOKEN: from gh`.
  Otherwise it prompts.
- **A variable that is set wins.** For `GITHUB_TOKEN` and `LLM_API_KEY` that
  holds even when it is empty: an empty `LLM_API_KEY` means the endpoint needs
  no key. An empty Linear, Slack or webhook secret counts as missing.
- **The App's private key is never prompted for.** A PEM has many lines, so
  it comes from `GITHUB_APP_PRIVATE_KEY_FILE`, then `GITHUB_APP_PRIVATE_KEY`,
  then the keychain entry `GITHUB_APP_PRIVATE_KEY`. `github:setup` saves it,
  or writes it to a file ([docs/github.md](github.md#the-private-key)).
  devbox never deletes it on its own.
- **Prompts hide the input.** After a prompt, and once the value's check
  passed (or right away when it has no check, or the check is skipped), it
  asks `Save <NAME> to the system keychain for <scope>? [Y/n]`. Enter saves.
  Values from your environment or `gh` are never saved.
- **Without a terminal** (CI), it reads the environment and the keychain,
  never prompts and never offers to save. A missing secret stops the run,
  naming the variable.

### The keychain

devbox keeps saved secrets in the system keychain: the macOS Keychain, the
Secret Service on Linux (libsecret), Windows Credential Manager. The entries
are under the service `devbox`, one set per deployment, so a local stack and
each cluster keep their own tokens:

| Deployment | Scope | Entry name |
|---|---|---|
| The local stack | `compose` | `compose/<NAME>` |
| A cluster | `k8s:<context>/devbox` | `k8s:<context>/devbox/<NAME>` |

- Where the platform has no keychain (headless Linux without libsecret),
  `up`, `k8s:install` and the `linear:*` and `github:*` commands skip it without
  a message.
  `bun run secrets` prints `The system keychain is not available on this
  machine.` and exits 1.
- `--no-keychain`, on `up`, `k8s:install`, `linear:setup`, `linear:status`,
  `linear:disable`, `github:setup`, `github:status` and `github:disable`, never
  reads or writes it.
- `bun run linear:setup` saves the two Linear secrets only if you choose to,
  and never takes them from your environment ([docs/linear.md](linear.md#saving-the-secrets-or-not)).
  `bun run github:setup` does the same for the App's private key and webhook
  secret ([docs/github.md](github.md#the-private-key)).

### Rejected values

When a check rejects a secret (GitHub, the LLM endpoint or Linear refuses it):

- **A saved value** is removed: `The saved <NAME> for <scope> was rejected;
  removing it`. Then, with a terminal, it is asked for as a typed one is.
- **A typed value**, with a terminal: the check's message, then
  `Enter <NAME> again, or press Enter on an empty value to exit.`, and the
  prompt again, until a value is accepted. An empty answer stops the run,
  naming the variable.
- **A value from your environment or `gh`**, or any value without a terminal:
  the run stops with the check's message. A variable is never changed.

### `bun run secrets`

```bash
bun run secrets ls [--target <file>]
bun run secrets rm <NAME> [--target <file>]
bun run secrets clear [--target <file>] [--yes]
```

Without `--target`, they act on the local stack's entries; with it, on the
cluster that target file names.

- `ls` prints each secret's name and where it would come from: `env`,
  `keychain`, `gh` or `missing`. Never a value.
- `rm` removes one saved secret, without asking.
- `clear` removes every saved secret of the deployment. It is
  [destructive](#destructive-commands): it asks first, and needs `--yes`
  without a terminal.

There is no `secrets set`: run `up` or `k8s:install` in a terminal and save
the value at the prompt, or use `linear:setup` for the Linear secrets and
`github:setup` for the GitHub App's.

### Destructive commands

`bun run secrets clear`, `bun run linear:disable --forget`,
`bun run github:disable --forget` and `bun run k8s:uninstall --purge` delete data, and confirm the same way:

- **With a terminal**, they list what they will delete, one item per line,
  and ask a question ending `[y/N]`. Enter or Ctrl-D answers no: nothing is
  deleted, and they print `Nothing was removed.`
- **Without a terminal**, they refuse unless you pass `--yes`:
  `<command> deletes data: pass --yes to confirm without a terminal`.
- **`--yes`** skips the question, with or without a terminal.

`secrets rm <NAME>` and a plain `k8s:uninstall` don't ask.

### The GitHub token

With the GitHub App enabled there is no `GITHUB_TOKEN`: the App's
installation token is the token, and the checks below run on it. With
devbox-minted tokens the App must be installed on every configured repo (a
repo it does not cover stops `up` and `k8s:install` with
`These repos are not in the GitHub App's installation: …`). See
[docs/github.md](github.md).

Otherwise, the GitHub token needs Contents and Pull requests, both read and write, on
every configured repo. Before anything starts, devbox checks that it has them
and that the LLM endpoint answers.
[What preflight checks](#what-preflight-checks) lists every request those
checks make.

The checks also give the agent's commit identity:

- **With a personal access token:** your name (or login) and
  `<id>+<login>@users.noreply.github.com`.
- **With the GitHub App enabled** ([docs/github.md](github.md)): the App's bot,
  `<slug>[bot]` and `<botUserId>+<slug>[bot]@users.noreply.github.com`. On
  Kubernetes, `git.name` and `git.email` under `values` still win.
- **With another App token or an Actions token,** which has no user, or with
  `bun run up --skip-checks`: the harness image's default identity. On
  Kubernetes, set `git.name` and `git.email` under `values` in the
  [target file](#the-target-file---target) to name the App instead.
- **On Kubernetes, with your own GitHub Secret** (`existingSecret`): the
  installer doesn't read it, so the identity is `git.name` and `git.email`
  from the values, or the chart's default.

### Where the secrets go

`bun run k8s:install` looks the secrets up the same way, with these
differences: the LLM key must not be empty, the secrets go into Kubernetes
Secrets instead of a process environment, and it resolves none for a Secret
you named with `existingSecret`
([docs/kubernetes/secrets.md](kubernetes/secrets.md)).

`up` passes the secrets only in the environment of the `docker compose` process
it starts. Compose gives `GITHUB_TOKEN` and `LLM_API_KEY` to iron-proxy, and
`GITHUB_TOKEN` (and the Linear secrets, with Linear on) to the control plane.
With the GitHub App, `GITHUB_TOKEN` is empty: the token is a file in a volume
the minter fills (or your `tokenFile`'s directory), and the control plane gets
`GITHUB_WEBHOOK_SECRET`. The App's private key goes only to the minter, as a
Compose secret.
They are not written to a file, only to the keychain when you save them.
`docker inspect` on those containers shows them.

The CLI's API token is the one secret written to a file. `up` creates it and
writes it, with the API URL, as the profile `local` in
`$XDG_CONFIG_HOME/devbox/config.json` (by default
`~/.config/devbox/config.json`), with mode `0600` (see
[CLI profiles](#cli-profiles)). On the next `up`, it keeps the token if the API
still accepts it.

### What preflight checks

These flows run the checks, which the code calls preflight:

| Flow | When the checks run | How to skip them |
|---|---|---|
| `bun run up` | Step 3, before any container starts | `--skip-checks` skips all of them, LLM and Linear included |
| `bun run k8s:install` | Step 2, before the namespaces, Secrets and chart are installed. A re-run (an upgrade) checks again. | `--skip-push-check` skips requests 3 and 4, `--skip-llm-check` request 5, `--skip-linear-check` requests 6 and 7 |
| `bun run k8s:kind` | It runs `k8s:install`, so the same as above | Same as above |
| `bun run k8s:check` | When you run it, against the values in the cluster's Secrets | `--skip-push-check` skips requests 3 and 4 |

`k8s:connect`, `k8s:refresh-snapshot` and `k8s:uninstall` don't check the
token. `k8s:install` checks only the values it resolved itself, from the
[lookup order above](#secrets): it never reads a Secret you named with
`existingSecret`. `bun run k8s:check` checks those
([docs/kubernetes/README.md](kubernetes/README.md#check-the-secrets)).

Preflight makes these requests in order, and stops at the first failure. In the
error messages, `[...]` marks a part that appears only when GitHub gives a
reason.
Requests 1 to 4 use the GitHub token; requests 2 to 4 run once per repo, in
the order of `repos`. Request 5 uses the LLM key. Requests 6 and 7 run only
with Linear enabled, and use the client ID and `LINEAR_CLIENT_SECRET`.

| # | Request | What it proves | Passes on | Fails with |
|---|---|---|---|---|
| 1 | `GET https://api.github.com/user`, once | GitHub accepts the token. The answer also gives the commit identity. | 200 (a PAT), or 403 with `Resource not accessible by integration` (an App or Actions token, which has no user) | `GitHub rejected GITHUB_TOKEN (GET /user returned <status>[: <GitHub's message>])`. Any other 403, for example SAML enforcement, fails here too. |
| 2 | `GET https://api.github.com/repos/<owner>/<repo>` | The repo exists and the token can see it | 200 | `<owner>/<repo> (repos[<i>]) does not exist or GITHUB_TOKEN cannot see it (GET /repos/<owner>/<repo> returned <status>[: <GitHub's message>])` |
| 3 | `GET https://github.com/<owner>/<repo>.git/info/refs?service=git-receive-pack`, with the token as the Basic-auth password of `x-access-token` and `User-Agent: git/devbox-up`. Redirects are not followed. | The token can push. This is the first step of a `git push`; GitHub answers it only for a token that can push, and nothing is pushed. | 200 | `GITHUB_TOKEN cannot push to <owner>/<repo> (repos[<i>]): git's push endpoint returned <status>[: <GitHub's text>]; check the token has Contents: read and write (...)`. GitHub's text names other causes, for example an archived repo. A redirect means the repo was renamed or transferred: `<owner>/<repo> (repos[<i>]) has moved to <url>: update repos[<i>].url` |
| 4 | `POST https://api.github.com/repos/<owner>/<repo>/pulls`, asking for a pull request from a random branch that doesn't exist (`devbox-preflight-<16 hex digits>`) into the repo's `branch` | The token can open pull requests. GitHub checks the permission before it checks the branch. | 422, which means the request was allowed and then rejected because the branch doesn't exist | `GITHUB_TOKEN cannot open pull requests in <owner>/<repo> (repos[<i>]): POST /repos/<owner>/<repo>/pulls returned <status>[: <GitHub's message>]; check the token has Pull requests: read and write (...)` |
| 5 | The LLM request, once: a one-message chat completion, or a Responses call, to `llm.baseUrl` with the LLM key | The endpoint, model and key work | 2xx | `LLM check failed: ...`. `k8s:install --skip-llm-check` skips it. |
| 6 | `POST https://api.linear.app/oauth/token`, the client-credentials grant with the client ID and secret | Linear accepts the app's credentials, and the app allows client credentials | a token | `Linear rejected the client ID or LINEAR_CLIENT_SECRET (invalid_client): ...`, `the Linear app does not allow client credentials: ...`, or `can't reach api.linear.app: ...` |
| 7 | `POST https://api.linear.app/graphql`, `{ viewer { name } organization { name urlKey } }`, with that token | The app user and the workspace devbox acts in. They are printed: `Linear: devbox acts as <name> in workspace <workspace>`. | 200 with both | `Linear check failed: ...` |

**Rate limits.** If GitHub answers any of requests 1 to 4 with 429, or with a
403 that is a rate limit (`x-ratelimit-remaining: 0`, or a message about a rate
limit), preflight fails with
`GitHub rate limit hit (<request> returned <status>[: <GitHub's message>])[; retry in <n>s | ; retry after <time>]`,
not with a permission error. Preflight makes 1 + 3 × (number of repos) GitHub
requests per run.

What the requests leave behind:

- **In the repo, nothing.** No branch is created, nothing is pushed, and no pull
  request is opened.
  - The one exception is a branch with that random name already existing. Then
    request 4 opens a real pull request, and preflight closes it straight away
    (`PATCH /repos/<owner>/<repo>/pulls/<number>`). The pull request still
    existed for a moment, so GitHub sends its notifications and may request
    CODEOWNERS reviews.
  - If that close fails, preflight stops with
    `the pull request check opened a real pull request in <owner>/<repo>, ... and could not close it (...): close <url> by hand`.
- **Outside the repo:** the requests count against the token's rate limit, like
  any other API call. An organization's audit log may record them.
- **The token itself:** never printed, and never written anywhere by
  preflight.

Why devbox doesn't read `permissions.push` from request 2: that field doesn't
describe the token.

- For a fine-grained PAT, it is the token owner's role on the repo. A read-only
  token of a repo admin reads `push: true`.
- For a GitHub App or Actions token, every field is `false`, even for a token
  that can push.

Requests 3 and 4 check what the token can do, whatever kind it is.

What each kind of token needs, and what preflight reports. Each row was tested
against GitHub on 2026-10-15:

| Token | Needs | Request 1 | Missing Contents write | Missing Pull requests write |
|---|---|---|---|---|
| Classic PAT | scope `repo`. `public_repo` only works for public repos. | 200, identity from your account | fails at 3, or at 2 for a private repo with `public_repo` | can't happen: `repo` grants both |
| Fine-grained PAT | Contents and Pull requests: read and write, on the configured repos | 200, identity from your account | fails at 3 | fails at 4, `Resource not accessible by personal access token` |
| GitHub App installation token | the App's Contents and Pull requests: read and write, installed on the configured repos | 403, so the default commit identity applies ([above](#the-github-token)) | fails at 3 | fails at 4, `Resource not accessible by integration` |
| Actions `GITHUB_TOKEN` | `permissions: contents: write, pull-requests: write` in the workflow, **and** the repo setting below | 403, as for an App | fails at 3 | fails at 4, `Resource not accessible by integration` |

An Actions token also needs Settings → Actions → General → Workflow
permissions → **Allow GitHub Actions to create and approve pull requests**. An
organization can turn this off for all of its repos.

- **With the setting off,** request 4 fails even when the workflow grants
  `pull-requests: write`, with GitHub's message `GitHub Actions is not permitted
  to create or approve pull requests.` (tested).
- **With the setting on,** request 4 passes, as it does for an App token
  (tested).

What preflight doesn't check:

- **Workflows permission.** The agent can't change files under
  `.github/workflows` without it. Preflight doesn't ask for it, because most
  tasks don't need it.
- **Branch protection and rulesets.** The agent pushes to a new branch, so
  these only matter if they cover every branch.
- **That `branch` exists.** Cloning it fails later, in the repos volume (Compose)
  or the snapshot build (Kubernetes).
- **That the token will still be valid later.** A token that expires, is
  revoked or loses access after the checks makes tasks fail when they push or
  open the pull request. App installation tokens expire after an hour. With
  `integrations.githubApp` and `tokens: "devbox"`, devbox mints a fresh one
  every 30 minutes; with `tokens: "external"`, your tooling must
  ([docs/github.md](github.md#external-tokens)). A personal token you rotate
  yourself, on Kubernetes as
  [docs/kubernetes/secrets.md](kubernetes/secrets.md#rotation) describes.

With `--skip-push-check`, devbox still installs with a token that can only
read. Tasks run, but each one fails when it pushes or opens its pull request.
devbox's own Kubernetes CI does this on purpose, with a read-only Actions
token.

## Environment variables

There are three namespaces:

| Namespace | Read by | Examples |
|---|---|---|
| No prefix or subsystem prefix | the control plane | `DATABASE_URL`, `GITHUB_TOKEN`, `SANDBOX_RUNTIME` |
| `HARNESS_*` | the agent in the sandbox | `HARNESS_MODEL`, `HARNESS_REVIEW_ENABLED` |
| `DEVBOX_CLI_*` | the CLI | `DEVBOX_CLI_URL`, `DEVBOX_CLI_TOKEN` |

### What reaches the sandbox

The control plane forwards only the `HARNESS_*` settings explicitly listed in
`control-plane/src/forwardedEnv.ts`. It also accepts the enumerated
`HARNESS_<STAGE>_MODEL` and `HARNESS_<STAGE>_REASONING_EFFORT` families. Matching
the prefix alone is not enough: an unknown `HARNESS_*` variable remains in the
control plane. This prevents Kubernetes Service-link variables, platform input,
and stray values from crossing into every sandbox.

- **Real secrets never use a forwarded name.** They are `GITHUB_TOKEN` and
  `LLM_API_KEY`. `HARNESS_LLM_API_KEY` holds only the dummy value that
  iron-proxy swaps for the real key. Never put a real secret in a name listed by
  the forwarding contract.
- **`DEVBOX_CLI_*` never reaches the sandbox.** It remains the CLI namespace.
- **`HARNESS_TRUSTED_ORGS` and `HARNESS_TRUSTED_USERS`** are set separately from
  the control plane's validated `GITHUB_TRUSTED_ORGS` and
  `GITHUB_TRUSTED_USERS`; they are not generic forwarded input (see
  [Trust settings](#trust-settings)).
- **Runtime-only `DEVBOX_*` names remain internal to the sandbox.** Paths use
  `DEVBOX_DIR`, `DEVBOX_SCRIPTS_DIR`, `DEVBOX_PROMPTS_DIR` and
  `DEVBOX_RUNTIME_DIR`. The daemon sets `DEVBOX_EVENTS_FILE`,
  `DEVBOX_EVENTS_LOCK`, `DEVBOX_INBOX_ID` and `DEVBOX_TARGET_IDS`. None is on the
  forwarding list.

This is a clean namespace break: legacy `DEVBOX_*` harness configuration is not
accepted or forwarded. Rename operator settings to the corresponding
`HARNESS_*` name.

### Configuring the local stack

Configure the Compose deployment only through the supported settings in
`devbox.config.json` and then run `bun run up` again. `llm`, `sandbox`, `github`
and `integrations` are translated to the control-plane and sandbox environment
by `up`; same-named values in your shell do not override them. Agent model and
effort settings therefore belong in `llm`, not in hand-set `HARNESS_*` variables.

Agent tuning that has no `devbox.config.json` field is Kubernetes-only: put the
variable in the chart's `extraEnv` (or under `values.extraEnv` in a target
file). There is no supported Compose path for those tuning variables. Never put
a real secret in a forwarded `HARNESS_*` name, because its value reaches every
sandbox.

Two variables are read by Compose itself. Set them in the shell you run
`bun run up` from:

- `POSTGRES_PORT`, default `5432`. The stack's Postgres listens on
  `127.0.0.1:<POSTGRES_PORT>`. If a local Postgres already uses 5432, `up` fails
  when Compose starts, with Docker's "port is already allocated". Run
  `POSTGRES_PORT=5433 bun run up` instead.
- `OPENSANDBOX_IMAGE`, the OpenSandbox server image.

Ports 3000 (the API) and 8080 (the OpenSandbox server) are fixed.

### Control-plane settings

The deployment sets these; they matter when you run the control plane another
way.

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_RUNTIME` | `docker` | `docker` (workspace volumes copied from `devbox-repos`) or `k8s` (PersistentVolumeClaims restored from repo snapshots). `k8s` also needs `PVC_STORAGE_CLASS`. |
| `MAX_CONCURRENT_SANDBOXES` | `50` | Running-sandbox soft cap. Compose sets it from `sandbox.maxConcurrent` (default `5`); the chart sets it from `sandbox.maxConcurrent` (default `5`). |
| `SANDBOX_RESOURCE_CPU` | `2` | Per-sandbox CPU limit. Compose sets it from `sandbox.cpu` (default `2`); the chart sets it from `sandbox.cpu` (default `2`). |
| `SANDBOX_RESOURCE_MEMORY` | `8Gi` | Per-sandbox memory limit. Compose sets it from `sandbox.memory` (default `4Gi`); the chart sets it from `sandbox.memory` (default `8Gi`). |
| `GITHUB_TOKEN_FILE` | | A file holding the control plane's GitHub token. It is re-read at most every 60 seconds, so a rotated token is picked up without a restart. Wins over `GITHUB_TOKEN`. The chart mounts the GitHub Secret there. |
| `GITHUB_TOKEN` | | The token itself, when `GITHUB_TOKEN_FILE` is unset. Compose sets it with a personal token. |
| `GITHUB_WEBHOOKS_ENABLED` | | `true` turns on `POST /webhook/github`. Set with the GitHub App enabled. |
| `GITHUB_WEBHOOK_SECRET` | | The App's webhook secret, which signs each delivery. |
| `GITHUB_BOT_LOGIN`, `GITHUB_BOT_USER_ID` | | The App's slug and its bot's numeric user ID. Events from the bot itself, and on pull requests it did not open, are dropped. |
| `GITHUB_CI_RESULT_ENABLED` | | `true` sends a failed CI run on a task's pull request to the task. The setting `integrations.githubApp.ciResults` sets it. |
| `GITHUB_CI_RESULT_MAX_PER_TASK` | `20` | The most CI failures sent to one task. Environment only. |
| `SANDBOX_GIT_NAME`, `SANDBOX_GIT_EMAIL` | | The commit identity of the agent in every sandbox. Set both or neither. Unset, the harness image's own identity applies. The chart sets them from `git.name` and `git.email`. |

### Settings for the token minter

`bun run github-token` is the control-plane image run as the GitHub App's
token minter ([docs/github.md](github.md)). Compose and the chart set these;
they matter when you run it another way. `--once` writes one token and exits.

| Variable | Meaning |
|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` | The App and its installation. Required. |
| `GITHUB_APP_PRIVATE_KEY_FILE` | The path of the App's private key (PEM). Required. Compose and the chart mount the key there. |
| `GITHUB_APP_REPOSITORIES` | The repo names (without the owner), comma-separated, that each token is narrowed to. Empty: the whole installation. |
| `GITHUB_TOKEN_SINK` | Where the token goes: `file:<path>` (the token, and `expires-at` beside it), or `secret:<namespace>/<name>` (a Kubernetes Secret, patched with `kubectl`). Required. |

It mints a token 30 minutes before the last one expires. On a failure the loop
retries after 5 seconds, doubling to 5 minutes, and never exits on a GitHub
error; `--once` stops at once on a 401, 403, 404 or 422 and gives up after 5
attempts on anything else. It exits 1 on bad startup input.

### Settings for the agent

These are the forwarded `HARNESS_*` variables worth knowing. Empty counts as unset unless a row notes stricter validation.

| Variable | Default | Meaning |
|---|---|---|
| `HARNESS_LLM_PROVIDER` | `openai` | Derived from `llm.provider`. |
| `HARNESS_LLM_BASE_URL` | none | Derived from required `llm.baseUrl`. |
| `HARNESS_MODEL` | `gpt-5.6-sol` (`openai`), `claude-opus-5-5` (`anthropic`) | Derived from required `llm.model` in a deployment. These code models apply only to a standalone harness when the variable is unset. |
| `HARNESS_LLM_API_KEY` | deployment-provided | The dummy value iron-proxy swaps for the real key. |
| `HARNESS_<STAGE>_MODEL` | `HARNESS_MODEL`, then provider code model | Derived from `llm.stages.<stage>.model`. Model resolution is independent of effort resolution. |
| `HARNESS_REASONING_EFFORT` | unset | Derived from `llm.reasoningEffort`. When present it replaces every stage's code-default effort unless that stage has an override. |
| `HARNESS_<STAGE>_REASONING_EFFORT` | stage code default | Derived from `llm.stages.<stage>.reasoningEffort`; see the [seven-stage table](#llm). |
| `HARNESS_REVIEW_ENABLED` | `true` | `false` skips the agent's review of its own change. |
| `HARNESS_DISTILLATION_ENABLED` | `true` | Non-empty values other than `1`, `true`, `yes`, or `on` skip assignment and follow-up knowledge distillation. Empty counts as unset and keeps the default. |
| `HARNESS_REPO_KNOWLEDGE_DIR` | `.agents/knowledge` | Repository-relative directory used to read, write, and publish knowledge at repo and component scope. It must be non-empty and below the scope root; absolute paths, `.`, `..` segments, and backslashes fail the task when the first agent that reads repository knowledge starts. The directory may be a symlink to another directory inside the repository; one that resolves outside the repository, or to the repo or component root itself, is ignored with a log line. |
| `HARNESS_REVIEW_MAX_ITERATIONS` | `2` | The most review-then-fix passes. `1` reviews without fixing. |
| `HARNESS_REVIEW_MAX_PARALLEL_LENSES` | `6` | The most review agents that run at once. |
| `HARNESS_SYNC_REPOS_BEFORE_PLANNING` | `true` | `false` skips fetching the latest commits before planning. |
| `HARNESS_POLL_INTERVAL_SECONDS` | `1.0` | How often the harness checks its inbox. |
| `HARNESS_DEEPAGENTS_MODEL_TIMEOUT_SECONDS` | `180` | How long a model response may stay silent before the request fails and is retried. |
| `HARNESS_DEEPAGENTS_MODEL_MAX_RETRIES` | `5` | Retries of one model request. |
| `HARNESS_DEEPAGENTS_MAX_RETRIES` | `3` | Retries of a whole agent run after a transient LLM error. |
| `HARNESS_DEEPAGENTS_RETRY_BASE_SECONDS` | `10` | The first wait before such a retry. It doubles on each retry. |
| `HARNESS_DEEPAGENTS_RETRY_MAX_SECONDS` | `300` | The longest wait before such a retry. |
| `HARNESS_DEEPAGENTS_RATE_LIMIT_MIN_SECONDS` | `30` | The shortest wait after the endpoint rate-limits a request. |
| `HARNESS_TRUSTED_BOT_IDS` | none | See [Trust settings](#trust-settings). |

`<STAGE>` is one of `ORIENTATION`, `PLANNING`, `PLAN_REVIEW`, `IMPLEMENTATION`,
`DISTILLATION`, `REVIEW` and `FOLLOWUP`. Configure these through the camelCase
`llm.stages` keys documented [above](#llm). Other agent settings in this table
have no Compose configuration path; on Kubernetes, set them with `extraEnv`.

### The CLI's variables

The CLI takes its API URL and token from, in order:

1. `--url` and `--token`;
2. `DEVBOX_CLI_URL` and `DEVBOX_CLI_TOKEN`;
3. a profile in the CLI config file (see [CLI profiles](#cli-profiles)).

A URL from a flag or `DEVBOX_CLI_URL` never reads the file, because the file's
token belongs to the file's URL. `--token` or `DEVBOX_CLI_TOKEN` overrides the
profile's token. If the file is readable by other users, the CLI warns and
still uses it.

### CLI profiles

The CLI config file, `$XDG_CONFIG_HOME/devbox/config.json` (by default
`~/.config/devbox/config.json`), holds named profiles, each a control plane URL
and an API token, and names the current one:

```json
{
  "current": "local",
  "profiles": {
    "local": { "url": "http://localhost:3000", "token": "dbx_…" },
    "k8s-my-cluster": { "url": "http://localhost:13000", "token": "dbx_…" }
  }
}
```

- `bun run up` writes the profile `local`. `bun run k8s:install` writes one per
  cluster, `k8s-<context>` or the target file's `profile`. Both make theirs
  current.
  `bun run k8s:uninstall` removes its profile.
- The CLI uses the profile named by `--profile <name>`, else by
  `DEVBOX_CLI_PROFILE`, else the current one.
- Profile names use lower-case letters, digits and `-`.
- The commands, which need no control plane:

  ```bash
  bun run devbox profile ls                 # * marks the current profile; --json for JSON
  bun run devbox profile use <name>         # make a profile current
  bun run devbox profile add <name> --url <url> --token <token> [--use]
  ```

  `profile add` adds or replaces a profile, for a control plane installed
  without the installer.
- A config file in the older format, a single URL and token, is replaced on the
  next `bun run up` or `bun run k8s:install`.

## Trust settings

Anyone who can comment on a pull request could try to steer the agent through
the comment. The agent reads pull request discussion only from authors you
trust. There are no defaults, and with nothing configured it reads none.

| Variable | Where | Meaning |
|---|---|---|
| `GITHUB_TRUSTED_ORGS` | control plane | GitHub orgs whose members are trusted. Comma- or space-separated. |
| `GITHUB_TRUSTED_USERS` | control plane | GitHub logins that are trusted. Comma- or space-separated. |
| `HARNESS_TRUSTED_BOT_IDS` | sandbox | Numeric GitHub user IDs of bots, for example a review bot, whose comments are also trusted. Comma- or space-separated. |

- On Compose, `up` sets `GITHUB_TRUSTED_ORGS` and `GITHUB_TRUSTED_USERS` from
  the top-level `github` block of `devbox.config.json` (`trustedOrgs`,
  `trustedUsers`). `bun run github:setup` fills it when empty, with the account
  that owns the App's installation.
- The control plane forwards `GITHUB_TRUSTED_ORGS` and `GITHUB_TRUSTED_USERS` to
  the sandbox as `HARNESS_TRUSTED_ORGS` and `HARNESS_TRUSTED_USERS`.
- `HARNESS_TRUSTED_BOT_IDS` has no control-plane counterpart. On Kubernetes,
  set it with the chart's `extraEnv`; it is on the forwarding list. It adds to the trusted orgs and users. On its own, it
  trusts no one. There is no supported Compose configuration path.
- If an org's member list can't be fetched, the agent reads no discussion.
- On Kubernetes, set the two lists with the chart values `github.trustedOrgs`
  and `github.trustedUsers`, not `extraEnv`
  ([customizing.md](kubernetes/customizing.md#integrations)).

With the GitHub App, the trust lists also decide whose `@mentions` and
reviews reach the agent ([docs/github.md](github.md#trust-lists)).

In the quickstart, none of these is set. Follow-ups come from
`bun run devbox send`, and the agent reads no pull request discussion.

## What iron-proxy allows

`up` writes iron-proxy's config, `control-plane/infra/local/iron-proxy.yaml`,
from `control-plane/infra/local/iron-proxy.template.yaml` and
`devbox.config.json`. The code is `control-plane/scripts/up/ironProxy.ts`.
iron-proxy reads the config only once, so `up` then recreates it, in every
token mode. A repo you remove from `repos` loses its rules on that `up`.
Recreating it briefly cuts sandboxes off from the hosts below.

| Host | Allowed |
|---|---|
| `github.com` | `GET` and `HEAD` on every path, `POST` to `/*/*/git-upload-pack` (clones and fetches of any repo). Everything on `/{owner}/{repo}/*` and `/{owner}/{repo}.git/*` for each configured repo (pushes). |
| `codeload.github.com` | `GET` and `HEAD` |
| `api.github.com` | `/repos/{owner}/{repo}/*` for each configured repo; `GET` and `HEAD` on `/orgs/{org}/members` for each trusted org and on `/users/*` (the sandbox's trust lookups) |
| `*.blob.core.windows.net` | `GET` and `HEAD` on `/actions-results/*` (CI job log downloads). On Compose this rule has no effect: the host is not an iron-proxy alias. |
| `raw.githubusercontent.com` | `/{owner}/{repo}/*` for each configured repo |
| the LLM host | `POST` to the one endpoint the agent calls: `<path of llm.baseUrl>/responses` for `openai`, `<path of llm.baseUrl>/v1/messages` for `anthropic` |

A trailing `/*` matches the path itself and everything under it. iron-proxy
puts the real GitHub token on requests to `github.com`, `api.github.com` and
`raw.githubusercontent.com`, and the real LLM key on requests to the LLM host.
Sandbox traffic to other hosts does not go through iron-proxy.
