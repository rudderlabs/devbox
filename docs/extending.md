# Extending devbox

## Not a stable interface

devbox has no extension or hook interface. This page lists the places in the
code where hooks would naturally go, so you know where to look if you change
devbox for your own needs. All of it can change in any commit, without notice
and without a migration path.

## The repos the agent works on

This one needs no code change. The agent reads instructions from the repos it
works on: `AGENTS.md`, `CLAUDE.md` and the Markdown files in the repository
knowledge directory (`.agents/knowledge/` by default) at the repo and configured
component roots (`harness/src/harness/deepagents/middleware/knowledge.py`). Set
`HARNESS_REPO_KNOWLEDGE_DIR` to a safe repository-relative directory such as
`.devbox/knowledge` to customize it. Absolute paths, the scope root, traversal
segments, empty values, and backslashes are rejected. A knowledge directory
may be a symlink to another directory in the same repository, for example to
share one directory between components. A symlink that leads outside the
repository, or to the repo or component root itself, is ignored and logged,
and that scope then has no knowledge. Put your conventions, build and test
commands there. Set `HARNESS_DISTILLATION_ENABLED=false` to read
existing knowledge without promoting new harness memory after code rounds.

## The harness's stages

`process_assignment` in `harness/src/harness/handlers/assignment.py` runs an
assignment's stages in order. The boundaries between them are where hooks would
go. Orientation, planning and plan review run inside one stage,
`run_planning` in `harness/src/harness/planning.py`; review and distillation
live in their own modules.

| Boundary | Code | A hook could |
|---|---|---|
| Before orientation | `setup_workspace` | prepare the workspace, add context to the task |
| After orientation | `_orientation_for_task` (`planning.py`) | change the repos and components the planners get |
| After plan review | `run_planning` (`planning.py`), after `_persist_plan_review` | act on the reviewer's verdict before revisions |
| After planning | `_run_planning_stage` | check or change `.harness/plan.json` before any code changes |
| After implementation | `_run_implementation_stage` | run extra checks on the change |
| After review | `run_self_review_loop` (`harness/src/harness/self_review.py`) | add findings, or stop the commit |
| After distillation | `run_distillation_stage` (`harness/src/harness/distillation.py`) | change the knowledge files the task writes |
| Before and after the commit | `run_commit_stage` | change the branch, the commit or the pull request, or notify someone |

Each stage saves its result under `.harness/`, and a restarted daemon reuses
it. A hook that changes a stage's result must keep that working.

Follow-up rounds run through `run_followup_round` in
`harness/src/harness/followup.py`, with one handler per inbox kind in
`harness/src/harness/handlers/`.

## The agents

- Each agent is a preset in `harness/src/harness/deepagents/agents/`.
- The agents' tools are middleware in
  `harness/src/harness/deepagents/middleware/`. A new tool would be a new
  middleware, added to the presets that need it.
- Prompt fragments are in `harness/src/harness/prompts/`. The runtime-only
  `DEVBOX_PROMPTS_DIR` points the harness at another directory inside a sandbox;
  it is not forwarded from the control plane.
- The model is built in `build_openai_model` in
  `harness/src/harness/deepagents/model.py`. Another kind of model would go
  there.

## Task sources

The API (`control-plane/src/routes/api.ts`, `control-plane/src/services/apiTask.service.ts`)
is the documented way to create tasks. A task source:

- creates a row in `tasks`, and an `assignment` row in `inbox` for it;
- adds an `inbox` row for each follow-up;
- gives each inbox row the reply targets that say where the harness's answers
  go (`ReplyTargetSpec` in `control-plane/src/repositories/inbox.repository.ts`).

The harness sees only the inbox file (`InboxMessage` in
`control-plane/src/types/inboxMessage.ts`). The control plane routes the
harness's events back to the source by reply target, in
`control-plane/src/services/eventDispatcher.ts`. A new source would add a
`source` value, its routes, and its reply-target kinds. The code has other
sources, which this repo doesn't document.

## The sandbox runtime

- The control plane creates sandboxes through OpenSandbox, in
  `control-plane/src/services/sandboxManager.service.ts`. OpenSandbox decides
  where they run. The local stack's OpenSandbox server uses Docker
  (`control-plane/infra/opensandbox.toml`).
- `SANDBOX_RUNTIME` selects how the control plane makes each task's workspace
  volume (`control-plane/src/sandboxConfig.ts`). `docker`, the default and what
  the local stack uses, copies the `devbox-repos` volume
  (`control-plane/src/clients/docker.ts`). `k8s`, which the Helm chart sets,
  creates a PersistentVolumeClaim from the newest ready repo snapshot
  (`control-plane/src/clients/k8s.ts`).
- The environment a sandbox gets is built in `buildDaemonEnv` in
  `sandboxManager.service.ts`. With `k8s` it adds `K8S_EGRESS_ENV`, which turns
  on the iron-proxy CA and git setup in the harness's `bootstrap.sh`.
- On Kubernetes, the pod around each sandbox comes from the chart's template,
  `deploy/helm/devbox/templates/sandbox.yaml`: DNS through iron-proxy, the CA
  mount, the NetworkPolicy label, no service account token, and the
  pass-through `sandbox.*` values. The control plane cannot set these per
  sandbox.

## Egress

The sandboxes reach GitHub and the LLM endpoint through iron-proxy. Its rules
come from `control-plane/infra/local/iron-proxy.template.yaml`, with the repo
and LLM rules added by `control-plane/scripts/up/ironProxy.ts`. Another host the
agent should reach with a credential would need a network alias in
`control-plane/docker-compose.yml`, an allowlist rule, and a secret rule.

On Kubernetes the rules are in the chart,
`deploy/helm/devbox/templates/iron-proxy-config.yaml`, and
`deploy/helm/devbox/tests/iron-proxy.test.ts` keeps them equal to the Compose
renderer's. No alias is needed there: sandboxes send every DNS lookup to
iron-proxy. `ironProxy.extraAllowlist` adds allowlist rules without a code
change; a secret rule still needs one.
