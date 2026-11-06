import { afterEach, expect, it, mock, setSystemTime } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";

// The GitHub client reads config at import; its token comes from the env here.
mock.module("../../../config", () => ({ config: {} }));

const { github } = await import("..");
const { logger } = await import("../../../logger");

const ENV = {
  GITHUB_WEBHOOKS_ENABLED: "true",
  GITHUB_WEBHOOK_SECRET: "hook",
  GITHUB_BOT_LOGIN: "my-bot",
  GITHUB_BOT_USER_ID: "42",
  GITHUB_TRUSTED_USERS: "alice",
};

const created = (env: Record<string, string>) => {
  const cfg = github.parseConfig({ ...ENV, ...env });
  if (!cfg) throw new Error("GitHub should be on");
  return github.create({ tasks: {} as never, log: logger }, cfg);
};

afterEach(() => {
  setSystemTime();
});

it("creates GitHub from its settings: a webhook signed with its secret shows in its status", async () => {
  setSystemTime(new Date("2026-10-30T12:00:00Z"));
  const integration = created({ GITHUB_CI_RESULT_ENABLED: "true" });
  const app = new Hono().post("/webhook/github", (c) =>
    (integration.webhook as NonNullable<typeof integration.webhook>)(c),
  );
  const body = "{}";
  const signature = `sha256=${createHmac("sha256", "hook").update(body).digest("hex")}`;

  // A ping on no PR of the bot's: accepted and ignored, nothing fetched.
  const res = await app.request("/webhook/github", {
    method: "POST",
    headers: { "x-github-event": "ping", "x-hub-signature-256": signature },
    body,
  });

  expect(res.status).toBe(200);
  expect(await integration.status()).toEqual({
    token: expect.objectContaining({ source: "env" }),
    webhooks: { enabled: true, lastWebhookAt: "2026-10-30T12:00:00.000Z", ciResults: true },
  });
  expect(integration.prMentionLogin).toBe("my-bot");
});

it("reports CI results off and no webhook yet from its settings", async () => {
  expect(await created({ GITHUB_CI_RESULT_ENABLED: "false" }).status()).toEqual({
    token: expect.objectContaining({ source: "env" }),
    webhooks: { enabled: true, lastWebhookAt: null, ciResults: false },
  });
});

it("creates no tasks and says so while off", () => {
  expect(github.createsTasks).toBe(false);
  expect(github.parseConfig({})).toBeUndefined();
  expect(github.disabledStatus()).toEqual({
    token: expect.objectContaining({ source: "env" }),
    webhooks: { enabled: false, lastWebhookAt: null, ciResults: false },
  });
});
