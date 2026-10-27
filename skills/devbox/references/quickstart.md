# Setting devbox up locally

The fastest path is `bun run quickstart` from the root of the devbox repo. It
runs on Docker Compose or on a local kind cluster.

## 1. Check what the user has

- Docker running, with about 8 GB of memory for it; Docker Compose 2.13 or
  newer; Bun 1.4.4 or newer; `make` and `openssl`.
- For kind as well: kind 0.24 or newer, `kubectl`, Helm 3.14 or newer, `git`,
  and about 30 GB of free disk.
- A GitHub token that can push to the repos and open pull requests in them:
  `GITHUB_TOKEN`, or `gh` logged in (`gh auth status`).
- An OpenAI or Anthropic API key, as `LLM_API_KEY` or typed when asked.

The quickstart checks the tools too and lists every missing one, so you can
also run it and read what it says.

## 2. Write devbox.config.json

Ask the user, one question each:

1. Which repos may the agent work on, and on which branch (default `main`)?
2. OpenAI or Anthropic?
3. Use the provider's public endpoint, or a different base URL? Ask this even
   when they answered OpenAI: Azure OpenAI, an LLM gateway or a self-hosted
   server all need their own base URL. The defaults are
   `https://api.openai.com/v1` and `https://api.anthropic.com`.
4. Which model? For Azure OpenAI this is the deployment name, not the model
   family.

For **Azure OpenAI**: `provider` is `openai` (Azure serves the same Responses
API), `baseUrl` is the resource's v1 URL,
`https://<resource>.openai.azure.com/openai/v1`, and `model` is the
deployment's name. The key is the Azure resource's key, as `LLM_API_KEY`.
Every base URL needs a DNS name and the default port (443 or 80), and the model
needs reasoning support
([docs/configuration.md](../../../docs/configuration.md#llm)).

Then one of two ways:

- **The quickstart asks.** When there is no `devbox.config.json` and the user
  runs `bun run quickstart` in a terminal, it asks for the repos (each
  `owner/name` and its branch), the provider, the model and the base URL,
  checks them and writes the file. It never changes an existing file. Tell the
  user what to answer, from their answers above; for Azure, they replace the
  default base URL.
- **You write it**, when you run the quickstart yourself (you have no terminal,
  so it only says what is missing) or the user wants more than the basics.
  Start from `devbox.config.example.json`:

```json
{
  "repos": [{ "url": "https://github.com/<owner>/<repo>.git", "branch": "main" }],
  "llm": { "provider": "anthropic", "baseUrl": "https://api.anthropic.com", "model": "<model>" }
}
```

- `repos[].url` must be `https://github.com/<owner>/<repo>.git`; `branch`
  defaults to `main`. Repo names must be unique.
- `llm.provider` is `openai` (Responses API: OpenAI, Azure OpenAI or a
  compatible server) or `anthropic` (Messages API, base URL without `/v1`; the
  model must support adaptive thinking).
- `llm.baseUrl` is the user's answer to question 3, or the provider's default.
- Optional: `llm.reasoningEffort`, per-stage `llm.stages`, `sandbox` sizing.
  Every field: [docs/configuration.md](../../../docs/configuration.md#devboxconfigjson).

The quickstart refuses the example's placeholder repo `your-org/your-repo`.

## 3. Decide the questions

The quickstart asks three things unless flags answer them:

| Question | Flags |
|---|---|
| Docker Compose or kind? | `--compose` or `--kind` |
| Set up the GitHub App? | `--github-app` or `--no-github-app` |
| Set up Linear? | `--linear` or `--no-linear` |

Without a terminal, an unanswered question stops it, naming the flags. For a
first try, recommend Compose without integrations: a personal token is enough,
and the integrations need a public HTTPS URL (a tunnel).

With an integration, the webhooks need a tunnel that forwards to the control
plane: port 3000 on Compose (`ngrok http 3000`), or on kind the local port of
`bun run k8s:connect --target devbox.kind.json`, kept running in another
terminal. `--public-url <url>` passes the tunnel's URL to the setups. Without
it, Compose's setups ask for the URL; on kind the quickstart asks after
`k8s:kind`, and without a terminal it stops at the start unless
`--public-url` is given or `devbox.kind.json` already has one. A tunnel to the
kind port can only start after the first `k8s:kind`, so for a first kind run
from an agent, leave the integrations out and add them on a second run.

## 4. Run it

The user runs it (it may ask for secrets, hidden), for example:

```bash
bun run quickstart --compose --no-github-app --no-linear
```

It starts devbox (`bun run up` or `bun run k8s:kind`; the first build takes
about 10 minutes), runs each chosen integration's setup, then starts devbox
again to apply them. Every step is safe to re-run: after fixing a failure, run
the quickstart again.

## 5. First task

```bash
bun run devbox create "Add a /health endpoint to <owner>/<repo>"
bun run devbox logs -f <task>
```

On kind, `bun run k8s:connect --target devbox.kind.json` must be running in
another terminal for the CLI to reach the cluster. Next:
[using.md](using.md).

For a team, Linear is the recommended next step: anyone can delegate an issue
and follow it in Linear, without the CLI. Then the GitHub App, for a bot
identity and pull request `@mentions` ([integrations.md](integrations.md)).

## Without the quickstart

- Compose: `bun run up`. It does the secret lookup and the checks, builds the
  images, starts the stack and logs the CLI in (profile `local`).
- kind: `bun run k8s:kind` ([docs/kubernetes/kind.md](../../../docs/kubernetes/kind.md)).
- Then, if wanted, `bun run github:setup` / `bun run linear:setup`, and
  `bun run up` (or `k8s:kind`) again to apply.
