// What devbox.config.json holds, for the quickstart. It never changes the
// file (quickstart/createConfig.ts writes one only where there is none). It
// says what is there, or what is missing and where to read about it.
import { existsSync } from "node:fs";
import { llmSummary } from "../up";
import { ConfigError, type DevboxConfig, loadConfig } from "../up/config";
import type { Platform } from "./choices";
import { bold, dim } from "./style";

export class ConfigMissing extends Error {}

const HOW =
  "List the repos the agent may work on under `repos` and your LLM endpoint under `llm`; " +
  "devbox.config.example.json is a start and docs/configuration.md describes every field.";

// The example's placeholders, which pass validation but name no real repo.
const PLACEHOLDER_OWNER = "your-org";
const PLACEHOLDER_REPO = "your-repo";

// Loads the config as the platform reads it: kind skips the Compose-only
// blocks (its integrations are in devbox.kind.json).
export function loadForQuickstart(path: string, platform: Platform): DevboxConfig {
  if (!existsSync(path)) {
    throw new ConfigMissing(`devbox.config.json not found. ${HOW}`);
  }
  try {
    return platform === "kind" ? loadConfig(path, { integrations: false }) : loadConfig(path);
  } catch (err) {
    if (err instanceof ConfigError) throw new ConfigMissing(`${err.message}. ${HOW}`);
    throw err;
  }
}

// The lines to print; throws ConfigMissing when a repo is still the example's.
export function describeConfig(cfg: DevboxConfig): string[] {
  const placeholder = cfg.repos.find(
    (r) => r.owner === PLACEHOLDER_OWNER || r.name === PLACEHOLDER_REPO,
  );
  if (placeholder) {
    throw new ConfigMissing(
      `devbox.config.json: repos still has the example's ${placeholder.owner}/${placeholder.name}: put your own repo there. ${HOW}`,
    );
  }
  return [
    `devbox.config.json: ${cfg.repos.length} repo(s)`,
    ...cfg.repos.map((r) => `  ${bold(`${r.owner}/${r.name}`)} ${dim(`(branch ${r.branch})`)}`),
    `  ${dim("LLM:")} ${llmSummary(cfg.llm)}`,
  ];
}
