# GitLab

devbox can work on repos hosted on a GitLab instance: self-managed, or
`https://gitlab.com`. The agent clones from it, pushes its branch and opens a
**draft merge request**, the way it opens a draft pull request on GitHub. With
the webhooks on, an `@<bot>` note on that merge request and a failed pipeline
on it reach the running task, and the agent answers in the note's thread. A
deployment may mix GitHub and GitLab repos; each repo's host is read from its
URL. Kubernetes only: the local Compose stack takes GitHub repos.

Not there yet: a batched review (GitLab sends each note on its own, so each
mentioning note is one round), approvals as a signal, and an installer step
(`gitlab:setup`). Tracked in
[rudderlabs/devbox#8](https://github.com/rudderlabs/devbox/issues/8).

## What you need

- **A GitHub token as well.** GitLab is added beside GitHub, not instead of
  it: the egress proxy and the snapshot builder read the GitHub token Secret
  unconditionally, so a deployment with only GitLab repos still needs a GitHub
  token (any account's, with no repos to reach) or the GitHub App. Making it
  optional is tracked in [rudderlabs/devbox#8](https://github.com/rudderlabs/devbox/issues/8).
- **A group or project access token** for the group that holds the repos,
  with the `api`, `read_repository` and `write_repository` scopes and at least
  the Developer role. Merge requests, commits and replies are attributed to the
  token's bot user, whose username and numeric id the webhooks need (see
  below). The token does not rotate itself: set an expiry you can live with
  and replace it in the Secret before then. A personal access token works for
  a trial, but then the bot is you: your own notes are ignored as the bot's,
  so mention it from another account.
- **The instance's URL** as `gitlab.baseUrl`: `https://gitlab.example.com`,
  or with a relative URL root `https://example.com/gitlab`. The default port
  only, like `llm.baseUrl`, because the egress proxy intercepts only 80 and
  443.
- **A private CA, if the instance has one.** Put the CA certificate (PEM, the
  chain if there is one) in a Secret and name it in `ironProxy.caBundle`. The
  chart hands it to the three things that talk to GitLab directly: the egress
  proxy, the snapshot builder (clones) and the control plane (replies and
  trust lookups, with the webhooks on). Sandboxes see the proxy's own
  certificate and need nothing.

## Configure

> Rotating the CA: a new `gitlab.caFile` is written to the same Secret, which
> rolls nothing. `k8s:install` prints the `rollout restart` for the control
> plane and iron-proxy; run it, then `k8s:check`.

Kubernetes only: the local Compose stack takes GitHub repos. The pieces are
the ones every integration has: the setup in `devbox.config.json`, the
deployment's settings in the target file, the secrets in Secrets the
installer writes.

1. Put the instance and the repos in `devbox.config.json`:

   ```json
   {
     "gitlab": { "baseUrl": "https://gitlab.example.com", "caFile": "/etc/devbox/corp-ca.pem" },
     "repos": [
       { "url": "https://github.com/acme/widgets.git", "branch": "main" },
       { "url": "https://gitlab.example.com/platform/backend/api.git", "branch": "develop" }
     ]
   }
   ```

   A GitLab repo is `<gitlab.baseUrl>/<group>[/<subgroup>...]/<project>.git`.
   Nested groups are fine. Repo names (the last path segment) must be unique
   across both hosts, because each is cloned to `/workspace/<name>`. `caFile`
   is the PEM of the instance's private CA, absolute path, only when it has
   one; the installer puts it in a Secret for the chart.

2. Run the setup, with the token in `GITLAB_TOKEN` or at its prompt:

   ```
   bun run gitlab:setup --target <file> [--public-url <url>]
                        [--trusted-group <group>]... [--trusted-user <name>]...
                        [--secret-token] [--skip-webhook] [--skip-push-check] [--no-keychain]
   ```

   It checks the token against the instance and every repo under it (the
   project exists, the token can push and open merge requests; with the
   webhooks, that it can read pipelines, jobs and the trusted groups'
   members), learns the bot's identity from the token, registers a webhook
   on each project with a signing token it generates, saves the token in the
   system keychain (or shows it once), and writes `integrations.gitlab`,
   `values.gitlab` (the trust lists) and `publicUrl` to the target file. It
   applies nothing and never touches the cluster.

   | Flag | Effect |
   |---|---|
   | `--target <file>` | The Kubernetes deployment. Required. |
   | `--public-url <url>` | The public HTTPS URL GitLab sends webhooks to; else the saved `publicUrl`, else the Ingress ([GitHub: The public URL](github.md#the-public-url)). |
   | `--trusted-group`, `--trusted-user` | Who may drive devbox from GitLab. Default: what the target file holds, else the first repo's group. |
   | `--secret-token` | Verify webhooks with the legacy `X-Gitlab-Token` instead of the signing token. Chosen by itself below GitLab 19.1. |
   | `--bot-username`, `--bot-user-id` | The bot, when the token sits in your own Secret and cannot be asked. |
   | `--skip-webhook` | Register no webhook; create them by hand as below. |
   | `--no-keychain` | Never read or write the system keychain. |

   A token that may not manage webhooks (below Maintainer) gets the manual
   instructions instead: URL `<public URL>/webhook/gitlab`, triggers
   **Comments** and **Pipeline events**, the token setup printed.

3. `bun run k8s:install --target <file>` as usual. It checks the token again,
   writes `devbox-gitlab` (the token), `devbox-gitlab-ca` (the CA, with
   `caFile`) and the webhook token into `devbox-integrations`, and sets
   `secrets.gitlab.existingSecret`, `ironProxy.caBundle` and the
   `integrations.gitlab` values for the chart. `bun run k8s:check` verifies
   the Secrets and the token afterwards; `bun run gitlab:status` shows the
   configuration, the control plane's view and whether the webhook URL
   reaches devbox; `bun run gitlab:disable` turns the webhooks off, or with
   `--forget` removes the block and the saved secrets.

With GitOps, set the values directly ([values](../deploy/helm/devbox/README.md)):
`gitlab.baseUrl`, `repos`, `secrets.gitlab.existingSecret` (a Secret with key
`token`), `ironProxy.caBundle` (a Secret with key `ca.crt`), and for the
webhooks `integrations.gitlab {enabled, botUsername, botUserId, ciResults}`,
`gitlab.trustedGroups` or `gitlab.trustedUsers`, and
`GITLAB_WEBHOOK_SIGNING_TOKEN` (or `GITLAB_WEBHOOK_SECRET`) in the
integrations Secret. To bring your own token Secret, name it in
`secrets.gitlab.existingSecret` in the target file's values: the installer
then writes none and runs no token check (`k8s:check` does).

## Webhooks: notes and pipelines

With `integrations.gitlab.enabled`, the control plane serves
`POST /webhook/gitlab` and the agent hears back from its merge requests:

- **A note that mentions `@<botUsername>`** on a merge request the agent
  opened starts a comment round. An inline (diff) note keeps its file and
  line. The agent reacts with 👀, works, and replies in the note's thread.
- **A failed pipeline** on such a merge request starts a CI round: the agent
  downloads the failed jobs' traces, fixes the cause, pushes, and posts a note.
  A branch pipeline (no `merge_request` in the event) is matched to the open
  merge requests of its branch. Off with `integrations.gitlab.ciResults:
  false`. At most 20 failed pipelines reach one task, so a fix that keeps
  failing cannot loop forever; `GITLAB_CI_RESULT_MAX_PER_TASK` changes that
  ([configuration.md](configuration.md#control-plane-settings)).

With the webhooks on, the agent introduces itself on each merge request it
opens: one note that names the bot and says how to mention it. The merge
request gets no assignee yet. On GitHub, with the App, the pull request is
assigned to the person a Linear issue belongs to, through the GitHub account
Linear links to them, and nothing links a person to a GitLab account.

Only notes from trusted users count: members of `gitlab.trustedGroups`
(inherited members included) and `gitlab.trustedUsers`, by immutable numeric
id. The bot's own notes are ignored, and so is everything on merge requests it
did not open. Approvals, `Merge Request Hook` events and notes without the
mention are ignored.

Deliveries are verified before anything is looked up: the signing token
(Standard Webhooks `webhook-signature` over
`webhook-id.webhook-timestamp.body`, five minutes of clock skew allowed; GitLab
19.1+), or on an older instance the secret token in `X-Gitlab-Token`. With
both configured a signed delivery must verify and an unsigned one falls back
to the secret token, GitLab's own migration path. A rejected delivery is one
`gitlab_webhook.rejected` log line with the reason.

The control plane needs the GitLab token too, for the replies and the member
lookups: the chart mounts `secrets.gitlab.existingSecret` into it when the
webhooks are on.

`GET /api/integrations/gitlab` reports the token, the webhooks and the last
verified delivery.

## How it works

- **Clones** come from the snapshot builder, which reads the token from the
  Secret and sends it as a Basic credential on `http.<gitlab.baseUrl>/`
  only, through `GIT_CONFIG_*` env, so no token lands in a `.git/config`.
- **Pushes and the API** go through iron-proxy. Sandboxes hold a placeholder
  (`proxy-gitlab-dummy-token`) that the proxy swaps for the real token on the
  `Authorization` header for that one host. The allowlist admits each
  configured project's git paths and its `/api/v4/projects/<group>/<project>`
  routes, nothing else on the instance.
- **The harness** picks a client per repo from its remote: GitHub for
  github.com, GitLab for a remote under `gitlab.baseUrl`
  (`harness/src/harness/codehost.py`). The merge request's `web_url` is what
  the task records as its PR URL, and what a webhook's merge request is
  matched against. In a follow-up round the same adapter reads the merge
  request's notes as discussion history (trusted authors only, the same lists
  as the webhook gate), updates its title or description, fetches job traces
  and retries a pipeline's failed jobs. The sandbox reaches only the configured
  projects, the trusted groups' member lists and `/api/v4/users`.
- **The control plane** verifies and gates the webhooks, matches the merge
  request to its task, and posts the agent's replies: in the note's discussion
  thread (looked up when the event did not name it), or as a new note for a CI
  result. A crashed round posts a retry hint naming the bot; a CI round that
  crashes stays silent.

## Versions and editions

Any GitLab that serves REST API v4 and smart-HTTP git works for the outbound
half: every call used (project, branch, merge request create and list) predates
GitLab 10. The webhooks need the signing token, GitLab 19.1 (19.0 behind a
flag), or the secret token on anything older; the events, notes, discussions,
award emoji, pipelines and job trace calls are all years old. Drafts are the
`Draft:` title prefix. The Free tier is enough; a group webhook needs Premium,
project webhooks do not.
