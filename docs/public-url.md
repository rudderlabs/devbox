# The public URL

Integrations deliver webhooks to devbox over the internet, so a deployment
that takes webhooks needs one public HTTPS URL. It is the top-level
`publicUrl` of the config file (`devbox.config.json`, or the target file on
Kubernetes), not part of any integration's block. One tunnel or Ingress
serves every integration: each one's webhook is at
`<publicUrl>/webhook/<integration>`, for example `/webhook/linear`.

## What setup accepts

Every integration's setup command reads and writes `publicUrl`, and all of
them refuse anything but a public HTTPS URL: `http://`, `localhost`, and
loopback, link-local or private (RFC 1918, ULA) addresses. A path prefix is
kept (`https://example.com/devbox`) and a trailing slash dropped; a query, a
fragment or credentials are refused.

A setup uses `--public-url` when you pass it, else the saved `publicUrl`,
else the Ingress on Kubernetes. On Compose it asks for one in a terminal.

## Getting one

- **Compose: bring your own.** Run a tunnel or a reverse proxy that forwards
  HTTPS to port 3000 on your machine, and pass its URL with `--public-url`:
  - [ngrok](https://ngrok.com/): `ngrok http 3000`;
  - [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):
    `cloudflared tunnel --url http://localhost:3000`;
  - a reverse proxy with a certificate, on a host you own.

  devbox bundles no tunnel. A free tunnel's URL changes when it restarts; a
  free ngrok static domain (`ngrok http --url=<your-domain> 3000`) or a named
  Cloudflare tunnel keeps it. If it changes anyway, see
  [When it changes](#when-it-changes).
- **kind: a tunnel too.** kind's Ingress host is `localhost`, so it has no
  public address. Point the tunnel at the local port
  `bun run k8s:connect --target devbox.kind.json` forwards to the control
  plane, and pass its URL with `--public-url`.
- **Kubernetes: the Ingress.** Without `--public-url` or a saved URL, it comes
  from the target file's values: the `ingress.webhooks` host, else the
  `ingress.api` host ([customizing.md](kubernetes/customizing.md#ingress)). It
  is `https://` when that Ingress has `tls`, and `http://` without, which is
  refused. When TLS ends at a load balancer in front of the Ingress (the ALB
  example), `tls` stays empty: pass `--public-url https://<host>`.

  A `webhooks` Ingress alone is enough. An `api` Ingress that only your VPN
  reaches can't receive webhooks: add a public `ingress.webhooks`.

## Body size

The control plane accepts webhook request bodies up to 1 MiB. A larger
delivery receives HTTP 413 and is not processed, so a legitimate delivery
above this limit is lost. Keep any tunnel, reverse-proxy, or Ingress body
limit at or below 1 MiB so it rejects oversized requests before they reach the
control plane.

## Who reads it

Only the CLI: the setup commands, for the apps and webhooks they register or
print, and the `*:status` commands, for the probe. The control plane never
reads it.

## When it changes

Run the setup of any integration that is on with the new URL:
`bun run <integration>:setup --public-url <new>`, with `--target <file>` on
Kubernetes. It updates `publicUrl` in the config and prints, for each
integration that is on, what to update and where. Each integration's page
explains its line. Then run each integration's `*:status` to probe the new
URL.
