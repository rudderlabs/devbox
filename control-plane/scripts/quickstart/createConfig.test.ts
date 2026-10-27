import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../up/config";
import { type CreateDeps, createConfig, repoUrl } from "./createConfig";

const dir = mkdtempSync(join(tmpdir(), "devbox-quickstart-create-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const nextPath = () => join(dir, `c${n++}.json`);

// Answers in order: strings for promptLine, booleans (or "" for Enter) for
// confirm.
function world(answers: (string | boolean)[]) {
  const asked: string[] = [];
  const log: string[] = [];
  const next = (q: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new Error(`unexpected question: ${q}`);
    return a;
  };
  const deps: CreateDeps = {
    promptLine: async (q) => String(next(q)),
    confirm: async (q, { defaultYes }) => {
      const a = next(q);
      return a === "" ? defaultYes : a === true;
    },
    log: (l) => void log.push(l),
  };
  return { deps, asked, log };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("repoUrl", () => {
  it("takes owner/name and GitHub URLs", () => {
    const url = "https://github.com/frodo/ring.git";
    expect(repoUrl("frodo/ring")).toBe(url);
    expect(repoUrl(" https://github.com/frodo/ring ")).toBe(url);
    expect(repoUrl("https://github.com/frodo/ring.git")).toBe(url);
    expect(repoUrl("https://github.com/frodo/ring/")).toBe(url);
    expect(repoUrl("frodo/ring.js")).toBe("https://github.com/frodo/ring.js.git");
  });

  it("refuses anything else", () => {
    expect(repoUrl("ring")).toBeUndefined();
    expect(repoUrl("https://gitlab.com/frodo/ring")).toBeUndefined();
    expect(repoUrl("git@github.com:frodo/ring.git")).toBeUndefined();
    expect(repoUrl("frodo/ring/tree/main")).toBeUndefined();
  });
});

describe("createConfig", () => {
  it("writes the defaults with Enter on every question but the repo", async () => {
    const path = nextPath();
    const w = world(["", "frodo/ring", "", "", "", "", ""]);
    expect(await createConfig(path, w.deps)).toBe(true);
    expect(w.asked).toEqual([
      "Create it now? [Y/n] ",
      "Repo the agent may work on (owner/name): ",
      "Branch of frodo/ring [main]: ",
      "Another repo (owner/name, Enter when done): ",
      "LLM provider [openai/anthropic] (openai): ",
      "Model [gpt-5.6-sol]: ",
      "Base URL [https://api.openai.com/v1]: ",
    ]);
    expect(readJson(path)).toEqual({
      repos: [{ url: "https://github.com/frodo/ring.git", branch: "main" }],
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-sol" },
    });
    // What it writes, `up` accepts.
    expect(loadConfig(path).repos).toHaveLength(1);
  });

  it("takes several repos and Anthropic's defaults", async () => {
    const path = nextPath();
    const w = world([
      true,
      "frodo/ring",
      "develop",
      "https://github.com/frodo/shire",
      "",
      "",
      "anthropic",
      "",
      "",
    ]);
    await createConfig(path, w.deps);
    expect(readJson(path)).toEqual({
      repos: [
        { url: "https://github.com/frodo/ring.git", branch: "develop" },
        { url: "https://github.com/frodo/shire.git", branch: "main" },
      ],
      llm: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-opus-5-5",
      },
    });
  });

  it("asks again after an answer the parser refuses", async () => {
    const path = nextPath();
    const w = world([
      "",
      "", // no repo yet
      "ring", // not owner/name
      "frodo/ring",
      "",
      "samwise/ring", // same name as frodo/ring
      "",
      "",
      "gemini", // unknown provider
      "anthropic",
      "",
      "https://api.anthropic.com/v1", // anthropic takes no /v1
      "",
      "",
    ]);
    await createConfig(path, w.deps);
    expect(w.log).toEqual([
      "devbox.config.json not found. It lists the repos the agent may work on and your LLM.",
      "At least one repo is needed.",
      '"ring" is not owner/name or https://github.com/owner/name',
      'devbox.config.json: repos[1].url: another repo is also named "ring" (each repo is cloned to /workspace/<repo>)',
      'Answer "openai" or "anthropic".',
      'devbox.config.json: llm.baseUrl: for provider "anthropic" use the API root without /v1, for example https://api.anthropic.com',
      `✓ Wrote ${path}. Edit it later for per-stage models and sandbox sizing (docs/configuration.md).`,
    ]);
    expect((readJson(path) as { repos: unknown[] }).repos).toHaveLength(1);
  });

  it("writes nothing when the user says no", async () => {
    const path = nextPath();
    expect(await createConfig(path, world([false]).deps)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});
