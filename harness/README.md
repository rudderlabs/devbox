# harness

The harness is the part of devbox that runs in each task's sandbox. Its daemon
reads work from `.harness/inbox/`, runs the agents (built on
[DeepAgents](https://github.com/langchain-ai/deepagents)), opens pull requests,
and reports progress in `.harness/events.jsonl`.

This file is for working on the harness. For using devbox, see the
[README](../README.md). The settings are in
[docs/configuration.md](../docs/configuration.md), and how the harness and the
control plane talk is in [docs/architecture.md](../docs/architecture.md).

## Build and test

Needs [uv](https://docs.astral.sh/uv/). Run from this directory:

```bash
make setup   # once: creates .venv and installs the dependencies
make test    # the unit tests (no network, no LLM)
make lint    # ruff check and ruff format --check
make build   # the sandbox image, devbox-dev:latest
```

The sandbox image includes native Go 1.27.3 (`go` and `gofmt` in
`/usr/local/go/bin`) for both amd64 and arm64.

`bun run up` builds the image for the local stack with
`make build IRON_PROXY_CA=<path/to/ca.crt>`. That also builds
`devbox-dev:local`, which adds iron-proxy's CA, `IRON_PROXY_EGRESS=true`, and
a git identity (`LOCAL_GIT_NAME`, `LOCAL_GIT_EMAIL`) on top of the plain image.

## Layout

| Path | What it is |
|---|---|
| `src/harness/cli.py` | The `harness` command: `harness daemon`, `harness memory`, `harness archive`. |
| `src/harness/daemon.py` | The daemon: polls the inbox, dispatches each file by `kind`, archives it. |
| `src/harness/handlers/` | One handler per inbox kind. `assignment.py` runs the stages of a new task. |
| `src/harness/followup.py` | Follow-up rounds (comments, reviews, CI results). |
| `src/harness/self_review.py` | The review stage: review agents, then a fix agent, in a loop. |
| `src/harness/distillation.py` | The distillation stage: notes to the configured knowledge directory (default `.agents/knowledge/`). |
| `src/harness/git.py` | Git and the GitHub REST API: branches, commits, pull requests. |
| `src/harness/events.py`, `emit.py` | Writing `.harness/events.jsonl`. |
| `src/harness/paths.py` | Every path under `WORKSPACE` and `.harness/`. |
| `src/harness/deepagents/` | The agents (`agents/`), their tools (`middleware/`) and the model (`model.py`). |
| `src/harness/prompts/` | Prompt fragments. |
| `src/harness/schemas/` | Pydantic models of the stages' JSON results. |
| `scripts/` | The image's entrypoint and bootstrap, and `seed_inbox.py`. |
| `tests/` | Unit tests (`unittest`). |
| `docs/deepagents-events.md` | The format of the optional DeepAgents event files. |

## Running the daemon without a sandbox

You can run the daemon on your machine against a workspace directory that holds
git checkouts of your repos. Set the variables from [sample.env](sample.env),
then:

```bash
export WORKSPACE=/path/to/workspace
HARNESS_LLM_API_KEY="$LLM_API_KEY" uv run harness daemon
```

In another shell, give it work with `scripts/seed_inbox.py`, which writes inbox
files the way the control plane does:

```bash
python3 scripts/seed_inbox.py assignment "Fix the login bug" --source api --task-key DEMO-1
```

`python3 scripts/seed_inbox.py --help` lists the other kinds.

Outside a sandbox, nothing swaps tokens, so the harness uses the real
`GITHUB_TOKEN` from its environment. Pass the real LLM key as
`HARNESS_LLM_API_KEY` to that one process only, as above. In a deployed control
plane, that allowlisted name is reserved for the proxy placeholder; never put a
real key in it.

`HARNESS_SKIP_COMMIT=true` skips the commit stage. `HARNESS_DRY_RUN_PUBLISH=true`
runs it without pushing or opening a pull request.

## Other settings

[docs/configuration.md](../docs/configuration.md) lists the main `HARNESS_*`
settings. The harness also reads:

| Variable | Meaning |
|---|---|
| `WORKSPACE` | The workspace root. Default `/workspace`. |
| `GITHUB_TOKEN` | A real GitHub token, for runs outside a sandbox. Unset in sandboxes. |
| `GITHUB_PROXY_TOKEN` | The dummy token iron-proxy swaps. Default `proxy-github-dummy-token`. |
| `GITHUB_API_URL` | Default `https://api.github.com`. |
| `HARNESS_DISTILLATION_ENABLED` | Default `true`. Set to any non-empty value other than `1`, `true`, `yes`, or `on` to skip assignment and follow-up knowledge distillation. |
| `HARNESS_REPO_KNOWLEDGE_DIR` | Repository-relative knowledge directory. Default `.agents/knowledge`; absolute, empty, root, traversal, and backslash-containing values fail the task when the first agent that reads repository knowledge starts. A knowledge directory symlinked outside the repository is ignored. |
| `HARNESS_GIT_SIGNER_NAME`, `HARNESS_GIT_SIGNER_EMAIL`, `HARNESS_GPG_PRIVATE_KEY_FILE`, `HARNESS_GPG_KEY_ID` | Optional GPG signing of the agent's commits. The first three go together. |
| `HARNESS_EXP_*` | Experimental flags. `devbox create --flag <NAME>` sets `HARNESS_EXP_<NAME>=true` for one task. |
