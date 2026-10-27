# control-plane

The control plane is the part of devbox that stores tasks, starts a sandbox for
each task through OpenSandbox, delivers work to the harness in the sandbox, and
reads its progress back. The CLI talks to its HTTP API.

This file is for working on the control plane. For using devbox, see the
[README](../README.md). The settings are in
[docs/configuration.md](../docs/configuration.md), and how the pieces fit is in
[docs/architecture.md](../docs/architecture.md).

Stack: Bun, [Hono](https://hono.dev), Drizzle with Postgres 18, Biome.

## Build and test

Needs Bun 1.4.4 or newer. Run from this directory:

```bash
bun install
bun run biome:ci    # lint and format check (bun run format fixes formatting)
bun run typecheck
TEST_DATABASE_URL=postgres://devbox:devbox@localhost:5433/devbox bun test
```

Some tests need a Postgres 18 database at `TEST_DATABASE_URL`.
[CONTRIBUTING.md](../CONTRIBUTING.md) shows how to start one.

## Running it

Run the whole local stack with `bun run up` from the repo root, not with
`docker compose up`. `up` passes the secrets and the LLM settings to Compose;
without them, iron-proxy and the control plane start with empty secrets.
`bun run down` stops the stack and `bun run reset` also removes its volumes.

`docker-compose.yml` mounts this directory into the control-plane container and
runs it with `bun run dev`, which restarts the server when a file changes.

The control plane's own settings are environment variables without a prefix,
read in `src/config.ts`, `src/apiConfig.ts` and `src/integrationsConfig.ts`.
`.env.example` lists them. Compose sets them explicitly in `docker-compose.yml`
and reads no `.env` file. `bun run dev` outside Compose reads `.env` from this
directory.

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | The server, restarted on file changes. |
| `bun run start` | The server. |
| `bun run db:generate` | A new migration in `drizzle/` from changes to `src/db/schema.ts`. |
| `bun run db:migrate` | Applies the migrations. With `AUTO_MIGRATE=true`, the server does this when it starts. |
| `bun run api-token create <name>` | Creates an API token and prints it once. Also `list` and `revoke <name>`. |

In the local stack, run `api-token` inside the container:

```bash
docker compose -f control-plane/docker-compose.yml exec control-plane bun run api-token list
```

## Layout

| Path | What it is |
|---|---|
| `src/index.ts`, `src/app.ts` | Startup and wiring. |
| `src/config.ts` | Settings from the environment, checked at startup. |
| `src/forwardedEnv.ts` | Which variables reach the sandbox. |
| `src/routes/`, `src/controllers/` | HTTP routes: `/health`, `/api/*`. |
| `src/services/taskProcessor.service.ts` | The loop: claims tasks, starts and reaps sandboxes, reads events. |
| `src/services/sandboxManager.service.ts` | Sandboxes through OpenSandbox, and the files in them. |
| `src/services/inbox.service.ts` | Delivers inbox rows to the sandbox. |
| `src/services/eventDispatcher.ts` | Handles the harness's events. |
| `src/services/apiTask.service.ts` | The API's tasks. |
| `src/repositories/` | Database access. `apiTask.repository.ts` computes the task states. |
| `src/types/inboxMessage.ts`, `src/types/harnessEvent.ts` | The files exchanged with the harness. |
| `src/types/api.ts` | The API's types, shared with the CLI. |
| `src/db/schema.ts`, `drizzle/` | The schema and its migrations. |
| `scripts/up.ts`, `scripts/up/` | `bun run up`. |
| `scripts/local-down.sh` | `bun run down`. |
| `scripts/build-repos-volume.sh` | Clones the configured repos into the `devbox-repos` volume. |
| `scripts/gen-iron-proxy-ca.sh` | Creates iron-proxy's local CA. |
| `infra/local/iron-proxy.template.yaml` | The template of iron-proxy's config. |
| `infra/opensandbox.toml` | The OpenSandbox server's config. |

## Conventions

- Layers: routes call controllers, controllers call services, services call
  repositories and clients. Only repositories use the database.
- Never log a token or secret. The logger (`src/logger.ts`) redacts keys that
  match `token`, `secret`, `password` or `authorization`, but don't rely on it.
- In tests, `mock.module` replaces a whole module: mock its full export surface,
  mock the module the code imports (a barrel, if it imports one), and never the
  implementation module behind it.
- Run the suite through `bun run test`, not a bare `bun test`. The script adds
  `--isolate`, which gives every test file a fresh module registry. `mock.module`
  is process-global and otherwise leaks across files in readdir order
  (oven-sh/bun#12823) -- which is environment-dependent, so a suite that passes
  locally can fail in CI. Importing the implementation module instead of the
  mocked barrel is not sufficient on its own; it was tried and still failed in
  CI. Isolation is what contains it.
- No test asserts the order of keys in JSON.
