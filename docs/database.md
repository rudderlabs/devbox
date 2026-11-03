# Database

The control plane keeps its state in Postgres. Its schema is
`control-plane/src/db/schema.ts`, and the migrations that build it are the SQL
files in `control-plane/drizzle/`, applied in the order of
`drizzle/meta/_journal.json`.

## When migrations run

With `AUTO_MIGRATE=true`, the control plane applies pending migrations when it
starts, before it listens for requests or claims tasks. Otherwise run
`bun run db:migrate` from `control-plane/`; it does the same thing and exits.

| How devbox runs | What happens |
|---|---|
| Docker Compose (`bun run up`) | `docker-compose.yml` sets `AUTO_MIGRATE`. There is one control plane, and Compose stops the old container before it starts the new one. If the start fails, the process exits and Compose starts it again (`restart: unless-stopped`). |
| Kubernetes (installer or GitOps) | The chart sets `AUTO_MIGRATE`. Every new pod migrates when it starts, while the old pods keep serving ([Rolling deploys](#rolling-deploys)). A pod that fails exits, and Kubernetes restarts it with a growing delay. A pod has 5 minutes, its startup probe, to migrate and start listening; after that Kubernetes restarts it. |
| `bun run dev` or `bun run start` | `.env` decides; `.env.example` sets `AUTO_MIGRATE=true`. |

Startup logs `Running migrations`, then `Migrations complete`. When a
migration fails, the Postgres error follows `Running migrations` and the
process exits.

## How a run works

- **One at a time.** Before migrating, the control plane takes a Postgres
  advisory lock. Pods that start together take turns: the first applies the
  pending migrations, and the others wait for the lock and then find nothing
  left to do. The lock belongs to the database connection: Postgres releases
  it when the connection closes, for example when a pod dies mid-run.
- **One transaction.** All pending migrations run in a single transaction,
  which also records each of them in `drizzle.__drizzle_migrations`. If any
  statement fails, the whole run rolls back: none of the pending migrations is
  applied or recorded, and the next start tries them all again. An upgrade
  that skips releases applies all their migrations in one run.
- **What ran.** `SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER
  BY id;` lists the applied migrations. `created_at` is the migration's `when`
  in `drizzle/meta/_journal.json`.

## Lock timeouts

Changing a table locks it: the migration waits for transactions already using
the table, and until the run commits, other queries on that table wait for the
migration. Migrations that change tables a running control plane uses,
`tasks` and `inbox`, start with `SET LOCAL lock_timeout = '5s'`, so each of
their statements waits at most 5 seconds for a lock. The setting lasts until
the end of the run's transaction.

When the wait runs out, Postgres cancels the statement (`canceling statement
due to lock timeout`), the run rolls back, and the control plane exits. It is
restarted and tries again. On Kubernetes the old pods keep serving meanwhile,
and the rollout waits for the new pod.

Postgres may instead find a deadlock between the migration and a request on a
running control plane (`deadlock detected`), and cancel one of them. If it
cancels the migration, the pod restarts as above. If it cancels the request,
that request answers 500. Linear retries a failed webhook; GitHub doesn't, and
a failed delivery can be sent again from the GitHub App's Recent deliveries
page ([github.md](github.md#troubleshooting)).

A new migration that changes a table in use starts with the same
`SET LOCAL lock_timeout = '5s';` statement.

## Rolling deploys

On Kubernetes the chart uses the default rolling update: new pods start while
the old ones keep serving, and an old pod stops as a new one becomes ready.
With four or more replicas, up to a quarter of the old pods may stop first. As
soon as the first new pod has migrated, the old pods run against the new
schema, so each migration is written to keep the previous release working. A
release that needs more, such as a step before upgrading, says so in its
release notes.

## Rollbacks: migrations only go forward

There are no down migrations. Rolling back the control plane does not roll
back the database: the older release runs against the newer schema.

Don't undo schema changes by hand, such as dropping an index, a column or a
type that a newer migration added. The migrator applies only migrations newer
than the last one it recorded, so it doesn't re-create a dropped object on the
next upgrade, and the newer release then fails wherever it relies on it.
