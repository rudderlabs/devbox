# How DevBox compares

People ask how DevBox relates to Claude Code, Codex, Devin, Claude Managed
Agents and LangChain's Open SWE. This page answers each one the same way: a
short answer first, then the differences that matter when you pick a tool for
a team.

DevBox does not replace the coding tool at your keyboard. We use Claude Code
and Codex every day. DevBox is the shared harness the whole org hands tickets
to, running where your code and secrets already live.

Facts about other products come from their public docs, as checked on
November 18, 2026. The sources are listed under each tool's section below.
Prices change often, so this page links to pricing pages instead of quoting
them. If something here is out of date, open an issue or a pull request.

## DevBox in one table

Every comparison below uses this column. It comes from the
[README](../README.md) and the docs in this folder.

| | DevBox |
| --- | --- |
| Who it serves | The whole engineering org: one shared harness, many people hand it work |
| How work comes in | Linear, Jira Cloud, ClickUp or the CLI. On GitHub and GitLab, follow-ups on its own pull requests ([README](../README.md#not-in-v1)) |
| Where it runs | Your Docker Compose or Kubernetes, one sandbox per task |
| Who drives the steps | The harness: orient, plan, plan review, implement, self-review, draft PR |
| Models | OpenAI or Anthropic, model and reasoning effort set per stage ([configuration](configuration.md#llm)) |
| Memory | Learnings land in your repo as a commit on the pull request, reviewed like code |
| Secrets | Placeholder tokens in the sandbox; iron-proxy adds the real ones and allows writes only to your repos |
| Code hosts | GitHub and GitLab. No Bitbucket |
| License and price | MIT, free. You pay for your compute and model tokens |

What DevBox does not do yet is listed in [Not in v1](../README.md#not-in-v1):
no web UI, no stopping a task from Linear, Jira or ClickUp, and no new tasks
from GitHub issues.

## At a glance

A summary of the sections below, where each fact has its source.

| | DevBox | Claude Code | Codex | Devin | Claude Managed Agents | Open SWE |
| --- | --- | --- | --- | --- | --- | --- |
| What it is | Ticket-to-PR harness for a team | Coding agent for one developer | Coding agent for one developer | Hosted autonomous engineer | API to run an agent you define | Open source "software factory" |
| Work starts from | Linear, Jira, ClickUp, CLI | Developer session, `@claude` on GitHub (Actions) | Developer session, Linear issue | Slack, Teams, Linear, Jira, web app | Your code calls the API | Dashboard, GitHub, Slack, Linear |
| Agent runs on | Your infra | Local, or Anthropic cloud | Local, or OpenAI cloud | Cognition cloud | Anthropic (sandbox can be yours, beta) | As is, LangSmith's Managed Deep Agents |
| Models | OpenAI, Anthropic, per stage | Claude | OpenAI | OpenAI, Claude, Gemini, open source and more | Claude | Configurable |
| Source | MIT | Closed | CLI Apache-2.0, cloud closed | Closed | Closed | MIT (own code) |
| Price | Free; your compute and tokens | Claude plan or API | ChatGPT plan | Paid plans | Tokens + session runtime | Free; your runtime and tokens |

## DevBox vs Claude Code and Codex

**Short answer.** Use both. Claude Code and Codex are one developer's tool, at
the keyboard or in a cloud session that developer starts. DevBox is one shared
harness for the team, on your own infra: hand it a Linear, Jira or ClickUp
ticket and get a draft pull request.

**How they differ**

| | DevBox | Claude Code | Codex |
| --- | --- | --- | --- |
| Who starts work | Anyone on the team, from their tracker or the CLI | A developer's session; `@claude` on a GitHub issue or PR through GitHub Actions [1][2] | A developer's session; a Linear issue assigned to Codex [3] |
| Runs on | Your Docker Compose or Kubernetes | Local, or Anthropic-hosted cloud sessions [1] | Local, or OpenAI-hosted cloud tasks [3][4] |
| Models | OpenAI or Anthropic, per stage | Claude | OpenAI |
| Who drives the steps | The harness runs fixed stages, including a plan review before any code | The model | The model |
| Price | MIT, free. You pay compute and tokens | Claude plan or API usage | ChatGPT plan. The CLI is Apache-2.0 [4] |

**Worth knowing**

- Both now run in the cloud and keep git credentials out of the sandbox in
  their own ways [1]. The difference is not local versus cloud. It is who the
  tool is for and whose infra it runs on.
- DevBox reads the `AGENTS.md` and `CLAUDE.md` files your team already keeps,
  so the same instructions work for all three
  ([extending](extending.md#the-repos-the-agent-works-on)).

Sources: [1] [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web),
[2] [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions),
[3] [Codex in Linear](https://learn.chatgpt.com/docs/third-party/linear),
[4] [Codex repository](https://github.com/openai/codex).

## DevBox vs Devin

**Short answer.** Both take a ticket and return a pull request. Devin is a
hosted product from Cognition: polished, nothing to run, paid per plan. DevBox
is MIT code you run on your own infra with your own model keys, and every stage
is in the repo for you to read and change.

**How they differ**

| | DevBox | Devin |
| --- | --- | --- |
| Runs on | Your Docker Compose or Kubernetes | Cognition's cloud; a dedicated deployment option on Enterprise [1] |
| Source | MIT | Closed |
| Models | OpenAI or Anthropic, per stage | Frontier models from OpenAI, Anthropic, Google and others, plus open source models [1] |
| Work comes in from | Linear, Jira Cloud, ClickUp, CLI | Slack, Teams, Linear, Jira and more [1] |
| Code hosts | GitHub, GitLab | GitHub, GitLab, Bitbucket, custom git providers [1] |
| Price | Free. You pay compute and tokens | Individual and team plans, per seat for teams [1] |

**Where Devin is ahead.** A hosted UI, nothing to operate, more models, Slack
as a place to start work, and Bitbucket. DevBox has no web UI yet.

**Where DevBox fits better.** When code and credentials must stay on your
infra, when you want to read and change the pipeline, or when you would rather
pay for compute and tokens than seats.

Sources: [1] [Devin pricing and plans](https://devin.ai/pricing).

## DevBox vs Claude Managed Agents

**Short answer.** Different layers. Claude Managed Agents is an Anthropic API
for running a Claude agent you define yourself. DevBox is a finished
ticket-to-PR workflow that runs on your infra, and it can use Claude models.

**How they differ**

| | DevBox | Claude Managed Agents |
| --- | --- | --- |
| What it is | Ready ticket-to-PR harness | API to run an agent you define: model, prompt, tools, MCP servers, skills [1] |
| Agent loop runs at | Your infra | Anthropic, also when the sandbox is yours [2] |
| Sandbox | Yours, one per task | Anthropic's, or yours (beta) [2] |
| Models | OpenAI or Anthropic, per stage | Claude [1] |
| Status | v0.2.0 | Beta [1] |
| Price | Free. You pay compute and tokens | Tokens plus a fee per hour of session runtime [3] |

**Worth knowing**

- On Managed Agents you build the tracker integrations, the stages, pull
  request follow-ups and memory yourself. DevBox ships them.
- Anthropic also offers a self-hosted version of the whole Managed Agents
  service through sales [1][3].

Sources: [1] [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview),
[2] [Self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes),
[3] [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing).

## DevBox vs LangChain Open SWE

**Short answer.** Closest cousin: both are built on LangChain's
[Deep Agents](https://github.com/langchain-ai/deepagents), and we owe that
project a lot. Open SWE (now presented as Robin) is a broad framework whose
README says that deploying it as is needs LangSmith's Managed Deep Agents.
DevBox does one job, ticket to pull request, on your own Compose or
Kubernetes, with no real keys in the sandbox.

**How they differ**

| | DevBox | Open SWE |
| --- | --- | --- |
| Built on | Deep Agents | Deep Agents and LangGraph [1] |
| Scope | Ticket to PR, plus follow-ups on its pull requests | Coding tasks, PR review, CI babysitting, scheduled tasks, dashboard [1] |
| Work comes in from | Linear, Jira Cloud, ClickUp, CLI | Dashboard, GitHub issues and PRs, Slack, Linear [1] |
| Runs on | Your Docker Compose or Kubernetes | As is, Managed Deep Agents (hosted); otherwise fork and adapt to your runtime [1] |
| GitHub access in the sandbox | Placeholder tokens; the proxy adds real ones and allows writes only to your repos | Usually installation-wide GitHub App access [1] |
| Models | OpenAI or Anthropic, per stage | Configurable [1] |
| License | MIT | MIT for its own code [1] |
| Contributions | Open | Not accepting external contributions for now [1] |

Sources: [1] [Open SWE repository](https://github.com/langchain-ai/open-swe).
