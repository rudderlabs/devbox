import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Task } from "../../db/schema";
import type { Person } from "../../integrations/types";

const postIssueComment = mock(() => Promise.resolve({ id: 1, url: "u" }));
const addPrAssignees = mock(() => Promise.resolve({ assigned: [] as string[] }));
const getUserById = mock(() => Promise.resolve({ login: "", id: 0 }));

// The full export surface of the ../../clients/github barrel.
mock.module("../../clients/github", () => ({
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

const { CodeHost } = await import("../codeHost.service");
const { BackgroundWork } = await import("../backgroundWork");
const { logger } = await import("../../logger");

const task = { id: "task-1", key: "XYZ-1", source: "linear" } as Task;
const PR_URL = "https://github.com/o/r/pull/1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("CodeHost", () => {
  let assignee: ReturnType<typeof mock>;
  let background: InstanceType<typeof BackgroundWork>;
  let info: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;

  // A code host over a registry whose integrations take @-mentions for
  // `mentionLogin` and report `assignee` as the task's person.
  const codeHost = (mentionLogin: string | undefined = "bot", sendTimeoutMs?: number) =>
    new CodeHost(
      { for: () => ({ assignee }) as never, prMentionLogin: () => mentionLogin },
      background,
      sendTimeoutMs,
    );
  const person = (githubAccount?: string | null): Person => ({
    id: "usr-1",
    displayName: "ada",
    email: "ada@acme.com",
    ...(githubAccount === undefined ? {} : { githubAccount }),
  });
  // The PR opened, the mirror included.
  const prOpened = async (host = codeHost()) => {
    await host.prOpened(task, host.prRef({ pr_url: PR_URL, repo: "r", branch: "b" }));
    await background.drain(sleep(500));
  };
  // The mirror's pr_assignee.result log lines.
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
    assignee = mock(() => Promise.resolve(person(null)));
    background = new BackgroundWork();
    info = spyOn(logger, "info").mockImplementation(() => logger);
    warn = spyOn(logger, "warn").mockImplementation(() => logger);
    error = spyOn(logger, "error").mockImplementation(() => logger);
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it("prRef carries the PR's GitHub coordinates, or null for another host", () => {
    const host = codeHost();
    expect(host.prRef({ pr_url: PR_URL, repo: "r", branch: "b" })).toEqual({
      url: PR_URL,
      repo: "r",
      branch: "b",
      github: { owner: "o", repo: "r", prNumber: 1 },
    });
    expect(
      host.prRef({ pr_url: "https://gitlab.com/o/r/pull/1", repo: "r", branch: "b" }).github,
    ).toBeNull();
  });

  it("a hung onboarding comment is cut at the send timeout; the mirror still runs", async () => {
    postIssueComment.mockImplementation(() => new Promise(() => {}));
    assignee.mockResolvedValue(person("octocat"));
    addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
    await prOpened(codeHost("bot", 20));
    expect(postIssueComment).toHaveBeenCalledTimes(1);
    expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
  });

  it("an integration that can't link accounts → skip as unsupported", async () => {
    assignee.mockResolvedValue(person());
    await prOpened();
    expect(addPrAssignees).not.toHaveBeenCalled();
    expect(results()).toEqual([
      { ...logged, status: "skipped", reason: "unsupported", personId: "usr-1" },
    ]);
  });

  describe("account id to login", () => {
    it("numeric account → resolves the login via getUserById and assigns it", async () => {
      assignee.mockResolvedValue(person("583231"));
      getUserById.mockResolvedValue({ login: "octocat", id: 583231 });
      addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });

      await prOpened();

      expect(assignee).toHaveBeenCalledWith(task, { prUrl: PR_URL });
      expect(getUserById).toHaveBeenCalledWith("583231", expect.any(AbortSignal));
      expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
      expect(results()).toEqual([
        { ...logged, status: "assigned", requested: "octocat", assigned: ["octocat"] },
      ]);
    });

    it("non-numeric account is treated as a login directly (no getUserById)", async () => {
      assignee.mockResolvedValue(person("octocat"));
      addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });

      await prOpened();

      expect(getUserById).not.toHaveBeenCalled();
      expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
    });

    it("empty login from a malformed getUserById response → skip, no assignees POST", async () => {
      assignee.mockResolvedValue(person("583231"));
      getUserById.mockResolvedValue({ login: "", id: 0 });

      await prOpened();

      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(results()).toEqual([
        { ...logged, status: "skipped", reason: "unresolved_login", personId: "usr-1" },
      ]);
    });

    it("getUserById rejection is swallowed: no throw, no assignees POST", async () => {
      assignee.mockResolvedValue(person("583231"));
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
