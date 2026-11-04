import { afterAll, afterEach, expect, it, mock, setSystemTime } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";

// The GitHub client (for assignees) reads config at import.
mock.module("../../../config", () => ({ config: {} }));

const { linear } = await import("..");
const { logger } = await import("../../../logger");

// The token and identity requests behind the status; nothing reaches Linear.
const realFetch = globalThis.fetch;
const tokenRequests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  if (url.endsWith("/oauth/token")) {
    tokenRequests.push(String(init?.body));
    return json({ access_token: "tok", expires_in: 30 * 86400, token_type: "Bearer" });
  }
  if (url.endsWith("/graphql")) {
    return json({
      data: {
        viewer: { id: "u1", name: "Bot" },
        organization: { id: "o1", name: "Org", urlKey: "org" },
      },
    });
  }
  throw new Error(`unexpected request to ${url}`);
}) as typeof fetch;

afterEach(() => {
  setSystemTime();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

it("creates Linear from its settings: a webhook signed with its secret shows in its status", async () => {
  setSystemTime(new Date("2026-10-30T12:00:00Z"));
  const cfg = linear.parseConfig({
    LINEAR_ENABLED: "true",
    LINEAR_CLIENT_ID: "cid",
    LINEAR_CLIENT_SECRET: "csecret",
    LINEAR_WEBHOOK_SECRET: "wsecret",
  });
  if (!cfg) throw new Error("Linear should be on");
  const integration = linear.create({ tasks: {} as never, log: logger }, cfg);
  const app = new Hono().post("/webhook/linear", (c) =>
    (integration.webhook as NonNullable<typeof integration.webhook>)(c),
  );
  const body = JSON.stringify({ type: "Unrelated" });
  const signature = createHmac("sha256", "wsecret").update(body).digest("hex");

  const res = await app.request("/webhook/linear", {
    method: "POST",
    headers: { "linear-signature": signature },
    body,
  });

  expect(res.status).toBe(200);
  expect(await integration.status()).toEqual({
    configured: true,
    workspace: { id: "o1", name: "Org", urlKey: "org" },
    appUser: { id: "u1", name: "Bot" },
    lastWebhookAt: "2026-10-30T12:00:00.000Z",
    lastTokenError: null,
  });
  expect(tokenRequests).toHaveLength(1);
  const form = new URLSearchParams(tokenRequests[0]);
  expect([form.get("client_id"), form.get("client_secret")]).toEqual(["cid", "csecret"]);
});

it("is off without LINEAR_ENABLED and says so while off", () => {
  expect(linear.parseConfig({})).toBeUndefined();
  expect(linear.disabledStatus()).toEqual({ configured: false });
});
