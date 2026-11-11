import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployment } from "./deployment";

const dir = mkdtempSync(join(tmpdir(), "devbox-clickup-deployment-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CLICKUP = { enabled: true, teamId: "9000000000", botUserId: 100000001, botName: "devbox" };

describe("loadDeployment", () => {
  it("Compose and k8s: the block is integrations.clickup, the rest as Jira's", () => {
    const configPath = join(dir, "devbox.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ url: "https://github.com/example-org/example-repo.git" }],
        llm: { baseUrl: "https://llm.example.com/v1", model: "m1" },
        integrations: { clickup: CLICKUP },
      }),
    );
    const { api: _, ...compose } = loadDeployment({ configPath });
    expect(compose).toEqual({
      deployment: { kind: "compose" },
      configPath,
      clickup: CLICKUP,
      integrations: { clickup: CLICKUP },
      flag: "",
      applyCommand: "bun run up",
    });

    const target = join(dir, "devbox.k8s.json");
    writeFileSync(
      target,
      JSON.stringify({
        context: "prod",
        integrations: { clickup: { ...CLICKUP, enabled: false } },
      }),
    );
    const k8s = loadDeployment({ target });
    expect(k8s.clickup).toEqual({ ...CLICKUP, enabled: false });
    expect(k8s.flag).toBe(` --target ${target}`);
    expect("jira" in k8s).toBe(false);
  });
});
