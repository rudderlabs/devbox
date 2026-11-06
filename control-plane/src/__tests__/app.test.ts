// createApp's wiring, end to end through HTTP and the test database: the API
// creates tasks through its own TaskService, and the task sources the API and
// the claim filter use are the registry's.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { sql } from "drizzle-orm";
import { parseApiConfig } from "../apiConfig";
import { parseSandboxRuntimeConfig } from "../sandboxConfig";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
const ENV = {
  API_ENABLED: "true",
  API_AUTH_ENABLED: "false",
  API_PUBLIC_BASE_URL: "https://devbox.example",
};
mock.module("../config", () => ({
  config: {
    databaseUrl: TEST_DATABASE_URL,
    podId: "pod-test",
    codeHost: { tokenSettings: { token: "test-token" }, trustedOrgs: [], trustedUsers: [] },
    opensandbox: { ...parseSandboxRuntimeConfig({}), domain: "localhost:1", forwardedEnv: {} },
    api: parseApiConfig(ENV),
  },
}));

const { createApp } = await import("../app");
const { db } = await import("../db");
const { definitions } = await import("../integrations");
const { parseIntegrationConfigs } = await import("../services/integrationRegistry");
const { migrate } = await import("drizzle-orm/bun-sql/migrator");

describe("createApp", () => {
  let bundle: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
    bundle = createApp(parseIntegrationConfigs(definitions, ENV));
  });
  afterAll(() => {
    bundle.stopApiStreams();
  });

  it("creates API tasks through the API's own TaskService", async () => {
    const res = await bundle.app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Add a health check" }),
    });
    expect(res.status).toBe(201);
    expect(await db.execute(sql`SELECT source FROM tasks`)).toEqual([{ source: "api" }]);
  });

  it("lists and claims the sources of the integrations that create tasks", async () => {
    const res = await bundle.app.request("/api/tasks?source=github");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_request", message: "source must be linear, api, or jira" },
    });
    // The claim filter (TaskProcessorService's own list).
    expect((bundle.taskProcessor as unknown as { taskSources: string[] }).taskSources).toEqual([
      "linear",
      "api",
      "jira",
    ]);
  });

  it("serves every integration's status, off ones included, and mounts no webhook while off", async () => {
    const none = { heldTasks: 0, oldestHoldAgeMs: 0 };
    const status = async (name: string) =>
      (await bundle.app.request(`/api/integrations/${name}`)).json();
    expect(await status("linear")).toEqual({ configured: false, holds: none });
    expect(await status("api")).toEqual({ enabled: true, holds: none });
    expect(await status("jira")).toEqual({ configured: false, holds: none });
    for (const name of ["linear", "github", "jira"]) {
      const res = await bundle.app.request(`/webhook/${name}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    }
  });
});
