import { afterEach, describe, expect, it, mock } from "bun:test";

// Pin a complete-enough config before importing the real impl. Other test files
// mock.module("../../config") with partial shapes and on Linux those mocks leak
// across files in readdir order (oven-sh/bun#12823). Registering our own mock
// here makes this file immune to whatever ran before it. See
// control-plane/README.md (Conventions).
mock.module("../../config", () => ({
  config: { slack: { botToken: "xoxb-test-token" } },
}));

// Import a FRESH instance of ./slackApi, NOT the ../slack barrel or the cached
// ./slackApi. Service tests mock.module the ../slack barrel; bun's module mocks
// are process-global and leak across files on Linux. If an earlier file loaded
// the real barrel, mocking it later writes through its `export *` into the cached
// ./slackApi too. The query string gives this file its own module instance. See
// control-plane/README.md (Conventions).
const { lookupSlackUserIdByEmail, postSlackMessage } = await import(
  "../slackApi.ts" + "?slack-impl-test"
);

type Captured = { url: string; init: RequestInit };

// Build a fetch stub returning one Response, capturing the request.
function fetchReturning(resp: { ok: boolean; status: number; body: unknown }): {
  fn: typeof fetch;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured.push({ url: String(url), init: init ?? {} });
    const text = typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
    return Promise.resolve({
      ok: resp.ok,
      status: resp.status,
      text: () => Promise.resolve(text),
    } as unknown as Response);
  };
  return { fn: fn as unknown as typeof fetch, captured };
}

describe("postSlackMessage", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs chat.postMessage with a bearer token and thread_ts/text body", async () => {
    const { fn, captured } = fetchReturning({
      ok: true,
      status: 200,
      body: { ok: true, ts: "9.9" },
    });
    globalThis.fetch = fn;

    const out = await postSlackMessage({ channel: "C1", threadTs: "1699.0001", text: "hi" });

    expect(out).toEqual({ ts: "9.9" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-test-token");
    const body = JSON.parse(String(captured[0]?.init.body));
    expect(body).toEqual({ channel: "C1", thread_ts: "1699.0001", text: "hi" });
  });

  it("omits thread_ts when no thread is given", async () => {
    const { fn, captured } = fetchReturning({ ok: true, status: 200, body: { ok: true, ts: "1" } });
    globalThis.fetch = fn;

    await postSlackMessage({ channel: "C1", text: "hi" });
    const body = JSON.parse(String(captured[0]?.init.body));
    expect(body).toEqual({ channel: "C1", text: "hi" });
  });

  it("includes blocks only when provided", async () => {
    const { fn, captured } = fetchReturning({ ok: true, status: 200, body: { ok: true, ts: "1" } });
    globalThis.fetch = fn;

    await postSlackMessage({
      channel: "C1",
      threadTs: "t",
      text: "hi",
      blocks: [{ type: "section" }],
    });
    const body = JSON.parse(String(captured[0]?.init.body));
    expect(body.blocks).toEqual([{ type: "section" }]);
  });

  // Slack answers HTTP 200 even on a logical failure — the `ok` field is the
  // real status, so a not-ok body must throw (surfacing the `error`).
  it("throws on an HTTP-200 not-ok response, surfacing the Slack error code", async () => {
    const { fn } = fetchReturning({
      ok: true,
      status: 200,
      body: { ok: false, error: "channel_not_found" },
    });
    globalThis.fetch = fn;

    await expect(postSlackMessage({ channel: "bad", threadTs: "t", text: "hi" })).rejects.toThrow(
      "channel_not_found",
    );
  });

  it("throws on a non-2xx transport error", async () => {
    const { fn } = fetchReturning({ ok: false, status: 500, body: "upstream boom" });
    globalThis.fetch = fn;

    await expect(postSlackMessage({ channel: "C1", threadTs: "t", text: "hi" })).rejects.toThrow(
      "HTTP 500",
    );
  });

  it("never puts the token in the thrown error message", async () => {
    const { fn } = fetchReturning({
      ok: true,
      status: 200,
      body: { ok: false, error: "not_authed" },
    });
    globalThis.fetch = fn;

    const err = await postSlackMessage({ channel: "C1", threadTs: "t", text: "hi" }).catch(
      (e: Error) => e,
    );
    expect(String(err)).not.toContain("xoxb-test-token");
  });
});

describe("lookupSlackUserIdByEmail", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GETs users.lookupByEmail with the encoded email and returns the user id", async () => {
    const { fn, captured } = fetchReturning({
      ok: true,
      status: 200,
      body: { ok: true, user: { id: "U0ADA" } },
    });
    globalThis.fetch = fn;

    const out = await lookupSlackUserIdByEmail("ada+dev@acme.com");

    expect(out).toBe("U0ADA");
    expect(captured[0]?.url).toBe(
      "https://slack.com/api/users.lookupByEmail?email=ada%2Bdev%40acme.com",
    );
    expect(captured[0]?.init.method).toBe("GET");
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-test-token");
  });

  // Logical misses degrade to null — a mention falls back to a plain name,
  // never worth failing the message over.
  it("returns null on users_not_found", async () => {
    const { fn } = fetchReturning({
      ok: true,
      status: 200,
      body: { ok: false, error: "users_not_found" },
    });
    globalThis.fetch = fn;
    expect(await lookupSlackUserIdByEmail("ghost@acme.com")).toBeNull();
  });

  it("returns null when the bot lacks the users:read.email scope", async () => {
    const { fn } = fetchReturning({
      ok: true,
      status: 200,
      body: { ok: false, error: "missing_scope" },
    });
    globalThis.fetch = fn;
    expect(await lookupSlackUserIdByEmail("ada@acme.com")).toBeNull();
  });

  it("throws on a non-2xx transport error", async () => {
    const { fn } = fetchReturning({ ok: false, status: 500, body: "boom" });
    globalThis.fetch = fn;
    await expect(lookupSlackUserIdByEmail("ada@acme.com")).rejects.toThrow("HTTP 500");
  });
});
