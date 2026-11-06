import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Task } from "../../../db/schema";
import type { Person } from "../../types";

const postIssueComment = mock(() => Promise.resolve({ id: 1, url: "u" }));
const addPrAssignees = mock(() => Promise.resolve({ assigned: [] as string[] }));
const getUserById = mock(() => Promise.resolve({ login: "", id: 0 }));
// The full export surface of the ../../clients/github barrel; the suite runs
// with --isolate, so this cannot leak.
mock.module("../../../clients/github", () => ({
  postIssueComment,
  postReviewCommentReply: mock(() => Promise.resolve({ id: 1, url: "u" })),
  addIssueCommentReaction: mock(() => Promise.resolve()),
  addReviewCommentReaction: mock(() => Promise.resolve()),
  getReviewComments: mock(() => Promise.resolve([])),
  fetchOrgMembers: mock(() => Promise.resolve(new Set())),
  addPrAssignees,
  getUserById,
  getUserIdByLogin: mock(() => Promise.resolve(null)),
  requestReviewers: mock(() => Promise.resolve()),
  parsePrUrl: (url: string) => {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], prNumber: Number(m[3]) } : null;
  },
  githubTokenState: () => ({ source: "env", expiresAt: null, readAt: null, lastError: null }),
}));

const { GithubIntegration } = await import("..");
const { logger } = await import("../../../logger");

const PR_URL = "https://github.com/o/r/pull/1";
const task = { id: "task-1", key: "XYZ-1" } as Task;
const opened = (url = PR_URL) => ({ url, repo: "r", branch: "b" });
const person = (githubAccount?: string | null): Person => ({
  id: "usr-1",
  displayName: "ada",
  email: "ada@acme.com",
  ...(githubAccount === undefined ? {} : { githubAccount }),
});

// What GitHub does on a pull request the agent opened there. Core hands it
// each new one (IntegrationRegistry.onPrOpenedOnHost), with the task's person
// to ask for.
describe("GithubIntegration.onPrOpened", () => {
  const integration = new GithubIntegration(
    { botLogin: "acme-bot" },
    { status: () => ({}) as never },
    { handleWebhook: async () => new Response() },
  );
  const signal = new AbortController().signal;
  let lookup: ReturnType<typeof mock>;
  let info: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;
  // What the hook handed to ctx.background, as core would track it.
  let deferred: Promise<unknown>[];
  const ctx = (firstTime = true) => ({
    signal,
    log: logger,
    isCurrent: async () => false,
    firstTime,
    person: lookup as unknown as () => Promise<Person | null | undefined>,
    background: (work: Promise<unknown>) => {
      deferred.push(work);
    },
  });
  // The hook, then the background work it deferred.
  const prOpened = async (url = PR_URL, firstTime = true) => {
    await integration.onPrOpened(ctx(firstTime), task, opened(url));
    await Promise.all(deferred);
  };
  // The assignee's pr_assignee.result log lines.
  const results = () =>
    [...info.mock.calls, ...warn.mock.calls]
      .map(([, meta]) => meta as Record<string, unknown> | undefined)
      .filter((meta) => meta?.event === "pr_assignee.result");
  const logged = { event: "pr_assignee.result", taskId: "task-1", prUrl: PR_URL };

  beforeEach(() => {
    for (const m of [postIssueComment, addPrAssignees, getUserById]) m.mockReset();
    postIssueComment.mockResolvedValue({ id: 1, url: "u" });
    addPrAssignees.mockResolvedValue({ assigned: [] });
    getUserById.mockResolvedValue({ login: "", id: 0 });
    lookup = mock(() => Promise.resolve(person(null)));
    deferred = [];
    info = spyOn(logger, "info").mockImplementation(() => logger);
    warn = spyOn(logger, "warn").mockImplementation(() => logger);
    error = spyOn(logger, "error").mockImplementation(() => logger);
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it("hosts github.com pull requests and nothing else", () => {
    expect(integration.hostsPr(PR_URL)).toBe(true);
    expect(integration.hostsPr("https://gitlab.example.com/g/p/-/merge_requests/3")).toBe(false);
    expect(integration.hostsPr("https://github.com/o/r/issues/1")).toBe(false);
  });

  describe("the onboarding comment", () => {
    it("is posted on the pull request, naming the bot and the task", async () => {
      await prOpened("https://github.com/o/r/pull/7");
      expect(postIssueComment).toHaveBeenCalledTimes(1);
      const [owner, repo, prNumber, body, sent] = postIssueComment.mock.calls[0] as unknown as [
        string,
        string,
        number,
        string,
        AbortSignal,
      ];
      expect([owner, repo, prNumber]).toEqual(["o", "r", 7]);
      expect(body).toContain("I'm **acme-bot**");
      expect(body).toContain("this PR from task `XYZ-1`");
      expect(body).toContain("`@acme-bot`");
      expect(sent).toBe(signal);
    });

    it("a failed post is logged and doesn't cost the PR its assignee", async () => {
      postIssueComment.mockRejectedValue(new Error("github down"));
      lookup.mockResolvedValue(person("octocat"));
      addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
      await prOpened();
      expect(error).toHaveBeenCalledWith(
        "onboarding comment post failed",
        expect.objectContaining({ taskId: "task-1", prUrl: PR_URL, message: "github down" }),
      );
      expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
    });
  });

  it("does nothing on a replay of a pull request the task already has", async () => {
    await prOpened(PR_URL, false);
    expect(postIssueComment).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does nothing for a URL that is not a github.com pull request", async () => {
    await prOpened("https://gitlab.example.com/platform/api/-/merge_requests/3");
    expect(postIssueComment).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  describe("the assignee", () => {
    it("is handed to the background: the hook returns while it is still running", async () => {
      lookup.mockResolvedValue(person("octocat"));
      let release: (v: { assigned: string[] }) => void = () => {};
      addPrAssignees.mockImplementation(
        () => new Promise<{ assigned: string[] }>((resolve) => (release = resolve)),
      );
      await integration.onPrOpened(ctx(), task, opened());
      // The comment is posted; the assignment is in flight, not awaited.
      expect(postIssueComment).toHaveBeenCalledTimes(1);
      expect(deferred).toHaveLength(1);
      expect(results()).toEqual([]);
      await Promise.resolve();
      release({ assigned: ["octocat"] });
      await Promise.all(deferred);
      expect(results()).toEqual([
        { ...logged, status: "assigned", requested: "octocat", assigned: ["octocat"] },
      ]);
    });

    it("a hung login lookup is cut at its own timeout: no assignees POST", async () => {
      const { assignToTaskPerson } = await import("../assignee");
      lookup.mockResolvedValue(person("583231"));
      getUserById.mockImplementation(() => new Promise(() => {}));
      await assignToTaskPerson(
        ctx(),
        task,
        { url: PR_URL, owner: "o", repo: "r", prNumber: 1 },
        20,
      );
      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        "PR assignee mirror failed",
        expect.objectContaining({ taskId: "task-1", message: "timed out after 20 ms" }),
      );
    });

    it("a task whose integration names no person (an API task, or a failed lookup) → nothing, no log", async () => {
      lookup.mockResolvedValue(undefined);
      await prOpened();
      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(results()).toEqual([]);
    });

    it("no human assignee → skip", async () => {
      lookup.mockResolvedValue(null);
      await prOpened();
      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(results()).toEqual([{ ...logged, status: "skipped", reason: "no_human_assignee" }]);
    });

    it("a person without a linked GitHub account → skip as no_github_mapping", async () => {
      lookup.mockResolvedValue(person(null));
      await prOpened();
      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(results()).toEqual([
        { ...logged, status: "skipped", reason: "no_github_mapping", personId: "usr-1" },
      ]);
    });

    it("an integration that can't link accounts → skip as unsupported", async () => {
      lookup.mockResolvedValue(person());
      await prOpened();
      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(results()).toEqual([
        { ...logged, status: "skipped", reason: "unsupported", personId: "usr-1" },
      ]);
    });

    it("numeric account → resolves the login via getUserById and assigns it", async () => {
      lookup.mockResolvedValue(person("583231"));
      getUserById.mockResolvedValue({ login: "octocat", id: 583231 });
      addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
      await prOpened();
      expect(getUserById).toHaveBeenCalledWith("583231", expect.any(AbortSignal));
      expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
      expect(results()).toEqual([
        { ...logged, status: "assigned", requested: "octocat", assigned: ["octocat"] },
      ]);
    });

    it("non-numeric account is treated as a login directly (no getUserById)", async () => {
      lookup.mockResolvedValue(person("octocat"));
      addPrAssignees.mockResolvedValue({ assigned: ["Octocat"] });
      await prOpened();
      expect(getUserById).not.toHaveBeenCalled();
      // The response echoes canonical casing: compared case-folded.
      expect(results()).toEqual([
        { ...logged, status: "assigned", requested: "octocat", assigned: ["Octocat"] },
      ]);
    });

    it("empty login from a malformed getUserById response → skip, no assignees POST", async () => {
      lookup.mockResolvedValue(person("583231"));
      getUserById.mockResolvedValue({ login: "", id: 583231 });
      await prOpened();
      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(results()).toEqual([
        { ...logged, status: "skipped", reason: "unresolved_login", personId: "usr-1" },
      ]);
    });

    it("a login GitHub drops for lack of push access is reported, not thrown", async () => {
      lookup.mockResolvedValue(person("octocat"));
      addPrAssignees.mockResolvedValue({ assigned: [] });
      await prOpened();
      expect(results()).toEqual([
        {
          ...logged,
          status: "silently_dropped",
          reason: "no_push_access",
          requested: "octocat",
          assigned: [],
        },
      ]);
    });

    it("a failed lookup or assign is swallowed and logged", async () => {
      lookup.mockResolvedValue(person("583231"));
      getUserById.mockRejectedValue(new Error("github down"));
      await prOpened();
      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        "PR assignee mirror failed",
        expect.objectContaining({ taskId: "task-1", prUrl: PR_URL, message: "github down" }),
      );
    });
  });
});
