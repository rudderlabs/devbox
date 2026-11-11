import { afterEach, describe, expect, it } from "bun:test";
import { HttpError, retryable } from "../../http";
import { RetryableError } from "../../outbound";
import { clickUpClient } from "../client";

const TOKEN = "pk_test_token";
const BASE = "https://api.clickup.com/api/v2";

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
    return Promise.resolve(answer ? answer() : new Response("{}"));
  }) as typeof fetch;
  return captured;
}

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers });

const client = () => clickUpClient({ token: TOKEN });
const signal = () => new AbortController().signal;
const request = (c: Captured | undefined) => `${c?.init.method} ${c?.url}`;
const sentBody = (c: Captured | undefined) => JSON.parse(String(c?.init.body));

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("clickUpClient: requests", () => {
  it("reads the token's user with the token as is and the caller's signal", async () => {
    const captured = stubFetch(json({ user: { id: 1000001, username: "devbox", email: "x" } }));
    const s = signal();
    expect(await client().user(s)).toEqual({ id: 1000001, username: "devbox" });
    expect(request(captured[0])).toBe(`GET ${BASE}/user`);
    expect(captured[0]?.init.signal).toBe(s);
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(TOKEN);
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("refuses a user answer with no id", async () => {
    stubFetch(json({ user: { username: "x" } }));
    expect(String(await rejection(client().user(signal())))).toContain("no user id");
  });

  it("reads the workspace's members and their roles", async () => {
    const captured = stubFetch(
      json({
        teams: [
          { id: "7654321", members: [{ user: { id: 1, role: 1 } }] },
          {
            id: "1234567",
            members: [
              { user: { id: 1000002, username: "a", role: 3 } },
              { user: { id: 1000004, role: 4 } },
              { user: { id: 1000006 } },
              { user: { username: "no id" } },
              { invited_by: {} },
            ],
          },
        ],
      }),
    );
    expect(await client().members("1234567", signal())).toEqual([
      { id: 1000002, role: 3 },
      { id: 1000004, role: 4 },
      { id: 1000006, role: null },
    ]);
    expect(request(captured[0])).toBe(`GET ${BASE}/team`);
  });

  it("refuses a workspace the token can't see", async () => {
    stubFetch(json({ teams: [{ id: "7654321", members: [] }] }));
    expect(String(await rejection(client().members("1234567", signal())))).toContain(
      "isn't among the token's",
    );
  });

  it("reads a task with its description as Markdown", async () => {
    const captured = stubFetch(
      json({
        id: "abc0001",
        name: "Fix the login page",
        markdown_description: "The **button**",
        description: "The button",
        creator: { id: 1000003, username: "x", email: "x@example.com" },
        assignees: [{ id: 1000001 }, { id: "1000002" }, { username: "no id" }],
        status: { status: "to do", type: "open" },
        list: { id: "7000001", name: "List" },
        team_id: "1234567",
      }),
    );
    expect(await client().task("abc0001", signal())).toEqual({
      id: "abc0001",
      name: "Fix the login page",
      markdownDescription: "The **button**",
      creatorId: 1000003,
      assigneeIds: [1000001, 1000002],
      status: "to do",
      listId: "7000001",
      teamId: "1234567",
    });
    expect(request(captured[0])).toBe(`GET ${BASE}/task/abc0001?include_markdown_description=true`);
  });

  it("reads a task's numeric ids and missing fields without throwing", async () => {
    stubFetch(json({ list: { id: 7000001 }, team_id: 1234567 }));
    expect(await client().task("abc0001", signal())).toEqual({
      id: "",
      name: "",
      markdownDescription: "",
      creatorId: null,
      assigneeIds: [],
      status: "",
      listId: "7000001",
      teamId: "1234567",
    });
  });

  it("posts a comment as rich-text parts, notifying no one", async () => {
    const captured = stubFetch(json({ id: 90000001, hist_id: "x", date: 1 }));
    const parts = [
      { text: "hi", attributes: { bold: true } },
      { text: "\n", attributes: {} },
    ];
    expect(await client().addComment("abc0001", parts, signal())).toEqual({ id: "90000001" });
    expect(request(captured[0])).toBe(`POST ${BASE}/task/abc0001/comment`);
    expect(sentBody(captured[0])).toEqual({ comment: parts, notify_all: false });
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("refuses a successful comment answer with no comment id", async () => {
    stubFetch(
      () => new Response(null),
      () => new Response("not json"),
      json({ id: "" }),
    );
    const c = client();
    for (let i = 0; i < 3; i++) {
      expect(String(await rejection(c.addComment("abc0001", [], signal())))).toContain(
        "no comment id",
      );
    }
  });

  it("sets a task's status, and reads a list's statuses", async () => {
    const captured = stubFetch(
      json({}),
      json({ statuses: [{ status: "to do" }, { status: "in progress" }, { color: "x" }] }),
    );
    const c = client();
    await c.setStatus("abc0001", "in progress", signal());
    expect(await c.listStatuses("7000001", signal())).toEqual(["to do", "in progress"]);
    expect(captured.map(request)).toEqual([`PUT ${BASE}/task/abc0001`, `GET ${BASE}/list/7000001`]);
    expect(sentBody(captured[0])).toEqual({ status: "in progress" });
  });

  it("lists the team's webhooks without their secrets", async () => {
    const captured = stubFetch(
      json({
        webhooks: [
          {
            id: "00000000-0000-4000-8000-000000000000",
            userid: 1000001,
            team_id: 1234567,
            endpoint: "https://devbox.example.com/webhook/clickup",
            client_id: "x",
            events: ["taskAssigneeUpdated", "taskCommentPosted"],
            health: { status: "failing", fail_count: 5 },
            secret: "listed-webhook-secret",
          },
          { id: "w2" },
        ],
      }),
    );
    const hooks = await client().webhooks("1234567", signal());
    expect(hooks).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000000",
        endpoint: "https://devbox.example.com/webhook/clickup",
        health: { status: "failing", failCount: 5 },
      },
      { id: "w2", endpoint: "", health: { status: "", failCount: 0 } },
    ]);
    expect(JSON.stringify(hooks)).not.toContain("listed-webhook-secret");
    expect(request(captured[0])).toBe(`GET ${BASE}/team/1234567/webhook`);
  });

  it("refuses an id that could change the path, before sending anything", async () => {
    const captured = stubFetch(json({}));
    const c = client();
    for (const bad of ["", "ABC", "abc/../user", "abc?x=1", " abc", "abc#", "a".repeat(33)]) {
      expect(await rejection(c.task(bad, signal()))).toBeInstanceOf(Error);
      expect(await rejection(c.addComment(bad, [], signal()))).toBeInstanceOf(Error);
      expect(await rejection(c.setStatus(bad, "x", signal()))).toBeInstanceOf(Error);
    }
    for (const bad of ["", "12a", "1/../2", "-1"]) {
      expect(await rejection(c.listStatuses(bad, signal()))).toBeInstanceOf(Error);
      expect(await rejection(c.webhooks(bad, signal()))).toBeInstanceOf(Error);
      expect(await rejection(c.members(bad, signal()))).toBeInstanceOf(Error);
    }
    expect(captured).toHaveLength(0);
  });
});

describe("clickUpClient: errors", () => {
  it("turns a 429 into a retryable HttpError that honours Retry-After", async () => {
    stubFetch(json({ err: "Rate limit reached" }, 429, { "Retry-After": "30" }));
    const err = await rejection(client().addComment("abc0001", [], signal()));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).retryAfterMs).toBe(30_000);
    expect(retryable(err)).toBeInstanceOf(RetryableError);
  });

  it("waits for X-RateLimit-Reset (epoch seconds), at least a minute, without Retry-After", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 5 * 60);
    stubFetch(json({}, 429, { "X-RateLimit-Reset": reset }), json({}, 429));
    const later = (await rejection(client().user(signal()))) as HttpError;
    expect(later.retryAfterMs).toBeGreaterThan(4 * 60_000);
    expect(later.retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
    const bare = (await rejection(client().user(signal()))) as HttpError;
    expect(bare.retryAfterMs).toBeGreaterThanOrEqual(60_000);
  });

  it("does not retry a server error or a refusal", async () => {
    stubFetch(json({}, 500), json({ err: "Task not found", ECODE: "ITEM_013" }, 404));
    const c = client();
    const e500 = await rejection(c.user(signal()));
    const e404 = await rejection(c.task("abc0001", signal()));
    expect((e500 as HttpError).status).toBe(500);
    expect((e404 as HttpError).status).toBe(404);
    expect(retryable(e500)).toBeUndefined();
    expect(retryable(e404)).toBeUndefined();
  });

  it("keeps the error message to method, path, status and a short snippet", async () => {
    stubFetch(json({ err: "bad", echo: "x".repeat(1000) }, 400));
    const err = (await rejection(client().addComment("abc0001", [], signal()))) as HttpError;
    expect(err.message).toStartWith("ClickUp POST /task/abc0001/comment failed: HTTP 400 ");
    expect(err.message.length).toBeLessThan(300);
    expect(err.message).not.toContain(TOKEN);
  });

  it("passes a connection failure through for the shared classification", async () => {
    const refused = Object.assign(new TypeError("Unable to connect"), { code: "ECONNREFUSED" });
    globalThis.fetch = (() => Promise.reject(refused)) as unknown as typeof fetch;
    const err = await rejection(client().user(signal()));
    expect(err).toBe(refused);
    expect(retryable(err)).toBeInstanceOf(RetryableError);
  });

  it("uses a fetch it is given instead of the global one", async () => {
    const captured = stubFetch(json({}, 500));
    const urls: string[] = [];
    const own = clickUpClient({ token: TOKEN }, async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ user: { id: 1 } }));
    });
    expect(await own.user(signal())).toEqual({ id: 1, username: "" });
    expect(urls).toEqual([`${BASE}/user`]);
    expect(captured).toHaveLength(0);
  });

  it("shows no token when the client itself is logged", () => {
    const shown = `${JSON.stringify(client())} ${Bun.inspect(client())}`;
    expect(shown).not.toContain(TOKEN);
  });
});
