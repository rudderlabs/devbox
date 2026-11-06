import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Task } from "../../../db/schema";

const postIssueComment = mock(() => Promise.resolve({ id: 1, url: "u" }));
// The full export surface of the ../../clients/github barrel; the suite runs
// with --isolate, so this cannot leak.
mock.module("../../../clients/github", () => ({
  postIssueComment,
  postReviewCommentReply: mock(() => Promise.resolve({ id: 1, url: "u" })),
  addIssueCommentReaction: mock(() => Promise.resolve()),
  addReviewCommentReaction: mock(() => Promise.resolve()),
  getReviewComments: mock(() => Promise.resolve([])),
  fetchOrgMembers: mock(() => Promise.resolve(new Set())),
  addPrAssignees: mock(() => Promise.resolve({ assigned: [] })),
  getUserById: mock(() => Promise.resolve({ login: "", id: 0 })),
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

// The onboarding comment is the GitHub integration's own: the code host hands
// it each new pull request on github.com (services/codeHost.service.ts).
describe("GithubIntegration.onHostedPrOpened", () => {
  const integration = new GithubIntegration(
    { botLogin: "acme-bot" },
    { status: () => ({}) as never },
    { handleWebhook: async () => new Response() },
  );
  const signal = new AbortController().signal;
  const ctx = { signal, log: logger, isCurrent: async () => false };
  const task = { id: "task-1", key: "XYZ-1" } as Task;
  const opened = (url: string) => ({ url, repo: "r", branch: "b", host: "github" });

  beforeEach(() => {
    postIssueComment.mockReset();
    postIssueComment.mockResolvedValue({ id: 1, url: "u" });
  });

  it("posts the onboarding comment on the pull request, naming its bot and the task", async () => {
    await integration.onHostedPrOpened(ctx, task, opened("https://github.com/o/r/pull/7"));
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

  it("posts nothing for a URL that is not a github.com pull request", async () => {
    await integration.onHostedPrOpened(
      ctx,
      task,
      opened("https://gitlab.example.com/platform/api/-/merge_requests/3"),
    );
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it("lets a failed post reach the registry, which logs it", async () => {
    postIssueComment.mockRejectedValue(new Error("github down"));
    await expect(
      integration.onHostedPrOpened(ctx, task, opened("https://github.com/o/r/pull/7")),
    ).rejects.toThrow("github down");
  });
});
