# ClickUp

devbox can work from ClickUp. You connect it once, with a bot account that is
a member of your ClickUp workspace and a webhook that `clickup:setup` creates
through ClickUp's API. Both belong to one devbox deployment: the local stack
(`bun run up`) or a Kubernetes install (`bun run k8s:install`, or GitOps).

## What you get

- **Assign a task** to the bot (add it to the task's assignees), and it starts
  a task, as `bun run devbox create` does. Creating a task with the bot
  already among its assignees does the same. devbox moves the task to
  "in progress" (the "started" status) and, when the run finishes, to a done
  or failed status if one is set ([Statuses](#statuses)).
- **Follow-ups** are comments that mention the bot, picked from ClickUp's
  @-list or typed as `@<bot name>`. They reach the task, like
  `bun run devbox send` ([Follow-ups](#follow-ups)).
- **Replies** arrive as comments on the task. The reply carries the draft
  pull request's URL (a github.com pull request, or a merge request on the
  deployment's GitLab instance); devbox adds no other link to the task
  ([Known limits](#known-limits)).
- There is no live progress on the task. Follow a task with the CLI: its key
  is usually `CU-` and the ClickUp task id, so
  `bun run devbox logs -f CU-86a1b2c3d` works, and
  `bun run devbox ls --source clickup` lists the ClickUp tasks.
- Stopping a task from ClickUp is not supported ([Lifecycle](#lifecycle)).

The agent works on the repos in `devbox.config.json`. With more than one,
name the repo in the task. The task's name and description are what the
agent works from.

devbox calls ClickUp's API (`api.clickup.com`) as the bot, with its personal
API token. One deployment works with one ClickUp workspace.

## Requirements

- **A ClickUp workspace.**
- **A bot**: a ClickUp account of its own that is a **member** of the
  workspace, not a guest, with its personal API token (`pk_…`). An admin
  works too, but a member is enough. The bot creates and updates devbox's
  webhook itself, so nobody needs to change ClickUp's settings.
- **A public HTTPS URL** that reaches devbox ([below](#the-public-url)).

## The public URL

ClickUp delivers webhooks to `<publicUrl>/webhook/clickup`; see
[The public URL](public-url.md) for what the URL must be and how to get one.
`clickup:setup` creates or updates the webhook with that URL through
ClickUp's API ([The webhook](#3-the-webhook)), so there is nothing to paste
into ClickUp.

**When the URL changes**, run
`bun run clickup:setup --public-url <new> [--target <file>]`. It saves the new
URL and moves the webhook to it, keeping the webhook's secret:
`Webhook <id> in ClickUp: updated for <new>/webhook/clickup (it pointed at <old>/webhook/clickup)`.
It also prints what each other integration that is on needs
([When it changes](public-url.md#when-it-changes)).

Another integration's setup run with a new URL prints
`Run bun run clickup:setup to update the ClickUp webhook's URL` (with
`--target <file>` on Kubernetes) while ClickUp is on. Until you run it,
ClickUp keeps sending to the old URL.

## Setup

Every deployment follows the same steps: create the bot, `clickup:setup`
checks it, creates or updates the webhook and records the settings, the
deployment's usual command applies them, and `clickup:status` checks the
result. `clickup:setup` applies nothing: it never runs `up` or `k8s:install`,
never touches the cluster and sends nothing to devbox. It first runs
`bun install` for the control plane and the CLI, as `bun run up` does. After
that, its only network calls go to ClickUp (`api.clickup.com`).

### 1. The bot

1. Create a ClickUp account for the bot, with an email address you control,
   and invite it to the workspace as a **member**, not a guest (Settings →
   People). Its username is the bot's name in ClickUp: the name people assign
   tasks to and type as `@<bot name>`. `clickup:setup` reads it from ClickUp.
2. Signed in as the bot, generate its personal API token under Settings →
   Apps (`https://app.clickup.com/settings/apps`). It starts with `pk_`.
3. devbox reads each task as the bot, so the bot must be able to see the
   spaces, folders and lists devbox works in: share private ones with it.
   **devbox works on any task in the workspace that a trusted person assigns
   to the bot** ([Trust](#trust)). There is no list of spaces, and the webhook
   covers the whole workspace.

`clickup:setup` refuses a guest:
`` <bot> is a guest in workspace <name>: a guest sees only what is shared with it and may not manage the workspace's webhooks, so devbox needs a member (or an admin or owner). Make it a member in ClickUp (Settings → People), then run `bun run clickup:setup` again. ``

### 2. Run `clickup:setup`

On Compose, `devbox.config.json` must exist first: run `bun run quickstart`
once. On Kubernetes, the target file must exist.

```
bun run clickup:setup [--target <file>] [--public-url <url>] [--team <id>]
                      [--no-keychain]
```

| Flag | Effect |
|---|---|
| `--target <file>` | The Kubernetes deployment that target file describes. Without it, the Compose deployment. |
| `--public-url <url>` | The public HTTPS URL ClickUp sends webhooks to. Wins over the saved one and the Ingress. |
| `--team <id>` | The workspace, by its id (digits only, as setup lists it: `<name> (<id>)`), when the bot is in several. Wins over the configured `teamId`. |
| `--no-keychain` | Never read or write the system keychain. |

What it does, in order. Without a terminal, a value it would ask for stops it
with a message that names the flag or the variable that gives it. A blank
line sets off each part of its output: the bot, the webhook, and what it
saved and wrote.

1. **The public URL**: `--public-url`, else the saved `publicUrl`, else
   (Kubernetes) the Ingress, else (Compose, in a terminal) a prompt. It prints
   `Public URL: <url>`.
2. **The API token.** `CLICKUP_API_TOKEN` from your environment is used as it
   is. Otherwise, in a terminal with no token saved, it first prints where to
   get one:

   ```
   The bot, the ClickUp account devbox acts as:
     1. Invite it to your workspace as a member (not a guest), if it isn't there.
     2. Signed in as the bot, generate its personal API token under Settings → Apps:
     https://app.clickup.com/settings/apps
   ```

   Then it asks `ClickUp API token of the bot (pk_…) (input hidden): `, or,
   with a token saved in the keychain,
   `ClickUp API token of the bot (pk_…) (input hidden; press Enter to keep the saved one): `.
   Pasting the saved token again counts as keeping it. Without a terminal it
   uses the saved one, or stops with
   `` no CLICKUP_API_TOKEN: run `bun run clickup:setup` in a terminal, or set CLICKUP_API_TOKEN ``.
   An empty answer stops it with
   `` No ClickUp API token entered: nothing was written. Run `bun run clickup:setup` again when you have it. ``

   It checks the token with ClickUp (`GET /user`). The bot's user id and
   username come from that answer, never from you. A rejected saved or typed
   token is asked for again, after
   `ClickUp rejected CLICKUP_API_TOKEN (401): use the bot's personal API token (pk_…), from ClickUp's Settings → Apps while signed in as the bot`
   and `Enter CLICKUP_API_TOKEN again, or press Enter on an empty value to exit.`
   A rejected saved one stays saved
   (`The saved CLICKUP_API_TOKEN for <scope> was rejected; keeping it`): only
   you remove a saved token.
3. **The workspace** (`GET /team`): `--team`, else the configured `teamId`,
   else the bot's only workspace. When the bot is in several, it lists them
   in a terminal and asks:

   ```
   The bot is in several ClickUp workspaces:
     1. Example (1234567890)
     2. Example Labs (2345678901)
   The workspace devbox works in (number or id): 
   ```

   Without a terminal it stops with
   `the bot is in <n> ClickUp workspaces: pass --team <id> with one of <name> (<id>), …`.
   A workspace the bot isn't in stops it with
   `the bot is not in ClickUp workspace <id>: invite it there as a member, or pass --team with one of its workspaces: …`.
4. **The bot's role** in that workspace, from the same answer. A guest is
   refused ([above](#1-the-bot)), and so is a role setup can't read
   (`can't tell <bot>'s role in workspace <name>: it must be a member, an admin or the owner there`).
   It prints
   `devbox will act as <username> (user <id>), a <member | admin | owner> of workspace <name> (<id>)`.
5. **The webhook**, created or updated in place
   ([below](#3-the-webhook)).
6. **The webhook's secret.** ClickUp makes it, and gives it to setup when it
   creates the webhook and in its list of webhooks: you never type it. A
   `CLICKUP_WEBHOOK_SECRET` in your environment must match it; one that
   doesn't stops setup with
   `` CLICKUP_WEBHOOK_SECRET in your environment is not the secret of webhook <id>: unset it, or set it to the webhook's, and run `bun run clickup:setup` again. Nothing was written. ``
   A different one saved in the keychain is replaced by ClickUp's:
   `The CLICKUP_WEBHOOK_SECRET saved in the system keychain for <scope> is not webhook <id>'s secret: using ClickUp's`.
7. **Save.** With a terminal and a working keychain, it offers to save the
   token you typed and a webhook secret the keychain doesn't hold yet:
   `Save CLICKUP_API_TOKEN and CLICKUP_WEBHOOK_SECRET to the system keychain for <scope>? [Y/n]`
   (naming only those), where `<scope>` is `compose` or
   `k8s:<context>/devbox`. Values from your environment are never saved. A
   webhook secret you don't save is shown once on the terminal, after
   `Press Enter to show the webhook secret, to set as CLICKUP_WEBHOOK_SECRET`.
   Without a terminal it isn't shown:
   `` The webhook secret is not shown without a terminal: run `bun run clickup:setup` in a terminal to save or see it ``.
8. **Write.** It writes `integrations.clickup` (`enabled: true`, `teamId`,
   `botUserId`, `botName` and, on a first run, `statuses`) and `publicUrl` to
   the deployment's config file, keeping the rest of the file, and prints
   `Wrote integrations.clickup to <file>`.
9. **Next step.** For each secret that is neither saved in the keychain nor
   saved now, it says what the next apply does:
   `<apply command> will use <NAME> from your environment`, or
   `Set <NAME> in your environment before <apply command>; otherwise it asks for it in a terminal`.
   A new value you didn't save while an older one is saved gets
   `The old <NAME> saved in the system keychain for <scope> stays, and <apply command> would use it: set <NAME> in your environment, which wins, or remove the old one with bun run secrets rm <NAME>`.
   Then `Next: <apply command> (setup applies nothing)` and
   `Then check ClickUp with: bun run clickup:status [--target <file>]`.

#### Running it again

Running it again is safe. The webhook is updated in place, never deleted and
created again, which would change its secret. A configured setting is kept
unless a flag changes it, the statuses included; `botUserId` and `botName`
are read from the token's account on every run. A saved secret is never
removed.

The token comes from your environment or the keychain; in a terminal, press
Enter to keep the saved one. The webhook secret always comes from ClickUp, so
a run also replaces a stale saved one (save it when asked). To change the
statuses, edit the config file.

### 3. The webhook

Setup keeps one webhook in the workspace for devbox, through ClickUp's API
with the bot's token. It lists the bot's webhooks there
(`GET /team/<id>/webhook`), then:

- **One at this URL, or at an older public URL** (any of the bot's webhooks
  whose URL ends in `/webhook/clickup`) is updated in place
  (`PUT /webhook/<id>`) with this URL and devbox's two events, and set
  active, which also reactivates a suspended one. It keeps its secret. Setup
  prints `Webhook <id> in ClickUp: updated for <url>`, with
  ` (it pointed at <old url>)` when the URL changed and
  `; reactivated (it was <status>)` when it wasn't active.
- **None:** it creates one (`POST /team/<id>/webhook`) and prints
  `Webhook <id> in ClickUp: created for <url> (taskAssigneeUpdated, taskCommentPosted)`.
  ClickUp answers with the webhook's secret.

The webhook covers the whole workspace and sends exactly the two events
devbox handles: `taskAssigneeUpdated` and `taskCommentPosted`. devbox acts
only on the bot being added to a task's assignees and on comments that
mention it, and answers every other delivery at once. ClickUp lists only the
webhooks of the token's own account, so the webhook belongs to the bot.

Setup creates the webhook when it runs, before the apply. Until the control
plane has ClickUp on, every delivery fails, and in a busy workspace enough
failures get the webhook suspended. Apply soon after setup;
`clickup:status` shows a suspended webhook, and another `clickup:setup` run
reactivates it.

### 4. Apply and check

#### Compose

```bash
ngrok http 3000                                              # in another terminal
bun run clickup:setup --public-url https://<your-tunnel-host>
bun run up
bun run clickup:status
```

The settings go in `devbox.config.json`:

```json
"publicUrl": "https://…",
"integrations": { "clickup": {
  "enabled": true, "teamId": "1234567890", "botUserId": 12345678, "botName": "devbox",
  "statuses": { "started": "in progress" } } }
```

With `enabled: true`, `bun run up` resolves the two ClickUp secrets, checks
the token with ClickUp (it must still belong to `botUserId`), and passes
`CLICKUP_*` to the control plane. It prints
`ClickUp: devbox acts as <name> in workspace <id>` and, near the end,
`Check ClickUp with: bun run clickup:status`. `--skip-clickup-check` skips
the token check, and `--skip-checks` skips it with the others.

#### kind

kind has no public address, so it needs a tunnel
([The public URL](public-url.md#getting-one)): point it at the local port
`bun run k8s:connect --target devbox.kind.json` forwards to.
`devbox.kind.json` must exist first: run `bun run k8s:kind` once. Then run
`bun run clickup:setup --target devbox.kind.json --public-url https://<your-tunnel-host>`,
then `bun run k8s:kind` (the apply command setup prints) and
`bun run clickup:status --target devbox.kind.json`.

#### Kubernetes

```bash
bun run clickup:setup --target devbox.k8s.json
bun run k8s:install --target devbox.k8s.json
bun run clickup:status --target devbox.k8s.json
```

The settings go in the target file's top-level `integrations` block, not
under `values`, with the same keys as on Compose. The installer copies the
block into the chart values as it is (`integrations.clickup.*`), resolves the
two secrets, checks the token, and writes the secrets to the Secret
`devbox-integrations`. `k8s:install --skip-clickup-check` skips the token
check. The control plane needs egress to `api.clickup.com`.

With your own integrations Secret (`secrets.integrations.existingSecret` in
the target file's values), setup still reads the token to check it, but
saves no secret. In a terminal it shows the webhook's secret on every run,
after
`Press Enter to show the webhook secret, to set as CLICKUP_WEBHOOK_SECRET in Secret "<name>"`,
and it prints
`Put CLICKUP_API_TOKEN and CLICKUP_WEBHOOK_SECRET in Secret "<name>" in namespace devbox.`
Put them there yourself, then restart the control plane after each change to
that Secret. The installer never reads the Secret, so it doesn't check the
token: `bun run k8s:check --target <file>` does
([kubernetes/README.md](kubernetes/README.md#check-the-secrets)).

#### GitOps

`clickup:setup` needs a target file for the cluster, even when you never run
the installer: `context`, the Ingress values (or pass `--public-url`), and
`profile` set to the CLI profile you added with `bun run devbox profile add`,
which `clickup:status` uses. Then:

1. `bun run clickup:setup --target devbox.k8s.json`. Set
   `secrets.integrations.existingSecret` under `values` first, or decline the
   keychain. Near the end it prints
   `With GitOps, set the chart values integrations.clickup.* to the integrations.clickup block in <file> instead, with enabled: true`.
   Ignore its `Set … in your environment before bun run k8s:install` and
   `Next: bun run k8s:install …` lines: they are for the installer.
2. Put `CLICKUP_API_TOKEN` and `CLICKUP_WEBHOOK_SECRET` in the integrations
   Secret ([kubernetes/secrets.md](kubernetes/secrets.md)). The webhook
   secret is the one setup showed you: ClickUp made it, and you can't choose
   another.
3. Set the chart values `integrations.clickup.*` to the block in the target
   file, and sync.
4. `bun run k8s:check --target devbox.k8s.json` checks the Secret and the
   token, and `bun run clickup:status --target devbox.k8s.json` the rest.
   `k8s:check` reads that ClickUp is enabled from the target file's
   `integrations` block: keep it in step with the chart values.

The chart refuses to render `integrations.clickup.enabled: true` without each
of `teamId`, `botUserId` and `botName`
(`integrations.clickup.enabled is true: integrations.clickup.<key> is required`).

### What turns ClickUp on

Only `enabled: true` in `integrations.clickup`: in `devbox.config.json`, the
target file, or the chart values with GitOps. A `CLICKUP_*` variable in your
shell, a saved secret or a key in a Secret never turns ClickUp on, and does
nothing while `enabled` is `false` or the block is absent. The fields are in
[configuration.md](configuration.md#integrations).

## Trust

A task's description and its comments become the agent's instructions, so
devbox acts only on the workspace's owners, admins and members:

- **An assignment** counts only when both the person who added the bot to
  the assignees and the task's creator are an owner, admin or member of the
  workspace. The creator wrote the description the agent works from. The
  assigner's role comes with the webhook. devbox then reads the task again
  from ClickUp, so its workspace, creator, name and description come from
  ClickUp, not from the delivery, and looks the creator up in the
  workspace's member list.
- **A follow-up** counts only when the comment's author is an owner, admin or
  member.

**devbox trusts every owner, admin and member of the workspace**, as Linear
trusts everyone in its workspace. There are no trust lists. Nobody outside
the workspace can drive devbox: ClickUp sends events only for what happens in
the workspace, and devbox checks each webhook's signature.

Never trusted:

- **Guests.** On ClickUp's Free plan, a guest gets full edit rights on
  whatever is shared with them, so a guest could write a task or a comment as
  a member does. That is why devbox checks every actor's role instead of
  trusting whoever can comment.
- **Automations** ([below](#automations-never-start-work)).
- **The bot.** Its own events are ignored.

**The member list.** devbox reads the workspace's members and their roles
(`GET /team`) and keeps the list for six hours. Someone missing from it, such
as a new member, has it read again, at most once a minute. When a read
fails, the last list serves until it is twelve hours old. Without a usable
list devbox answers 503 and logs `clickup_webhook.trust_unresolved`, and
ClickUp delivers the event again. A creator who has left the workspace is
not a member, so their tasks are ignored.

An untrusted action is ignored. devbox answers the webhook, posts nothing on
the task, and logs `clickup_webhook.ignored` with `reason: untrusted`, `side`
(`assigner`, `creator` or `commenter`), the user id and the role, never a
name or an email.

**Important: devbox checks who created the task, not who last edited it.**
Anyone who can edit a task, a guest with edit rights included, can change its
description before a member assigns the bot, and the agent then works from
that text. Read the description before you assign a task that guests can
edit.

### Automations never start work

A ClickUp automation acts as ClickBot. ClickBot has no role in the workspace,
and the event records ClickBot, not the person whose change set the
automation off, so devbox can't tell who is behind it and never trusts it:

- an automation that assigns the bot does nothing
  (`reason: untrusted`, `side: assigner`, `role: null`);
- a comment an automation posts is never a follow-up;
- a task whose creator ClickUp records as ClickBot can't start work, whoever
  assigns it.

Assign the bot by hand.

### Private comments

A comment that only some people can see is ignored, even when it mentions the
bot (`reason: private_comment`): the agent's answer is a comment everyone on
the task can read.

## Follow-ups

A follow-up is a comment on the task that mentions the bot:

- **picked** from ClickUp's @-list, or
- **typed** as `@<bot name>`, the bot's ClickUp username, in any letter case.
  It must stand alone: `@devboxer` or `@devbox/cli` don't mention a bot named
  `devbox`.

A mention inside inline code or a code block doesn't count. The bot must have
been assigned the task first: a mention on a task devbox has no task for is
ignored (`reason: no_task`). The bot's own comments never count, even when
they name it.

The agent gets the comment as Markdown. The bot's mention is dropped, and
anyone else's becomes `@user`, never their name or email. Links are kept only
for `http` and `https`; attachments and mentions of tasks or docs are
dropped.

## Statuses

`integrations.clickup.statuses` names the statuses devbox moves a task to:
`started`, `done` and `failed`. Each is optional, and an absent one means no
move. Names match in any letter case.

When the config has no `integrations.clickup` block, `clickup:setup` writes
`{ "started": "in progress" }` and asks nothing; a re-run keeps what is
there. There is no `done` by default: devbox finishes with a draft pull
request that still needs review, so the work isn't done yet, and many teams
close a task when its pull request merges. To change `started`, or to set
`done` or `failed`, edit `integrations.clickup.statuses`, then apply.

**Status names are per list.** In ClickUp each list has its own statuses (or
takes its folder's or space's). devbox looks the name up in the task's list,
and in a list without it, that move is skipped and logged
(`clickup status move skipped: the task's list has no such status`).

devbox moves a task:

- **to `started`** when the task starts, before its sandbox is created;
- **to `done`** when the assignment's run finishes, or **to `failed`** when
  the task failed and `failed` is set. A run that opened a pull request in one
  repo and failed in another counts as done. Without `failed`, a failed task
  stays in `started`.

**Each move is a compare-and-set.** devbox reads the task first, and moves it
only while the bot is still one of its assignees, the task isn't in that
status already and, for done and failed, it is still in `started`. A task
someone took the bot off, or moved by hand, is never touched, and neither is
one whose devbox task was restarted meanwhile. Without a `started` status
devbox moves nothing at all, since it can't tell its own move from one made
by hand. Follow-ups don't move the task.

A skipped move is logged as `clickup status move skipped` with its `reason`
(`not_assignee`, `already_there`, `status_moved` or `restarted`), and a move
ClickUp refuses (HTTP 400) as `clickup status move refused`.

## Lifecycle

- **Removing the bot from the assignees doesn't stop a run.** The task
  finishes and posts its replies; the task is no longer the bot's, so it
  isn't moved.
- **Restarting.** Remove the bot from the task's assignees, then add it
  again: a new run and a new draft pull request. The old pull request is left
  as it is. Both steps are needed, since devbox acts only on the bot being
  added; removing it starts nothing.
- **There is no cancel**, from ClickUp or from the CLI.
- **When something fails**, devbox comments:
  - for a failed assignment round, the harness's short summary of what went
    wrong;
  - when the task fails,
    `devbox couldn't finish this task. To start over, remove <bot name> from the assignees and assign it again; this opens a new pull request.`;
  - when the task's workspace is gone,
    `This task's workspace was cleaned up, so devbox can't continue it. Remove <bot name> from the assignees and assign it again to start over.`

  A follow-up that fails gets a comment that ends
  `Comment with @<bot name> to retry.`

## Replies

Each reply is a comment on the task, posted as the bot.

- **Formatting.** The agent writes Markdown, and devbox posts it as ClickUp
  rich text: bold, italic, inline code, links, bulleted and numbered lists
  (nested ones too) and code blocks with their language. ClickUp's API
  documents no heading format, so a heading becomes a bold line; a rule
  becomes `---`.
- **Length.** ClickUp documents no length limit for a comment, so devbox keeps
  each one within 5,000 characters of text. A long reply is split into up to
  three comments; past that it is cut and ends with
  `Full text in the pull request.` A code block split across comments carries
  on in the next one, in the same language.
- **Notifications.** devbox posts with `notify_all: false`, and a reply never
  mentions anyone: devbox sends no mentions, whatever the agent writes.
- **Failures.** A comment ClickUp rate-limits is sent again later, after
  ClickUp's `Retry-After` or `X-RateLimit-Reset`. Any other failure is not
  sent again, and once one comment of a long reply is on the task the rest
  isn't retried, since a retry would post that comment twice. `clickup:status`
  shows the last failure ([Status](#status)).

## The API token

A ClickUp personal token never expires, so there is nothing to rotate on a
schedule. It stops working when it is regenerated in the bot's Settings →
Apps, or when the bot's account goes away. Then `clickup:status` shows
`auth rejected`, `up`, `k8s:install` and `k8s:check` refuse it with
`ClickUp rejected CLICKUP_API_TOKEN (401): …`, and the bot's comments fail
with HTTP 401 and are not sent again (`clickup:status` shows
`Last failed reply to ClickUp: http_401 at <time>`).

To replace it, for example after a leak:

1. Signed in as the bot, regenerate its token under Settings → Apps. The old
   token stops working, so do the next steps right away.
2. Give devbox the token:
   - **Saved in the keychain:** run `bun run clickup:setup [--target <file>]`,
     paste the new token at
     `ClickUp API token of the bot (pk_…) (input hidden; press Enter to keep the saved one): `,
     and save it. If you don't save it, the old token stays saved and the
     next apply would use it: setup says so, and
     `bun run secrets rm CLICKUP_API_TOKEN [--target <file>]` removes it.
   - **From your environment:** set `CLICKUP_API_TOKEN` to the new token and
     run `bun run clickup:setup [--target <file>]`.
   - **In your own Secret, or with GitOps:** put the token in the Secret, then
     restart the control plane.
3. Apply. `bun run up` recreates the control plane. On Kubernetes,
   `k8s:install` rewrites the Secret and prints the
   `kubectl rollout restart` command: the control plane reads the token only
   when it starts ([kubernetes/secrets.md](kubernetes/secrets.md#rotation)).

## Replacing the webhook secret

ClickUp makes the webhook's secret, and setup never recreates the webhook,
so a new secret takes a new webhook:

1. `bun run clickup:disable --forget [--target <file>]`, with the bot's token
   in your environment or the keychain. It deletes the webhook in ClickUp,
   `integrations.clickup` and the saved ClickUp secrets, the token included:
   keep the token at hand, or set `CLICKUP_API_TOKEN`, for the next step.
2. `bun run clickup:setup [--target <file>]`. It creates a new webhook with a
   new secret and offers to save both. The statuses are back to
   `{ "started": "in progress" }`: set yours again.
3. Apply (`bun run up`, or `k8s:install` and the restart it prints).

ClickUp's events between steps 1 and 2 are lost, and between steps 2 and 3
the running control plane refuses the new webhook's deliveries for their
signature: do the steps together. With your own Secret, put the secret setup
shows in it at step 2, then restart the control plane.

## Changing the bot

To move devbox to another ClickUp account:

1. Set up the new account as in [The bot](#1-the-bot): a member, with its own
   personal token.
2. **Remove the old bot's webhook.** Setup, with the new bot's token, sees only
   the new bot's webhooks: it creates a second one and leaves the old one in
   place ([Known limits](#known-limits)). The old one keeps delivering, signed
   with its own secret, and devbox refuses each delivery
   (`ClickUp webhook rejected: signature mismatch (check CLICKUP_WEBHOOK_SECRET)`)
   until ClickUp suspends it. Either:
   - remove the old bot from the workspace (Settings → People), which stops
     its webhook; or
   - delete the webhook through ClickUp's API with the old bot's token in the
     `Authorization` header: `GET https://api.clickup.com/api/v2/team/<workspace id>/webhook`
     lists its webhooks, and `DELETE https://api.clickup.com/api/v2/webhook/<webhook id>`
     deletes the one whose `endpoint` ends in `/webhook/clickup`.
3. Run `bun run clickup:setup [--target <file>]` with the new bot's token:
   paste it at the token prompt, or set `CLICKUP_API_TOKEN`. It writes the
   new `botUserId` and `botName`, creates the new bot's webhook and offers to
   save its secret (`The CLICKUP_WEBHOOK_SECRET saved in the system keychain for <scope> is not webhook <id>'s secret: using ClickUp's`).
   Unset a `CLICKUP_WEBHOOK_SECRET` in your environment first: it is the old
   webhook's, and setup stops on it.
4. Apply. Until then the running control plane refuses the new webhook's
   deliveries, so do steps 3 and 4 together.

Tasks assigned to the old bot no longer move ([Statuses](#statuses)): devbox
moves a task only while the configured bot is one of its assignees.

## Status

```
bun run clickup:status [--target <file>] [--no-keychain]
```

Read-only: it never prompts, never reads a Kubernetes Secret and never prints
a secret. It exits 0 whatever the control plane or the probe report; only a
config or target file it can't load makes it exit 1. It prints:

1. **The settings**: the `workspace` id, the `bot` (username and user id),
   `publicUrl`, and where each ClickUp secret would come from at the next
   apply: `env`, `keychain` or `missing`, or `from Secret "<name>" (not read)`
   with your own integrations Secret. Without a block:
   `ClickUp is not configured for <scope>. Run: bun run clickup:setup`. With
   `enabled: false`, it says so and stops.
2. **What the running control plane reports**, through the deployment's CLI
   profile (on Kubernetes it opens a port-forward when needed). It comes from
   the one replica it reaches.
   - `Control plane: bot <name>, auth <ok | rejected | unknown>, last webhook from ClickUp <time | none yet>`.
     `auth rejected` means ClickUp refuses the token, and adds
     `ClickUp rejects CLICKUP_API_TOKEN: generate a new personal token for the bot, run bun run clickup:setup, then <apply command>`.
   - `Webhook in ClickUp: <health>[, <n> failed deliveries]`: the health
     ClickUp reports for the bot's devbox webhook, `active` when deliveries
     succeed. A suspended one adds
     `ClickUp sends nothing to a suspended webhook: bun run clickup:setup reactivates it`.
     `Webhook in ClickUp: none for this workspace. Run: bun run clickup:setup`
     means the bot has none. There is no line when ClickUp's list can't be
     read.
   - `Last failed reply to ClickUp: <class> at <time>`, after a comment
     failed. The class is `http_<status>`, `timeout` or an error name.
   - `Control plane: ClickUp is not on there yet. Run: <apply command>` means
     the settings were not applied, and `Control plane: not reachable (…)`
     that the profile doesn't reach it.
3. **The probe**, when `publicUrl` is set: an unsigned
   `POST <publicUrl>/webhook/clickup` with body `{}` and a 10-second timeout.
   devbox with ClickUp on answers it `403 {"error":"invalid signature"}` and
   records nothing, so a 403 prints
   `Webhook URL <url>/webhook/clickup: reaches devbox with ClickUp on`.
   devbox answers a bad signature with 403, never 401 or 410: ClickUp
   suspends a webhook that gets either. Other answers are in
   [Troubleshooting](#troubleshooting).

The probe proves only that the URL reaches devbox **from the machine you run
it on**. It does not prove ClickUp can reach it, or that the webhook's secret
matches. "last webhook from ClickUp" moves only when a webhook signed with
`CLICKUP_WEBHOOK_SECRET` arrives. The webhook covers the whole workspace, so
any assignee change or comment there moves it.

`clickup:status` reads `GET /api/integrations/clickup`, which takes an API
token like the rest of the API. With ClickUp on, it answers:

```json
{ "configured": true, "bot": { "id": 12345678, "name": "devbox" }, "team": "1234567890",
  "auth": "ok", "lastWebhookAt": "2026-01-01T00:00:00.000Z",
  "webhook": { "health": "active", "failCount": 0 }, "lastReplyFailure": null }
```

and `{ "configured": false }` with it off. `webhook` is `null` when the bot
has no devbox webhook, and absent when ClickUp's list can't be read.
`lastReplyFailure` is `{ "at": <time>, "error": <class> }`. It holds no
secret and no text from ClickUp's answers. `lastWebhookAt` and
`lastReplyFailure` are kept in memory by the replica that answers.

## Disable

```
bun run clickup:disable [--target <file>] [--no-keychain] [--forget [--yes]]
```

- **`clickup:disable`** sets `integrations.clickup.enabled` to `false` and
  keeps the settings, the saved secrets and the webhook in ClickUp. It asks
  nothing, and prints
  `The webhook in ClickUp stays: with ClickUp off its deliveries fail, and ClickUp suspends it after 100 failures; bun run clickup:setup reactivates it.`
  Turn ClickUp back on with `bun run clickup:setup`, which also reactivates
  the webhook, or by setting `enabled` to `true`.
- **`clickup:disable --forget`** deletes the devbox webhook in ClickUp, the
  `integrations.clickup` block and the deployment's saved
  `CLICKUP_API_TOKEN` and `CLICKUP_WEBHOOK_SECRET`. It lists what it deletes
  (`webhook <id> in ClickUp workspace <id> (<url>)`, the block, each saved
  secret) and asks `Remove these? [y/N]`; Enter or Ctrl-D answers no, and
  `Nothing was removed.` Without a terminal it refuses unless you pass
  `--yes`. It works on a disabled block too. It deletes the webhook with the
  bot's token from your environment or the keychain; without one it prints
  `No CLICKUP_API_TOKEN in your environment or the system keychain, so the webhook in ClickUp stays: to delete it too, run this with CLICKUP_API_TOKEN set to the bot's token. Removing the bot from the workspace also stops it.`
  It deletes the webhook first, printing `Deleted webhook <id> in ClickUp.`,
  so a failed delete leaves the block in place for another try. The bot's
  account and its token are yours to remove.

Both print how many ClickUp tasks are open:
`<n> open ClickUp task(s) (bun run devbox ls --source clickup): these keep running; their results will not reach ClickUp.`
When devbox's API can't be reached, they print
`Open ClickUp tasks (bun run devbox ls --source clickup) keep running; their results will not reach ClickUp.`
instead.

Neither applies anything. Both print `Next: <apply command>`; run it to turn
ClickUp off in the running deployment. "Already disabled" and "not
configured" print no `Next:` line. On Kubernetes, the installer then writes
`devbox-integrations` without the ClickUp keys, or deletes it when nothing is
left.

## Several control-plane replicas

With `controlPlane.replicas` above 1, turn ClickUp on for every replica in one
rollout. While replicas that still have ClickUp off run beside the new ones:

- a webhook that reaches one of them gets a 404 and counts as a failed
  delivery. If ClickUp doesn't deliver it again, remove the bot from the
  task's assignees and add it again;
- one of them can pick up a ClickUp task. That task misses its move to
  `started`, and with it the move to done or failed. What it posts while that
  replica holds it doesn't reach ClickUp either.

Each replica keeps its own copy of the member list ([Trust](#trust)).

## Upgrading and rolling back

ClickUp needs no database change. A control plane without ClickUp answers
`/webhook/clickup` with 404, and an older release that picks up tasks of any
source can work a ClickUp task without moving it or posting anything to it.
So:

- **Upgrade with ClickUp off**, and run `clickup:setup` once every replica
  runs the release that has it: setup starts the webhook's deliveries.
- **Before rolling back** to a release without ClickUp:
  1. Stop new work: `bun run clickup:disable --forget [--target <file>]`
     deletes the webhook, the settings and the saved secrets, and applies
     nothing, so the running control plane keeps ClickUp on.
  2. Wait until no ClickUp task is queued or running
     (`bun run devbox ls --source clickup`), so their results still reach
     ClickUp.
  3. Run the apply command it printed, then roll back.

  Turning ClickUp off before the tasks finish has the same effect as the
  rollback: they finish without posting to ClickUp. To use ClickUp again
  later, run `clickup:setup`: it creates a new webhook.

## Known limits

- **A new bot leaves the old bot's webhook behind.** ClickUp lists only the
  webhooks of the token's own account, so neither `clickup:setup` nor
  `clickup:disable --forget` sees another account's. Remove the old bot from
  the workspace, or delete its webhook with its token
  ([Changing the bot](#changing-the-bot)).
- **One workspace per deployment.** Tasks from any other workspace are ignored
  (`reason: wrong_team`). Moving with `--team` leaves the old workspace's
  webhook in place, since setup works only in the new one: run
  `clickup:disable --forget` before you move.
- **One deployment per bot.** Setup takes over any of the bot's webhooks at a
  `/webhook/clickup` URL, and `--forget` deletes all of them, so two
  deployments that share a bot take its webhook from each other. Give each
  deployment its own bot.
- **No pull request link on the task.** ClickUp has no place for a link to
  the pull request, so it appears only in the reply's text.
- **No live progress and no cancel** from ClickUp.

## Troubleshooting

| Where | What you see | What to do |
|---|---|---|
| `clickup:setup`, `up`, `k8s:install`, `k8s:check` | `ClickUp rejected CLICKUP_API_TOKEN (401): use the bot's personal API token (pk_…), from ClickUp's Settings → Apps while signed in as the bot` | The token is wrong or was regenerated. A saved token stays saved. Give devbox the bot's current token ([The API token](#the-api-token)). |
| `up`, `k8s:install`, `k8s:check` | `CLICKUP_API_TOKEN belongs to <name> (user <id>), not the configured bot <name> (user <id>): run bun run clickup:setup` | The token is another account's. Use the bot's token, or run `clickup:setup` with the new account's token to change bots ([Changing the bot](#changing-the-bot)). |
| same, and `clickup:setup` | `can't reach api.clickup.com: check this machine's egress or proxy` | On Kubernetes, the control plane needs egress to `api.clickup.com` too. |
| `clickup:setup` | `ClickUp <method> <path> returned <status>` | ClickUp refused a call: 429 is its rate limit, which passes. For the webhook calls, check that the bot is still a member of the workspace. Then run setup again. |
| `clickup:setup` | `the bot is in no ClickUp workspace: …`, or `the bot is not in ClickUp workspace <id>: …` | Invite the bot to the workspace as a member, or pass `--team` with one of the workspaces it lists. |
| `clickup:setup` | `the bot is in <n> ClickUp workspaces: pass --team <id> with one of …` | Pass `--team`, or run setup in a terminal to choose. |
| `clickup:setup` | `<bot> is a guest in workspace <name>: …`, or `can't tell <bot>'s role in workspace <name>: …` | Make the bot a member in ClickUp (Settings → People). |
| `clickup:setup` | `CLICKUP_WEBHOOK_SECRET in your environment is not the secret of webhook <id>: …` | Unset it: setup reads the secret from ClickUp. |
| `clickup:setup` | `ClickUp created webhook <id> but returned no secret: …` | Run setup again: it reads the secret from the webhook it created. |
| `clickup:setup` | `ClickUp didn't return the secret of webhook <id>, and none is in your environment or the keychain: …` | Set `CLICKUP_WEBHOOK_SECRET` to the webhook's secret if you have it. Otherwise [replace the webhook secret](#replacing-the-webhook-secret). |
| `clickup:status` | `auth rejected`, or `Last failed reply to ClickUp: http_401 at <time>` | The token was regenerated, or the bot's account is gone: [The API token](#the-api-token). |
| `clickup:status` | `auth unknown` | The control plane couldn't ask ClickUp: check its egress to `api.clickup.com`. |
| `clickup:status` | `Webhook in ClickUp: none for this workspace. Run: bun run clickup:setup` | The webhook was deleted, or the bot changed. Run setup. |
| `clickup:status` | `Webhook in ClickUp: suspended`, or `<health>, <n> failed deliveries` | Deliveries fail: ClickUp is not on in the control plane yet, the URL doesn't reach devbox (the probe), or the secret doesn't match (the log). Fix that, then run setup, which reactivates the webhook. |
| `clickup:status` | `Last failed reply to ClickUp: http_<status> at <time>` | ClickUp refused a comment. `http_429` is its rate limit: devbox sends those again. Otherwise check that the bot can still see the task. |
| `clickup:status` probe | `got no answer (…): the public URL does not reach devbox` | The tunnel is down, or the Ingress or DNS is not ready yet. With the URL from `ingress.api`, that Ingress may be VPN-only: add a public `ingress.webhooks`. |
| `clickup:status` probe | `got 404: something answered, but not devbox with ClickUp on` | Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that `integrations.clickup.enabled` is `true` and applied, or restart the control plane. |
| `clickup:status` | `Control plane: ClickUp is not on there yet` | Run the apply command. |
| control plane log | `ClickUp webhook rejected: signature mismatch (check CLICKUP_WEBHOOK_SECRET)` | The control plane's `CLICKUP_WEBHOOK_SECRET` isn't the webhook's. Run `clickup:setup`, which reads the secret from ClickUp, save it, and apply. After a change of bot, the old bot's webhook does this ([Changing the bot](#changing-the-bot)). |
| control plane log | `clickup_webhook.task_unresolved` | devbox couldn't read the task: a timeout, no egress to `api.clickup.com`, or the bot can't see the task. It answered 503, so ClickUp delivers the event again. Check egress, and share the task's space, folder or list with the bot. |
| control plane log | `clickup_webhook.trust_unresolved`, after `clickup member list read failed` | devbox couldn't read the workspace's member list to check the task's creator ([Trust](#trust)). It answered 503, so ClickUp delivers the event again. Check egress to `api.clickup.com`. |
| control plane log | `clickup webhook failed` with `code: 23505` | The task's key, `CU-<task id>`, is already the key of a task from another source, such as an issue from a Linear team or Jira project with the key `CU`: task keys are unique across sources regardless of case. Nothing is posted on the task. Don't use the key `CU` elsewhere. |
| ClickUp | Assigning does nothing; `clickup:status` shows `last webhook from ClickUp none yet` | The webhook is missing or suspended (`Webhook in ClickUp: …`), or its URL doesn't reach devbox (the probe). Then read the control plane's logs for a rejected signature. |
| ClickUp | Assigning does nothing; webhooks arrive | Read the logs for `clickup_webhook.ignored` and its `reason`: `untrusted` with `side: assigner` (a guest, or an automation, added the bot) or `side: creator` (a guest, ClickBot or someone no longer in the workspace created the task) ([Trust](#trust)), or `wrong_team`. |
| ClickUp | An automation assigns the bot and nothing happens | Automations never start work ([Automations never start work](#automations-never-start-work)). Assign the bot by hand. |
| ClickUp | A comment that mentions the bot does nothing | The comment is private (`reason: private_comment`), its author is a guest or an automation (`reason: untrusted`, `side: commenter`), the mention is in code, the typed name differs from the bot's username, or the bot was never assigned the task (`reason: no_task`). |
| ClickUp | Assigning the bot again doesn't restart | Remove the bot from the assignees first, then add it ([Lifecycle](#lifecycle)). |
| ClickUp | The task doesn't move | See [Statuses](#statuses): no `started` status, the bot was taken off or the task moved by hand, or the logs show `clickup status move skipped` or `clickup status move refused`. |

The control plane's logs:

```bash
docker compose -f control-plane/docker-compose.yml logs control-plane   # Compose
kubectl --context <context> -n devbox logs deploy/devbox-control-plane  # Kubernetes
```
