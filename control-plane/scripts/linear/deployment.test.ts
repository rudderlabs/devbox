import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConfigError } from "../up/cliLogin";
import { loadDeployment } from "./deployment";

const dir = mkdtempSync(join(tmpdir(), "devbox-linear-deployment-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// No CLI profiles: an empty config directory.
let savedXdg: string | undefined;
beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(dir, "config-"));
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

const LINEAR = { enabled: true, clientId: "client-1" };
const PUBLIC = "https://hooks.example.com";

let n = 0;
function targetFile(content: unknown): string {
  const path = join(dir, `t${n++}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe("loadDeployment on k8s", () => {
  it("kind's target file: applied with k8s:kind", async () => {
    const path = targetFile({
      context: "kind-devbox",
      profile: "k8s-kind-devbox",
      publicUrl: PUBLIC,
      values: {},
      integrations: { linear: LINEAR },
    });
    const { api, ...d } = loadDeployment({ target: path, noKeychain: true });
    expect(d).toEqual({
      deployment: { kind: "k8s", context: "kind-devbox", namespace: "devbox" },
      configPath: path,
      linear: LINEAR,
      publicUrl: PUBLIC,
      fromApiIngress: false,
      applyCommand: "bun run k8s:kind",
      statusCommand: `bun run linear:status --target ${path}`,
    });
    await expect(api("/api/integrations/linear")).rejects.toThrow(
      new CliConfigError('no CLI profile "k8s-kind-devbox": run `bun run k8s:kind` first'),
    );
  });

  it("an enabled GitHub App carries its slug, token mode and owning organization", () => {
    const path = targetFile({
      context: "kind-devbox",
      profile: "k8s-kind-devbox",
      publicUrl: PUBLIC,
      values: {},
      integrations: {
        githubApp: {
          enabled: true,
          appId: 123,
          slug: "example-devbox",
          installationId: 7,
          botUserId: 9,
          tokens: "devbox",
          org: "example-org",
        },
      },
    });
    const d = loadDeployment({ target: path, noKeychain: true });
    expect(d.githubApp).toEqual({ tokens: "devbox", slug: "example-devbox", org: "example-org" });
  });

  it("any other target file: applied with k8s:install --target", async () => {
    const path = targetFile({
      context: "prod",
      profile: "k8s-prod",
      publicUrl: PUBLIC,
      values: {},
      integrations: { linear: LINEAR },
    });
    const { api, ...d } = loadDeployment({ target: path, noKeychain: true });
    expect(d).toEqual({
      deployment: { kind: "k8s", context: "prod", namespace: "devbox" },
      configPath: path,
      linear: LINEAR,
      publicUrl: PUBLIC,
      fromApiIngress: false,
      applyCommand: `bun run k8s:install --target ${path}`,
      statusCommand: `bun run linear:status --target ${path}`,
    });
    await expect(api("/api/integrations/linear")).rejects.toThrow(
      new CliConfigError(
        `no CLI profile "k8s-prod": run \`bun run k8s:install --target ${path}\` first`,
      ),
    );
  });
});
