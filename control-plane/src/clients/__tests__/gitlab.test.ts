import { afterEach, describe, expect, it, mock } from "bun:test";

// A complete-enough config before importing the real impl (see github.test.ts
// for why this file pins its own).
mock.module("../../config", () => ({
  config: {
    gitlab: { baseUrl: "https://gitlab.example.com", tokenSettings: { token: "test-token" } },
  },
}));

// A fresh instance of ./gitlabApi, not the ../gitlab barrel other tests mock.
const {
  awardNoteEmoji,
  fetchGroupMembers,
  findDiscussionIdForNote,
  getUserIdByUsername,
  gitlabTokenState,
  listOpenMergeRequestsForBranch,
  mrWebUrl,
  parseMrUrl,
  postDiscussionNote,
  postMrNote,
} = (await import("../gitlabApi.ts" + "?gitlab-impl-test")) as typeof import("../gitlabApi");
const { HttpError, retryable } = await import("../../integrations/http");

type Call = { url: string; init: RequestInit | undefined };

// A fetch stub answering each call from `responses` in order (status, body,
// headers), recording what was requested.
function fetchReturning(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    const r = responses[i++] ?? { status: 200, body: [] };
    const status = r.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(r.headers ?? {}),
      text: () => Promise.resolve(r.body === undefined ? "" : JSON.stringify(r.body)),
    } as unknown as Response);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("mrWebUrl / parseMrUrl", () => {
  it("builds the URL GitLab renders and the harness records", () => {
    expect(mrWebUrl("https://gitlab.example.com/platform/backend/api/", 3)).toBe(
      "https://gitlab.example.com/platform/backend/api/-/merge_requests/3",
    );
  });

  it("parses a merge request URL under the instance, nested groups included", () => {
    expect(
      parseMrUrl("https://gitlab.example.com/platform/backend/api/-/merge_requests/3/diffs"),
    ).toEqual({ project: "platform/backend/api", mrIid: 3 });
    expect(
      parseMrUrl(
        "https://example.com/gitlab/acme/api/-/merge_requests/9",
        "https://example.com/gitlab",
      ),
    ).toEqual({ project: "acme/api", mrIid: 9 });
  });

  it("returns null for other hosts, other objects and when GitLab is off", () => {
    expect(parseMrUrl("https://github.com/o/r/pull/1")).toBeNull();
    expect(parseMrUrl("https://gitlab.example.com/platform/api/-/issues/3")).toBeNull();
    expect(parseMrUrl("https://gitlab.example.com/platform/api/-/merge_requests/3", "")).toBeNull();
  });
});

describe("requests", () => {
  it("sends the bearer token to the instance's API, by project id and merge request iid", async () => {
    const { fn, calls } = fetchReturning([{ status: 201, body: { id: 77 } }]);
    globalThis.fetch = fn;
    expect(await postMrNote(55, 3, "hello")).toEqual({ id: 77 });
    expect(calls[0]?.url).toBe(
      "https://gitlab.example.com/api/v4/projects/55/merge_requests/3/notes",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ body: "hello" }));
  });

  it("replies inside a discussion, URL-encoding its id", async () => {
    const { fn, calls } = fetchReturning([{ status: 201, body: { id: 78 } }]);
    globalThis.fetch = fn;
    await postDiscussionNote(55, 3, "ab/c", "reply");
    expect(calls[0]?.url).toBe(
      "https://gitlab.example.com/api/v4/projects/55/merge_requests/3/discussions/ab%2Fc/notes",
    );
  });

  it("finds a note's discussion by listing discussions", async () => {
    const { fn } = fetchReturning([
      {
        body: [
          { id: "d1", notes: [{ id: 1 }, { id: 2 }] },
          { id: "d2", notes: [{ id: 901 }] },
        ],
      },
    ]);
    globalThis.fetch = fn;
    expect(await findDiscussionIdForNote(55, 3, 901)).toBe("d2");
    globalThis.fetch = fetchReturning([{ body: [{ id: "d1", notes: [{ id: 1 }] }] }]).fn;
    expect(await findDiscussionIdForNote(55, 3, 901)).toBeNull();
  });

  it("treats a repeated award (404) as done, and other failures as errors", async () => {
    globalThis.fetch = fetchReturning([
      { status: 404, body: { message: "404 Award Emoji Not Found" } },
    ]).fn;
    await expect(awardNoteEmoji(55, 3, 901, "eyes")).resolves.toBeUndefined();
    globalThis.fetch = fetchReturning([{ status: 500, body: { message: "boom" } }]).fn;
    await expect(awardNoteEmoji(55, 3, 901, "eyes")).rejects.toBeInstanceOf(HttpError);
  });

  it("walks every page of a group's members by the x-next-page header", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const { fn, calls } = fetchReturning([
      { body: page1, headers: { "x-next-page": "2" } },
      { body: [{ id: 500 }, { id: 0 }], headers: { "x-next-page": "" } },
    ]);
    globalThis.fetch = fn;
    const members = await fetchGroupMembers("platform/backend");
    expect(members.size).toBe(101);
    expect(members.has(500)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://gitlab.example.com/api/v4/groups/platform%2Fbackend/members/all?per_page=100&page=1",
      "https://gitlab.example.com/api/v4/groups/platform%2Fbackend/members/all?per_page=100&page=2",
    ]);
  });

  it("resolves a username to its id, null when unknown", async () => {
    globalThis.fetch = fetchReturning([{ body: [{ id: 42, username: "carol" }] }]).fn;
    expect(await getUserIdByUsername("carol")).toBe(42);
    globalThis.fetch = fetchReturning([{ body: [] }]).fn;
    expect(await getUserIdByUsername("nobody")).toBeNull();
  });

  it("lists the open merge requests of a source branch", async () => {
    const { fn, calls } = fetchReturning([{ body: [{ iid: 3, web_url: "u3" }, { iid: "x" }] }]);
    globalThis.fetch = fn;
    expect(await listOpenMergeRequestsForBranch(55, "devbox/XYZ-1 fix")).toEqual([
      { iid: 3, webUrl: "u3" },
    ]);
    expect(calls[0]?.url).toBe(
      "https://gitlab.example.com/api/v4/projects/55/merge_requests?state=opened&source_branch=devbox%2FXYZ-1%20fix",
    );
  });

  it("a 429 is retryable with its Retry-After; other errors are not", async () => {
    globalThis.fetch = fetchReturning([
      { status: 429, body: { message: "slow down" }, headers: { "retry-after": "7" } },
    ]).fn;
    const err = await postMrNote(55, 3, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(retryable(err)?.retryAfterMs).toBe(7000);
    globalThis.fetch = fetchReturning([{ status: 403, body: { message: "forbidden" } }]).fn;
    const forbidden = await postMrNote(55, 3, "x").catch((e: unknown) => e);
    expect(String((forbidden as Error).message)).toContain("HTTP 403");
    expect(retryable(forbidden)).toBeUndefined();
  });

  it("reports the token as configured from the env", () => {
    expect(gitlabTokenState()).toEqual({
      configured: true,
      source: "env",
      readAt: null,
      lastError: null,
    });
  });
});
