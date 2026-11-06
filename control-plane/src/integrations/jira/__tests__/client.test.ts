import { afterEach, describe, expect, it } from "bun:test";
import { HttpError, retryable } from "../../http";
import { RetryableError } from "../../outbound";
import type { AdfDoc } from "../adf";
import { jiraClient } from "../client";

const CLOUD_ID = "11111111-2222-4333-8444-555555555555";
const EMAIL = "devbox-bot@example.com";
const TOKEN = "jira-test-token";
const BASE = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3`;
const BASIC = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;

type Captured = { url: string; init: RequestInit };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Stubs fetch with one answer per call, capturing each request.
function stubFetch(...answers: Array<() => Response>): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    const answer = answers[captured.length - 1] ?? answers.at(-1);
    return Promise.resolve(answer ? answer() : new Response(null, { status: 204 }));
  }) as typeof fetch;
  return captured;
}

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers });

const client = () => jiraClient({ cloudId: CLOUD_ID, email: EMAIL, token: TOKEN });
const signal = () => new AbortController().signal;
const doc: AdfDoc = { type: "doc", version: 1, content: [] };

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("jiraClient: requests", () => {
  it("calls the API gateway with Basic auth and the caller's signal", async () => {
    const captured = stubFetch(
      json({ accountId: "5e0f1a2b3c4d5e6f7a8b9c0d", accountType: "app", displayName: "devbox" }),
    );
    const s = signal();
    expect(await client().myself(s)).toEqual({
      accountId: "5e0f1a2b3c4d5e6f7a8b9c0d",
      accountType: "app",
      displayName: "devbox",
    });
    expect(captured[0]?.url).toBe(`${BASE}/myself`);
    expect(captured[0]?.init.method).toBe("GET");
    expect(captured[0]?.init.signal).toBe(s);
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(BASIC);
    expect(headers.Accept).toBe("application/json");
  });

  it("refuses a myself answer with no account id", async () => {
    stubFetch(json({ displayName: "x" }));
    expect(String(await rejection(client().myself(signal())))).toContain("no accountId");
  });

  it("posts a comment as an ADF body", async () => {
    const captured = stubFetch(json({ id: "10077", body: doc }, 201));
    expect(await client().addComment("10042", doc, signal())).toEqual({ id: "10077" });
    expect(captured[0]?.url).toBe(`${BASE}/issue/10042/comment`);
    expect(captured[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(captured[0]?.init.body))).toEqual({ body: doc });
    const headers = captured[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("application/json");
  });

  it("reads an issue limited to the asked-for fields", async () => {
    const captured = stubFetch(
      json({ id: "10042", key: "DEMO-7", fields: { assignee: null, status: { name: "Done" } } }),
    );
    expect(await client().getIssue("10042", ["assignee", "status"], signal())).toEqual({
      id: "10042",
      key: "DEMO-7",
      fields: { assignee: null, status: { name: "Done" } },
    });
    expect(captured[0]?.url).toBe(`${BASE}/issue/10042?fields=assignee%2Cstatus`);
  });

  it("lists transitions and makes one", async () => {
    const captured = stubFetch(
      json({
        transitions: [
          { id: "21", name: "Start", to: { id: "3", name: "In Progress", statusCategory: {} } },
        ],
      }),
      () => new Response(null, { status: 204 }),
    );
    const c = client();
    expect(await c.transitions("10042", signal())).toEqual([
      { id: "21", name: "Start", to: { id: "3", name: "In Progress" } },
    ]);
    await c.transition("10042", "21", signal());
    expect(captured.map((r) => `${r.init.method} ${r.url}`)).toEqual([
      `GET ${BASE}/issue/10042/transitions`,
      `POST ${BASE}/issue/10042/transitions`,
    ]);
    expect(JSON.parse(String(captured[1]?.init.body))).toEqual({ transition: { id: "21" } });
  });

  it("upserts a remote link by its global id", async () => {
    const captured = stubFetch(json({ id: 10000, self: "x" }, 201));
    const pr = "https://github.com/example/repo/pull/1";
    await client().upsertRemoteLink("10042", { globalId: pr, url: pr, title: "PR #1" }, signal());
    expect(captured[0]?.url).toBe(`${BASE}/issue/10042/remotelink`);
    expect(JSON.parse(String(captured[0]?.init.body))).toEqual({
      globalId: pr,
      object: { url: pr, title: "PR #1" },
    });
  });

  it("reads which permissions the bot holds, without a project", async () => {
    const captured = stubFetch(
      json({
        permissions: {
          BROWSE_PROJECTS: { key: "BROWSE_PROJECTS", havePermission: true },
          ADD_COMMENTS: { key: "ADD_COMMENTS", havePermission: false },
        },
      }),
    );
    expect(
      await client().myPermissions(["BROWSE_PROJECTS", "ADD_COMMENTS", "LINK_ISSUES"], signal()),
    ).toEqual({ BROWSE_PROJECTS: true, ADD_COMMENTS: false, LINK_ISSUES: false });
    expect(captured[0]?.url).toBe(
      `${BASE}/mypermissions?permissions=BROWSE_PROJECTS%2CADD_COMMENTS%2CLINK_ISSUES`,
    );
  });

  it("refuses an issue or transition id that isn't numeric, before sending anything", async () => {
    const captured = stubFetch(json({}));
    const c = client();
    for (const bad of [
      "",
      "DEMO-7",
      "10042/../../myself",
      "10042?x=1",
      " 10042",
      "1e3",
      "010042",
    ]) {
      expect(await rejection(c.addComment(bad, doc, signal()))).toBeInstanceOf(Error);
      expect(await rejection(c.getIssue(bad, [], signal()))).toBeInstanceOf(Error);
      expect(await rejection(c.transition("10042", bad, signal()))).toBeInstanceOf(Error);
    }
    expect(captured).toHaveLength(0);
  });

  it("refuses a cloud id that isn't a UUID", () => {
    for (const cloudId of ["", "..", "../ex/jira/x", `${CLOUD_ID}/..`, "example"]) {
      expect(() => jiraClient({ cloudId, email: EMAIL, token: TOKEN })).toThrow("UUID");
    }
  });

  it("refuses a successful comment answer with no comment id", async () => {
    stubFetch(
      () => new Response(null, { status: 201 }),
      () => new Response("not json", { status: 201 }),
      json({ self: "x" }, 201),
    );
    const c = client();
    for (let i = 0; i < 3; i++) {
      expect(String(await rejection(c.addComment("10042", doc, signal())))).toContain(
        "no comment id",
      );
    }
  });
});

describe("jiraClient: errors", () => {
  it("turns a 429 into a retryable HttpError that honours Retry-After", async () => {
    stubFetch(json({ errorMessages: ["slow down"] }, 429, { "Retry-After": "30" }));
    const err = await rejection(client().addComment("10042", doc, signal()));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).retryAfterMs).toBe(30_000);
    const r = retryable(err);
    expect(r).toBeInstanceOf(RetryableError);
    expect(r?.retryAfterMs).toBe(30_000);
  });

  it("waits for the rate-limit reset, at least a minute, without Retry-After", async () => {
    const reset = new Date(Date.now() + 5 * 60_000).toISOString();
    stubFetch(json({}, 429, { "X-RateLimit-Reset": reset }), json({}, 429));
    const later = (await rejection(client().myself(signal()))) as HttpError;
    expect(later.retryAfterMs).toBeGreaterThan(4 * 60_000);
    const bare = (await rejection(client().myself(signal()))) as HttpError;
    expect(bare.retryAfterMs).toBeGreaterThanOrEqual(60_000);
  });

  it("does not retry a server error or a refusal", async () => {
    stubFetch(json({}, 500), json({ errorMessages: ["Issue does not exist"] }, 404));
    const c = client();
    const e500 = await rejection(c.myself(signal()));
    const e404 = await rejection(c.getIssue("10042", ["status"], signal()));
    expect((e500 as HttpError).status).toBe(500);
    expect((e404 as HttpError).status).toBe(404);
    expect(retryable(e500)).toBeUndefined();
    expect(retryable(e404)).toBeUndefined();
  });

  it("keeps the error message to method, path, status and a short snippet", async () => {
    stubFetch(json({ errorMessages: ["bad"], echo: "x".repeat(1000) }, 400));
    const err = (await rejection(client().addComment("10042", doc, signal()))) as HttpError;
    expect(err.message).toStartWith("Jira POST /issue/10042/comment failed: HTTP 400 ");
    expect(err.message.length).toBeLessThan(300);
    for (const secret of [TOKEN, EMAIL, BASIC.slice(6)]) expect(err.message).not.toContain(secret);
  });

  it("passes a connection failure through for the shared classification", async () => {
    const refused = Object.assign(new TypeError("Unable to connect"), { code: "ECONNREFUSED" });
    globalThis.fetch = (() => Promise.reject(refused)) as unknown as typeof fetch;
    const err = await rejection(client().myself(signal()));
    expect(err).toBe(refused);
    expect(retryable(err)).toBeInstanceOf(RetryableError);
  });

  it("shows no credentials when the client itself is logged", () => {
    const shown = `${JSON.stringify(client())} ${Bun.inspect(client())}`;
    for (const secret of [TOKEN, EMAIL, BASIC.slice(6)]) expect(shown).not.toContain(secret);
  });
});
