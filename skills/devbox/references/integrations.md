# Integrations

Each integration has a setup, a status and a disable command. The setups write
the config and save secrets in the keychain if the user agrees; they never
apply anything. They end by naming the command that applies the change
(`bun run up`, `bun run k8s:kind`, or `bun run k8s:install --target <file>`).
Re-running a setup is safe: it reuses what is configured.

Without `--target` the commands act on Compose (`devbox.config.json`); with
`--target <file>` on that Kubernetes deployment (`devbox.kind.json` on kind).

## The public URL

GitHub and Linear deliver webhooks only to a public HTTPS URL, the
deployment's top-level `publicUrl`, shared by both. The setups refuse
`http://`, `localhost` and private addresses.

- Compose: a tunnel or reverse proxy to port 3000 (`ngrok http 3000`,
  `cloudflared tunnel --url http://localhost:3000`).
- kind: a tunnel to the local port of
  `bun run k8s:connect --target devbox.kind.json`.
- Kubernetes: the Ingress host (`ingress.webhooks`, else `ingress.api`).

A free tunnel gets a new URL each time it restarts, and GitHub and Linear keep
sending to the old one. Recommend a URL that doesn't change: a free ngrok
static domain (`ngrok http --url=<domain> 3000`) or a named Cloudflare tunnel.
If it changed anyway, run the setup again with the new `--public-url`
([docs/linear.md](../../../docs/linear.md#when-the-public-url-changes)).

## GitHub App

Without it, devbox uses a personal token: commits as the user, no webhooks.
With it: commits and pull requests from the App's bot, tokens that refresh,
and `@mentions`, reviews and failed CI runs reach the task.

```bash
bun run github:setup [--target <file>] [--public-url <url>] [--org <org>]
bun run up                      # or k8s:kind / k8s:install --target <file>
bun run github:status [--target <file>]
```

- Token modes: devbox mints the tokens (default), or `--external-tokens` for
  the user's own tooling (Vault, External Secrets).
- `--app-id <id>` adopts an existing App. `--print-registration-link` for a
  machine without a browser.
- The App's private key is never prompted for: `GITHUB_APP_PRIVATE_KEY_FILE`,
  `GITHUB_APP_PRIVATE_KEY`, or the keychain.
- On kind, `devbox.kind.json` must exist first: run `bun run k8s:kind` once.

Everything: [docs/github.md](../../../docs/github.md).

## Linear

Delegate an issue to the agent, or `@mention` it, and it starts a task.

```bash
bun run linear:setup [--target <file>] [--public-url <url>]
bun run up                      # or k8s:kind / k8s:install --target <file>
bun run linear:status [--target <file>]
```

Secrets: `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET`. One deployment
works with one Linear workspace. Everything:
[docs/linear.md](../../../docs/linear.md).

## Slack

Kubernetes only: `integrations.slack` in the target file and `SLACK_BOT_TOKEN`
([docs/kubernetes/customizing.md](../../../docs/kubernetes/customizing.md#integrations)).

## Turning one off

`bun run github:disable` / `bun run linear:disable` set `enabled: false` and
keep the settings, so the setup turns it back on. `--forget` deletes the
settings and saved secrets: ask first. Apply with `up` (or the k8s command).
