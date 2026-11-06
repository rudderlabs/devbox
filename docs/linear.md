# Linear

devbox can work from Linear. You connect it to your Linear workspace once,
with a Linear app that belongs to one devbox deployment: the local stack
(`bun run up`) or a Kubernetes install (`bun run k8s:install`, or GitOps).

## What you get

- **Delegate an issue** to the agent, or **@mention** it on an issue, and it
  starts a task, as `bun run devbox create` does. It moves the issue to the
  team's first "started" state, posts its progress to the agent session and
  opens a draft pull request.
- **Follow-ups** you write in the agent session reach the task, like
  `bun run devbox send`.
- Stopping a session from Linear is not supported yet: the agent answers that
  it can't stop.

The agent works on the repos in `devbox.config.json`. With more than one,
name the repo in the issue.

devbox uses Linear's client-credentials grant: there is no consent screen and
no token stored. The control plane asks Linear for a token when it needs one
and keeps it in memory. One deployment works with one Linear workspace, the
one that owns the app.

## The public URL

Linear delivers webhooks to `<publicUrl>/webhook/linear`; see
[The public URL](public-url.md) for what the URL must be and how to get one.
`linear:setup` registers the Linear app with it, and the app stores it: when
the URL changes, the app is updated by hand
([When the public URL changes](#when-the-public-url-changes)).

## Setup

Every deployment follows the same three steps: `linear:setup` registers the
app and records its settings, the deployment's usual command applies them,
and `linear:status` checks the result. `linear:setup` applies nothing: it
never runs `up` or `k8s:install`, never touches the cluster and sends nothing
to devbox. So it is safe to run before devbox is installed.

```
bun run linear:setup [--target <file>] [--public-url <url>] [--name <app name>]
                     [--reregister] [--no-keychain]
```

| Flag | Effect |
|---|---|
| `--target <file>` | The Kubernetes deployment that target file describes. Without it, the Compose deployment. |
| `--public-url <url>` | The public HTTPS URL Linear sends webhooks to. Wins over the saved one and the Ingress. |
| `--name <app name>` | The app's name in Linear, which is how the agent appears there. Default `devbox`. Used only when registering. |
| `--reregister` | Register a new app even when a client ID is configured, for example after the public URL changed for good. |
| `--no-keychain` | Never read or write the system keychain. |

What it does, in order:

1. **The public URL**: `--public-url`, else the one saved in
   the top-level `publicUrl`, else (Kubernetes) the Ingress, else
   (Compose, in a terminal) a prompt. It prints `Public URL: <url>`.
2. **Register.** It opens Linear's "create app" page, filled in from a
   manifest, and prints the link too, for a machine without a browser.
   Review the app and click **Create**, then copy the client ID, the client
   secret and the webhook signing secret from the app's page. Skipped when a
   client ID is already configured, unless `--reregister`.
3. **Client ID.** When it registered an app, it asks for the client ID
   (`Client ID: `); an empty answer writes nothing. Otherwise it uses the one
   in the config.
4. **Write.** It writes `integrations.linear` with `enabled: true`, the client
   ID and the public URL to the deployment's config file, and keeps the rest of
   the file.
5. **Secrets.** It offers to save the two secrets in the system keychain
   ([below](#saving-the-secrets-or-not)).
6. **Next step.** It prints the command that applies the settings, then
   `Then check Linear with: bun run linear:status [--target <file>]`.

Running it again is safe: each step reuses what is configured.

### Compose

```bash
ngrok http 3000                                            # in another terminal
bun run linear:setup --public-url https://<your-tunnel-host>
bun run up
bun run linear:status
```

The settings go in `devbox.config.json`:

```json
"publicUrl": "https://…",
"integrations": { "linear": { "enabled": true, "clientId": "…" } }
```

With `enabled: true`, `bun run up` resolves the two Linear secrets, checks the
client secret with Linear before it starts anything, and passes `LINEAR_*` to
the control plane. It ends with `Check Linear with: bun run linear:status`.

### Kubernetes

```bash
bun run linear:setup --target devbox.k8s.json
bun run k8s:install --target devbox.k8s.json
bun run linear:status --target devbox.k8s.json
```

The settings go in the target file's top-level `integrations` block, not
under `values`:

```json
{ "context": "my-eks",
  "values": { "ingress": { "webhooks": { "enabled": true, "host": "hooks.example.com",
                                         "tls": [{ "hosts": ["hooks.example.com"], "secretName": "devbox-hooks-tls" }] } } },
  "publicUrl": "https://hooks.example.com",
  "integrations": { "linear": { "enabled": true, "clientId": "…" } } }
```

The installer copies the block into the chart values
(`integrations.linear.enabled`, `integrations.linear.clientId`), resolves the
two secrets, checks the client secret, and writes them to the Secret
`devbox-integrations`. `devbox.config.json`'s `integrations` block is not read
on Kubernetes.

With your own integrations Secret (`secrets.integrations.existingSecret` in
the target file's values), `linear:setup` asks for no secret and prints
`Put LINEAR_CLIENT_SECRET and LINEAR_WEBHOOK_SECRET in Secret "<name>" in
namespace devbox.` Put them there yourself, then restart the control plane
after each change to that Secret. The installer never reads it:
`bun run k8s:check --target <file>`, before or after the install, checks it
([kubernetes/README.md](kubernetes/README.md#check-the-secrets)).

### GitOps

`linear:setup` needs a target file for the cluster, even when you never run
the installer: `context`, the Ingress values (or pass `--public-url`), and
`profile` set to the CLI profile you added with `bun run devbox profile add`,
which `linear:status` uses. Then:

1. `bun run linear:setup --target devbox.k8s.json`. Decline the keychain, or
   set `secrets.integrations.existingSecret` under `values`, so it asks for
   no secret. Near the end it prints the chart values to set:
   `integrations.linear.enabled: true, integrations.linear.clientId: <id>`.
   If you declined the keychain, ignore the
   `Set LINEAR_CLIENT_SECRET in your environment before bun run k8s:install …`
   lines and the `Next: bun run k8s:install …` line: they are for the
   installer.
2. Put `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` in the integrations
   Secret ([kubernetes/secrets.md](kubernetes/secrets.md)).
3. Set the two chart values and sync.
4. `bun run k8s:check --target devbox.k8s.json` checks the Secret and the
   client secret, and `bun run linear:status --target devbox.k8s.json` the
   rest. `k8s:check` reads that Linear is enabled from the target file's
   `integrations` block, which `linear:setup` wrote: keep it in step with the
   chart values.

The chart refuses to render `integrations.linear.enabled: true` without
`integrations.linear.clientId`.

### What turns Linear on

Only `enabled: true` in `integrations.linear`: in `devbox.config.json`, the
target file, or the chart values with GitOps. A `LINEAR_*` variable in your
shell, a saved secret or a key in a Secret never turns Linear on, and does
nothing while `enabled` is `false` or the block is absent.

**Upgrading.** If you set `LINEAR_*`, `SLACK_*` or `GITHUB_WEBHOOK_SECRET` in
your shell, or the Linear, Slack or GitHub webhook settings in `extraEnv`, to
turn an integration on, move them to the `integrations` blocks or the chart
values ([customizing.md](kubernetes/customizing.md#integrations)). The
secrets themselves still come from your shell, the keychain or a Secret.

## Saving the secrets or not

`linear:setup` never reads a secret from your environment. With a terminal
and a working keychain (and no `--no-keychain`), it asks
`Save the Linear secrets to the system keychain for <scope>? [Y/n]`, where
`<scope>` is `compose` or `k8s:<context>/devbox`. On yes:

1. `Linear client secret (input hidden): `. It checks the secret with the
   client ID against Linear and prints
   `devbox will act as <app user> in workspace <workspace>`. A rejected secret
   is asked for again; an empty answer exits and saves nothing.
2. `Linear webhook signing secret (input hidden): `. An empty answer exits and
   saves nothing. Nothing can check this one: only Linear holds the real
   value.
3. It saves both for the deployment.

This is setup's only network call. Offline, decline the save: `up` and
`k8s:install` then ask for the secrets, and `up --skip-checks` or
`k8s:install --skip-linear-check` skip the Linear check.

On no, or without a keychain or a terminal, it saves nothing. `up` and
`k8s:install` then look the secrets up as they do for any secret
([configuration.md](configuration.md#secrets)): your environment, the
keychain, a prompt.

At the end, setup compares each secret in your environment with what it
saved (in memory, never printed) and tells you what the next apply will do:

| Case | Message |
|---|---|
| A new app was registered, and the variable is set | `<NAME> is set in your environment from before this app was created: set it to the new app's value, or unset it, before <apply command>` |
| Not saved, the variable is unset, and nothing for this app is in the keychain | `Set <NAME> in your environment before <apply command>, or it asks for them` |
| Not saved, and the variable is set (no new app) | `<apply command> will use <NAME> from your environment` |
| Saved, and the variable differs (no new app) | `<NAME> in your environment overrides the saved value at install: unset it, or set it to the new value` |

After registering a new app without saving, a secret still saved for the
deployment belongs to the earlier app: setup prints
`The saved <NAME> for <scope> belongs to an earlier app: remove it with bun run secrets rm <NAME>`
(with `--target <file>` on Kubernetes). It removes nothing itself.

## Private teams

The app sees every public team of the workspace. For a private team, a
workspace admin adds the app on the team's page in Linear (Settings → API →
Applications → the app → team access). Until then, the agent is not offered
as a delegate in that team.

## The GitHub username

Linear's app page has an optional **GitHub username**, which links the app to
the GitHub account its commits and comments come from. The manifest can't set
it, so after the registration link, setup prints the value to use:
`<slug>[bot]` when a GitHub App is enabled (the App's bot login, for example
`example-devbox[bot]`), otherwise the GitHub account devbox works as, the owner
of `GITHUB_TOKEN`.
Setup does not look the account up and does not check what you enter.

## Status

```
bun run linear:status [--target <file>] [--no-keychain]
```

Read-only: it never prompts, never reads a Kubernetes Secret and never prints
a secret. It exits 0 whatever the control plane or the probe report; only a
config or target file it can't load makes it exit 1. It prints:

1. The settings (`clientId`, `publicUrl`) and where each Linear secret would
   come from at the next apply: `env`, `keychain` or `missing`, or
   `from Secret "<name>" (not read)` with your own integrations Secret.
   Without a block: `Linear is not configured for <scope>. Run: bun run
   linear:setup`. With `enabled: false`, it says so and stops.
2. What the running control plane reports, through the deployment's CLI
   profile (on Kubernetes it opens a port-forward when needed):
   `Control plane: workspace <name> (<urlKey>), app user <name>, last webhook from Linear <time | none yet>`,
   and the last token error if there is one. `Linear is not on there yet`
   means the settings were not applied: run the apply command.
3. **The probe**: an unsigned `POST <publicUrl>/webhook/linear` with body `{}`
   and a 10-second timeout. devbox with Linear on answers it
   `401 {"error":"invalid signature"}` and records nothing, so a 401 prints
   `Webhook URL <url>/webhook/linear: reaches devbox with Linear on`. Other
   answers are in [Troubleshooting](#troubleshooting).

The probe needs no secret, and it proves only that the URL reaches devbox
**from the machine you run it on**. It does not prove Linear can reach it, or
that the webhook signing secret matches Linear's. "last webhook from Linear"
moves only when a webhook signed by Linear arrives: after you delegate an
issue, "none yet" is a real signal.

## Disable

```
bun run linear:disable [--target <file>] [--no-keychain] [--forget [--yes]]
```

- **`linear:disable`** sets `integrations.linear.enabled` to `false` and keeps
  the client ID, the public URL and the saved secrets. Open Linear tasks keep
  running, but nothing more is posted to Linear. Turn Linear back on with the
  same app with `bun run linear:setup`, or by setting `enabled` to `true`. It
  asks nothing.
- **`linear:disable --forget`** removes the `integrations.linear` block and the
  deployment's saved `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET`. It
  lists what it deletes and asks `[y/N]`; Enter or Ctrl-D answers no, and
  `Nothing was removed.` Without a terminal it refuses unless you pass
  `--yes`. It works on a disabled block too. It then prints
  `Delete the app in Linear: Settings → API → Applications → <name>`: devbox
  can't delete the app for you.

Neither applies anything. Both print `Next: <apply command>` (`--forget`
follows it with the `Delete the app` line); run it to turn Linear off in the
running deployment. "Already disabled" and "not configured" print no `Next:`
line: there is nothing to apply. On Kubernetes, the installer then
writes `devbox-integrations` without the Linear keys, or deletes it when
nothing is left. Keys left in your own Secret do nothing once Linear is off.

## Rotating secrets

Rotate the client secret or the webhook signing secret on the app's page in
Linear, then give devbox the new values.

- **Saved in the keychain:** run `bun run linear:setup [--target <file>]`,
  answer yes to the save, and enter the new values. Then run the apply
  command.
- **From your environment:** set the new values, then run the apply command.

`bun run up` recreates the control plane with the new values. On Kubernetes,
a changed Secret does not restart the control plane, and it keeps the old
values until it restarts. When `k8s:install` changed only
`devbox-integrations`, it says so:

```
The integrations secrets changed; the control plane keeps the old values until it restarts:
  kubectl --context <ctx> -n devbox rollout restart deploy/devbox-control-plane
then: bun run k8s:check --target <file>
```

With your own integrations Secret, or with GitOps, the same rule applies and
nothing prints it: change the Secret, then restart the control plane with the
`kubectl` command above, then run `k8s:check`.

### When the public URL changes

Run `bun run linear:setup --public-url <new> [--target <file>]`. It updates
the config and prints
`Update the webhook URL in the Linear app to <new>/webhook/linear`. That edit,
on the app's page in Linear, is yours to make: Linear has no API for it. It
also prints what each other integration that is on needs
([When it changes](public-url.md#when-it-changes)). Then run `linear:status`
to probe the new URL.

Another integration's setup run with a new URL prints the same line while
Linear is on.

## Troubleshooting

| Where | What you see | What to do |
|---|---|---|
| `linear:setup` | `Webhooks need a public HTTPS URL: …` | Use a public HTTPS URL ([The public URL](public-url.md#what-setup-accepts)). On Kubernetes with TLS at a load balancer, pass `--public-url https://<host>`. |
| `linear:setup` | `No client ID entered: nothing was written.` | Run `bun run linear:setup` again once you have the client ID. Without a terminal, set `integrations.linear.clientId` in the config file. |
| `linear:setup`, `up`, `k8s:install`, `k8s:check` | `Linear rejected the client ID or LINEAR_CLIENT_SECRET (invalid_client)` | Copy both again from the app's page in Linear (Settings → API → Applications). |
| same | `the Linear app does not allow client credentials` | Turn on client credentials on the app (Settings → API → Applications → the app). |
| same | `Entity not found: Organization. A new Linear app answers this for about a minute` | Linear answers this for a short while after the app is created; the check already retried for 60 seconds. Run the command again a little later. |
| same | `can't reach api.linear.app` | Check this machine's egress or proxy. On Kubernetes, the control plane needs egress to `api.linear.app` too. |
| `linear:status` probe | `got no answer (…): the public URL does not reach devbox` | The tunnel is down, or the Ingress or DNS is not ready yet. With the URL from `ingress.api`, that Ingress may be VPN-only: add a public `ingress.webhooks`. |
| `linear:status` probe | `got 404: something answered, but not devbox with Linear on` | Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that `integrations.linear.enabled` is `true` and applied, or restart the control plane. |
| `linear:status` probe | `got <status>: <body>` | Something else answered: the status and the first 300 characters of the body say what. |
| `linear:status` | `Control plane: Linear is not on there yet` | Run the apply command. |
| Linear | The agent is not offered as a delegate in a team | The team is private: add the app to it ([Private teams](#private-teams)). |
| Linear | Delegating does nothing; the probe passes and `linear:status` shows `last webhook from Linear none yet` | Read the control plane's logs (below). `Linear webhook rejected: signature mismatch (check LINEAR_WEBHOOK_SECRET)` means `LINEAR_WEBHOOK_SECRET` differs from the app's signing secret. Copy the signing secret again from the app's page, remove the saved one with `bun run secrets rm LINEAR_WEBHOOK_SECRET [--target <file>]` (or fix it in your environment or your Secret), run the apply command and enter the value, then on Kubernetes restart the control plane. |

The control plane's logs:

```bash
docker compose -f control-plane/docker-compose.yml logs control-plane   # Compose
kubectl --context <context> -n devbox logs deploy/devbox-control-plane  # Kubernetes
```

Nothing can check the webhook signing secret before Linear uses it: Linear
signs with its own copy, and devbox can only compare against the one it has.
A typo shows only when Linear's webhooks are rejected: each one logs
`Linear webhook rejected: signature mismatch (check LINEAR_WEBHOOK_SECRET)`.
`linear:status`'s probe sends no signature, so it logs nothing.

## Registering the app by hand

If the manifest link stops working, create the app in Linear (Settings → API
→ Applications) with the fields below, which are what the manifest fills in.
Then run `bun run linear:setup`: ignore the link it prints, and enter the
client ID when it asks.

| Field | Value |
|---|---|
| Name | `devbox`, or the name the agent should have in Linear (`--name`) |
| Developer | `devbox` |
| Description | `devbox coding agent` |
| Developer URL | `https://github.com/rudderlabs/devbox` |
| Callback URL | `<public-url>/oauth/callback`. Linear requires one; devbox never uses it. |
| Client credentials | on |
| Distribution | private: the app stays in your workspace |
| Webhooks | on, URL `<public-url>/webhook/linear`, events: agent session events |
