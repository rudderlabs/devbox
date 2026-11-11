import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { pickForwardedEnv } from "../../../forwardedEnv";
import { parseClickUpConfig } from "../config";

// Synthetic values throughout.
const CLICKUP_ENV = {
  CLICKUP_ENABLED: "true",
  CLICKUP_TEAM_ID: "1234567",
  CLICKUP_BOT_USER_ID: "1000001",
  CLICKUP_BOT_NAME: "devbox",
  CLICKUP_API_TOKEN: "pk_test_token",
  CLICKUP_WEBHOOK_SECRET: "webhook-test-secret",
};

describe("parseClickUpConfig", () => {
  it("CLICKUP: off ignores its settings", () => {
    const { CLICKUP_ENABLED: _e, ...settings } = CLICKUP_ENV;
    expect(parseClickUpConfig(settings)).toBeUndefined();
    expect(parseClickUpConfig({ ...settings, CLICKUP_ENABLED: "" })).toBeUndefined();
    expect(parseClickUpConfig({ ...settings, CLICKUP_ENABLED: "false" })).toBeUndefined();
  });

  it("CLICKUP: an invalid switch value", () => {
    for (const v of ["True", "yes", "1"]) {
      expect(() => parseClickUpConfig({ ...CLICKUP_ENV, CLICKUP_ENABLED: v })).toThrow(
        new Error(`CLICKUP_ENABLED must be true or false, got "${v}"`),
      );
    }
  });

  it("CLICKUP: on with every setting", () => {
    expect(
      parseClickUpConfig({
        ...CLICKUP_ENV,
        CLICKUP_STATUS_STARTED: "in progress",
        CLICKUP_STATUS_DONE: " review ",
        CLICKUP_STATUS_FAILED: "blocked",
      }),
    ).toEqual({
      teamId: "1234567",
      botUserId: 1000001,
      botName: "devbox",
      statuses: { started: "in progress", done: "review", failed: "blocked" },
      apiToken: "pk_test_token",
      webhookSecret: "webhook-test-secret",
    });
  });

  it("CLICKUP: the statuses are optional", () => {
    expect(parseClickUpConfig(CLICKUP_ENV)?.statuses).toEqual({
      started: undefined,
      done: undefined,
      failed: undefined,
    });
  });

  it("CLICKUP: on with settings missing, the secrets included", () => {
    expect(() => parseClickUpConfig({ CLICKUP_ENABLED: "true" })).toThrow(
      new Error(
        "CLICKUP_ENABLED is true but these are missing: CLICKUP_TEAM_ID, CLICKUP_BOT_USER_ID, CLICKUP_BOT_NAME, CLICKUP_API_TOKEN, CLICKUP_WEBHOOK_SECRET",
      ),
    );
    const { CLICKUP_API_TOKEN: _t, CLICKUP_WEBHOOK_SECRET: _s, ...noSecrets } = CLICKUP_ENV;
    expect(() => parseClickUpConfig({ ...noSecrets, CLICKUP_API_TOKEN: " " })).toThrow(
      new Error(
        "CLICKUP_ENABLED is true but these are missing: CLICKUP_API_TOKEN, CLICKUP_WEBHOOK_SECRET",
      ),
    );
  });

  it.each([
    ["CLICKUP_TEAM_ID", "12a4", "CLICKUP_TEAM_ID must be digits only"],
    ["CLICKUP_TEAM_ID", "-1234", "CLICKUP_TEAM_ID must be digits only"],
    ["CLICKUP_TEAM_ID", "1234/../5", "CLICKUP_TEAM_ID must be digits only"],
    ["CLICKUP_BOT_USER_ID", "0", "CLICKUP_BOT_USER_ID must be a positive integer"],
    ["CLICKUP_BOT_USER_ID", "-5", "CLICKUP_BOT_USER_ID must be a positive integer"],
    ["CLICKUP_BOT_USER_ID", "1.5", "CLICKUP_BOT_USER_ID must be a positive integer"],
    ["CLICKUP_BOT_USER_ID", "0123", "CLICKUP_BOT_USER_ID must be a positive integer"],
    ["CLICKUP_BOT_USER_ID", "1".repeat(16), "CLICKUP_BOT_USER_ID must be a positive integer"],
    ["CLICKUP_BOT_USER_ID", "devbox", "CLICKUP_BOT_USER_ID must be a positive integer"],
  ])("CLICKUP: rejects %s=%p", (name, value, message) => {
    expect(() => parseClickUpConfig({ ...CLICKUP_ENV, [name]: value })).toThrow(new Error(message));
  });

  it("CLICKUP: an error never echoes a value", () => {
    let message = "";
    try {
      parseClickUpConfig({ ...CLICKUP_ENV, CLICKUP_BOT_USER_ID: "pk_test_token" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("CLICKUP_BOT_USER_ID must be a positive integer");
  });

  it("CLICKUP: no setting reaches a sandbox, secrets included", async () => {
    // Every CLICKUP_* name the parser reads.
    const source = await Bun.file(join(import.meta.dir, "../config.ts")).text();
    const names = [...new Set(source.match(/\bCLICKUP_[A-Z][A-Z_]*\b/g))];
    // A scan that finds nothing would pass vacuously.
    expect(names).toContain("CLICKUP_API_TOKEN");
    expect(names).toContain("CLICKUP_WEBHOOK_SECRET");
    expect(names).toContain("CLICKUP_STATUS_FAILED");
    expect(pickForwardedEnv(Object.fromEntries(names.map((name) => [name, "real"])))).toEqual({});
  });
});
