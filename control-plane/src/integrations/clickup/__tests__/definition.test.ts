import { afterAll, afterEach, expect, it, setSystemTime } from "bun:test";
import { Hono } from "hono";
import { sign } from "./fixtures";

const { clickup } = await import("..");
const { logger } = await import("../../../logger");

const ENV = {
  CLICKUP_ENABLED: "true",
  CLICKUP_TEAM_ID: "1234567",
  CLICKUP_BOT_USER_ID: "1000001",
  CLICKUP_BOT_NAME: "devbox",
  CLICKUP_API_TOKEN: "pk_test_token",
  CLICKUP_WEBHOOK_SECRET: "webhook-test-secret",
};

// The status's requests; nothing reaches ClickUp.
const realFetch = globalThis.fetch;
const requests: { url: string; auth: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
  const path = new URL(url).pathname;
  const json = (body: unknown) => new Response(JSON.stringify(body));
  if (path.endsWith("/user")) return json({ user: { id: 1000001, username: "devbox" } });
  if (path.endsWith("/team/1234567/webhook")) return json({ webhooks: [] });
  throw new Error(`unexpected request to ${url}`);
}) as typeof fetch;

afterEach(() => {
  setSystemTime();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

it("creates ClickUp from its settings: a webhook signed with its secret shows in its status", async () => {
  setSystemTime(new Date("2026-11-02T12:00:00Z"));
  const cfg = clickup.parseConfig(ENV);
  if (!cfg) throw new Error("ClickUp should be on");
  const integration = clickup.create({ tasks: {} as never, log: logger }, cfg);
  const app = new Hono().post("/webhook/clickup", (c) =>
    (integration.webhook as NonNullable<typeof integration.webhook>)(c),
  );
  const body = JSON.stringify({ event: "taskUpdated", task_id: "abc0001", history_items: [] });

  const res = await app.request("/webhook/clickup", {
    method: "POST",
    headers: { "x-signature": sign(body, "webhook-test-secret") },
    body,
  });

  expect(res.status).toBe(200);
  expect(await integration.status()).toEqual({
    configured: true,
    bot: { id: 1000001, name: "devbox" },
    team: "1234567",
    auth: "ok",
    lastWebhookAt: "2026-11-02T12:00:00.000Z",
    webhook: null,
    lastReplyFailure: null,
  });
  // ClickUp's v2 API, with the personal token as is.
  expect(requests.length).toBeGreaterThan(0);
  for (const r of requests) {
    expect(r.url).toStartWith("https://api.clickup.com/api/v2/");
    expect(r.auth).toBe("pk_test_token");
  }
});

it("creates tasks, and is off without CLICKUP_ENABLED and says so while off", () => {
  expect(clickup.name).toBe("clickup");
  expect(clickup.createsTasks).toBe(true);
  expect(clickup.parseConfig({})).toBeUndefined();
  expect(clickup.disabledStatus()).toEqual({ configured: false });
});
