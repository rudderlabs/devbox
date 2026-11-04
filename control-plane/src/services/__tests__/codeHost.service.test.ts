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
  const person = (githubLogin: string): Person => ({
    id: "usr-1",
    displayName: "ada",
    email: "ada@acme.com",
    codeHost: { githubLogin },
  });
  // The PR opened, the mirror included.
  const prOpened = async (host = codeHost()) => {
    await host.prOpened(task, host.prRef({ pr_url: PR_URL, repo: "r", branch: "b" }));
    await background.drain(sleep(500));
  };

  beforeEach(() => {
    for (const m of [postIssueComment, addPrAssignees, getUserById]) m.mockReset();
    postIssueComment.mockResolvedValue({ id: 1, url: "u" });
    addPrAssignees.mockResolvedValue({ assigned: [] });
    getUserById.mockResolvedValue({ login: "", id: 0 });
    assignee = mock(() => Promise.resolve(null));
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
});
