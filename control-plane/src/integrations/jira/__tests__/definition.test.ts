import { afterAll, afterEach, expect, it, setSystemTime } from "bun:test";
import { Hono } from "hono";
import { sign } from "./fixtures";

const { jira } = await import("..");
const { logger } = await import("../../../logger");

const ENV = {
  JIRA_ENABLED: "true",
  JIRA_SITE_URL: "https://example.atlassian.net",
  JIRA_CLOUD_ID: "11111111-2222-4333-8444-555555555555",
  JIRA_BOT_EMAIL: "devbox-bot@example.com",
  JIRA_BOT_ACCOUNT_ID: "acct-123",
  JIRA_BOT_NAME: "devbox",
  JIRA_PROJECT_KEYS: "ENG",
  JIRA_TRUSTED_USERS: "acct-456",
  JIRA_TOKEN_EXPIRES_AT: "2027-06-30",
  JIRA_API_TOKEN: "jira-test-token",
  JIRA_WEBHOOK_SECRET: "webhook-test-secret",
};

// The status's requests; nothing reaches Jira.
const realFetch = globalThis.fetch;
const requests: { url: string; auth: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
  const path = new URL(url).pathname;
  const json = (body: unknown) => new Response(JSON.stringify(body));
  if (path.endsWith("/myself")) return json({ accountId: "acct-123", accountType: "app" });
  if (path.endsWith("/mypermissions")) {
    const asked = new URL(url).searchParams.get("permissions")?.split(",") ?? [];
    return json({
      permissions: Object.fromEntries(asked.map((p) => [p, { havePermission: true }])),
    });
  }
  if (path.endsWith("/statuses")) return json([]);
  throw new Error(`unexpected request to ${url}`);
}) as typeof fetch;

afterEach(() => {
  setSystemTime();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

it("creates Jira from its settings: a webhook signed with its secret shows in its status", async () => {
  setSystemTime(new Date("2026-11-02T12:00:00Z"));
  const cfg = jira.parseConfig(ENV);
  if (!cfg) throw new Error("Jira should be on");
  const integration = jira.create({ tasks: {} as never, log: logger }, cfg);
  const app = new Hono().post("/webhook/jira", (c) =>
    (integration.webhook as NonNullable<typeof integration.webhook>)(c),
  );
  const body = JSON.stringify({ webhookEvent: "jira:issue_deleted" });

  const res = await app.request("/webhook/jira", {
    method: "POST",
    headers: { "x-hub-signature": sign(body, "webhook-test-secret") },
    body,
  });

  expect(res.status).toBe(200);
  expect(await integration.status()).toEqual({
    configured: true,
    lastWebhookAt: "2026-11-02T12:00:00.000Z",
    bot: { accountId: "acct-123", name: "devbox" },
    auth: "ok",
    tokenDaysLeft: 239,
    trust: { source: "users", cachedAccounts: 0 },
    projects: { ENG: { missingPermissions: [], missingStatuses: [] } },
    lastReplyFailure: null,
  });
  // Through Atlassian's gateway for the site's cloud id, with Basic email:token.
  const basic = `Basic ${Buffer.from("devbox-bot@example.com:jira-test-token").toString("base64")}`;
  expect(requests.length).toBeGreaterThan(0);
  for (const r of requests) {
    expect(r.url).toStartWith(
      "https://api.atlassian.com/ex/jira/11111111-2222-4333-8444-555555555555/rest/api/3/",
    );
    expect(r.auth).toBe(basic);
  }
});

it("creates tasks, and is off without JIRA_ENABLED and says so while off", () => {
  expect(jira.name).toBe("jira");
  expect(jira.createsTasks).toBe(true);
  expect(jira.parseConfig({})).toBeUndefined();
  expect(jira.disabledStatus()).toEqual({ configured: false });
});
