import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConfigError } from "../up/cliLogin";
import { loadDeployment } from "./deployment";

const dir = mkdtempSync(join(tmpdir(), "devbox-github-deployment-"));
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
const APP = {
  enabled: true,
  appId: 123,
  slug: "example-devbox",
  installationId: 7,
  botUserId: 1234567,
  tokens: "devbox" as const,
};
const REPO = {
  url: "https://github.com/example-org/example-repo.git",
  branch: "main",
  owner: "example-org",
  name: "example-repo",
};

let n = 0;
function file(content: unknown): string {
  const path = join(dir, `f${n++}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const SETUP = {
  repos: [{ url: REPO.url }],
  llm: { baseUrl: "https://llm.example.com/v1", model: "m1" },
};

describe("loadDeployment", () => {
  it("Compose: devbox.config.json holds the App, the trust lists and the repos", async () => {
    const configPath = file({
      ...SETUP,
      publicUrl: PUBLIC,
      github: { trustedOrgs: ["example-org"] },
      integrations: { githubApp: APP, linear: { enabled: true, clientId: "c" } },
    });
    const { api, ...d } = loadDeployment({ noKeychain: true, configPath });
    expect(d).toEqual({
      deployment: { kind: "compose" },
      configPath,
      githubApp: { ...APP, tokenScope: "repos", ciResults: true },
      linear: true,
      repos: [REPO],
      trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
      publicUrl: PUBLIC,
      applyCommand: "bun run up",
      statusCommand: "bun run github:status",
    });
    await expect(api("/api/integrations/github")).rejects.toThrow(
      new CliConfigError('no CLI profile "local": run `bun run up` first'),
    );
  });

  it("Compose without an App or Linear", () => {
    const configPath = file(SETUP);
    const { api: _, ...d } = loadDeployment({ noKeychain: true, configPath });
    expect(d).toEqual({
      deployment: { kind: "compose" },
      configPath,
      githubApp: undefined,
      linear: false,
      repos: [REPO],
      trust: { trustedOrgs: [], trustedUsers: [] },
      applyCommand: "bun run up",
      statusCommand: "bun run github:status",
    });
  });

  it("k8s: the target file holds the App and the trust lists; the user's own Secrets", async () => {
    const configPath = file(SETUP);
    const path = file({
      context: "prod",
      profile: "k8s-prod",
      publicUrl: PUBLIC,
      values: {
        github: { trustedUsers: ["example-user"] },
        secrets: {
          github: { existingSecret: "my-token" },
          githubApp: { existingSecret: "my-app-key" },
          integrations: { existingSecret: "my-integrations" },
        },
      },
      integrations: { githubApp: { enabled: false, appId: 123, slug: "example-devbox" } },
    });
    const { api, ...d } = loadDeployment({ target: path, noKeychain: true, configPath });
    expect(d).toEqual({
      deployment: { kind: "k8s", context: "prod", namespace: "devbox" },
      configPath: path,
      githubApp: {
        enabled: false,
        appId: 123,
        slug: "example-devbox",
        tokenScope: "repos",
        ciResults: true,
      },
      linear: false,
      repos: [REPO],
      trust: { trustedOrgs: [], trustedUsers: ["example-user"] },
      publicUrl: PUBLIC,
      fromApiIngress: false,
      applyCommand: `bun run k8s:install --target ${path}`,
      statusCommand: `bun run github:status --target ${path}`,
      byoGithubSecret: "my-token",
      byoKeySecret: "my-app-key",
      byoIntegrationsSecret: "my-integrations",
    });
    await expect(api("/api/integrations/github")).rejects.toThrow(
      new CliConfigError(
        `no CLI profile "k8s-prod": run \`bun run k8s:install --target ${path}\` first`,
      ),
    );
  });

  it("k8s: an Ingress gives the URL", () => {
    const configPath = file(SETUP);
    const path = file({
      context: "kind-devbox",
      values: { ingress: { webhooks: { enabled: true, host: "hooks.example.com", tls: [{}] } } },
    });
    const { api: _, ...d } = loadDeployment({ target: path, noKeychain: true, configPath });
    expect(d).toEqual({
      deployment: { kind: "k8s", context: "kind-devbox", namespace: "devbox" },
      configPath: path,
      githubApp: undefined,
      linear: false,
      repos: [REPO],
      trust: { trustedOrgs: [], trustedUsers: [] },
      ingressUrl: PUBLIC,
      fromApiIngress: false,
      applyCommand: "bun run k8s:kind",
      statusCommand: `bun run github:status --target ${path}`,
    });
  });
});
