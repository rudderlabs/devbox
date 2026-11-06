# Jira

devbox can work from Jira Cloud. You connect it once, with a Jira service
account and an admin webhook that belong to one devbox deployment: the local
stack (`bun run up`) or a Kubernetes install (`bun run k8s:install`, or
GitOps).

## What you get

- **Assign an issue** to the bot (the service account), and it starts a task,
  as `bun run devbox create` does. It moves the issue to the configured
  "started" status, links the draft pull request on the issue and, when the
  run finishes, moves the issue to done, or to failed if the task failed
  ([Statuses](#statuses)).
- **Follow-ups** are comments that mention the bot, picked from Jira's @-list
  or typed as `@<bot name>`. They reach the task, like `bun run devbox send`.
- **Replies** arrive as comments on the issue.
- There is no live progress on the issue. Follow a task with the CLI: its key
  is usually the issue key, so `bun run devbox logs -f ENG-12` works, and
  `bun run devbox ls --source jira` lists the Jira tasks.
- Stopping a task from Jira is not supported ([Lifecycle](#lifecycle)).

The agent works on the repos in `devbox.config.json`. With more than one,
name the repo in the issue.

devbox calls Jira as the service account, through Atlassian's API gateway
(`api.atlassian.com`), with the account's email and API token. One deployment
works with one Jira site.

## Requirements

- **A Jira Cloud site**, `https://<name>.atlassian.net`. Jira Data Center is
  not supported.
- **A service account** in the site's Atlassian organization, with an API
  token. devbox supports service-account tokens only, not the API token of a
  regular user's account. An organization admin creates the service account.
- **A Jira admin**, to create the webhook. The service account can't create it.
- **A public HTTPS URL** that reaches devbox ([below](#the-public-url)).

## The public URL

Jira delivers webhooks only to a public HTTPS URL. It is the same setting as
for Linear and GitHub: the top-level `publicUrl` of the config file
(`devbox.config.json`, or the target file on Kubernetes). One tunnel or
Ingress serves `/webhook/jira`, `/webhook/linear` and `/webhook/github`. How
the URL is chosen and which URLs are refused is described in
[Linear: The public URL](linear.md#the-public-url).

In short:

- **Compose and kind: bring your own.** Run a tunnel or a reverse proxy that
  forwards HTTPS to port 3000 on your machine (on kind, to the local port of
  `bun run k8s:connect`), and pass its URL with `--public-url`.
- **Kubernetes with an Ingress:** the `ingress.webhooks` host, else the
  `ingress.api` host.

The control plane accepts webhook request bodies up to 1 MiB, and answers a
larger delivery with HTTP 413 without processing it. Keep any tunnel,
reverse-proxy, or Ingress body limit at or below 1 MiB.

Only `jira:setup` (and the Linear and GitHub setups) and `jira:status` (for
the probe) use the public URL. The control plane does not read it.

**When the URL changes**, run
`bun run jira:setup --public-url <new> [--target <file>]`. It saves the new
URL and prints the webhook's settings with it: edit the webhook in Jira (Settings → System → WebHooks) and set its
URL to `<new>/webhook/jira`. Jira has no API the bot may use for it. With
Linear or the GitHub App on, it also prints what they need. A token or
webhook secret that is neither in your environment nor in the keychain is
asked for again: at the webhook secret, paste the current one, since Enter
generates a new one that you must then set in Jira
([Running it again](#running-it-again)). `linear:setup` and `github:setup`
run with a new URL print
`Update the webhook URL in Jira (Settings → System → WebHooks) to <new>/webhook/jira`.

## Setup

Every deployment follows the same steps: create the service account,
`jira:setup` checks it and records the settings, a Jira admin creates the
webhook, the deployment's usual command applies the settings, and
`jira:status` checks the result. `jira:setup` applies nothing: it never runs
`up` or `k8s:install`, never touches the cluster and sends nothing to devbox.
It first runs `bun install` for the control plane and the CLI, as `bun run up`
does. After that, its only network calls go to your Jira site and to
`api.atlassian.com`.

### 1. The service account

Jira now calls issues *work items* and projects *spaces*, and its permission
screens use those words. This page keeps saying issue and project.

You don't have to find these pages yourself: run in a terminal, `jira:setup`
opens each one when a step needs it, and always prints its link. Jira takes
nothing prefilled from a link, so setup also says what to do on the page.

1. In Atlassian Administration, open Directory → Service accounts and create
   one. Give it access to Jira. Its name is the bot's name in Jira: the name
   people assign issues to and type as `@<bot name>`.
2. Create an API token for it with the scopes `read:jira-work`,
   `write:jira-work` and `read:jira-user`. Copy the token: Atlassian shows it
   only once.
3. **Note the token's expiry date.** Atlassian tokens last at most a year.
   devbox can't read the date from Atlassian: `jira:setup` asks for it, and
   devbox warns from 14 days before ([Rotating the API token](#rotating-the-api-token)).
4. In each project devbox works in, give the service account a role that lets
   it browse the project, add comments, transition issues and link issues
   (the permissions Browse projects, Add comments, Transition work items and
   Link work items), and be assigned issues (Assignable user). `jira:setup`
   and `jira:status` check all five. Without Assignable user, Jira doesn't
   offer the bot as an assignee, so nobody can start a task. Linking the pull
   request also needs issue linking to be on for the site, which it is by
   default. On Jira Free there is nothing to do: permissions can't be
   customized there, and the fixed default scheme gives these permissions to
   every user with access to Jira, a service account with Jira access
   included ([Jira Free](#jira-free)).
5. **Only if you narrow trust to groups** ([Trust](#trust)): create each
   group first if it doesn't exist (Atlassian Administration → Directory →
   Groups), and give the service account the global permission **Browse users
   and groups**: in Jira Settings → System → Global permissions, grant it to a
   group the service account is in. devbox reads each person's groups with it.
   Without it every group lookup fails, so devbox answers assignments and
   follow-ups with HTTP 503 (`jira_webhook.trust_unresolved`), and once Jira
   has retried five times the event is lost. `jira:setup` warns about it, and
   `jira:status` shows it as `missing USER_PICKER …`. Without trusted groups,
   devbox reads no groups and the service account doesn't need this
   permission.

### 2. Run `jira:setup`

On Compose, `devbox.config.json` must exist first: run `bun run quickstart`
once. On Kubernetes, the target file must exist.

```
bun run jira:setup [--target <file>] [--public-url <url>] [--site <url>]
                   [--email <address>] [--projects <KEY,…>]
                   [--trusted-groups <names>] [--trusted-users <ids>]
                   [--token-expires <YYYY-MM-DD>] [--no-keychain]
```

| Flag | Effect |
|---|---|
| `--target <file>` | The Kubernetes deployment that target file describes. Without it, the Compose deployment. |
| `--public-url <url>` | The public HTTPS URL Jira sends webhooks to. Wins over the saved one and the Ingress. |
| `--site <url>` | The Jira site, `https://example.atlassian.net`: an `https` origin, with no path. |
| `--email <address>` | The service account's email, shown on its page in Atlassian Administration. |
| `--projects <KEY,…>` | The keys of the projects devbox works in, comma-separated, such as `ENG,OPS`. Upper-cased. |
| `--trusted-groups <names>` | Only members of these Jira groups may assign issues to devbox and ask it to follow up, comma-separated ([Trust](#trust)). Without this flag and `--trusted-users`, everyone with access to the site may. |
| `--trusted-users <ids>` | Account IDs of other people who may, comma-separated. |
| `--token-expires <YYYY-MM-DD>` | When the API token expires. |
| `--no-keychain` | Never read or write the system keychain. |

What it does, in order. Each value comes from its flag, else from the config,
else from a prompt in a terminal. Without a terminal, a missing value stops it
with `no <what>: pass <flag>, or run bun run jira:setup in a terminal`, and an
empty answer at a prompt with `No <what> entered: nothing was written.`

1. **The public URL**: `--public-url`, else the saved `publicUrl`, else
   (Kubernetes) the Ingress, else (Compose, in a terminal) a prompt. It prints
   `Public URL: <url>`.
2. **The site** (`Jira site URL (e.g. https://example.atlassian.net): `). It
   reads the site's cloud ID from `<site>/_edge/tenant_info`; the API gateway
   needs it.
3. **The service account's email**
   (`The service account's email (shown on its page in Atlassian Administration): `).
4. **The API token.** `JIRA_API_TOKEN` from your environment is used as it
   is. Otherwise, in a terminal, it asks
   `Jira API token (input hidden): `, or, with a token saved in the keychain,
   `Jira API token (input hidden; press Enter to keep the saved one): `.
   Before asking for a new token (none in your environment or the keychain),
   it prints
   `Create the service account in Atlassian Administration (Directory → Service accounts) if it doesn't exist, give it Jira access, and create its API token with the scopes read:jira-work, write:jira-work and read:jira-user:`
   and the link `https://admin.atlassian.com/`, and opens it.
   Without a terminal it uses the saved one, or stops with
   `no JIRA_API_TOKEN: run bun run jira:setup in a terminal, or set JIRA_API_TOKEN`.
   It checks the token with Jira (`GET /myself`) and prints
   `devbox will act as <name> (account <account id>) on <site>`. The bot's
   account ID and name come from that answer, never from you. A rejected saved
   or typed token is asked for again. A rejected saved one stays saved, with
   `The saved JIRA_API_TOKEN for <scope> was rejected; keeping it`: Jira
   answers a wrong email with the same 401, and Atlassian shows a token only
   once. Pasting the saved token again counts as keeping it.
5. **The projects**
   (`Jira project keys devbox works in, comma-separated (the key of each space, e.g. ENG): `).
   For each, it checks the five permissions and reads the statuses its
   workflows use. It warns, and goes on, about a project the bot can't see or
   a permission it lacks, and prints the link to that project's permissions,
   `<site>/plugins/servlet/project-config/<KEY>/permissions`. It opens the
   first such link only.
6. **The statuses**, on the first run only ([Statuses](#statuses)).
7. **Trust**, on the first run in a terminal, unless a trust flag is given:
   `Jira groups whose members may assign issues to devbox, comma-separated (Enter for everyone with access to the site): `,
   then `Account ids of other people who may, comma-separated (Enter for none): `,
   or, with no group,
   `Account ids of the only people who may, comma-separated (Enter for everyone with access to the site): `.
   No answer is required. With no group or account ID (Enter at both, or no
   flag without a terminal), it prints
   `Trust: everyone with access to the site (narrow it with --trusted-groups or --trusted-users)`.
   With trusted groups, it checks that the service account has the global
   permission Browse users and groups. When it doesn't, setup warns and
   prints and opens the global permissions page,
   `<site>/secure/admin/GlobalPermissions!default.jspa`.
8. **The token's expiry**
   (`When the API token expires (YYYY-MM-DD, as Atlassian showed when you created it): `),
   asked again whenever a new token was typed. A date in the past is refused.
9. **The webhook's secret.** `JIRA_WEBHOOK_SECRET` from your environment or
   the keychain is used as it is. Otherwise, in a terminal, it asks
   `Jira webhook secret (input hidden; paste the webhook's current one, or press Enter to generate a new one to set in Jira): `.
   Paste the secret the webhook in Jira already has, or press Enter to have it
   generate a new one, which you then set in Jira. A typed secret must have at
   least 20 characters (a secret from Jira's own Generate button qualifies): the signature it makes is the only proof that a
   delivery comes from Jira. A shorter one stops setup with
   `the webhook secret you entered has <n> characters; it needs at least 20 …`.
10. **Save.** With a terminal and a working keychain, it offers to save what
    you typed or it generated:
    `Save JIRA_API_TOKEN and JIRA_WEBHOOK_SECRET to the system keychain for <scope>? [Y/n]`
    (naming only those), where `<scope>` is `compose` or
    `k8s:<context>/devbox`. Values from your environment are never saved.
    When you decline to save a new token, it removes the token saved before,
    so that the next apply doesn't use the old one:
    `Removed the old JIRA_API_TOKEN saved in the system keychain for <scope>, so that <apply command> doesn't use it instead of the new one`.
11. **Write.** It writes `integrations.jira` with `enabled: true` and
    `publicUrl` to the deployment's config file, keeping the rest of the file,
    and prints `Wrote integrations.jira to <file>`.
12. **The webhook**, on every run ([below](#3-create-the-webhook-in-jira)).
13. **Next step.** For each secret that is neither saved in the keychain nor
    saved now, it says what the next apply does:
    `<apply command> will use <NAME> from your environment`, or
    `Set <NAME> in your environment before <apply command>; otherwise it asks for it in a terminal`.
    Then `Next: <apply command> (setup applies nothing)` and
    `Then check Jira with: bun run jira:status [--target <file>]`.

#### Running it again

Running it again is safe: a configured setting is kept unless a flag changes
it. To change the projects or the trust lists on a re-run, pass the flag or
edit the config file. To trust everyone with access to the site again, remove
`trustedGroups` and `trustedUsers` from the config file, or pass
`--trusted-groups "" --trusted-users ""`. To change the statuses, edit the
config file.

The secrets are the exception: setup reuses the token and the webhook secret
only from your environment or the keychain. Otherwise it asks for them again.
At the webhook secret, paste the one the webhook in Jira has: pressing Enter
generates a new one, which you must then put in Jira
([Replacing the webhook secret](#replacing-the-webhook-secret)).

### 3. Create the webhook in Jira

At the end, setup prints the webhook a Jira admin creates:

```
The webhook in Jira (a Jira admin creates it once: Settings → System → WebHooks):
  <site>/plugins/servlet/webhooks
Click Create there, or edit the webhook you have, and paste these values:
  URL     <public-url>/webhook/jira
  Secret  the new secret shown below
  Events  Issue: created, updated; Comment: created
  JQL     project in ("ENG", "OPS")
Update the webhook's JQL whenever the project keys change.
```

The `Secret` line says where the secret is: `the new secret shown below`
(after `Press Enter to show the webhook secret, to paste into the webhook's Secret field`;
it is shown once, on the terminal), `the secret you entered`,
`JIRA_WEBHOOK_SECRET from your environment`, the one saved in the keychain
(not shown), or `JIRA_WEBHOOK_SECRET from Secret "<name>"`.

Setup opens the webhooks page on a first run, and whenever it generated a new
webhook secret, which Jira must get. Other runs only print the link.

In Jira, as an admin, open Settings → System → WebHooks (the printed link) and
create a webhook:

- **URL:** the `URL` line.
- **Secret:** the webhook's secret. devbox refuses deliveries without a valid
  signature.
- **Events:** Issue created and Issue updated, and Comment created.
- **JQL:** the `JQL` line, `project in ("…")` with the project keys, each
  quoted: keys such as `GO`, `IF`, `SET` or `NEXT` are JQL reserved words.
- Leave **Exclude body** unchecked: devbox reads the body.

**Update the webhook's JQL whenever the project keys change.** Jira sends
nothing for a project the JQL leaves out, and devbox ignores events from a
project that is not in `projectKeys`.

### 4. Apply and check

#### Compose

```bash
ngrok http 3000                                           # in another terminal
bun run jira:setup --public-url https://<your-tunnel-host>
# a Jira admin creates the webhook it prints
bun run up
bun run jira:status
```

The settings go in `devbox.config.json`:

```json
"publicUrl": "https://…",
"integrations": { "jira": {
  "enabled": true, "siteUrl": "https://example.atlassian.net", "cloudId": "…",
  "botEmail": "…", "botAccountId": "…", "botName": "devbox",
  "projectKeys": ["ENG", "OPS"],
  "statuses": { "started": "In Progress", "done": "Done" },
  "tokenExpiresAt": "2027-01-31" } }
```

With `enabled: true`, `bun run up` resolves the two Jira secrets, warns when
the token expires within 14 days, checks the token with Jira (it must still
belong to `botAccountId`), and passes `JIRA_*` to the control plane. It
prints `Jira: devbox acts as <name> on <site>` and, near the end,
`Check Jira with: bun run jira:status` (followed by `Check GitHub with: …`
when the GitHub App is on). `--skip-jira-check` skips the token
check, and `--skip-checks` skips it with the others; the expiry warning stays.

#### kind

kind has no public address, so it needs a tunnel, as for the
[GitHub App](github.md#kind): point it at the local port
`bun run k8s:connect --target devbox.kind.json` forwards to.
`devbox.kind.json` must exist first: run `bun run k8s:kind` once. Then run
`bun run jira:setup --target devbox.kind.json --public-url https://<your-tunnel-host>`,
then `bun run k8s:kind` (the apply command setup prints) and
`bun run jira:status --target devbox.kind.json`.

#### Kubernetes

```bash
bun run jira:setup --target devbox.k8s.json
# a Jira admin creates the webhook it prints
bun run k8s:install --target devbox.k8s.json
bun run jira:status --target devbox.k8s.json
```

The settings go in the target file's top-level `integrations` block, not
under `values`, with the same keys as on Compose. The installer copies the
block into the chart values as it is (`integrations.jira.*`), resolves the
two secrets, warns about the expiry, checks the token, and writes the secrets
to the Secret `devbox-integrations`. `k8s:install --skip-jira-check` skips the
token check. The control plane needs egress to `api.atlassian.com`.

With your own integrations Secret (`secrets.integrations.existingSecret` in
the target file's values), setup still reads the token to check it, but saves
no secret and prints
`Put JIRA_API_TOKEN and JIRA_WEBHOOK_SECRET in Secret "<name>" in namespace devbox.`
Put them there yourself, then restart the control plane after each change to
that Secret. Setup generates no webhook secret then: make one (for example
`openssl rand -hex 32`) and put the same value in the Secret and in Jira's
webhook. The installer never reads the Secret: it checks only the expiry, and
`bun run k8s:check --target <file>` checks the token and warns about its expiry
([kubernetes/README.md](kubernetes/README.md#check-the-secrets)).

#### GitOps

`jira:setup` needs a target file for the cluster, even when you never run
the installer: `context`, the Ingress values (or pass `--public-url`), and
`profile` set to the CLI profile you added with `bun run devbox profile add`,
which `jira:status` uses. Then:

1. `bun run jira:setup --target devbox.k8s.json`. Set
   `secrets.integrations.existingSecret` under `values` first, or decline the
   keychain. Near the end it prints
   `With GitOps, set the chart values integrations.jira.* to the integrations.jira block in <file> instead, with enabled: true`.
   Ignore its `Set … in your environment before bun run k8s:install` and
   `Next: bun run k8s:install …` lines: they are for the installer.
2. Put `JIRA_API_TOKEN` and `JIRA_WEBHOOK_SECRET` in the integrations Secret
   ([kubernetes/secrets.md](kubernetes/secrets.md)). With
   `secrets.integrations.existingSecret` set, setup makes no webhook secret:
   make one yourself (`openssl rand -hex 32`) and put the same value in the
   Secret and in Jira's webhook. Otherwise use the one setup showed you once.
3. Set the chart values `integrations.jira.*` to the block in the target file,
   and sync.
4. `bun run k8s:check --target devbox.k8s.json` checks the Secret and the
   token, and `bun run jira:status --target devbox.k8s.json` the rest.
   `k8s:check` reads that Jira is enabled from the target file's
   `integrations` block: keep it in step with the chart values.

The chart refuses to render `integrations.jira.enabled: true` without each of
`siteUrl`, `cloudId`, `botEmail`, `botAccountId`, `botName`, `projectKeys` and
`tokenExpiresAt`
(`integrations.jira.enabled is true: integrations.jira.<key> is required`).

### What turns Jira on

Only `enabled: true` in `integrations.jira`: in `devbox.config.json`, the
target file, or the chart values with GitOps. A `JIRA_*` variable in your
shell, a saved secret or a key in a Secret never turns Jira on, and does
nothing while `enabled` is `false` or the block is absent. The fields are in
[configuration.md](configuration.md#integrations).

## Trust

An issue's description and its comments become the agent's instructions, so
devbox acts only on people it trusts:

- **An assignment** counts only when both the person who assigned the issue
  to the bot and the issue's reporter are trusted (its creator, when it has no
  reporter). The reporter wrote the description the agent works from.
- **A follow-up** counts only when the comment's author is trusted.

**By default, devbox trusts everyone with access to the site**, as Linear
trusts everyone in its workspace. That is everyone your Jira admins let onto
the site: your colleagues, people from outside your company they invite, such
as contractors, and, when the site lets people sign up on their own (for
example anyone with an email address at your company's domain), everyone who
does. It is never the public: Jira sends events only for what accounts on the
site do, and devbox checks each webhook's signature. In this mode devbox looks
nothing up, and the service account needs no extra permission.

Two lists in `integrations.jira` narrow trust. With either set, devbox trusts
only the people they name:

- **`trustedGroups`**: Jira group names, in any letter case. devbox looks up
  each person's groups as the service account, which needs the global
  permission Browse users and groups ([The service account](#1-the-service-account)),
  and caches the answer for about 6 hours. Removing someone from a group takes
  effect within 6 hours, or up to about 12 hours while lookups fail, or at
  once after a restart of the control plane.
- **`trustedUsers`**: account IDs. A person's account ID is the last part of
  their profile URL in Jira.

In every mode, only people are trusted. Accounts of apps, Automation for Jira
among them, and Jira Service Management customers never are: an action by one
is ignored with `reason: non_human`, and an issue one reported is ignored with
`reason: untrusted` and `side: reporter`. So an automation rule that runs as
Automation for Jira (its default actor) does nothing; a rule set to run as the
user who triggered it counts as that user. The bot's own events are ignored.

An untrusted action is ignored. devbox answers the webhook, posts nothing on
the issue, and logs `jira_webhook.ignored` with `reason: untrusted`, `side`
(`assigner`, `reporter` or `commenter`) and the account ID.

With trusted groups, when a group lookup fails, devbox tries that person
again at most once a minute and meanwhile keeps the last answer for up to 6
more hours. With no answer at all, it answers the webhook with HTTP 503, so
Jira delivers it again later (Jira retries up to five times), and logs
`jira_webhook.trust_unresolved`. When the service account lacks Browse users
and groups, every lookup fails this way.

**Important: devbox checks who reported the issue, not who last edited it.**
Anyone who can edit an issue can change its description before a trusted
person assigns it to the bot, and the agent then works from that text. By
default the people who can edit issues are trusted anyway; apps that edit
issues are not, so an app that copies outside text into descriptions passes
that text to the agent. **When you narrow trust, restrict the Edit work items
permission to trusted groups in the projects devbox works in.** On Jira Free
you can't ([Jira Free](#jira-free)).

## Restricted issues and comments

The agent's pull request and its replies can reach people who can't see
restricted content in Jira. So by default devbox skips it:

- **An issue with a security level** is ignored, on assignment and on every
  follow-up (a level can be set after the task started). The log says
  `reason: restricted_issue`. On an assignment, devbox reads the issue when
  the webhook leaves the level out; on a follow-up it always reads it again.
  If that read fails, it answers 503, logs
  `jira_webhook.security_unresolved`, and Jira retries. Set
  `allowRestrictedIssues: true` in `integrations.jira` to act on these
  issues too.
- **A comment restricted to a role or a group**, and an internal comment on a
  service project, is ignored (`reason: restricted_comment`), whatever
  `allowRestrictedIssues` says.

## Statuses

`integrations.jira.statuses` names the statuses devbox moves an issue to:
`started`, `done` and, optionally, `failed`. Names match in any letter case.
An absent one means no move.

On its first run, `jira:setup` prints `Statuses every project has: …` and
proposes `In Progress` for `started` and `Done` for `done`, when every project
has them:
`Status devbox moves an issue to when it starts work [In Progress] (- for none): `.
Press Enter to take the proposal, type another status, or `-` for none.
Without a terminal it takes the proposals. Once the config has `statuses`,
setup no longer asks: edit `integrations.jira.statuses` to change them,
including to set `failed`, then apply. setup warns about a missing `started`
or `done`, and about a project without a configured status; `jira:status`
shows the latter too.

devbox moves an issue:

- **to `started`** when the task starts, before its sandbox is created, if
  the bot is still the assignee;
- **to `done`** when the assignment's run finishes, or **to `failed`** when
  the task failed and `failed` is set. A run that opened a pull request in one
  repo and failed in another counts as done. Without `failed`, a failed task
  leaves the issue in `started`.

These moves happen only while the bot is still the assignee and, for done and
failed, while the issue is still in `started`. An issue someone re-assigned or
moved by hand is never touched. Without a `started` status devbox moves
nothing at all, since it can't tell its own move from one made by hand.
Follow-ups don't move the issue.

A move the workflow doesn't offer from the issue's current status is skipped
and logged (`jira transition skipped: the workflow has no move to this status`),
and so is a move Jira refuses, for example one whose screen requires a field
(`jira transition refused`).

## Lifecycle

- **Un-assigning doesn't stop a run.** The task finishes and posts its
  replies; the issue is no longer the bot's, so it isn't moved.
- **Assigning the issue to the bot again starts over**: a new run and a new
  draft pull request. The old pull request is left as it is.
- **There is no cancel**, from Jira or from the CLI.
- **When something fails**, devbox comments:
  - for a failed assignment round, the harness's short summary of what went
    wrong;
  - when the task fails,
    `devbox couldn't finish this task. To start over, assign the issue to someone else and then back to <bot name>; this opens a new pull request.`;
  - when the task's workspace is gone,
    `This task's workspace was cleaned up, so devbox can't continue it. Assign the issue to someone else and then back to <bot name> to start over.`
  A follow-up that fails gets a comment that ends
  `Comment with @<bot name> to retry.`
- **A long reply** is split into up to three comments. Past that it is cut
  and ends with `Full text in the pull request.`

## Rotating the API token

devbox warns from 14 days before the date in `tokenExpiresAt`:

- `jira:setup`, `up`, `k8s:install` and `k8s:check` print
  `warning: the Jira API token expires in <n> days (<date>): create a new one for the service account, then run bun run jira:setup`.
  Once the date has passed, `up`, `k8s:install` and `k8s:check` say
  `expired on <date>` instead; `jira:setup` refuses a date in the past;
- `jira:status` prints `API token: expires in <n> days: rotate it soon …`;
- the control plane logs
  `Jira API token expires soon: rotate it, then update JIRA_API_TOKEN and JIRA_TOKEN_EXPIRES_AT`
  at most once a day per replica, when a webhook or a status call arrives.

To rotate:

1. Create a new API token for the service account, with the same scopes, and
   note its expiry.
2. Give devbox the token and the date:
   - **Saved in the keychain:** run `bun run jira:setup [--target <file>]`,
     paste the new token at
     `Jira API token (input hidden; press Enter to keep the saved one): `,
     enter its expiry, and save it. If you don't save it, setup removes the
     old saved token, and the next apply takes the token from
     `JIRA_API_TOKEN` or asks for it in a terminal.
   - **From your environment:** set `JIRA_API_TOKEN` to the new token and run
     `bun run jira:setup --token-expires <YYYY-MM-DD> [--target <file>]`.
     Without the flag, setup keeps the old date for a token from your
     environment.
   - **In your own Secret, or with GitOps:** put the token in the Secret,
     and set `tokenExpiresAt` in the target file and in the chart values.
3. Apply. `bun run up` recreates the control plane. On Kubernetes,
   `k8s:install` rewrites the Secret, and the new expiry rolls the control
   plane. When only `devbox-integrations` changed, it prints the
   `kubectl rollout restart` command
   ([kubernetes/secrets.md](kubernetes/secrets.md#rotation)).
4. Delete the old token in Atlassian Administration.

## Replacing the webhook secret

Jira doesn't show a webhook's secret once it is saved, and nothing can check
the secret before Jira signs with it.

1. Remove the old one: `bun run secrets rm JIRA_WEBHOOK_SECRET [--target <file>]`,
   or unset it in your environment.
2. Run `bun run jira:setup [--target <file>]`, press Enter at
   `Jira webhook secret (input hidden; paste the webhook's current one, or press Enter to generate a new one to set in Jira): `,
   save it, and press Enter again to show it.
3. Edit the webhook in Jira and paste the secret into its Secret field.
4. Apply (`bun run up`, or `k8s:install` and the restart it prints).

Jira does not redeliver a webhook devbox refused for its signature, so
deliveries between steps 3 and 4 are lost: do them together. With your own
Secret, put a new random value there and in Jira, then restart the control
plane.

## Status

```
bun run jira:status [--target <file>] [--no-keychain]
```

Read-only: it never prompts, never reads a Kubernetes Secret and never prints
a secret. It exits 0 whatever the control plane or the probe report; only a
config or target file it can't load makes it exit 1. It prints:

1. **The settings**: `site`, `bot` (name and email), `projectKeys`, `trust`
   (`everyone with access to the site`, or the trusted groups and users),
   `tokenExpiresAt`, `publicUrl`, and where each Jira secret would come from
   at the next apply: `env`, `keychain` or `missing`, or
   `from Secret "<name>" (not read)` with your own integrations Secret.
   Without a block: `Jira is not configured for <scope>. Run: bun run jira:setup`.
   With `enabled: false`, it says so and stops.
2. **What the running control plane reports**, through the deployment's CLI
   profile (on Kubernetes it opens a port-forward when needed). They come
   from the one replica it reaches.
   - `Control plane: bot <name>, auth <ok | rejected | unknown>, last webhook from Jira <time | none yet>`.
     `auth rejected` means Jira refuses the token; it adds what to do.
   - `API token: expires in <n> days`, or `expired <n> days ago`.
   - `Trust: everyone with access to the site` without trust lists. With them,
     `Trust: <groups | users | groups+users>, <n> accounts cached`, and
     `last lookup failed: <class>` when the last group lookup failed. With
     trusted groups, it adds
     `missing USER_PICKER (the global permission Browse users and groups, needed to trust groups): grant it to a group the service account is in (Jira Settings → System → Global permissions)`
     when the service account lacks that permission.
   - `Project <KEY>: ok`, or what is wrong there: `missing <permissions>`,
     `no status "<name>"` for a configured status the project lacks, or
     `can't check (<class>)`.
   - `Last failed reply to Jira: <HTTP status | no answer> at <time>`, after a
     comment failed.
   - `Replies held for <n> task(s), the oldest for <m> min: Jira is refusing or rate-limiting them`:
     replies that wait to be sent again.
   - `Control plane: Jira is not on there yet. Run: <apply command>` means
     the settings were not applied, and `Control plane: not reachable (…)`
     that the profile doesn't reach it.
3. **The probe**, when `publicUrl` is set: an unsigned
   `POST <publicUrl>/webhook/jira` with body `{}` and a 10-second timeout.
   devbox with Jira on answers it `401 {"error":"invalid signature"}` and
   records nothing, so a 401 prints
   `Webhook URL <url>/webhook/jira: reaches devbox with Jira on`. Other
   answers are in [Troubleshooting](#troubleshooting).

The probe proves only that the URL reaches devbox **from the machine you run
it on**. It does not prove Jira can reach it, or that the webhook's secret
matches. "last webhook from Jira" moves only when a webhook signed with
`JIRA_WEBHOOK_SECRET` arrives: after you assign an issue, "none yet" is a real
signal.

## Disable

```
bun run jira:disable [--target <file>] [--no-keychain] [--forget [--yes]]
```

- **`jira:disable`** sets `integrations.jira.enabled` to `false` and keeps
  the settings and the saved secrets. Turn Jira back on with
  `bun run jira:setup`, or by setting `enabled` to `true`. It asks nothing.
- **`jira:disable --forget`** removes the `integrations.jira` block and the
  deployment's saved `JIRA_API_TOKEN` and `JIRA_WEBHOOK_SECRET`. It lists what
  it deletes and asks `[y/N]`; Enter or Ctrl-D answers no, and
  `Nothing was removed.` Without a terminal it refuses unless you pass
  `--yes`. It works on a disabled block too. The service account and its
  token are yours to remove.

Both print how many Jira tasks are open:
`<n> open Jira task(s) (bun run devbox ls --source jira): these keep running; their results will not reach Jira.`
When devbox's API can't be reached, they print
`Open Jira tasks (bun run devbox ls --source jira) keep running; their results will not reach Jira.`
instead.
**Disable the webhook in Jira yourself** (Settings → System → WebHooks), or
delete it after `--forget`: devbox can't.

Neither applies anything. Both print `Next: <apply command>`; run it to turn
Jira off in the running deployment. "Already disabled" and "not configured"
print no `Next:` line. On Kubernetes, the installer then writes
`devbox-integrations` without the Jira keys, or deletes it when nothing is
left.

## Several control-plane replicas

With `controlPlane.replicas` above 1, turn Jira on for every replica in one
rollout. While replicas that still have Jira off run beside the new ones:

- a webhook that reaches one of them gets a 404, which Jira does not
  redeliver: assign the issue again;
- one of them can pick up a Jira task. That task misses its move to
  `started`, and with it the move to done or failed. What it posts while that
  replica holds it doesn't reach Jira either.

## Upgrading and rolling back

Jira needs no database change. A control plane without Jira answers
`/webhook/jira` with 404, which Jira does not redeliver, and an older release
that picks up tasks of any source can work a Jira task without moving the
issue or posting anything to it. So:

- **Upgrade with Jira off**, and turn it on once every replica runs the
  release that has it.
- **Before rolling back** to a release without Jira:
  1. Disable the webhook in Jira, so no new work arrives.
  2. With Jira still on, wait until no Jira task is queued or running
     (`bun run devbox ls --source jira`), so their results still reach Jira.
  3. Turn Jira off (`jira:disable`, then the command it prints), then roll
     back.

  Turning Jira off before the tasks finish has the same effect as the
  rollback: they finish without posting to Jira.

## Jira Free

- Jira Free has up to 10 users. A service account doesn't count toward that
  limit ([Atlassian: service accounts](https://support.atlassian.com/user-management/docs/understand-service-accounts/)).
- On Free, project permissions and roles can't be customized, and on a site
  that has always been on Free everyone with access to Jira is an admin of
  every project
  ([Atlassian: the Free plan](https://support.atlassian.com/jira-cloud-administration/docs/what-is-the-free-jira-cloud-plan/)).
  The fixed default scheme gives every user with access to Jira the
  permissions devbox needs, a service account with Jira access included, so
  step 4 of [The service account](#1-the-service-account) needs no action.
  You can't restrict who edits issues either. With the default trust that
  changes nothing, since everyone with access to the site is trusted anyway.
  If you narrow trust to groups on Free, the gap in [Trust](#trust) stays
  open: anyone on the site can edit an issue's description before a trusted
  person assigns it to the bot, so the groups limit who starts a task, not
  whose text the agent reads.
- Each devbox comment notifies the issue's watchers by email, and Jira Free
  sends at most 100 emails a day. Past that, notifications pause until the
  next day.

## Troubleshooting

| Where | What you see | What to do |
|---|---|---|
| `jira:setup` | `the Jira site URL must be an https origin such as https://example.atlassian.net` | Pass the site's address with no path. |
| `jira:setup` | `<site> is not a Jira Cloud site (no cloud id at /_edge/tenant_info): check the site URL`, or `can't reach <site>: …` | Check the site URL, and this machine's egress or proxy. |
| `jira:setup`, `up`, `k8s:install`, `k8s:check` | `Jira rejected JIRA_API_TOKEN, or the email <email> doesn't match it (401): use the service account's API token, with scopes read:jira-work, write:jira-work and read:jira-user, and the service account's email` | The token is wrong or expired, it is not a service account's, or `<email>` is not the service account's email. A saved token stays saved. A wrong email: pass `--email` to `jira:setup`. Otherwise create a new token ([Rotating the API token](#rotating-the-api-token)). |
| `up`, `k8s:install`, `k8s:check` | `JIRA_API_TOKEN belongs to <name> (<id>), not the configured bot <name> (<id>): run bun run jira:setup` | The token is another account's. Use the bot's token, or run `jira:setup` with the new account's token to switch bots. |
| same | `can't reach api.atlassian.com: check this machine's egress or proxy` | On Kubernetes, the control plane needs egress to `api.atlassian.com` too. |
| `jira:setup` | `warning: project <KEY>: the bot can't see this project: check the key, and give the bot access to it` | Check the key, and give the service account a role in the project. |
| `jira:setup` | `warning: the bot lacks <permissions> in project <KEY>: …` | Give the service account a role there that has them ([The service account](#1-the-service-account)). |
| `jira:setup` | `warning: the bot lacks USER_PICKER (the global permission Browse users and groups, needed to trust groups): …` | Only with trusted groups. Grant Browse users and groups to a group the service account is in ([The service account](#1-the-service-account)). |
| `jira:setup` | `warning: project <KEY> has no status "<name>" (statuses.<role>)`, or `warning: no started status: …` | Set `integrations.jira.statuses` to statuses every project has ([Statuses](#statuses)). |
| `jira:status` | `Project <KEY>: missing …; no status "…"`, or `can't check (http_404)` | As the two rows above. `http_404`: the bot can't see the project. |
| `jira:status` | `Trust: …, last lookup failed: http_403` (or another `http_4xx`), or `missing USER_PICKER …` | Only with trusted groups. The service account can't read people's groups: grant it Browse users and groups ([The service account](#1-the-service-account)). Until then, assignments and follow-ups by group members fail with `jira_webhook.trust_unresolved`. |
| `jira:status` | `auth rejected`, or `API token: expired …` | Rotate the token ([Rotating the API token](#rotating-the-api-token)). |
| `jira:status` | `Replies held for …`, `Last failed reply to Jira: HTTP <status>` | Jira refuses the bot's comments. 403: the bot lacks Add Comments; 429: Jira's rate limit, which passes. |
| `jira:status` probe | `got no answer (…): the public URL does not reach devbox` | The tunnel is down, or the Ingress or DNS is not ready yet. With the URL from `ingress.api`, that Ingress may be VPN-only: add a public `ingress.webhooks`. |
| `jira:status` probe | `got 404: something answered, but not devbox with Jira on` | Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that `integrations.jira.enabled` is `true` and applied, or restart the control plane. |
| `jira:status` | `Control plane: Jira is not on there yet` | Run the apply command. |
| control plane log | `Jira webhook rejected: signature mismatch (check the webhook secret matches JIRA_WEBHOOK_SECRET)` | The webhook's secret in Jira differs from `JIRA_WEBHOOK_SECRET`: [replace it](#replacing-the-webhook-secret). |
| control plane log | `jira_webhook.security_unresolved` | devbox couldn't read the issue's security level: a timeout, no egress to `api.atlassian.com`, or the bot can't see the issue. It answered 503, so Jira retries. Check egress, and that the service account can browse the project. |
| control plane log | `Jira webhook rejected: unsigned (set a secret on the webhook in Jira)` | The webhook has no secret: set one ([Replacing the webhook secret](#replacing-the-webhook-secret)). |
| Jira | The bot is not offered as an assignee | Give the service account the Assignable User permission in the project. `jira:setup` warns about it, and `jira:status` shows `missing ASSIGNABLE_USER …`. |
| Jira | Assigning does nothing; `jira:status` shows `last webhook from Jira none yet` | The webhook is missing or disabled, its URL is wrong, its JQL leaves the project out, or its events lack Issue updated. Then read the control plane's logs for a rejected signature. |
| Jira | Assigning does nothing; webhooks arrive | Read the logs for `jira_webhook.ignored` and its `reason`: `untrusted` with `side: assigner` or `side: reporter` ([Trust](#trust)), `foreign_project` (add the key to `projectKeys` and the JQL), `restricted_issue`, or `non_human` (an app, or an automation rule running as Automation for Jira, assigned it). `jira_webhook.trust_unresolved`, with trusted groups, means group lookups fail, often because the service account lacks Browse users and groups ([The service account](#1-the-service-account)); Jira retries up to five times. |
| Jira | Assigning does nothing; the log shows `jira webhook failed` with `code: 23505` | The issue's key is already the key of a task from another source, such as a Linear issue with the same key: task keys are unique across sources regardless of case. Jira retries and then gives up; nothing is posted on the issue. Use a project key that no other source uses. |
| Jira | A comment that mentions the bot does nothing | The author is not trusted, the comment is restricted, the mention is inside a code block, the typed name differs from the bot's name, or the bot was never assigned the issue (`jira_webhook.ignored` with `reason: no_task`). When the bot is the assignee but has no task there, as after an ignored assignment, devbox answers 503 in case the assignment is still on its way, and logs `jira_webhook.task_not_found` at each of Jira's retries. |
| Jira | The issue doesn't move | See [Statuses](#statuses): no `started` status, the issue was re-assigned or moved, or the logs show `jira transition skipped` or `jira transition refused`. |

The control plane's logs:

```bash
docker compose -f control-plane/docker-compose.yml logs control-plane   # Compose
kubectl --context <context> -n devbox logs deploy/devbox-control-plane  # Kubernetes
```
