import { afterEach, describe, expect, it, mock } from "bun:test";

// Pin a complete-enough config before importing the real impl. Other test files
// mock.module("../../config") with partial shapes (e.g. { databaseUrl } in the
// repository tests), and on Linux those mocks leak across files in readdir order
// (oven-sh/bun#12823). If a partial mock leaks in before this file runs,
// config.github is undefined and githubFetch throws at call time — order-
// dependent CI-only failures. Registering our own mock here makes this file
// immune to whatever ran before it. See control-plane/README.md (Conventions).
mock.module("../../config", () => ({
  config: { github: { tokenSettings: { token: "test-token" } } },
}));

// Import a FRESH instance of ./githubApi, NOT the ../github barrel or the
// cached ./githubApi. Service/controller tests mock.module the ../github barrel;
// bun's module mocks are process-global and leak across files on Linux (and
// afterAll re-registration does NOT undo a cross-file leak — verified failing in
// CI). If an earlier file loaded the real barrel, mocking it later writes through
// its `export *` into the cached ./githubApi too. The query string gives this
// file its own module instance. See control-plane/README.md (Conventions).
const {
  addPrAssignees,
  fetchOrgMembers,
  getReviewComments,
  getUserById,
  getUserIdByLogin,
  parsePrUrl,
  postIssueComment,
  requestReviewers,
} = (await import("../githubApi.ts" + "?github-impl-test")) as typeof import("../githubApi");
const { HttpError } = await import("../../integrations/http");

// Build a fetch stub that returns each page in `pages` as a 200 JSON response,
// recording the requested URLs. githubFetch does resp.text() → JSON.parse, so
// the body is the stringified page. Extra calls past the list get an empty page.
function fetchReturning(pages: unknown[][]): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn = (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url));
    const page = pages[i++] ?? [];
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(page)),
    } as unknown as Response);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("parsePrUrl", () => {
  it("parses a well-formed github.com PR URL", () => {
    expect(parsePrUrl("https://github.com/acme/widgets/pull/42")).toEqual({
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
    });
  });

  it("accepts http and trailing path segments", () => {
    expect(parsePrUrl("http://github.com/o/r/pull/7/files")).toEqual({
      owner: "o",
      repo: "r",
      prNumber: 7,
    });
  });

  it("returns null for a non-GitHub host", () => {
    expect(parsePrUrl("https://gitlab.com/o/r/pull/1")).toBeNull();
  });

  it("returns null for an issue URL (not a PR)", () => {
    expect(parsePrUrl("https://github.com/o/r/issues/1")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(parsePrUrl("not a url")).toBeNull();
    expect(parsePrUrl("https://github.com/o/r/pull/")).toBeNull();
  });
});

describe("getReviewComments", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Avoids the legacy `/reviews/{id}/comments` endpoint which serializes the
  // Legacy Review Comment schema with line=null. See github.ts comment.
  it("hits the modern /pulls/{n}/comments endpoint with per_page=100", async () => {
    const { fn, calls } = fetchReturning([[]]);
    globalThis.fetch = fn as unknown as typeof fetch;

    await getReviewComments("o", "r", 7, 88);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://api.github.com/repos/o/r/pulls/7/comments?per_page=100&page=1");
  });

  it("filters by pull_request_review_id and maps fields", async () => {
    const { fn } = fetchReturning([
      [
        {
          id: 11,
          path: "a.ts",
          line: 3,
          start_line: 1,
          body: "nit",
          user: { login: "reviewer" },
          pull_request_review_id: 88,
        },
        {
          id: 12,
          path: "b.ts",
          line: 9,
          body: "other review",
          user: { login: "other" },
          pull_request_review_id: 999,
        },
      ],
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await getReviewComments("o", "r", 7, 88);

    expect(out).toEqual([
      { id: 11, path: "a.ts", line: 3, startLine: 1, body: "nit", user: { login: "reviewer" } },
    ]);
  });

  it("falls back to original_* anchors when modern line fields are null (outdated comment)", async () => {
    const { fn } = fetchReturning([
      [
        {
          id: 13,
          path: "a.ts",
          line: null,
          start_line: null,
          original_line: 42,
          original_start_line: 40,
          body: "outdated",
          user: { login: "rev" },
          pull_request_review_id: 88,
        },
      ],
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await getReviewComments("o", "r", 7, 88);
    expect(out[0]?.line).toBe(42);
    expect(out[0]?.startLine).toBe(40);
  });

  it("omits startLine when start anchors are absent", async () => {
    const { fn } = fetchReturning([
      [
        {
          id: 14,
          path: "a.ts",
          line: 22,
          body: "single line",
          user: { login: "rev" },
          pull_request_review_id: 88,
        },
      ],
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await getReviewComments("o", "r", 7, 88);
    expect(out[0]?.line).toBe(22);
    expect(out[0]?.startLine).toBeUndefined();
  });

  it("uses 0 for line and omits startLine when all anchors are absent", async () => {
    const { fn } = fetchReturning([
      [
        {
          id: 14,
          path: "a.ts",
          body: "no line",
          user: { login: "rev" },
          pull_request_review_id: 88,
        },
      ],
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await getReviewComments("o", "r", 7, 88);
    expect(out[0]?.line).toBe(0);
    expect(out[0]?.startLine).toBeUndefined();
  });

  it("paginates until a short page, then stops", async () => {
    const fullPage = Array.from({ length: 100 }, (_, k) => ({
      id: k + 1,
      path: "a.ts",
      line: k + 1,
      body: "x",
      user: { login: "u" },
      pull_request_review_id: 88,
    }));
    const tail = [
      {
        id: 9999,
        path: "z.ts",
        line: 1,
        body: "last",
        user: { login: "u" },
        pull_request_review_id: 88,
      },
    ];
    const { fn, calls } = fetchReturning([fullPage, tail]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await getReviewComments("o", "r", 7, 88);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("page=1");
    expect(calls[1]).toContain("page=2");
    expect(out).toHaveLength(101);
    expect(out[100]?.id).toBe(9999);
  });

  it("stops on empty page even when previous page was full", async () => {
    const fullPage = Array.from({ length: 100 }, (_, k) => ({
      id: k + 1,
      path: "a.ts",
      line: 1,
      body: "x",
      user: { login: "u" },
      pull_request_review_id: 88,
    }));
    const { fn, calls } = fetchReturning([fullPage, []]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await getReviewComments("o", "r", 7, 88);
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(100);
  });

  // Locks the no-early-exit invariant: target-review comments can be
  // interleaved with other-review comments across pages.
  it("collects target-review comments spread across multiple pages", async () => {
    const filler = (id: number, prid: number) => ({
      id,
      path: "x.ts",
      line: 1,
      body: "x",
      user: { login: "u" },
      pull_request_review_id: prid,
    });
    // page 1: 99 filler (other review) + 1 target hit at the end
    const page1 = [...Array.from({ length: 99 }, (_, k) => filler(k + 1, 777)), filler(500, 88)];
    // page 2: short tail with 1 target hit + 1 other
    const page2 = [filler(501, 88), filler(502, 777)];
    const { fn, calls } = fetchReturning([page1, page2]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await getReviewComments("o", "r", 7, 88);

    expect(calls).toHaveLength(2);
    expect(out.map((c) => c.id)).toEqual([500, 501]);
  });

  it("url-encodes owner and repo to defend against weird path chars", async () => {
    const { fn, calls } = fetchReturning([[]]);
    globalThis.fetch = fn as unknown as typeof fetch;

    await getReviewComments("o#1", "r/2", 7, 88);

    expect(calls[0]).toBe(
      "https://api.github.com/repos/o%231/r%2F2/pulls/7/comments?per_page=100&page=1",
    );
  });

  it("returns empty when no comments belong to the review", async () => {
    const { fn } = fetchReturning([
      [
        {
          id: 1,
          path: "a.ts",
          line: 1,
          body: "x",
          user: { login: "u" },
          pull_request_review_id: 777,
        },
      ],
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await getReviewComments("o", "r", 7, 88);
    expect(out).toEqual([]);
  });
});

describe("requestReviewers", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs /pulls/{n}/requested_reviewers with reviewers", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? "";
      seenBody = String(init?.body ?? "");
      return Promise.resolve({
        ok: true,
        status: 201,
        text: () => Promise.resolve("{}"),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    await requestReviewers("o", "r", 5, ["octocat"]);

    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("https://api.github.com/repos/o/r/pulls/5/requested_reviewers");
    expect(JSON.parse(seenBody)).toEqual({ reviewers: ["octocat"] });
  });

  it("sends the token from the provider in the request headers", async () => {
    let seenHeaders: unknown;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders = init?.headers;
      return Promise.resolve({
        ok: true,
        status: 201,
        text: () => Promise.resolve("{}"),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    await requestReviewers("o", "r", 5, ["octocat"]);

    expect(seenHeaders).toEqual({
      Authorization: "Bearer test-token",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    });
  });

  it("throws on a non-2xx response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Validation Failed"),
      } as unknown as Response)) as unknown as typeof fetch;

    await expect(requestReviewers("o", "r", 5, ["octocat"])).rejects.toThrow("HTTP 422");
  });
});

describe("githubFetch errors and signal", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("a non-2xx is an HttpError with status and Retry-After; the message is unchanged", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('{"message":"API rate limit exceeded"}', {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      )) as unknown as typeof fetch;

    const err = await postIssueComment("o", "r", 1, "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as InstanceType<typeof HttpError>).status).toBe(429);
    expect((err as InstanceType<typeof HttpError>).retryAfterMs).toBe(30_000);
    expect((err as Error).message).toBe(
      'GitHub POST /repos/o/r/issues/1/comments failed: HTTP 429 {"message":"API rate limit exceeded"}',
    );
  });

  it("passes the caller's signal to fetch", async () => {
    let seen: AbortSignal | null | undefined;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      seen = init?.signal;
      return Promise.resolve(Response.json({ id: 1, html_url: "u" }));
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    await postIssueComment("o", "r", 1, "hi", ac.signal);
    expect(seen).toBe(ac.signal);
  });
});

describe("addPrAssignees", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs /issues/{n}/assignees and returns the applied logins", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? "";
      seenBody = String(init?.body ?? "");
      return Promise.resolve({
        ok: true,
        status: 201,
        text: () =>
          Promise.resolve(JSON.stringify({ assignees: [{ login: "octocat" }, { login: "hub" }] })),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const out = await addPrAssignees("o", "r", 5, ["octocat"]);

    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("https://api.github.com/repos/o/r/issues/5/assignees");
    expect(JSON.parse(seenBody)).toEqual({ assignees: ["octocat"] });
    expect(out).toEqual({ assigned: ["octocat", "hub"] });
  });

  it("returns empty assigned when GitHub silently drops the login (still 201)", async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 201,
        text: () => Promise.resolve(JSON.stringify({ assignees: [] })),
      } as unknown as Response)) as unknown as typeof fetch;

    expect(await addPrAssignees("o", "r", 5, ["nobody"])).toEqual({ assigned: [] });
  });

  it("tolerates a malformed response shape", async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 201,
        text: () => Promise.resolve(JSON.stringify({ assignees: [{ id: 1 }, "junk", null] })),
      } as unknown as Response)) as unknown as typeof fetch;

    expect(await addPrAssignees("o", "r", 5, ["x"])).toEqual({ assigned: [] });
  });

  it("throws on a non-2xx response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Validation Failed"),
      } as unknown as Response)) as unknown as typeof fetch;

    await expect(addPrAssignees("o", "r", 5, ["x"])).rejects.toThrow("HTTP 422");
  });
});

describe("getUserById", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GETs /user/{id} and maps login + id", async () => {
    let seenUrl = "";
    let seenMethod = "";
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? "";
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ login: "octocat", id: 583231 })),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const out = await getUserById("583231");

    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("https://api.github.com/user/583231");
    expect(out).toEqual({ login: "octocat", id: 583231 });
  });

  it("throws on 404 (unknown id)", async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      } as unknown as Response)) as unknown as typeof fetch;

    await expect(getUserById(1)).rejects.toThrow("HTTP 404");
  });
});

describe("getUserIdByLogin", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const respond = (status: number, body: unknown, seen?: { url: string }) => {
    globalThis.fetch = ((url: string | URL | Request) => {
      if (seen) seen.url = String(url);
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      } as unknown as Response);
    }) as unknown as typeof fetch;
  };

  it("GETs /users/{login} and returns the numeric id", async () => {
    const seen = { url: "" };
    respond(200, { login: "octocat", id: 583231 }, seen);
    expect(await getUserIdByLogin("octo cat")).toBe(583231);
    expect(seen.url).toBe("https://api.github.com/users/octo%20cat");
  });

  it("returns null for an unknown login (404)", async () => {
    respond(404, "Not Found");
    expect(await getUserIdByLogin("nobody")).toBeNull();
  });

  it("throws on other failures", async () => {
    respond(500, "boom");
    await expect(getUserIdByLogin("x")).rejects.toThrow("HTTP 500");
  });
});

describe("fetchOrgMembers", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("hits /orgs/{org}/members with per_page=100 and encodes the org", async () => {
    const { fn, calls } = fetchReturning([[]]);
    globalThis.fetch = fn as unknown as typeof fetch;

    await fetchOrgMembers("my org/x");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://api.github.com/orgs/my%20org%2Fx/members?per_page=100&page=1");
  });

  it("returns a Set of numeric ids and skips non-numeric / non-positive entries", async () => {
    const { fn } = fetchReturning([
      [
        { id: 11, login: "a" },
        { id: 12, login: "b" },
        { id: "not-a-number", login: "junk" },
        { id: 0, login: "bad" },
        { id: -5, login: "bad" },
        { login: "no-id-field" },
      ],
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await fetchOrgMembers("o");
    expect([...out].sort()).toEqual([11, 12]);
  });

  it("paginates and aggregates across pages, stopping on a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, k) => ({ id: k + 1 }));
    const page2 = [{ id: 9999 }];
    const { fn, calls } = fetchReturning([page1, page2]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await fetchOrgMembers("o");
    expect(calls).toHaveLength(2);
    expect(out.size).toBe(101);
    expect(out.has(9999)).toBe(true);
  });

  it("returns an empty set when the org has no visible members", async () => {
    const { fn, calls } = fetchReturning([[]]);
    globalThis.fetch = fn as unknown as typeof fetch;

    const out = await fetchOrgMembers("o");
    expect(out.size).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
