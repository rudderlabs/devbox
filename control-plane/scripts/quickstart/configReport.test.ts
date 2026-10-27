import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigMissing, describeConfig, loadForQuickstart } from "./configReport";

const dir = mkdtempSync(join(tmpdir(), "devbox-quickstart-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LLM = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-sol" };
const EXAMPLE = join(import.meta.dir, "..", "..", "..", "devbox.config.example.json");

let n = 0;
function configFile(content: unknown): string {
  const path = join(dir, `c${n++}.json`);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("loadForQuickstart", () => {
  it("says what to fill when the file is missing", () => {
    expect(() => loadForQuickstart(join(dir, "none.json"), "compose")).toThrow(
      "devbox.config.json not found. List the repos the agent may work on under `repos`",
    );
  });

  it("passes the config error on, with where to read about it", () => {
    const path = configFile({ repos: [] });
    expect(() => loadForQuickstart(path, "compose")).toThrow(ConfigMissing);
    expect(() => loadForQuickstart(path, "compose")).toThrow(
      "devbox.config.json: repos: must be a non-empty list. List the repos",
    );
  });

  it("on kind, ignores the Compose-only blocks", () => {
    const path = configFile({
      repos: [{ url: "https://github.com/frodo/ring.git" }],
      llm: LLM,
      sandbox: { cpu: "not a quantity" },
    });
    expect(() => loadForQuickstart(path, "compose")).toThrow("sandbox.cpu");
    expect(loadForQuickstart(path, "kind").repos[0]?.name).toBe("ring");
  });
});

describe("describeConfig", () => {
  it("lists the repos and the LLM", () => {
    const path = configFile({
      repos: [
        { url: "https://github.com/frodo/ring.git" },
        { url: "https://github.com/frodo/shire.git", branch: "develop" },
      ],
      llm: LLM,
    });
    expect(describeConfig(loadForQuickstart(path, "compose"))).toEqual([
      "devbox.config.json: 2 repo(s)",
      "  frodo/ring (branch main)",
      "  frodo/shire (branch develop)",
      "  LLM: provider openai, model gpt-5.6-sol at https://api.openai.com/v1",
    ]);
  });

  it("refuses the example's placeholder repo", () => {
    const path = configFile(readFileSync(EXAMPLE, "utf8"));
    expect(() => describeConfig(loadForQuickstart(path, "compose"))).toThrow(
      "repos still has the example's your-org/your-repo: put your own repo there.",
    );
  });
});
