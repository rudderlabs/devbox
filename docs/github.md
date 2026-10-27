# GitHub

devbox can work as a GitHub App. You register the App once with
`bun run github:setup`, and the deployment's usual command applies it: the
local stack (`bun run up`) or a Kubernetes install (`bun run k8s:install`,
`bun run k8s:kind`, or GitOps).

## What you get

- **Commits and pull requests come from the App's bot**, `<slug>[bot]`, with
  the bot's commit identity, instead of from your own account.
- **Tokens refresh on their own.** devbox mints an installation token about
  every 30 minutes, so you need no External Secrets Operator, Vault or
  Reloader. Or your own tooling mints them
  ([External tokens](#external-tokens)).
- **GitHub webhooks reach the agent**, on Compose too: an `@<slug>` mention on
  a pull request, a review or review comment on the agent's pull request, and
  a failed CI run on its branch all reach the running task, like
  `bun run devbox send`.
- **The sandbox can look up who is trusted** (org members and users), so
  pull request discussion from your trusted orgs and users reaches the agent
  ([Trust lists](#trust-lists)).

**The App's name, slug and avatar.** You mention the App by its slug,
`@<slug>`, in any letter case. GitHub derives the slug from the App's name:
lowercase, with spaces turned into hyphens (`--name "Devbox Agent"` gives
`devbox-agent`). `github:status` shows it. Renaming the App on GitHub changes
the slug: the next `bun run up` or `k8s:install` then stops with
`integrations.githubApp.slug is "<config slug>" but App <id> is "<actual slug>": run bun run github:setup`.
Run `github:setup` again, with the App's private key at hand: it records the
new slug and prints
`The App was renamed on GitHub: its slug is now <new> (was <old>); mention it as @<new>`.
The manifest cannot set a logo, so the App shows its owner's avatar until you
upload one on the App's settings page, under Display information. Commits are
still authored by `<slug>[bot]` either way.

Webhooks need an App. With a personal `GITHUB_TOKEN` the "bot" would be your
own account, and devbox ignores its own events, so your own mentions would be
dropped. An App always comes with its webhooks: one switch,
`integrations.githubApp.enabled`, turns on both.

## Pick a mode

| Mode | Set by | Token | Webhooks | For |
|---|---|---|---|---|
| **Personal token** | no `integrations.githubApp` block, or `enabled: false` | `GITHUB_TOKEN`, never refreshed | no | trying devbox locally |
| **App, devbox mints the tokens** | `tokens: "devbox"` (the default) | a minter process, refreshed about every 30 minutes | yes | most self-hosters |
| **App, external tokens** | `tokens: "external"` (`--external-tokens`) | your own Secret (Kubernetes) or token file (Compose), refreshed by your tooling | yes | organizations with Vault, External Secrets or central key custody |

Pick **devbox mints the tokens** unless your organization forbids new
workloads that hold a signing key. In that mode a separate process, the
minter, is the only holder of the App's private key. It is the control-plane
image run as `bun run github-token`: the `github-token` service on Compose, the
Deployment `devbox-github-token` on Kubernetes. The control plane never sees
the key. If it is compromised, the attacker gets tokens that expire within an
hour.

The personal-token mode is the quickstart, unchanged. To go back to it, run
[`github:disable`](#disable-and-forget).

## The public URL

GitHub delivers webhooks only to a public HTTPS URL, and the App stores that
URL. It is the same setting as for Linear: the top-level `publicUrl` of the
config file (`devbox.config.json`, or the target file on Kubernetes). One
tunnel or Ingress serves `/webhook/github` and `/webhook/linear`. How the URL
is chosen and which URLs are refused is described in
[Linear: The public URL](linear.md#the-public-url).

In short:

- **Compose and kind: bring your own.** Run a tunnel or a reverse proxy that
  forwards HTTPS to port 3000 on your machine and pass its URL with
  `--public-url`. kind's Ingress host is `localhost`, so it needs the tunnel
  too.
- **Kubernetes with an Ingress:** the `ingress.webhooks` host, else the
  `ingress.api` host, as for Linear.

The control plane accepts webhook request bodies up to 1 MiB. Larger GitHub
deliveries receive HTTP 413 and are not processed; because GitHub does not
truncate deliveries to fit, a legitimate delivery above this limit is lost.
Keep any tunnel, reverse-proxy, or Ingress body limit at or below 1 MiB so it
rejects oversized requests before they reach the control plane.

**When the URL changes**, run `github:setup --public-url <new>` again. With
devbox-minted tokens it updates the App's webhook URL itself and prints
`Updated the GitHub App's webhook URL to <new>/webhook/github`. With external
tokens, or when no private key is available to it, it prints
`Update the webhook URL in the GitHub App to <new>/webhook/github: <settings link>`
and you change it on the App's settings page. If Linear is on, it prints
Linear's line too. `linear:setup` run with a new URL prints
`Run bun run github:setup to update the GitHub App's webhook URL` (with
`--target <file>` on Kubernetes): it does not hold the key.

## Set up

```
bun run github:setup [--target <file>] [--public-url <url>] [--org <org>]
                     [--name <app name>] [--external-tokens]
                     [--app-id <id> [--private-key-file <path>]]
                     [--reregister] [--no-keychain] [--print-registration-link]
```

| Flag | Effect |
|---|---|
| `--target <file>` | The Kubernetes deployment that target file describes. Without it, the Compose deployment. |
| `--public-url <url>` | The public HTTPS URL GitHub sends webhooks to. Wins over the saved one and the Ingress. |
| `--org <org>` | Register the App under this organization. Default: your account. |
| `--name <app name>` | The App's name on GitHub. Default `devbox`. Names are unique across GitHub; if yours is taken, GitHub says so on its create page and you edit the name there. |
| `--external-tokens` | Your own tooling mints the App's tokens, not devbox. |
| `--app-id <id>` | Adopt an existing App instead of registering one. |
| `--private-key-file <path>` | With `--app-id`: that App's private key. Without it, the key is looked up as [below](#the-private-key). |
| `--reregister` | Register a new App even when one is configured. |
| `--no-keychain` | Never read or write the system keychain. |
| `--print-registration-link` | For a machine without a browser: [print a link](#headless-machines). |

What it does, in order:

1. **The public URL**: `--public-url`, else the saved `publicUrl`, else
   (Kubernetes) the Ingress, else (Compose, in a terminal) a prompt. It prints
   `Public URL: <url>`.
2. **Register.** It starts a listener on `127.0.0.1` and `::1` (random port)
   and opens your browser on a local page that sends GitHub the App's manifest.
   You land on GitHub's pre-filled "Create GitHub App" page. Review it and
   click **Create**. GitHub redirects back to the listener, which exchanges
   the answer for the App's id, slug, private key and webhook secret. Nothing
   is copied by hand. Setup waits 15 minutes for the answer. It is skipped
   when an App is already configured, unless `--reregister`.
3. **Secrets**, right away, because GitHub hands the private key out only once
   ([below](#the-private-key)).
4. **Install.** It opens `<App page>/installations/new`. Choose the repos
   devbox works on. Setup polls GitHub every 3 seconds for up to 15 minutes
   (press Enter to check at once) and prints
   `The App is installed on <account> (installation <id>)`. With several
   installations it asks which one to use.
5. **Bot user.** It looks up the bot's numeric user ID, for the commit
   identity. This is the bot's user ID, not the App's ID.
6. **Repo coverage.** For each repo in `repos` it checks that the
   installation covers it, and prints
   `<owner>/<repo> is not in the App's installation: add it at <link>` for
   each one that is not. That is not a failure here, but `up` and
   `k8s:install` refuse to start while a repo is uncovered with
   `tokenScope: "repos"`.
7. **Write** `publicUrl` and `integrations.githubApp` (`enabled: true`,
   `appId`, `slug`, `installationId`, `botUserId`, `tokens`, `tokenScope`,
   `ciResults`, and `org` for an App owned by an organization) to the
   deployment's config file, keeping the rest. When no [trust list](#trust-lists)
   is set, it adds one (`Trusted: <name> (edit <file> to change)`). It prints
   `Wrote integrations.githubApp to <file>`.
8. **Next step.** It names the command that applies the settings, then
   `Then check GitHub with: bun run github:status [--target <file>]`.

`github:setup` applies nothing: it never runs `up` or `k8s:install` and never
touches the cluster. Its only network calls go to GitHub. So it is safe to run
before devbox is installed.

Running it again is safe: each step reuses what is configured. A re-run keeps
the token mode. To switch an App from external back to devbox tokens, set
`tokens` to `"devbox"` in the config and remove what external tokens used:
`tokenFile` on Compose, `secrets.github.existingSecret` on Kubernetes (the
chart refuses it with devbox tokens). `--external-tokens` is the way in, not
out.

If setup stops before the App is installed, it has already saved the App with
`enabled: false`, and its key is in the keychain or a file. Run it again, and
it goes straight to the installation.

### The private key

The key is a multi-line PEM, so devbox never prompts for it. Wherever it needs
the key (`github:setup`, `up`, `k8s:install`, `k8s:check`), it looks in this
order:

```
GITHUB_APP_PRIVATE_KEY_FILE (a path) → GITHUB_APP_PRIVATE_KEY (the PEM) → the system keychain
```

It says where the key came from. A file that cannot be read or holds no PEM
fails the run, naming the path. The keychain entry is `GITHUB_APP_PRIVATE_KEY`,
and `bun run secrets ls|rm` handles it like any other
([configuration.md](configuration.md#secrets)).

Right after the App is created, setup offers to save the private key and the
webhook secret in the system keychain
(`Save the App's private key and webhook secret to the system keychain for <scope>? [Y/n]`).
If you decline, or there is no keychain or terminal:

- The key goes to `./<slug>.private-key.pem`, mode `0600` and git-ignored. An
  existing file is never overwritten. Setup prints
  `Saved the App's private key to <path>. Keep it somewhere safe and set GITHUB_APP_PRIVATE_KEY_FILE=<path> before <apply command>`.
- The webhook secret is shown once, after
  `Press Enter to show the webhook secret (set it as GITHUB_WEBHOOK_SECRET before <apply command>)`.
  Set it as `GITHUB_WEBHOOK_SECRET` when you apply.

With external tokens the key never goes to devbox: setup writes the key file
and tells you to store it where your tooling reads it, then delete the file.
The webhook secret follows the rules above, because devbox needs it.

At the end, setup compares your environment with what it saved and prints
what the next apply will do, like Linear's setup does
([Linear: Saving the secrets or not](linear.md#saving-the-secrets-or-not)).
For a key or webhook secret saved for an earlier App it prints
`The saved <NAME> for <scope> is from an earlier App or key: remove it with bun run secrets rm <NAME>`
(with `--target <file>` on Kubernetes). It removes nothing itself.

devbox never deletes the private key on its own, not even when GitHub rejects
it. The key is removed only by `bun run secrets rm GITHUB_APP_PRIVATE_KEY` or
`github:disable --forget`.

### Compose

The token minter needs Docker Compose 2.13.0 or newer: it gets its private key
from a Compose secret with an `environment` source (Compose 2.6.1 and later),
and `bun run up` starts its first run with `docker compose run --build` (2.13.0
and later).

```bash
ngrok http 3000                                              # in another terminal
bun run github:setup --public-url https://<your-tunnel-host>
bun run up
bun run github:status
```

The settings go in `devbox.config.json`:

```json
"publicUrl": "https://…",
"github": { "trustedOrgs": ["example-org"] },
"integrations": { "githubApp": {
  "enabled": true, "appId": 123456, "slug": "example-devbox",
  "installationId": 7890123, "botUserId": 1234567,
  "tokens": "devbox", "tokenScope": "repos", "ciResults": true } }
```

With `enabled: true`, `bun run up`:

- resolves the private key and `GITHUB_WEBHOOK_SECRET`. A missing key stops it:
  `No private key for the GitHub App: set GITHUB_APP_PRIVATE_KEY_FILE to its path, or run bun run github:setup`;
- checks the App, then mints one token for its own checks and for the repos
  volume (`GitHub App example-devbox: minted a token for installation 7890123`),
  and checks that the installation covers every repo. `--skip-checks` skips
  the coverage and the permission checks;
- runs the minter once (`docker compose --profile github-app run --rm --build github-token bun run github-token --once`),
  so a first token is there before the control plane and iron-proxy start. If
  GitHub refuses, `up` fails there;
- starts the stack with the `github-app` profile, which adds the minter
  service `github-token`. It keeps the token fresh in the volume
  `devbox_github_token`, which the control plane and iron-proxy read;
- recreates the minter
  (`docker compose --profile github-app up -d --force-recreate --no-deps github-token`),
  so a running one always restarts with the current key: Compose does not
  notice a changed key on its own;
- recreates iron-proxy
  (`docker compose --profile github-app up -d --force-recreate --no-deps iron-proxy`),
  so it loads the config `up` just wrote: iron-proxy reads it only once;
- commits as `<slug>[bot]`, and turns on the webhooks.

It ends with `Check GitHub with: bun run github:status`.

### kind

kind has no public address, so it needs a tunnel, like Compose. Point the
tunnel at the local port `bun run k8s:connect --target devbox.kind.json`
forwards to the control plane (the URL of the CLI profile `k8s-kind-devbox`,
in `~/.config/devbox/config.json`):

```bash
bun run k8s:connect --target devbox.kind.json                 # in another terminal; keep it running
ngrok http <that port>                                        # in another terminal
bun run github:setup --target devbox.kind.json --public-url https://<your-tunnel-host>
bun run k8s:kind
bun run github:status --target devbox.kind.json
```

Everything else is as in [Kubernetes](#kubernetes), and the apply command
setup prints is `bun run k8s:kind`, not `k8s:install`. The target file
`devbox.kind.json` must exist before `github:setup` can use it: run
`bun run k8s:kind` once first
([kubernetes/kind.md](kubernetes/kind.md#install)).

### Kubernetes

```bash
bun run github:setup --target devbox.k8s.json
bun run k8s:install --target devbox.k8s.json
bun run github:status --target devbox.k8s.json
```

Run `github:setup` before `k8s:install`. The settings go in the target file's
top-level `integrations` block, not under `values`, and the trust list under
`values.github`:

```json
{ "context": "my-eks",
  "values": { "github": { "trustedOrgs": ["example-org"] },
              "ingress": { "webhooks": { "enabled": true, "host": "hooks.example.com",
                                         "tls": [{ "hosts": ["hooks.example.com"], "secretName": "devbox-hooks-tls" }] } } },
  "publicUrl": "https://hooks.example.com",
  "integrations": { "githubApp": {
    "enabled": true, "appId": 123456, "slug": "example-devbox",
    "installationId": 7890123, "botUserId": 1234567,
    "tokens": "devbox", "tokenScope": "repos", "ciResults": true } } }
```

The installer copies the block into the chart values
(`integrations.githubApp.*`, with `slug` as `botLogin`), resolves the private
key and `GITHUB_WEBHOOK_SECRET`, checks the App, mints a token, checks it
against the repos and writes:

- the key to the Secret `devbox-github-app` (key `private-key`);
- the webhook secret to `devbox-integrations`;
- the first token to `devbox-github`.

The chart then runs the minter as the Deployment `devbox-github-token`, with
its own ServiceAccount. Its Role allows `get`, `update` and `patch` on the
token Secret and nothing else, and its NetworkPolicy allows egress to DNS, to
GitHub (443) and to the Kubernetes API. The key Secret is mounted only into
the minter's pods. A Job, `devbox-github-token-seed`, mints one token after every
install and upgrade, before the first snapshot build, and fails the release if
GitHub refuses (it does not retry).

With your own key Secret (`secrets.githubApp.existingSecret`, key
`private-key`), the installer cannot mint a token. It creates an empty
`devbox-github` if that is missing (one that exists is left alone) and leaves
the first token to the seed Job. It skips the GitHub token checks, so run
`bun run k8s:check --target devbox.k8s.json` after the install. With your own
integrations Secret, setup asks for no secret and names the Secret and key to
fill. See [secrets.md](kubernetes/secrets.md).

Switching modes (for example devbox tokens to external) makes the installer
delete its own key and token Secrets that the new mode no longer uses. Secrets
you created yourself are never touched.

### GitOps

`github:setup` needs a target file even when you never run the installer:
`context`, the Ingress values (or `--public-url`), and `profile` set to the CLI
profile you added with `bun run devbox profile add`, which `github:status`
uses. Then:

1. Name your own Secrets first, under `values` in the target file:
   `secrets.githubApp.existingSecret` for the key and
   `secrets.integrations.existingSecret` for the webhook secret. Setup then
   asks for no secret. It writes a new App's key to `./<slug>.private-key.pem`,
   shows the webhook secret once, and tells you which Secret and key each goes
   in.
2. `bun run github:setup --target devbox.k8s.json`. Near the end it prints
   the chart values:
   `integrations.githubApp.enabled: true, integrations.githubApp.appId: …, integrations.githubApp.installationId: …, integrations.githubApp.botLogin: …, integrations.githubApp.botUserId: …, integrations.githubApp.tokens: …, integrations.githubApp.tokenScope: …, integrations.githubApp.ciResults: …`.
   Ignore its `Next: bun run k8s:install …` line: it is for the installer.
3. Put the private key in the key Secret (`private-key`) and
   `GITHUB_WEBHOOK_SECRET` in the integrations Secret
   ([secrets.md](kubernetes/secrets.md)), then delete the key file.
4. Set the chart values, plus `github.trustedOrgs` or `github.trustedUsers`,
   and sync.
5. `bun run k8s:check --target devbox.k8s.json` checks the Secrets and mints
   a token from the key, and `bun run github:status --target devbox.k8s.json`
   the rest. `k8s:check` reads that the App is enabled from the target file's
   `integrations` block, which `github:setup` wrote: keep it in step with the
   chart values.

The seed Job and the minter need the key Secret to exist when the release is
applied. The chart creates the token Secret `devbox-github` in its bootstrap
hook, if it is missing.

### Adopting an App you made yourself

```bash
bun run github:setup --app-id 123456 --private-key-file ./example-devbox.private-key.pem
```

Create the App in GitHub's settings with the permissions and events from
[below](#permissions-and-events), generate a private key and install it. Setup
then checks the key with GitHub (`GET /app`), takes the slug from GitHub, asks
for the webhook secret (empty generates a new one), sets the App's webhook URL
and secret, and continues with the install, as above. Check that the webhook is
Active on the App's settings page. The wrong `--app-id` gives
`GitHub has no App with id <id>: check --app-id (the App's settings page shows its App ID)`.

### Replacing the App

`github:setup --reregister`, or `--app-id <another id>` over a working App,
registers or adopts a new App without breaking the working one. The new App is
saved as `integrations.githubApp.pending` (`appId`, `slug`, `org` for an
organization, and `publicUrl` when you passed a new `--public-url`), and its
secrets are saved as `GITHUB_APP_PRIVATE_KEY_PENDING` and
`GITHUB_WEBHOOK_SECRET_PENDING`. The working App, and the saved `publicUrl`,
keep running until the new one is installed. Once it is, setup replaces the old
settings and secrets with the new App's, saves the new public URL (printing
what else needs it, such as Linear's webhook URL), and prints
`The App <old> is no longer used: delete it on GitHub: <link>`.

`github:status` shows a waiting App in a `pending` row. If you run setup again
before it is installed to register or adopt another App, or to adopt the
configured App again with a new key, it asks before dropping the waiting one,
and removes the dropped App's `_PENDING` secrets. With `--no-keychain` it
cannot: it says so, with the `bun run secrets rm` commands. If setup
stopped before the install, run `bun run github:setup` again to finish. When
the new App's key is in the file setup wrote (`./<slug>.private-key.pem`), not
in the keychain, that run prints
`Set GITHUB_APP_PRIVATE_KEY_FILE=<path> before <apply command>`.
That file, named after the App, comes before the `_PENDING` keychain entries;
if both are there, the entries are an earlier App's, and setup names them for
removal.
A plain `github:disable` keeps the waiting App, and the next `github:setup`
installs it, not the old one. `github:disable --forget` removes the pending
App too.

## Headless machines

A machine whose browser cannot open the local page can still set up the App:

```bash
bun run github:setup --print-registration-link --public-url https://<host>
```

It prints GitHub's URL-parameter link with the same name, permissions and
events, then
`Create the App, generate a private key, then run: bun run github:setup --app-id <id> --private-key-file <path>`.
Open the link on any machine, create the App, generate a private key, and
copy it to the machine. The link takes `--org`, `--name` and `--public-url`
like setup itself. Registering and adopting need a terminal; without one setup
stops with `registering or adopting a GitHub App needs a terminal: run bun run github:setup in one`.

## Permissions and events

The manifest sets these. Review them on GitHub's create page before you click
**Create**.

| Permission | Level | Why |
|---|---|---|
| Contents | write | push the agent's branch, change files through the API, clone private repos |
| Pull requests | write | open and update pull requests, review comments and replies, reviewers, reactions on review comments |
| Issues | write | pull request conversation comments, reactions, assignees |
| Actions | write | read CI jobs and logs, re-run failed jobs; the `workflow_run` event |
| Metadata | read | required by GitHub |
| Members | read | list the members of a trusted org |

| Event | Why |
|---|---|
| `issue_comment` | `@<slug>` mentions and comments on the agent's pull requests |
| `pull_request_review` | reviews on the agent's pull requests |
| `pull_request_review_comment` | review comments |
| `workflow_run` | a failed CI run on the agent's branch (when `ciResults` is `true`) |

The App is private (it can be installed only on the account that owns it) and
its webhook is `<publicUrl>/webhook/github`.

**Adding Workflows (write).** The manifest leaves it out: with it, the agent
can change `.github/workflows/`, which can read repo secrets. If you want
that, open the App's settings page (`github:status` prints the link),
Permissions & events → Repository permissions → Workflows → Read and write,
save, then accept the new permission on the installation (GitHub asks the
installation's owner). The tokens devbox mints carry the App's full set, so
they pick it up after that.

## Trust lists

The agent reads pull request discussion only from authors you trust. With the
App, the trust list says whose mentions and comments count:

- **Compose:** top-level `github.trustedOrgs` and `github.trustedUsers` in
  `devbox.config.json`.
- **Kubernetes:** `github.trustedOrgs` and `github.trustedUsers`, under
  `values` in the target file, or the chart values with GitOps.

With the App enabled, one of the two must be set. Otherwise `up` stops with
`integrations.githubApp: needs github.trustedOrgs or github.trustedUsers (who may drive the agent from GitHub)`,
and the chart with
`integrations.githubApp.enabled is true: github.trustedOrgs or github.trustedUsers is required`.
When none is set, `github:setup` adds the account that owns the installation:
`trustedOrgs` for an organization, else `trustedUsers`. Edit it to widen or
narrow it. More about the lists:
[configuration.md](configuration.md#trust-settings).

Both the control plane and the sandbox look the lists up on GitHub as the
App's token (members of each org, and each user). iron-proxy allows exactly
those reads: `GET` on `/orgs/<org>/members` for each trusted org and on
`/users/*`, and on `*.blob.core.windows.net/actions-results/*` for CI log
downloads.

## Token scope

`integrations.githubApp.tokenScope`, for devbox-minted tokens:

- **`"repos"` (the default):** each token covers only the repos in `repos`
  (devbox asks GitHub for those repository names). Public repos stay readable.
- **`"installation"`:** no narrowing. The token covers every repo the App is
  installed on, so the agent can also clone your other private repos.

The agent can write only to the configured repos either way, because
iron-proxy limits writes by path. Reads on github.com are open at the proxy, so
the token decides which private repos are readable. The token always carries
the App's full permissions.

With `"repos"`, a repo in the config that the installation does not cover makes
GitHub refuse the whole token request. `up` and `k8s:install` check this first
and stop with
`These repos are not in the GitHub App's installation: <repos>. Add them at <link>, or run with tokenScope "installation"`.
If the installation changes later, the minter logs `github_token.mint_failed`
with the reason
`a repo in GITHUB_APP_REPOSITORIES is not in the installation (<GitHub's message>)`
and keeps retrying; `github:status` shows the error.

The chart refuses `tokenScope: repos` with no `repos`:
`integrations.githubApp.enabled is true: tokenScope: repos needs at least one entry in repos (or use tokenScope: installation)`.

With external tokens, devbox narrows nothing: your tooling decides.

## External tokens

With `tokens: "external"` the key stays with you, and devbox only reads the
token you keep fresh. It re-reads the token at most every 60 seconds.

### Kubernetes

Run `github:setup --target <file> --external-tokens`. Name your own token
Secret (key `token`) in the target file or chart values:

```yaml
secrets:
  github: { existingSecret: my-github }
```

Put only `token` (and, if your tooling writes it, `expires-at`) in that
Secret, never the App's private key: every key in it reaches the control plane
and iron-proxy, which mount the whole Secret, and the snapshot builder, which
reads it.

The chart refuses the combinations that cannot work:

- `integrations.githubApp.enabled is true: tokens: external needs secrets.github.existingSecret: the Secret your tooling keeps fresh`
- `integrations.githubApp.enabled is true: tokens: devbox writes the token Secret itself: remove secrets.github.existingSecret, or use tokens: external`

The installer refuses both with the same words. The webhook secret still goes
in the integrations Secret. Check the Secret with
`bun run k8s:check --target <file>`.

**External Secrets.** [External Secrets Operator](https://external-secrets.io/)'s
`GithubAccessToken` generator mints a GitHub App installation token and
refreshes it before it expires. `appID` and `installID` are the values
`github:setup` printed (`github:status` shows them), and the key Secret is the
App's private key, which you stored where your tooling reads it:

```yaml
apiVersion: generators.external-secrets.io/v1alpha1
kind: GithubAccessToken
metadata:
  name: devbox-github-app
  namespace: devbox
spec:
  appID: "<app-id>"
  installID: "<installation-id>"
  auth:
    privateKey:
      secretRef: { name: <secret-with-the-app-key>, key: <key> }
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: my-github
  namespace: devbox
spec:
  refreshInterval: 30m   # installation tokens expire after an hour
  target: { name: my-github }
  dataFrom:
    - sourceRef:
        generatorRef:
          apiVersion: generators.external-secrets.io/v1alpha1
          kind: GithubAccessToken
          name: devbox-github-app
```

The generator writes the key `token`, as the chart expects. Older operator
versions serve `external-secrets.io/v1beta1`. The generator can also narrow the
token per consumer; devbox does not.

`k8s:check` runs every token check on the token, as on a personal access
token ([what preflight checks](configuration.md#what-preflight-checks)). The
installer knows the App, so the commit identity is the bot's.

### Compose

Run `github:setup --external-tokens`. Setup asks for `tokenFile` (or set it in
`devbox.config.json`): the absolute path of a file your tooling keeps fresh.

```json
"integrations": { "githubApp": {
  "enabled": true, "appId": 123456, "slug": "example-devbox",
  "installationId": 7890123, "botUserId": 1234567,
  "tokens": "external", "tokenFile": "/srv/devbox-github/token" } }
```

The rules for `tokenFile`:

- It must be absolute, with no `:` or `,` in the path.
- It must be in a directory of its own, not `/` or your home directory. The
  whole directory is mounted read-only at `/var/run/devbox/github` in the
  control plane and iron-proxy. (A single file would not do: a tool that
  replaces the file by renaming it leaves the container looking at the old
  one.)
- It must exist and hold a token when you run `bun run up`, which reads it
  once for its checks. Otherwise it fails with
  `integrations.githubApp.tokenFile <path>: not found` (or `is empty`, `is a directory`, `permission denied`).
- The containers must be able to read it. The control plane and iron-proxy
  read it as root, so a file only you can read (`0600`) works with Docker's
  usual setup. With user-namespace remapping (`userns-remap`), root in a
  container is an unprivileged user on the host: then make the file readable
  by others (`chmod 644`) and its directory searchable (`chmod 755`).

`up` starts no minter in this mode. A minimal loop that keeps the file fresh
(needs `openssl`, `curl` and `jq`; it signs the App's JWT and asks GitHub for
an installation token every 30 minutes):

```bash
#!/usr/bin/env bash
APP_ID=123456
INSTALL_ID=7890123
KEY=/path/to/example-devbox.private-key.pem
OUT=/srv/devbox-github/token

b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

while true; do
  now=$(date +%s)
  header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64)
  payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$APP_ID" | b64)
  sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$KEY" | b64)
  if token=$(curl -fsS -X POST \
        -H "Authorization: Bearer $header.$payload.$sig" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/app/installations/$INSTALL_ID/access_tokens" | jq -er .token); then
    printf '%s' "$token" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"   # a rename, so readers never see half a token
    sleep 1800
  else
    echo "could not get a token; retrying in 60 s" >&2
    sleep 60
  fi
done
```

Run it once in the foreground before the first `bun run up`, then keep it
running as a service of your own.

## Status

```
bun run github:status [--target <file>] [--no-keychain]
```

Read-only: it never prompts, never reads a Kubernetes Secret and never prints
a secret. It exits 0 whatever the control plane or the probe report; only a
config or target file it cannot load makes it exit 1. It prints:

1. **Without an App block:**
   `GitHub uses a personal token for <scope> (no App). Webhooks need an App: bun run github:setup`,
   and where `GITHUB_TOKEN` would come from. With `enabled: false`, it says
   the App is disabled and how to turn it on.
2. **The settings** (`appId`, `slug`, the App's settings link, `installationId`,
   `botUserId`, `tokens`, `tokenScope`, `ciResults`, the trust lists,
   `publicUrl`), a `pending` row for an App waiting for its install, the
   token file (external Compose: its path and whether it exists, not read), and
   where the key and the webhook secret would come from at the next apply:
   `env`, `keychain` or `missing`, or `from Secret "<name>" (not read)` with
   your own Secrets.
3. **What the running control plane reports**, through the deployment's CLI
   profile (on Kubernetes it opens a port-forward when needed):
   `Control plane: token expires <time> (refreshed <time>)`, the last token
   error if there is one, and
   `Control plane: last webhook from GitHub <time | none yet>`. A token past
   its expiry prints `the token has expired`, with the minter's log command
   (`docker compose -f control-plane/docker-compose.yml logs github-token`, or
   `kubectl --context <context> -n devbox logs deploy/devbox-github-token`).
   `GitHub webhooks are not on there yet` means the settings were not applied:
   run the apply command.
4. **The probe**: an unsigned `POST <publicUrl>/webhook/github` with body `{}`
   and a 10-second timeout. devbox with the App on answers
   `401 {"error":"invalid signature"}` and records nothing, so a 401 prints
   `Webhook URL <url>/webhook/github: reaches devbox with GitHub on`. Other
   answers are in [Troubleshooting](#troubleshooting).

The probe needs no secret, and it proves only that the URL reaches devbox
from the machine you run it on. It does not prove GitHub can reach it, or that
the webhook secret matches the App's. "last webhook from GitHub" moves only
when a webhook signed by GitHub arrives: after you comment on a pull request,
"none yet" is a real signal. GitHub also lists every delivery, with its
response, on the App's settings page under Advanced.

## Disable and forget

```
bun run github:disable [--target <file>] [--no-keychain] [--forget [--yes]]
```

- **`github:disable`** sets `integrations.githubApp.enabled` to `false` and
  keeps the settings and the saved secrets. The App and its webhooks are off,
  and devbox falls back to a personal token, so the next apply needs
  `GITHUB_TOKEN`. Turn the App back on with `bun run github:setup`, or by
  setting `enabled` to `true`. It asks nothing. A new App waiting for its
  install stays, and it prints
  `The new App <slug> is still waiting for its install: bun run github:setup resumes it, bun run github:disable --forget removes it`.
- **`github:disable --forget`** removes the `integrations.githubApp` block (a
  `pending` App with it) and the deployment's saved `GITHUB_APP_PRIVATE_KEY`
  and `GITHUB_WEBHOOK_SECRET`, and the `_PENDING` ones. It lists what it
  deletes and asks `[y/N]`; Enter or Ctrl-D answers no, and
  `Nothing was removed.` Without a terminal it refuses unless you pass
  `--yes`. It works on a disabled block too. The trust lists and `publicUrl`
  stay: they are shared. It then prints
  `Delete the App on GitHub: <settings link>/advanced`: devbox cannot delete
  the App for you.

Neither applies anything. Both print `Next: <apply command>`; run it to turn
the App off in the running deployment. On Compose, the next `bun run up`
stops and removes the minter. On Kubernetes, the installer removes the key
Secret `devbox-github-app` it created and the minter. A key in your own Secret
is left.

## Rotating the key

1. On the App's settings page, generate a new private key and download it.
2. Give devbox the new key and apply:

   ```bash
   bun run github:setup --app-id <id> --private-key-file <new key> [--target <file>]
   ```

   Setup checks the new key with GitHub, then asks
   `The App's webhook secret (input hidden; press Enter to generate a new one):`.
   Type the current secret to keep it, or press Enter for a new one. Either
   way setup sets the webhook URL and that secret on the App, then offers to
   save the key and the webhook secret in the keychain. If you decline, it
   tells you to set `GITHUB_APP_PRIVATE_KEY_FILE` to the new file's path before
   the apply. A key saved earlier is replaced by a saved new one; otherwise
   remove the old one with
   `bun run secrets rm GITHUB_APP_PRIVATE_KEY [--target <file>]`, as setup
   says.
3. Apply. On Compose, `bun run up` restarts the minter with the new key
   itself. On Kubernetes, run `bun run k8s:install --target <file>` (with your
   own key Secret, put the new key in it instead), then restart the minter,
   which reads the key only at start:
   `kubectl --context <context> -n devbox rollout restart deploy/devbox-github-token`.
   Check `bun run github:status [--target <file>]`.
4. Delete the old key on the App's settings page.

## Troubleshooting

| Where | What you see | What to do |
|---|---|---|
| `github:setup` | `No answer from GitHub after 15 minutes: run bun run github:setup again` | You did not click Create in time. Run setup again. |
| `github:setup` | `The answer from GitHub doesn't match this run: run bun run github:setup again` | The browser page was from an earlier run. Nothing was written; run it again. |
| `github:setup` | `No local port free on both 127.0.0.1 and ::1` | Free a port, or close what holds the loopback ports, and run it again. |
| `github:setup` | `GitHub didn't create the App from its manifest (HTTP <status>): run bun run github:setup again` | Run it again. If GitHub's page said the name is taken, pass another `--name`. |
| `github:setup` | `The App isn't installed yet: install it from <link>, then run bun run github:setup again` | Install the App on the repos devbox works on, then run it again. It resumes from the saved App. |
| `github:setup` | `The App is installed on several accounts (…): run bun run github:setup in a terminal to choose one` | Run it in a terminal and pick the account that owns the repos. |
| `github:setup` | `registering or adopting a GitHub App needs a terminal: run bun run github:setup in one` | Run it in a terminal, or use the [headless route](#headless-machines). |
| `github:setup` | `<path> exists already: nothing was overwritten. Generate a new private key …` | Move or delete the old key file, or generate a new key and pass it with `--private-key-file`. |
| `github:setup` | `<owner>/<repo> is not in the App's installation: add it at <link>` | Add the repo to the installation. Not a failure for setup itself. |
| `github:setup` | `No private key for the App here: skipping the installation and repo checks` | The App is configured but its key is not here. Set `GITHUB_APP_PRIVATE_KEY_FILE`, or this is fine if you only meant to change the config. |
| `github:setup` | `Saving <NAME> to the system keychain failed: …` | The value is not lost: setup writes the key to a file or shows the secret instead. |
| `github:setup` | `A new App <slug> is already waiting for its install` | Install it and run setup again, or remove it with `github:disable --forget`. |
| `github:setup`, `up`, `k8s:install`, `k8s:check` | `GitHub rejected the App's credentials: <GitHub's message>. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, run bun run secrets rm GITHUB_APP_PRIVATE_KEY, then bun run github:setup.` | In order: the machine's clock (GitHub rejects a JWT from a skewed clock), then `appId` in the config, then the key. Only if the key is wrong, remove it as the message says and run setup (`--app-id <id> --private-key-file <path>` for a new key). devbox never removes it itself. On Kubernetes the commands carry `--target <file>`, and with your own key Secret the message says to put the right key in it. |
| same | `GitHub has no App with id <id>: check integrations.githubApp.appId (the App's settings page shows its App ID)` | Fix `appId` in the config. It is the App ID on the App's settings page, not the installation ID. |
| same | `integrations.githubApp.slug is "<config slug>" but App <id> is "<actual slug>": run bun run github:setup` | The config names another App. Run setup, or fix `slug`. |
| `up`, `k8s:install`, `k8s:check` | `No private key for the GitHub App: set GITHUB_APP_PRIVATE_KEY_FILE to its path, or run bun run github:setup` | Put the key where [the lookup](#the-private-key) finds it. |
| same | `GITHUB_APP_PRIVATE_KEY_FILE=<path>: does not hold a PEM private key` (or `cannot read it`, `is a directory`), `GITHUB_APP_PRIVATE_KEY does not hold a PEM private key` | Fix the path or the value. |
| `up`, `k8s:install` | `These repos are not in the GitHub App's installation: …` | Add the repos to the installation, or set `tokenScope` to `"installation"`. |
| `up`, `k8s:install` | `integrations.githubApp.tokenFile <path>: …` | See [Compose external tokens](#compose-1). |
| config | `integrations.githubApp.tokenFile: required with tokens "external" on Compose` | Set `tokenFile`. |
| config | `integrations.githubApp.tokenFile: must be an absolute path`, `the path can't contain ":" or ","`, `keep the token file in a directory of its own (its whole directory is mounted into the containers)` | Move the token file as the message says. |
| config | `integrations.githubApp.tokenFile: Compose only; on Kubernetes use secrets.github.existingSecret` | Remove `tokenFile` from the target file. |
| config | `integrations.githubWebhooks: replaced by integrations.githubApp; run bun run github:setup` | Remove the old block and run setup. |
| config | `integrations.githubApp: needs github.trustedOrgs or github.trustedUsers (who may drive the agent from GitHub)` | Add a [trust list](#trust-lists). |
| `k8s:install`, chart | `integrations.githubApp.enabled is true: tokens: …` or `… tokenScope: repos needs at least one entry in repos …` | See [External tokens](#kubernetes-1) and [Token scope](#token-scope). |
| minter log | `github_token.mint_failed` with `status` 401, 403, 404 or 422 | 401: the key, App ID or clock (see above). 404: the installation is gone or the App ID is wrong. 403: GitHub refused the App (for example, it is suspended). 422: a repo is not in the installation. Run `github:status` for the last error. |
| minter | `bun run github-token --once` exits 1 with `token request failed: HTTP <status>: …`, `token request refused (HTTP 422): a repo in GITHUB_APP_REPOSITORIES is not in the installation (…)` or `gave up after 5 attempts: …` | `--once` (used by `up` and the seed Job) stops at once on 401, 403, 404 and 422, and on other failures after 5 attempts. Read the message. |
| minter | the token is stale and the log shows retries | The long-running minter never exits on GitHub errors. It retries every 5 seconds, doubling to 5 minutes (a 401 or 404 waits 5 minutes each time), so it recovers by itself once GitHub accepts the request. |
| `github:status` | `Control plane: the token has expired (…)` | Read the minter's logs with the command it prints. |
| `github:status` | `Control plane: not reachable (…)` | The control plane is not running, or the CLI profile does not reach it. |
| `github:status` | `Control plane: GitHub webhooks are not on there yet` | Run the apply command. |
| `github:status` probe | `the webhook URL <url> got no answer (…): the public URL does not reach devbox` | The tunnel is down, or the Ingress or DNS is not ready. With the URL from `ingress.api`, that Ingress may be VPN-only: add a public `ingress.webhooks`. |
| `github:status` probe | `got 404: something answered, but not devbox with GitHub on` | Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that `integrations.githubApp.enabled` is `true` and applied, or restart the control plane. |
| `github:status` probe | `got <status>: <body>` | Something else answered. The status and the first 300 characters of the body say what. |
| GitHub | `@<slug>` does nothing; the probe passes and `last webhook from GitHub` is `none yet` | Open the App's settings page, Advanced, Recent deliveries. A failed delivery shows GitHub's request and devbox's answer. A `401` there means `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret. Make them match, apply, and on Kubernetes restart the control plane. Also check that the webhook is Active and that the commenter is in a [trust list](#trust-lists). |

Where the logs are:

```bash
docker compose -f control-plane/docker-compose.yml logs github-token        # the minter, Compose
docker compose -f control-plane/docker-compose.yml logs control-plane       # Compose
kubectl --context <context> -n devbox logs deploy/devbox-github-token       # the minter, Kubernetes
kubectl --context <context> -n devbox logs deploy/devbox-control-plane      # Kubernetes
```
