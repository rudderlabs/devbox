---
name: devbox
description: How devbox works and how to run it — the self-hosted coding agent that takes a task, opens a draft pull request and takes follow-ups. Use when setting devbox up (bun run quickstart, devbox.config.json, Docker Compose, kind, Kubernetes, Helm, GitOps, EKS), when using it (bun run devbox create/logs/send, CLI profiles), when connecting the GitHub App, Linear or Slack, when upgrading or uninstalling it, or when something about it fails (bun run up, k8s:install, *:status, iron-proxy, sandboxes, secrets, the keychain, tunnels).
---

# devbox

devbox is a coding agent that runs on the user's own infrastructure and works
on their GitHub repos. A task goes in through the CLI (or a Linear issue, or a
GitHub `@mention`); the agent plans, implements, reviews its own work and opens
a draft pull request; follow-ups push new commits to the same pull request.

```
devbox CLI ──HTTP──> control plane ──OpenSandbox──> sandbox, one per task (harness)
                     (API, Postgres)                        │ dummy tokens
                                                            v
                                                       iron-proxy ── real tokens ──> GitHub, LLM
```

The sandbox never holds a real credential: iron-proxy swaps dummy tokens for
the real ones and allows writes only to the configured repos. Details:
[docs/architecture.md](../../docs/architecture.md).

## Rules for working with devbox

- **Run every command from the root of the devbox repo.** All commands are
  `bun run <script>` from its `package.json`.
- **Never put a secret in a file, a command line or the chat.** devbox finds
  secrets itself: the environment, then the system keychain, then
  `gh auth token` (GitHub token only), then a hidden prompt. If one is missing,
  tell the user which variable it is and let them provide it
  ([docs/configuration.md#secrets](../../docs/configuration.md#secrets)).
- **Hidden prompts need a terminal you don't have.** `bun run quickstart`,
  `up`, `k8s:install`, `k8s:kind` and the `*:setup` commands may ask questions.
  Pass the flags that answer them ahead, and when a secret is still needed,
  ask the user to run the command themselves (in Claude Code: `! bun run …`).
- **Ask before destructive commands:** `bun run reset` (deletes the database
  and every task's workspace), `k8s:uninstall --purge`, `*:disable --forget`,
  `bun run secrets rm|clear`.
- **Diagnose with the status commands first:** `github:status`,
  `linear:status`, `k8s:check`, `bun run devbox show <task>`.
- **Read the linked doc before changing a setting** instead of guessing a
  field: the config parsers reject unknown keys.

## What do you need?

| Goal | Read |
|---|---|
| Set devbox up on this machine for the first time | [references/quickstart.md](references/quickstart.md) |
| Run tasks, follow them, switch control planes | [references/using.md](references/using.md) |
| Connect the GitHub App, Linear or Slack | [references/integrations.md](references/integrations.md) |
| Run on Kubernetes: installer, GitOps, EKS, upgrade, uninstall | [references/kubernetes.md](references/kubernetes.md) |
| Something fails | [references/troubleshooting.md](references/troubleshooting.md) |

## Deployment modes

| Mode | Where it runs | Start / apply | Config |
|---|---|---|---|
| Docker Compose | this machine | `bun run up` (or `bun run quickstart --compose`) | `devbox.config.json` |
| kind | a local Kubernetes cluster in Docker | `bun run k8s:kind` (or `bun run quickstart --kind`) | `devbox.config.json` + `devbox.kind.json` |
| Kubernetes, installer | any cluster | `bun run k8s:install --target <file>` | `devbox.config.json` + the target file |
| Kubernetes, GitOps | any cluster | the Helm chart in `deploy/helm/devbox` | Helm values + your own Secrets |

`devbox.config.json` holds `repos` and `llm` for every mode. On Compose it also
holds `publicUrl`, `integrations`, `github` (trust lists) and `sandbox`. On
Kubernetes those live in the target file (`--target`) instead
([docs/configuration.md](../../docs/configuration.md)).

## Commands

| Command | Does |
|---|---|
| `bun run quickstart` | To a running local devbox, with chosen integrations; writes `devbox.config.json` from the user's answers when there is none |
| `bun run up` / `bun run down` / `bun run reset` | Start, stop (keeps tasks), or wipe the Compose stack |
| `bun run devbox <command>` | The CLI: `create`, `ls`, `show`, `logs`, `send`, `wait`, `restart`, `whoami`, `profile` |
| `bun run secrets ls\|rm\|clear` | Show or remove the secrets saved in the keychain |
| `bun run github:setup\|status\|disable` | The GitHub App |
| `bun run linear:setup\|status\|disable` | Linear |
| `bun run k8s:kind` | A local kind cluster with devbox installed |
| `bun run k8s:install\|connect\|check\|refresh-snapshot\|uninstall` | Kubernetes, with `--target <file>` |

The integration commands act on Compose without `--target`, and on that
Kubernetes deployment with it (`--target devbox.kind.json` on kind).

## What devbox does not do (v1)

Say so instead of looking for a way around it:

- GitHub only: no GitLab or Bitbucket.
- Two LLM APIs: OpenAI's Responses API and Anthropic's Messages API. A
  self-hosted model needs a server that speaks the Responses API with
  reasoning, on port 80 or 443 under a DNS name.
- Work comes in from the CLI, Linear and GitHub. Slack only gets completion
  updates, for Linear tasks unless `notifySources` adds API tasks. No Jira, no
  web UI.
- A task can't be stopped from Linear yet.
- No stable extension interface ([docs/extending.md](../../docs/extending.md)).
