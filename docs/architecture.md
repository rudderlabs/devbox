# Architecture

This page describes devbox as `bun run up` runs it: Docker Compose on one
machine, with tasks created through the API. [On Kubernetes](#on-kubernetes)
describes what changes when the Helm chart runs it.

## Components

| Component | Code | What it does |
|---|---|---|
| CLI | `cli/` | A client of the control plane's HTTP API (`/api/*`). It holds no state other than its config file. |
| Control plane | `control-plane/` | A Bun server with Postgres. It stores tasks, starts and stops sandboxes, delivers work to them and reads their progress. |
| OpenSandbox server | image `opensandbox/server` | Creates the sandbox containers on the host's Docker and gives the control plane access to their files. |
| Sandbox | `harness/` (the image `devbox-dev:local`) | One container per task. Runs the harness daemon, which does the work. |
| iron-proxy | image `ironsh/iron-proxy` | The sandboxes' way to GitHub and the LLM endpoint. Enforces an allowlist and swaps dummy tokens for real ones. |
| Postgres | image `postgres:18` | The control plane's database. |

`control-plane/docker-compose.yml` defines the services. The sandboxes are not
Compose services: OpenSandbox creates them.

### Networks

- The control plane and Postgres are on Compose's default network.
- The sandboxes, iron-proxy and the OpenSandbox server are on the `harness`
  network.
- On the `devbox` network, iron-proxy has network aliases for the GitHub hosts
  and the LLM host. Docker's DNS sends the sandboxes' traffic for those hosts to
  iron-proxy. The sandbox image trusts iron-proxy's local CA, so iron-proxy can
  read and change those requests.
- The control plane is not on the `devbox` network, so its own GitHub calls,
  with the real token, go straight to GitHub. It reaches the sandboxes through
  the OpenSandbox server.

### Workspace volumes

`bun run up` clones the configured repos into the `devbox-repos` Docker volume.
When a task first needs a sandbox, the control plane copies that volume into a
new volume for the task, labelled `devbox.task-volume`. It mounts it at
`/workspace` in the sandbox. The volume outlives the sandbox. A later sandbox for
the same task mounts the same volume, with the repos, the branches and the
harness's state as they were.

## A task's life

1. `bun run devbox create "<title>"` calls `POST /api/tasks`. In one transaction,
   the control plane writes the task, an `assignment` row in its inbox table,
   and a `task_created` event. The task gets a key such as `DBX-API-1`.
2. The control plane's loop (every 5 seconds) claims tasks that have undelivered
   inbox rows, up to the configured
   [sandbox concurrency limit](configuration.md#sandbox). For a task without a
   sandbox, it creates the workspace volume
   if needed and starts a sandbox. It writes a `sandbox_started` event.
3. The control plane delivers each undelivered inbox row to the sandbox as a
   file (see [the inbox](#the-inbox)).
4. The harness daemon in the sandbox picks up the file and runs the round. As it
   works, it appends events to `.harness/events.jsonl` (see
   [the event log](#the-event-log)).
5. On each loop, the control plane reads the new events, stores them for the
   API, and records pull request URLs. A `completed` event ends the round.
6. `bun run devbox logs -f` streams the stored events
   (`GET /api/tasks/<ref>/events/stream`).
7. After 15 minutes without activity and with no open round, the control plane
   removes the sandbox. The volume stays.
8. `bun run devbox send` calls `POST /api/tasks/<ref>/messages`, which adds a
   `comment` row to the inbox and writes a `message_queued` event. If the task
   has no sandbox, the control plane starts a new one on the same volume, and
   the round runs as in steps 3 to 5.

`bun run devbox restart` calls `POST /api/tasks/<ref>/restart`. It removes the
task's sandbox, fails its open follow-up rounds, queues the assignment again
under a new id, and starts the task on a new volume, with a `task_restarted`
event.

If a sandbox dies, the control plane starts a new one on the same volume, up to
`MAX_TASK_RETRIES` times (3 by default), and then fails the task.

## The inbox

The inbox is how the control plane gives the harness work.

- In Postgres, each round of work is a row in the `inbox` table, with a status:
  `pending` (not delivered yet), then `delivered` (written to the sandbox), then
  `responded` (the harness finished it). `failed` means the control plane could
  not deliver it.
- To deliver a row, the control plane writes it to
  `/workspace/.harness/inbox/<id>.json` in the sandbox, then marks it
  `delivered`. If the write fails, the row stays `pending` and is tried again.
- The file is one JSON object, the `InboxMessage` type in
  `control-plane/src/types/inboxMessage.ts`:

  ```json
  {
    "id": "<uuidv7>",
    "source": "api",
    "kind": "assignment",
    "external_id": "DBX-API-1",
    "payload": { "task_id": "…", "task_key": "DBX-API-1", "title": "…", "description": null, "external_url": "…", "target_id": "…" }
  }
  ```

- `kind` selects the harness's handler. Through the API there are two kinds:
  `assignment` (a new task) and `comment` (a follow-up message). The other kinds
  in the type come from task sources this repo doesn't document.
- The daemon (`harness/src/harness/daemon.py`) polls `.harness/inbox/` every
  second, and handles the files in name order. The ids are UUIDv7, so that is
  the order they were created in. When a file is done, it moves to
  `.harness/inbox/.processed/`, or to `.harness/inbox/.error/` if handling it
  failed.
- A file lock, `.harness/inbox.lock`, keeps a second daemon from running.

## The event log

The event log is how the harness reports back.

- The harness appends one JSON object per line to `.harness/events.jsonl`. Each
  has a `seq` number, a timestamp `ts`, a `type` and the `inbox_id` of its round.
  The types are in `control-plane/src/types/harnessEvent.ts`.
- `agent_thought`, `agent_action`, `agent_response` and `agent_error` carry a
  `body` of text for the user. `agent_response` is the round's answer.
- `pr_opened` carries the repo, the pull request URL, the branch and the commit.
- `completed` ends a round. For an assignment, its `status` is `completed`,
  `partial_failure` (some repos failed), `no_action` (the plan changed no repo)
  or `failed`.
- The control plane keeps a cursor per task, the last `seq` it read. On each
  loop it reads the file through OpenSandbox and handles the events after the
  cursor. It ignores lines it can't parse.
- For API tasks, the control plane stores the harness's events, and its own
  (`task_created`, `message_queued`, `task_restarted`, `sandbox_started`,
  `round_failed`), in the `task_events` table. The API serves them from there.

## The harness's stages

An `assignment` runs these stages (`harness/src/harness/handlers/assignment.py`):

1. **Setup.** Prepares the workspace and, unless turned off, fetches the latest
   commits of every repo.
2. **Orientation.** One agent looks over the workspace and picks the repos,
   and the components in them, that the task touches.
3. **Planning.** One agent per repo from orientation drafts that repo's part of
   the plan. The agents run in parallel.
4. **Plan review.** An adversarial agent checks the draft plan against the
   workspace. If it asks for revisions, the planning agents revise their parts
   once, and a repo the reviewer says is missing gets its own planning agent.
   The reviewer's verdict is kept in `.harness/plan-review.json` for debugging;
   nothing reads it back. The final plan is `.harness/plan.json` and
   `.harness/plan.md`. If no repo needs a change, the round ends as `no_action`.
5. **Implementation.** One agent per planned repo makes the change. The result
   is `.harness/implementation.json`.
6. **Review.** Review agents look at the diff, and a fix agent fixes or declines
   each finding, for up to `HARNESS_REVIEW_MAX_ITERATIONS` passes. The result is
   `.harness/review.json`. The stage can be disabled with
   `HARNESS_REVIEW_ENABLED`.
7. **Distillation.** Turns the notes the agents recorded during the task into
   knowledge files in the repo's configured knowledge directory (`.agents/knowledge/`
   by default). The stage can be disabled with `HARNESS_DISTILLATION_ENABLED`.
8. **Commit.** For each changed repo: a branch, a commit, a push, and a draft pull
   request against the configured branch.

Orientation, planning and plan review run inside `run_planning`
(`harness/src/harness/planning.py`), and their result is saved as one artifact,
the plan.

A `comment` round (`harness/src/harness/handlers/comment.py`) runs one agent with
the task's earlier context. It can change the code and push new commits to the
pull request's branch.

Seven of these are model stages: orientation, planning, plan review,
implementation, review, distillation, and the comment round's follow-up agent.
Each can have its own model and reasoning effort
([`llm.stages`](configuration.md#llm)). Setup and commit call no model.

If the daemon restarts in the middle of an assignment, it reuses the stages'
saved results and goes on from where it stopped.

## Task states

The API reports a task's `state`, computed from its inbox rows
(`STATE_SQL` in `control-plane/src/repositories/apiTask.repository.ts`):

| State | When |
|---|---|
| `queued` | A round is `pending` or `delivered`, and the task has no sandbox yet. |
| `running` | A round is `pending` or `delivered`, and the task has a sandbox. |
| `failed` | No round is open, and the latest round failed: it was not delivered, or it completed with status `failed`. |
| `idle` | No round is open, and the latest round did not fail. |

"The latest round" is the inbox row updated last. `bun run devbox wait` and the
`--wait` option return when the task is `idle` or `failed`.

## On Kubernetes

The chart `deploy/helm/devbox` runs the same components in two namespaces
([docs/kubernetes/README.md](kubernetes/README.md) installs it):

```
namespace: devbox (release)                       namespace: devbox-sandboxes
┌─────────────────────────────────────┐          ┌───────────────────────────────────┐
│ control plane (Deployment)          │─kubectl─▶│ task PVCs  ◀── restored from ───┐ │
│   ├─▶ Postgres (bundled or external)│          │ VolumeSnapshots repos-<ts>      │ │
│   └─▶ OpenSandbox server ──creates──────────▶  │ sandbox pods (harness image)    │ │
│ OpenSandbox controller              │          │   DNS → iron-proxy ClusterIP    │ │
│ iron-proxy (pinned ClusterIP)  ◀────────────── │   CA cert ConfigMap mounted     │ │
│   holds GitHub / LLM secrets        │ sandbox  │ snapshot builder CronJob ───────┘ │
│   ──▶ internet (allowlisted)        │  egress  │   (clone-only, real token)        │
│ bootstrap Job (generated secrets)   │          │                                   │
└─────────────────────────────────────┘          └───────────────────────────────────┘
```

What differs from the local stack:

- **Sandboxes are pods.** The OpenSandbox server creates each one in
  `devbox-sandboxes` from a pod template in its config (the ConfigMap
  `devbox-sandbox-template`). The template sets the DNS server, mounts the
  iron-proxy CA and gives the pod no service account token.
- **Workspaces are volumes restored from snapshots.** The snapshot builder, a
  CronJob, clones the configured repos into a scratch volume and takes a
  VolumeSnapshot `repos-<timestamp>`; it keeps the newest 3. For a task, the
  control plane creates a PersistentVolumeClaim from the newest ready snapshot
  and mounts it at `/workspace`. It replaces the `devbox-repos` volume.
- **DNS replaces network aliases.** iron-proxy's Service has a fixed address,
  `ironProxy.clusterIP`, and sandboxes use it as their only DNS server.
  iron-proxy answers every name with its own address, so all sandbox traffic
  reaches it, and it refuses hosts that are not on the allowlist.
- **Secrets are mounted files.** iron-proxy reads the GitHub token and the
  LLM key from Secrets mounted as files, and the control plane reads the GitHub
  token the same way (it gets only a dummy LLM key). Both re-read them, so a
  rotated Secret takes effect without a restart
  ([docs/kubernetes/secrets.md](kubernetes/secrets.md)).

### Traffic rules

The chart ships these NetworkPolicies, always on. They need a CNI that
enforces NetworkPolicy.

- **Sandboxes:** egress only to iron-proxy, on DNS (53, UDP and TCP), 80 and
  443; ingress only from the OpenSandbox server. No service account token.
- **iron-proxy:** ingress only from sandboxes.
- **OpenSandbox server:** ingress only from the control plane. Its
  `/sandboxes/{id}/proxy/{port}` endpoint skips the API key, so anything that
  reaches the server can run commands in any sandbox.
- **Postgres:** ingress only from the control plane.
- **Snapshot builder:** egress to DNS, the Kubernetes API and port 443. A plain
  NetworkPolicy cannot restrict by host name, so this is not limited to GitHub;
  the builder only clones and runs no repo code.
- **Control plane:** a ClusterIP Service. Two optional Ingresses: `webhooks` for `/webhook/`, `api` for everything.
