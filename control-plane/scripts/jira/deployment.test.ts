import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConfigError } from "../up/cliLogin";
import { loadDeployment } from "./deployment";

const dir = mkdtempSync(join(tmpdir(), "devbox-jira-deployment-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let savedXdg: string | undefined;
beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(dir, "config-"));
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

const PUBLIC = "https://hooks.example.com";
const JIRA = {
  enabled: true,
  siteUrl: "https://example.atlassian.net",
  cloudId: "00000000-0000-0000-0000-000000000000",
  botEmail: "devbox@example.com",
  botAccountId: "712020:00000000-0000-0000-0000-000000000000",
  botName: "devbox",
  tokenExpiresAt: "2027-06-30",
};
const SETUP = {
  repos: [{ url: "https://github.com/example-org/example-repo.git" }],
  llm: { baseUrl: "https://llm.example.com/v1", model: "m1" },
};

let n = 0;
function file(content: unknown): string {
  const path = join(dir, `f${n++}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe("loadDeployment", () => {
  it("Compose: devbox.config.json holds integrations.jira", async () => {
    const configPath = file({
      ...SETUP,
      publicUrl: PUBLIC,
      integrations: { jira: JIRA, linear: { enabled: true, clientId: "c" } },
    });
    const { api, ...d } = loadDeployment({ configPath });
    expect(d).toEqual({
      deployment: { kind: "compose" },
      configPath,
      jira: JIRA,
      linear: true,
      publicUrl: PUBLIC,
      flag: "",
      applyCommand: "bun run up",
    });
    await expect(api("/api/integrations/jira")).rejects.toThrow(
      new CliConfigError('no CLI profile "local": run `bun run up` first'),
    );
  });

  it("k8s: the target file holds integrations.jira; the user's own Secret", () => {
    const path = file({
      context: "prod",
      publicUrl: PUBLIC,
      values: { secrets: { integrations: { existingSecret: "my-integrations" } } },
      integrations: { jira: { ...JIRA, enabled: false } },
    });
    const { api: _, ...d } = loadDeployment({ target: path });
    expect(d).toEqual({
      deployment: { kind: "k8s", context: "prod", namespace: "devbox" },
      configPath: path,
      jira: { ...JIRA, enabled: false },
      linear: false,
      publicUrl: PUBLIC,
      fromApiIngress: false,
      flag: ` --target ${path}`,
      applyCommand: `bun run k8s:install --target ${path}`,
      byoIntegrationsSecret: "my-integrations",
    });
  });
});
