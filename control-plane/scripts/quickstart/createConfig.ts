// Writes devbox.config.json from the user's answers when there is none: the
// repos (owner/name or a GitHub URL, each with its branch) and the LLM
// (provider, model, base URL). Every answer is checked with the parser `up`
// uses, and a refused one is asked again. No secret is asked here: `up` finds
// the GitHub token and the LLM key itself. An existing file is never touched.
import { writeFileSync } from "node:fs";
import { ConfigError, type Provider, parseConfig } from "../up/config";
import { bad, dim, good } from "./style";

export const LLM_DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-sol" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" },
};

export type CreateDeps = {
  // Asks with echo; empty at EOF.
  promptLine: (q: string) => Promise<string>;
  confirm: (q: string, opts: { defaultYes: boolean }) => Promise<boolean>;
  log: (line: string) => void;
};

type RepoEntry = { url: string; branch: string };
type LlmEntry = { provider: Provider; baseUrl: string; model: string };

// owner/name, or https://github.com/owner/name with or without .git or a
// trailing slash, as the URL the config takes; undefined for anything else.
export function repoUrl(answer: string): string | undefined {
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    answer.trim(),
  );
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : undefined;
}

// The parser's message for a config, or undefined when it is accepted.
function refusal(repos: RepoEntry[], llm: LlmEntry): string | undefined {
  try {
    parseConfig({ repos, llm });
    return undefined;
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
}

async function askRepos(deps: CreateDeps): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [];
  for (;;) {
    const answer = (
      await deps.promptLine(
        repos.length === 0
          ? "Repo the agent may work on (owner/name): "
          : "Another repo (owner/name, Enter when done): ",
      )
    ).trim();
    if (!answer) {
      if (repos.length > 0) return repos;
      deps.log(bad("At least one repo is needed."));
      continue;
    }
    const url = repoUrl(answer);
    if (!url) {
      deps.log(bad(`"${answer}" is not owner/name or https://github.com/owner/name`));
      continue;
    }
    const name = url.slice("https://github.com/".length, -".git".length);
    const branch = (await deps.promptLine(`Branch of ${name} ${dim("[main]")}: `)).trim() || "main";
    const entry = { url, branch };
    const why = refusal([...repos, entry], { provider: "openai", ...LLM_DEFAULTS.openai });
    if (why) {
      deps.log(bad(why));
      continue;
    }
    repos.push(entry);
  }
}

async function askLlm(repos: RepoEntry[], deps: CreateDeps): Promise<LlmEntry> {
  let provider: Provider | undefined;
  while (!provider) {
    const a = (await deps.promptLine(`LLM provider ${dim("[openai/anthropic] (openai)")}: `))
      .trim()
      .toLowerCase();
    if (a === "" || a === "openai") provider = "openai";
    else if (a === "anthropic") provider = "anthropic";
    else deps.log(bad('Answer "openai" or "anthropic".'));
  }
  const d = LLM_DEFAULTS[provider];
  for (;;) {
    const model = (await deps.promptLine(`Model ${dim(`[${d.model}]`)}: `)).trim() || d.model;
    const baseUrl =
      (await deps.promptLine(`Base URL ${dim(`[${d.baseUrl}]`)}: `)).trim() || d.baseUrl;
    const llm = { provider, baseUrl, model };
    const why = refusal(repos, llm);
    if (!why) return llm;
    deps.log(bad(why));
  }
}

// Asks and writes; false when the user would rather write it themselves.
export async function createConfig(path: string, deps: CreateDeps): Promise<boolean> {
  deps.log("devbox.config.json not found. It lists the repos the agent may work on and your LLM.");
  if (!(await deps.confirm(`Create it now? ${dim("[Y/n]")} `, { defaultYes: true }))) return false;
  const repos = await askRepos(deps);
  const llm = await askLlm(repos, deps);
  const text = `${JSON.stringify({ repos, llm }, null, 2)}\n`;
  writeFileSync(path, text);
  deps.log(
    `${good("✓")} Wrote ${path}. Edit it later for per-stage models and sandbox sizing (docs/configuration.md).`,
  );
  return true;
}
