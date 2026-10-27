# Using devbox

The CLI is `bun run devbox <command>`; `bun run devbox <command> --help` shows
each command's options.

## Tasks

```bash
bun run devbox create "Add a /health endpoint to <owner>/<repo>"   # prints the key, e.g. DBX-API-1
bun run devbox logs -f <task>          # follow the event log
bun run devbox send <task> "Also add a test"
bun run devbox wait <task>             # until idle or failed; prints the final response
bun run devbox show <task>             # state, sandbox, pull requests, rounds
bun run devbox ls                      # newest first
bun run devbox restart <task>          # start over from a clean slate
```

- A task has no repo field. With more than one configured repo, name the repo
  in the task's text.
- The agent works only on the repos in `devbox.config.json`.
- A task's state is `queued`, `running`, `idle` or `failed`
  ([docs/architecture.md](../../../docs/architecture.md#task-states)). `wait`
  exits 0 done, 1 failed, 2 partial failure, 3 timeout.
- With a personal token, commits and pull requests appear as the token's
  owner, and `@mentions` on the pull request do nothing; follow-ups go through
  `send`. With the GitHub App, they come from its bot and `@mentions`, reviews
  and failed CI reach the task ([integrations.md](integrations.md)).
- Pull request discussion reaches the agent only from trusted authors:
  `github.trustedOrgs` and `github.trustedUsers`
  ([docs/configuration.md](../../../docs/configuration.md#trust-settings)).

## Control planes and profiles

The CLI keeps one profile per control plane in `~/.config/devbox/config.json`
(mode 0600): `bun run up` writes `local`, `k8s:install` one per cluster
(`k8s-kind-devbox` for kind). `bun run devbox profile ls|use|add` lists and
switches them; `--profile`, or `DEVBOX_CLI_PROFILE`, picks one per command
([docs/configuration.md](../../../docs/configuration.md#cli-profiles)).

A cluster without an Ingress is reached through
`bun run k8s:connect --target <file>`, kept running in another terminal.

## Changing the config

- Compose: edit `devbox.config.json`, then `bun run up` again.
- Kubernetes: edit `devbox.config.json` or the target file, then
  `bun run k8s:install --target <file>` (`bun run k8s:kind` on kind).

## Stopping

- `bun run down` stops the Compose stack and keeps the tasks.
- `bun run reset` also deletes the database, the cloned repos and every
  task's workspace. Ask first.
- Kubernetes: [kubernetes.md](kubernetes.md#uninstall).

## Model cost

Spend varies with the task and the model. To control it:

- a lighter model, or a lower reasoning effort, on the stages that don't need
  the strongest one (`llm.stages`,
  [docs/configuration.md](../../../docs/configuration.md#llm));
- fewer tasks at once: `sandbox.maxConcurrent`
  ([docs/configuration.md](../../../docs/configuration.md#sandbox));
- a separate API key for devbox, so the provider's usage page shows its spend.

## Customizing the agent

The agent reads `AGENTS.md`, `CLAUDE.md` and `.agents/knowledge/` in the repos
it works on: that is where repo conventions and build and test commands go.
It also adds what it learned there, as a commit on each pull request, reviewed
like code
([docs/extending.md](../../../docs/extending.md#the-repos-the-agent-works-on)).
