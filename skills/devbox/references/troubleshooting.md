# When something fails

Start with what the command printed: devbox's errors name the field, the
variable or the fix. Then the status command for the part that fails.

## Setup and startup

| What you see | Cause and fix |
|---|---|
| `devbox.config.json not found`, or an error naming a field | Write or fix that field ([docs/configuration.md](../../../docs/configuration.md#devboxconfigjson)). Unknown keys are refused on purpose. |
| `bun run quickstart: no terminal to ask in: pass …` | Pass the flags it names. |
| A hidden prompt you can't answer | The secret is not in the environment or the keychain. Ask the user to set the variable, or to run the command themselves. |
| A GitHub check fails before startup | The token cannot push to a repo or open pull requests in it. The checks are listed in [docs/configuration.md](../../../docs/configuration.md#what-preflight-checks). |
| The LLM check fails | Wrong key, `baseUrl` or model. For `anthropic`, `baseUrl` has no `/v1`. |
| `cannot reach the Docker daemon: permission denied` | Linux: `sudo usermod -aG docker $USER`, then log out and in. |
| The stack starts but tasks can't reach GitHub or the LLM | On networks that block public DNS: `bun run up --dns-resolver <host:port>`. |
| Started with `docker compose up` and secrets are empty | Always start with `bun run up`. |
| The control plane is not healthy | `docker compose -f control-plane/docker-compose.yml logs control-plane` |
| A keychain error | `--no-keychain` skips the keychain; `bun run secrets ls` shows what is saved. |
| `/dev/kmsg` errors when kind starts | [docs/kubernetes/kind.md](../../../docs/kubernetes/kind.md#without-devkmsg) |

## Integrations

- `bun run github:status [--target <file>]` and
  `bun run linear:status [--target <file>]` show the settings, where each
  secret is found, what the control plane reports, and whether the public URL
  reaches devbox.
- "no answer": the tunnel is down, or the Ingress or DNS is not ready.
  "404: something answered, but not devbox": the tunnel points at the wrong
  port, or the integration is not applied yet: run `up` or the k8s command.
- `Entity not found: Organization` from a Linear check: the Linear app was
  just created, and Linear answers this for about a minute. The check retries
  for 60 seconds; if it still fails, run the command again a little later.
- Tables of symptoms: [docs/github.md](../../../docs/github.md#troubleshooting)
  and [docs/linear.md](../../../docs/linear.md).

## Tasks

- `bun run devbox show <task>`: state, sandbox, pull requests and rounds.
- `bun run devbox logs <task>`: the event log, with the agent's errors.
- A task stuck `queued`: no sandbox could start. On Compose check the
  OpenSandbox and control-plane logs; on Kubernetes, the pods in
  `devbox-sandboxes`.
- The agent ignores pull request comments: their authors are not trusted
  ([docs/configuration.md](../../../docs/configuration.md#trust-settings)), or
  there is no GitHub App (a personal token gets no webhooks).

## Kubernetes

`bun run k8s:check --target <file>` first. Then
[docs/kubernetes/README.md](../../../docs/kubernetes/README.md#troubleshooting):
"no ready repo snapshot", the Postgres password, NetworkPolicy not enforced,
iron-proxy's address, "port … is in use" from `k8s:connect`, and log streams
cut by an Ingress.
