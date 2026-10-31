import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { Task } from "../../db/schema";
import type { TaskIntake } from "../../integrations/intake";
import { logger } from "../../logger";
import type { InboxService } from "../../services/inbox.service";

const WEBHOOK_SECRET = "gh-test-secret";

mock.module("../../config", () => ({
  config: {
    podId: "pod-test",
    github: { ciResultEnabled: true },
  },
}));

const SETTINGS = {
  secret: WEBHOOK_SECRET,
  botLogin: "acme-bot",
  botUserId: 7,
  trustedOrgs: ["acme"],
  trustedUsers: [] as string[],
};

const getReviewComments = mock(() => Promise.resolve([] as unknown[]));
const fetchOrgMembers = mock(() => Promise.resolve(new Set([1, 2, 3]) as ReadonlySet<number>));
const getUserIdByLogin = mock((_login: string) => Promise.resolve(null as number | null));
const addIssueCommentReaction = mock(() => Promise.resolve());
const addReviewCommentReaction = mock(() => Promise.resolve());
// Mock the full export surface of the ../../clients/github barrel. bun's
// mock.module is process-global; the module split alone did NOT contain it --
// in CI this mock reached github.test.ts and failed 25 of its tests. The suite
// now runs with --isolate (package.json "test"), which gives every file a fresh
// module registry, so this cannot leak. Do not drop that flag.
mock.module("../../clients/github", () => ({
  getReviewComments,
  fetchOrgMembers,
  getUserIdByLogin,
  addIssueCommentReaction,
  addReviewCommentReaction,
  postIssueComment: mock(() => Promise.resolve({ id: 1, url: "u" })),
  postReviewCommentReply: mock(() => Promise.resolve({ id: 1, url: "u" })),
  addPrAssignees: mock(() => Promise.resolve({ assigned: [] })),
  getUserById: mock(() => Promise.resolve({ login: "", id: 0 })),
  requestReviewers: mock(() => Promise.resolve()),
  parsePrUrl: () => null,
}));

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

const {
  GitHubWebhookController,
  mentionRegex,
  parseGithubEvent: parseWithMention,
} = await import("../githubWebhook.controller");

const parseGithubEvent = (eventHeader: string | undefined, payload: unknown) =>
  parseWithMention(eventHeader, payload, mentionRegex(SETTINGS.botLogin));

const sign = (body: string, secret: string = WEBHOOK_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

// ──── parseGithubEvent unit tests ────

describe("parseGithubEvent", () => {
  const repo = { name: "r", owner: { login: "o" } };

  it("issue_comment with @acme-bot on a PR → comment", () => {
    const parsed = parseGithubEvent("issue_comment", {
      action: "created",
      repository: repo,
      issue: { number: 7, pull_request: { url: "x" } },
      comment: {
        id: 555,
        body: "@acme-bot fix this",
        user: { login: "alice" },
        created_at: "2026-04-23T10:00:00Z",
      },
    });
    expect(parsed?.kind).toBe("comment");
    if (parsed?.kind === "comment") {
      expect(parsed.commentId).toBe(555);
      expect(parsed.prUrl).toBe("https://github.com/o/r/pull/7");
      expect(parsed.spec.kind).toBe("issue_comment");
      expect(parsed.createdAt).toBe("2026-04-23T10:00:00Z");
    }
  });

  it("issue_comment without a mention → null", () => {
    expect(
      parseGithubEvent("issue_comment", {
        action: "created",
        repository: repo,
        issue: { number: 7, pull_request: { url: "x" } },
        comment: { id: 1, body: "just chatting", user: { login: "alice" } },
      }),
    ).toBeNull();
  });

  it("issue_comment on a plain issue (no pull_request) → null", () => {
    expect(
      parseGithubEvent("issue_comment", {
        action: "created",
        repository: repo,
        issue: { number: 7 },
        comment: { id: 1, body: "@acme-bot", user: { login: "alice" } },
      }),
    ).toBeNull();
  });

  it("pull_request_review_comment in a review → dropped as dedup", () => {
    const parsed = parseGithubEvent("pull_request_review_comment", {
      action: "created",
      repository: repo,
      pull_request: { number: 7 },
      comment: { id: 2, body: "@acme-bot", user: { login: "a" }, pull_request_review_id: 99 },
    });
    expect(parsed?.kind).toBe("inline_review_comment_dropped_as_dedup");
  });

  it("standalone pull_request_review_comment with @acme-bot → comment", () => {
    const parsed = parseGithubEvent("pull_request_review_comment", {
      action: "created",
      repository: repo,
      pull_request: { number: 7 },
      comment: {
        id: 3,
        body: "@acme-bot rename",
        user: { login: "a" },
        path: "a.ts",
        line: 9,
        created_at: "2026-04-23T11:30:00Z",
      },
    });
    expect(parsed?.kind).toBe("comment");
    if (parsed?.kind === "comment") {
      expect(parsed.spec.kind).toBe("review_comment");
      if (parsed.spec.kind === "review_comment") {
        expect(parsed.spec.inReplyTo).toBe(3);
        expect(parsed.spec.line).toBe(9);
      }
      expect(parsed.createdAt).toBe("2026-04-23T11:30:00Z");
    }
  });

  it("pull_request_review submitted → review (no mention required)", () => {
    const parsed = parseGithubEvent("pull_request_review", {
      action: "submitted",
      repository: repo,
      pull_request: { number: 7 },
      review: {
        id: 88,
        body: "looks good",
        user: { login: "a" },
        submitted_at: "2026-04-23T12:00:00Z",
      },
    });
    expect(parsed?.kind).toBe("review");
    if (parsed?.kind === "review") {
      expect(parsed.reviewId).toBe(88);
      expect(parsed.reviewBody).toBe("looks good");
      expect(parsed.createdAt).toBe("2026-04-23T12:00:00Z");
    }
  });

  it("pull_request event → null (not handled yet)", () => {
    expect(
      parseGithubEvent("pull_request", {
        action: "closed",
        repository: repo,
        pull_request: { number: 7, merged: true },
        sender: { login: "a" },
      }),
    ).toBeNull();
  });

  it("unknown event header → null", () => {
    expect(parseGithubEvent("push", {})).toBeNull();
  });

  it("workflow_run completed with failure conclusion → workflow_run event", () => {
    const parsed = parseGithubEvent("workflow_run", {
      action: "completed",
      repository: { name: "r", owner: { login: "o" } },
      workflow_run: {
        id: 123456789,
        run_attempt: 1,
        name: "CI",
        head_branch: "devbox/XYZ-1234-fix",
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/o/r/actions/runs/123456789",
        pull_requests: [{ number: 42 }],
      },
      workflow: { id: 789, name: "CI", path: ".github/workflows/ci.yml" },
      sender: { login: "alice", id: 1 },
    });
    expect(parsed?.kind).toBe("workflow_run");
    if (parsed?.kind === "workflow_run") {
      expect(parsed.runId).toBe(123456789);
      expect(parsed.runAttempt).toBe(1);
      expect(parsed.conclusion).toBe("failure");
      expect(parsed.workflowName).toBe("CI");
      expect(parsed.workflowPath).toBe(".github/workflows/ci.yml");
      expect(parsed.headBranch).toBe("devbox/XYZ-1234-fix");
      expect(parsed.headSha).toBe("abc123");
      expect(parsed.pullRequests).toEqual([{ number: 42 }]);
      expect(parsed.runUrl).toBe("https://github.com/o/r/actions/runs/123456789");
      expect(parsed.owner).toBe("o");
      expect(parsed.repo).toBe("r");
    }
  });

  it("workflow_run defaults runAttempt to 1 when run_attempt is missing", () => {
    const parsed = parseGithubEvent("workflow_run", {
      action: "completed",
      repository: { name: "r", owner: { login: "o" } },
      workflow_run: {
        id: 123456789,
        name: "CI",
        head_branch: "devbox/XYZ-1234-fix",
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/o/r/actions/runs/123456789",
        pull_requests: [{ number: 42 }],
      },
      workflow: { path: ".github/workflows/ci.yml" },
      sender: { login: "alice" },
    });
    expect(parsed?.kind).toBe("workflow_run");
    if (parsed?.kind === "workflow_run") {
      expect(parsed.runAttempt).toBe(1);
    }
  });

  it("workflow_run captures run_attempt on re-runs", () => {
    const parsed = parseGithubEvent("workflow_run", {
      action: "completed",
      repository: { name: "r", owner: { login: "o" } },
      workflow_run: {
        id: 123456789,
        run_attempt: 2,
        name: "CI",
        head_branch: "devbox/XYZ-1234-fix",
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/o/r/actions/runs/123456789",
        pull_requests: [{ number: 42 }],
      },
      workflow: { path: ".github/workflows/ci.yml" },
      sender: { login: "alice" },
    });
    expect(parsed?.kind).toBe("workflow_run");
    if (parsed?.kind === "workflow_run") {
      expect(parsed.runAttempt).toBe(2);
    }
  });

  it("workflow_run completed with success conclusion → null", () => {
    expect(
      parseGithubEvent("workflow_run", {
        action: "completed",
        repository: { name: "r", owner: { login: "o" } },
        workflow_run: {
          id: 123456789,
          name: "CI",
          head_branch: "devbox/XYZ-1234-fix",
          head_sha: "abc123",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/o/r/actions/runs/123456789",
          pull_requests: [{ number: 42 }],
        },
        workflow: { path: ".github/workflows/ci.yml" },
        sender: { login: "alice" },
      }),
    ).toBeNull();
  });

  it("workflow_run non-completed action → null", () => {
    expect(
      parseGithubEvent("workflow_run", {
        action: "requested",
        repository: { name: "r", owner: { login: "o" } },
        workflow_run: {
          id: 1,
          name: "CI",
          head_branch: "b",
          head_sha: "x",
          status: "in_progress",
          conclusion: null,
          html_url: "u",
          pull_requests: [{ number: 42 }],
        },
        workflow: { path: ".github/workflows/ci.yml" },
        sender: { login: "alice" },
      }),
    ).toBeNull();
  });

  it("workflow_run completed with empty pull_requests → workflow_run with empty list", () => {
    const parsed = parseGithubEvent("workflow_run", {
      action: "completed",
      repository: { name: "r", owner: { login: "o" } },
      workflow_run: {
        id: 123,
        name: "CI",
        head_branch: "main",
        head_sha: "abc",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/o/r/actions/runs/123",
        pull_requests: [],
      },
      workflow: { path: ".github/workflows/ci.yml" },
      sender: { login: "alice" },
    });
    expect(parsed?.kind).toBe("workflow_run");
    if (parsed?.kind === "workflow_run") {
      expect(parsed.pullRequests).toEqual([]);
      expect(parsed.conclusion).toBe("failure");
    }
  });
});

// ──── Controller tests ────

type InboxServiceLike = Pick<
  InboxService,
  "enqueueComment" | "enqueueReview" | "enqueueLinearComment" | "enqueueCiResult"
>;

const linearTask = {
  id: "task-1",
  key: "XYZ-1",
  externalUrl: "https://linear.app/x/issue/XYZ-1/test",
} as Task;

const apiTask = {
  id: "task-api",
  source: "api",
  key: "DBX-API-7",
  externalUrl: "https://cp.example/api/tasks/DBX-API-7",
} as Task;

describe("GitHubWebhookController.handleWebhook", () => {
  let enqueueComment: ReturnType<typeof mock>;
  let enqueueReview: ReturnType<typeof mock>;
  let enqueueCiResult: ReturnType<typeof mock>;
  let findByPrUrl: ReturnType<typeof mock>;
  let app: Hono;
  let controller: InstanceType<typeof GitHubWebhookController>;
  let clock: { now: number };

  const build = () => {
    enqueueComment = mock(() => Promise.resolve());
    enqueueReview = mock(() => Promise.resolve());
    enqueueCiResult = mock(() => Promise.resolve());
    findByPrUrl = mock(() => Promise.resolve(linearTask));
    getReviewComments.mockReset();
    getReviewComments.mockResolvedValue([]);
    addIssueCommentReaction.mockReset();
    addIssueCommentReaction.mockResolvedValue(undefined);
    addReviewCommentReaction.mockReset();
    addReviewCommentReaction.mockResolvedValue(undefined);

    const inboxService = {
      enqueueComment,
      enqueueReview,
      enqueueCiResult,
    } as unknown as InboxServiceLike as InboxService;
    const intake = { findTaskByPrUrl: findByPrUrl } as unknown as TaskIntake;
    // Reset the module-mocked fetchOrgMembers so per-test mockImplementationOnce
    // overrides don't leak across cases. Default: resolves to the trusted-set
    // logins used across positive-path bodies. The bot login `acme-bot[bot]` is
    // intentionally NOT in this set — the bot-self-check short-circuits its
    // own events before the trust gate, so it never needs to be a "member".
    fetchOrgMembers.mockReset();
    fetchOrgMembers.mockResolvedValue(new Set([1, 2, 3]) as ReadonlySet<number>);
    getUserIdByLogin.mockReset();
    getUserIdByLogin.mockResolvedValue(null);
    clock = { now: 1_000_000 };
    controller = new GitHubWebhookController(inboxService, intake, SETTINGS, () => clock.now);
    const a = new Hono();
    a.post("/webhook/github", (c) => controller.handleWebhook(c));
    return a;
  };

  beforeEach(() => {
    app = build();
  });

  const post = (body: string, event: string, signature?: string, contentType?: string) =>
    app.request("/webhook/github", {
      method: "POST",
      headers: {
        "x-github-event": event,
        ...(signature ? { "x-hub-signature-256": signature } : {}),
        ...(contentType ? { "content-type": contentType } : {}),
      },
      body,
    });

  // Login → numeric id mapping used by the test fixtures. Trusted-set IDs are
  // {1, 2, 3}; everything else (outsider, human-author) lives outside the set
  // so the trust gate rejects it. The bot login `acme-bot[bot]` short-circuits
  // before the gate, so its id never matters.
  const USER_IDS: Record<string, number> = {
    alice: 1,
    a: 2,
    reviewer: 3,
    outsider: 99,
    "human-author": 100,
  };
  const userObj = (login: string) => {
    const id = USER_IDS[login];
    return id === undefined ? { login } : { login, id };
  };

  const commentBody = (userLogin = "alice", prOpener = "acme-bot[bot]", body = "@acme-bot fix") =>
    JSON.stringify({
      action: "created",
      repository: { name: "r", owner: { login: "o" } },
      issue: {
        number: 7,
        pull_request: { url: "x" },
        // PR opener — controller only processes bot-opened PRs.
        user: { login: prOpener },
      },
      comment: {
        id: 555,
        body,
        user: userObj(userLogin),
      },
    });

  it("returns 401 on a missing / bad signature", async () => {
    const res = await post(commentBody(), "issue_comment");
    expect(res.status).toBe(401);
    expect(enqueueComment).not.toHaveBeenCalled();
  });

  it("enqueues a comment on an API task's PR without parsing its URL", async () => {
    findByPrUrl.mockResolvedValue(apiTask);
    const body = commentBody("alice");
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueComment).toHaveBeenCalledWith(expect.objectContaining({ task: apiTask }));
  });

  it("enqueues a comment on a valid @acme-bot issue_comment from a trusted org member", async () => {
    const body = commentBody("alice");
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueComment).toHaveBeenCalledTimes(1);
    expect(enqueueComment.mock.calls[0]?.[0]).toMatchObject({ task: linearTask, commentId: 555 });
    await flushMicrotasks();
    expect(addIssueCommentReaction).toHaveBeenCalledWith("o", "r", 555, "eyes");
  });

  // No delivery-id dedupe here: the inbox's ON CONFLICT drops the duplicate row.
  it("a redelivered comment enqueues and reacts again", async () => {
    const body = commentBody("alice");
    expect((await post(body, "issue_comment", sign(body))).status).toBe(200);
    expect((await post(body, "issue_comment", sign(body))).status).toBe(200);
    await flushMicrotasks();
    expect(enqueueComment).toHaveBeenCalledTimes(2);
    expect(enqueueComment.mock.calls[1]).toEqual(enqueueComment.mock.calls[0]);
    expect(addIssueCommentReaction).toHaveBeenCalledTimes(2);
  });

  it("does not react to a shortened alias of the bot login", async () => {
    const body = commentBody("alice", "acme-bot[bot]", "@bot fix");
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueComment).not.toHaveBeenCalled();
  });

  it("accepts a form-encoded body (payload=<urlencoded JSON>)", async () => {
    // GitHub webhook config supports application/x-www-form-urlencoded as an
    // alternate content type — the body is `payload=` + URL-encoded JSON. The
    // HMAC is still over the raw body.
    const json = commentBody("alice");
    const formBody = `payload=${encodeURIComponent(json)}`;
    const res = await post(
      formBody,
      "issue_comment",
      sign(formBody),
      "application/x-www-form-urlencoded",
    );
    expect(res.status).toBe(200);
    expect(enqueueComment).toHaveBeenCalledTimes(1);
    expect(enqueueComment.mock.calls[0]?.[0]).toMatchObject({ task: linearTask, commentId: 555 });
  });

  it("rejects a comment from a user id not in the trusted org with 403", async () => {
    const body = commentBody("outsider");
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(403);
    expect(enqueueComment).not.toHaveBeenCalled();
  });

  it("trusts by numeric user id, not login — a renamed handle with a trusted id is accepted", async () => {
    // Trust gate compares against the immutable numeric user id (set: {1, 2, 3}).
    // A user who renames their handle keeps the same id, so a comment authored
    // under "renamed-handle" with id=1 must still pass. If the gate ever
    // regressed to compare logins, this test fails because "renamed-handle" is
    // not in the trusted-login fixture map.
    const body = JSON.stringify({
      action: "created",
      repository: { name: "r", owner: { login: "o" } },
      issue: { number: 7, pull_request: { url: "x" }, user: { login: "acme-bot[bot]" } },
      comment: { id: 555, body: "@acme-bot fix", user: { login: "renamed-handle", id: 1 } },
    });
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueComment).toHaveBeenCalledTimes(1);
  });

  it("rejects a comment whose login matches a trusted user but whose id does not (fail closed on id)", async () => {
    // Mirror of the renamed-handle test: same trusted login "alice" but a
    // stranger's id (99). Trust must reject — the post-rename handle reclaim
    // attack relies on a stale login matching while the id is fresh.
    const body = JSON.stringify({
      action: "created",
      repository: { name: "r", owner: { login: "o" } },
      issue: { number: 7, pull_request: { url: "x" }, user: { login: "acme-bot[bot]" } },
      comment: { id: 555, body: "@acme-bot fix", user: { login: "alice", id: 99 } },
    });
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(403);
    expect(enqueueComment).not.toHaveBeenCalled();
  });

  it("rejects a comment with a missing user.id as 403 (fail closed)", async () => {
    const body = JSON.stringify({
      action: "created",
      repository: { name: "r", owner: { login: "o" } },
      // PR opener is the bot so the PR-opener gate passes; the missing
      // commenter id is what 403s at the trust gate.
      issue: {
        number: 7,
        pull_request: { url: "x" },
        user: { login: "acme-bot[bot]" },
      },
      // No user field on the comment at all.
      comment: { id: 1, body: "@acme-bot" },
    });
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(403);
    expect(enqueueComment).not.toHaveBeenCalled();
  });

  it("ignores an unhandled event header (issues, push, …) before any trust/DB work", async () => {
    const body = JSON.stringify({
      action: "opened",
      repository: { name: "r", owner: { login: "o" } },
      issue: { number: 7, user: { login: "alice", id: 1 } },
    });
    const res = await post(body, "issues", sign(body));
    expect(res.status).toBe(200);
    expect(fetchOrgMembers).not.toHaveBeenCalled();
    expect(findByPrUrl).not.toHaveBeenCalled();
    expect(enqueueComment).not.toHaveBeenCalled();
  });

  it("ignores an issue_comment on a plain issue (no pull_request) before any trust/DB work", async () => {
    const body = JSON.stringify({
      action: "created",
      repository: { name: "r", owner: { login: "o" } },
      // No pull_request sub-object → this is a plain GitHub issue, not a PR.
      issue: { number: 7, user: { login: "alice", id: 1 } },
      comment: { id: 555, body: "@acme-bot fix", user: { login: "alice", id: 1 } },
    });
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(200);
    expect(fetchOrgMembers).not.toHaveBeenCalled();
    expect(findByPrUrl).not.toHaveBeenCalled();
    expect(enqueueComment).not.toHaveBeenCalled();
  });

  it("rejects a submitted review from an outside contributor with 403", async () => {
    const body = JSON.stringify({
      action: "submitted",
      repository: { name: "r", owner: { login: "o" } },
      pull_request: { number: 7, user: { login: "acme-bot[bot]" } },
      review: { id: 88, body: "lgtm", user: { login: "outsider", id: 99 } },
    });
    const res = await post(body, "pull_request_review", sign(body));
    expect(res.status).toBe(403);
    expect(enqueueReview).not.toHaveBeenCalled();
    expect(getReviewComments).not.toHaveBeenCalled();
  });

  it("ignores a comment on a non-bot-opened PR before any trust/DB work", async () => {
    // PR opener is a human — harness only acts on PRs it opened itself, so
    // this short-circuits before fetchOrgMembers and findByPrUrl run.
    const body = commentBody("alice", "human-author");
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueComment).not.toHaveBeenCalled();
    expect(fetchOrgMembers).not.toHaveBeenCalled();
    expect(findByPrUrl).not.toHaveBeenCalled();
  });

  it("ignores the controller's own bot comments before any trust/DB work", async () => {
    // GitHub Apps surface user.login as `<app-name>[bot]` in webhook payloads.
    // The bot-self-check short-circuits before the trust gate, so the org
    // fetch is never even triggered.
    const body = JSON.stringify({
      action: "created",
      repository: { name: "r", owner: { login: "o" } },
      issue: { number: 7, pull_request: { url: "x" } },
      comment: { id: 1, body: "@acme-bot", user: { login: "acme-bot[bot]" } },
    });
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueComment).not.toHaveBeenCalled();
    expect(fetchOrgMembers).not.toHaveBeenCalled();
    expect(findByPrUrl).not.toHaveBeenCalled();
  });

  it("ignores a comment whose PR maps to no task", async () => {
    findByPrUrl.mockResolvedValue(null);
    const body = commentBody();
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueComment).not.toHaveBeenCalled();
  });

  it("ignores a submitted review when neither body nor fetched inlines mention the bot", async () => {
    getReviewComments.mockResolvedValue([
      { id: 11, path: "a.ts", line: 3, startLine: 1, body: "nit", user: { login: "reviewer" } },
      { id: 12, path: "b.ts", line: 9, body: "rename", user: { login: "reviewer" } },
    ]);
    const body = JSON.stringify({
      action: "submitted",
      repository: { name: "r", owner: { login: "o" } },
      pull_request: { number: 7, user: { login: "acme-bot[bot]" } },
      review: { id: 88, body: "looks good", user: { login: "a", id: 2 } },
    });
    const res = await post(body, "pull_request_review", sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "no mention" });
    expect(getReviewComments).toHaveBeenCalledWith("o", "r", 7, 88);
    expect(enqueueReview).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(addReviewCommentReaction).not.toHaveBeenCalled();
  });

  it("enqueues a submitted review body mention with all non-bot inline comments", async () => {
    getReviewComments.mockResolvedValue([
      { id: 11, path: "a.ts", line: 3, startLine: 1, body: "nit", user: { login: "reviewer" } },
      { id: 12, path: "b.ts", line: 9, body: "rename", user: { login: "reviewer" } },
      {
        id: 13,
        path: "bot.ts",
        line: 1,
        body: "@acme-bot bot-authored echo",
        user: { login: "acme-bot[bot]" },
      },
    ]);
    const body = JSON.stringify({
      action: "submitted",
      repository: { name: "r", owner: { login: "o" } },
      pull_request: { number: 7, user: { login: "acme-bot[bot]" } },
      review: {
        id: 88,
        body: "@acme-bot please handle this review",
        user: { login: "a", id: 2 },
        submitted_at: "2026-04-23T12:00:00Z",
      },
    });
    const res = await post(body, "pull_request_review", sign(body));
    expect(res.status).toBe(200);
    expect(getReviewComments).toHaveBeenCalledWith("o", "r", 7, 88);
    expect(enqueueReview).toHaveBeenCalledTimes(1);
    expect(enqueueReview).toHaveBeenCalledWith({
      task: linearTask,
      reviewId: 88,
      reviewBody: "@acme-bot please handle this review",
      inlineComments: [
        { id: 11, path: "a.ts", line: 3, startLine: 1, body: "nit", user: { login: "reviewer" } },
        { id: 12, path: "b.ts", line: 9, body: "rename", user: { login: "reviewer" } },
      ],
      owner: "o",
      repo: "r",
      prNumber: 7,
      reviewerLogin: "a",
      createdAt: "2026-04-23T12:00:00Z",
    });
    await flushMicrotasks();
    // 👀 fires once per processed inline; review_body has no reactions API.
    expect(addReviewCommentReaction).toHaveBeenCalledTimes(2);
    expect(addReviewCommentReaction).toHaveBeenCalledWith("o", "r", 11, "eyes");
    expect(addReviewCommentReaction).toHaveBeenCalledWith("o", "r", 12, "eyes");
  });

  it("a redelivered review refetches its inline comments, enqueues and reacts again", async () => {
    getReviewComments.mockResolvedValue([
      { id: 11, path: "a.ts", line: 3, body: "nit", user: { login: "reviewer" } },
    ]);
    const body = JSON.stringify({
      action: "submitted",
      repository: { name: "r", owner: { login: "o" } },
      pull_request: { number: 7, user: { login: "acme-bot[bot]" } },
      review: {
        id: 88,
        body: "@acme-bot please handle this review",
        user: { login: "a", id: 2 },
        submitted_at: "2026-04-23T12:00:00Z",
      },
    });
    expect((await post(body, "pull_request_review", sign(body))).status).toBe(200);
    expect((await post(body, "pull_request_review", sign(body))).status).toBe(200);
    await flushMicrotasks();
    expect(getReviewComments).toHaveBeenCalledTimes(2);
    expect(enqueueReview).toHaveBeenCalledTimes(2);
    expect(addReviewCommentReaction).toHaveBeenCalledTimes(2);
  });

  it("enqueues a review on an API task's PR without parsing its URL", async () => {
    findByPrUrl.mockResolvedValue(apiTask);
    const body = JSON.stringify({
      action: "submitted",
      repository: { name: "r", owner: { login: "o" } },
      pull_request: { number: 7, user: { login: "acme-bot[bot]" } },
      review: {
        id: 88,
        body: "@acme-bot please handle this review",
        user: { login: "a", id: 2 },
        submitted_at: "2026-04-23T12:00:00Z",
      },
    });
    const res = await post(body, "pull_request_review", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueReview).toHaveBeenCalledWith(expect.objectContaining({ task: apiTask }));
  });

  it("enqueues only mentioning inline comments and blanks the review body for inline-only mentions", async () => {
    getReviewComments.mockResolvedValue([
      {
        id: 11,
        path: "a.ts",
        line: 3,
        startLine: 1,
        body: "@acme-bot fix this range",
        user: { login: "reviewer" },
      },
      { id: 12, path: "b.ts", line: 9, body: "rename", user: { login: "reviewer" } },
      {
        id: 13,
        path: "c.ts",
        line: 14,
        body: "Can @ACME-BOT take this one?",
        user: { login: "reviewer" },
      },
    ]);
    const body = JSON.stringify({
      action: "submitted",
      repository: { name: "r", owner: { login: "o" } },
      pull_request: { number: 7, user: { login: "acme-bot[bot]" } },
      review: {
        id: 88,
        body: "batch notes",
        user: { login: "a", id: 2 },
        submitted_at: "2026-04-23T13:00:00Z",
      },
    });
    const res = await post(body, "pull_request_review", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueReview).toHaveBeenCalledTimes(1);
    expect(enqueueReview).toHaveBeenCalledWith({
      task: linearTask,
      reviewId: 88,
      reviewBody: "",
      inlineComments: [
        {
          id: 11,
          path: "a.ts",
          line: 3,
          startLine: 1,
          body: "@acme-bot fix this range",
          user: { login: "reviewer" },
        },
        {
          id: 13,
          path: "c.ts",
          line: 14,
          body: "Can @ACME-BOT take this one?",
          user: { login: "reviewer" },
        },
      ],
      owner: "o",
      repo: "r",
      prNumber: 7,
      reviewerLogin: "a",
      createdAt: "2026-04-23T13:00:00Z",
    });
    await flushMicrotasks();
    expect(addReviewCommentReaction).toHaveBeenCalledTimes(2);
    expect(addReviewCommentReaction).toHaveBeenCalledWith("o", "r", 11, "eyes");
    expect(addReviewCommentReaction).toHaveBeenCalledWith("o", "r", 13, "eyes");
  });

  it("ignores a pull_request event (not handled today)", async () => {
    const body = JSON.stringify({
      action: "closed",
      repository: { name: "r", owner: { login: "o" } },
      pull_request: { number: 7, merged: true, user: { login: "acme-bot[bot]" } },
      sender: { login: "a", id: 2 },
    });
    const res = await post(body, "pull_request", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueComment).not.toHaveBeenCalled();
    expect(enqueueReview).not.toHaveBeenCalled();
  });

  const workflowRunBody = (
    conclusion = "failure",
    prNumbers = [42],
    senderId = 1,
    senderLogin = "alice",
  ) =>
    JSON.stringify({
      action: "completed",
      repository: { name: "r", owner: { login: "o" } },
      workflow_run: {
        id: 123456789,
        run_attempt: 1,
        name: "CI",
        head_branch: "devbox/XYZ-1234-fix",
        head_sha: "abc123",
        status: "completed",
        conclusion,
        html_url: "https://github.com/o/r/actions/runs/123456789",
        pull_requests: prNumbers.map((n) => ({ number: n })),
      },
      workflow: { id: 789, name: "CI", path: ".github/workflows/ci.yml" },
      sender: { login: senderLogin, id: senderId },
    });

  it("returns 401 on workflow_run with missing or bad workflow-run signature", async () => {
    const body = workflowRunBody();
    const missing = await post(body, "workflow_run");
    expect(missing.status).toBe(401);
    expect(enqueueCiResult).not.toHaveBeenCalled();

    const bad = await post(body, "workflow_run", sign(body, "bad-secret"));
    expect(bad.status).toBe(401);
    expect(enqueueCiResult).not.toHaveBeenCalled();
  });

  it("enqueues ci_result for a failed workflow_run on a known PR", async () => {
    const body = workflowRunBody();
    const res = await post(body, "workflow_run", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueCiResult).toHaveBeenCalledTimes(1);
    expect(enqueueCiResult.mock.calls[0]?.[0]).toMatchObject({
      task: linearTask,
      runId: 123456789,
      runAttempt: 1,
      conclusion: "failure",
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      owner: "o",
      repo: "r",
      prNumber: 42,
    });
  });

  it("enqueues ci_result on an API task's PR without parsing its URL", async () => {
    findByPrUrl.mockResolvedValue(apiTask);
    const body = workflowRunBody();
    const res = await post(body, "workflow_run", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueCiResult).toHaveBeenCalledWith(expect.objectContaining({ task: apiTask }));
  });

  it("enqueues ci_result for a bot-triggered workflow_run (sender is the bot)", async () => {
    // Real-world case: harness pushed to its own PR, so the workflow_run's
    // sender IS the bot (login acme-bot[bot], id = botUserId). The bot-self
    // loop guard must NOT drop this — it's the CI result we want to forward.
    const body = workflowRunBody("failure", [42], 7, "acme-bot[bot]");
    const res = await post(body, "workflow_run", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueCiResult).toHaveBeenCalledTimes(1);
  });

  it("ignores workflow_run with success conclusion", async () => {
    const body = workflowRunBody("success");
    const res = await post(body, "workflow_run", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueCiResult).not.toHaveBeenCalled();
  });

  it("ignores workflow_run with non-completed action", async () => {
    const body = JSON.stringify({
      action: "requested",
      repository: { name: "r", owner: { login: "o" } },
      workflow_run: {
        id: 1,
        name: "CI",
        head_branch: "b",
        head_sha: "x",
        status: "in_progress",
        conclusion: null,
        html_url: "u",
        pull_requests: [{ number: 42 }],
      },
      workflow: { path: ".github/workflows/ci.yml" },
      sender: { login: "alice", id: 1 },
    });
    const res = await post(body, "workflow_run", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueCiResult).not.toHaveBeenCalled();
  });

  it("ignores workflow_run on a PR not tracked by harness", async () => {
    findByPrUrl.mockResolvedValue(null);
    const body = workflowRunBody();
    const res = await post(body, "workflow_run", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueCiResult).not.toHaveBeenCalled();
  });

  it("rejects workflow_run from untrusted sender with 403", async () => {
    const body = workflowRunBody("success", [42], 99);
    const res = await post(body, "workflow_run", sign(body));
    expect(res.status).toBe(403);
    expect(enqueueCiResult).not.toHaveBeenCalled();
  });

  it("enqueues ci_result for each matched PR when workflow_run has multiple pull_requests", async () => {
    let callCount = 0;
    findByPrUrl.mockImplementation((_url: string) => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve({ ...linearTask, id: `task-${callCount}` });
      }
      return Promise.resolve(null);
    });
    const body = workflowRunBody("failure", [42, 43]);
    const res = await post(body, "workflow_run", sign(body));
    expect(res.status).toBe(200);
    expect(enqueueCiResult).toHaveBeenCalledTimes(2);
    expect(enqueueCiResult.mock.calls[0]?.[0]).toMatchObject({ prNumber: 42 });
    expect(enqueueCiResult.mock.calls[1]?.[0]).toMatchObject({ prNumber: 43 });
  });

  it("ignores workflow_run when ciResultEnabled flag is off", async () => {
    // Rebuild the app with the feature flag disabled.
    const { GitHubWebhookController: Ctrl } = await import("../githubWebhook.controller");
    mock.module("../../config", () => ({
      config: {
        podId: "pod-test",
        github: { ciResultEnabled: false },
      },
    }));
    const flagOffEnqueueCiResult = mock(() => Promise.resolve());
    const flagOffFindByPrUrl = mock(() => Promise.resolve(linearTask));
    const flagOffService = {
      enqueueComment: mock(() => Promise.resolve()),
      enqueueReview: mock(() => Promise.resolve()),
      enqueueCiResult: flagOffEnqueueCiResult,
    } as unknown as InboxService;
    const flagOffIntake = { findTaskByPrUrl: flagOffFindByPrUrl } as unknown as TaskIntake;
    fetchOrgMembers.mockResolvedValue(new Set([1, 2, 3]) as ReadonlySet<number>);
    const flagOffApp = new Hono();
    flagOffApp.post("/webhook/github", (c) =>
      new Ctrl(flagOffService, flagOffIntake, SETTINGS).handleWebhook(c),
    );

    const body = workflowRunBody();
    const res = await flagOffApp.request("/webhook/github", {
      method: "POST",
      headers: { "x-github-event": "workflow_run", "x-hub-signature-256": sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(flagOffEnqueueCiResult).not.toHaveBeenCalled();

    // Restore flag for remaining tests.
    mock.module("../../config", () => ({
      config: {
        podId: "pod-test",
        github: { ciResultEnabled: true },
      },
    }));
  });

  it("loads the trusted-org member set once across many webhooks", async () => {
    const body = commentBody("alice");
    const sig = sign(body);
    // Fire several requests; fetchOrgMembers should be called exactly once.
    await Promise.all([
      post(body, "issue_comment", sig),
      post(body, "issue_comment", sig),
      post(body, "issue_comment", sig),
    ]);
    expect(fetchOrgMembers).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when the member fetch fails, and retries on the next webhook", async () => {
    // First call rejects → 503. The catch path clears the cached promise so the
    // next webhook re-triggers the fetch (now resolves with the default set).
    fetchOrgMembers.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    const body = commentBody("alice");
    const sig = sign(body);

    const first = await post(body, "issue_comment", sig);
    expect(first.status).toBe(503);
    expect(enqueueComment).not.toHaveBeenCalled();

    const second = await post(body, "issue_comment", sig);
    expect(second.status).toBe(200);
    expect(enqueueComment).toHaveBeenCalledTimes(1);
    expect(fetchOrgMembers).toHaveBeenCalledTimes(2);
  });

  it("returns 503 when the member fetch resolves to an empty set", async () => {
    fetchOrgMembers.mockImplementationOnce(() =>
      Promise.resolve(new Set<number>() as ReadonlySet<number>),
    );
    const body = commentBody("alice");
    const res = await post(body, "issue_comment", sign(body));
    expect(res.status).toBe(503);
    expect(enqueueComment).not.toHaveBeenCalled();
  });

  describe("lastWebhookAt and rejection logs", () => {
    const postWithDelivery = (body: string, event: string, signature?: string) =>
      app.request("/webhook/github", {
        method: "POST",
        headers: {
          "x-github-event": event,
          "x-github-delivery": "delivery-1",
          ...(signature ? { "x-hub-signature-256": signature } : {}),
        },
        body,
      });
    const asApp = (login: string, id: number, prOpener = "acme-bot[bot]") => {
      const parsed = JSON.parse(commentBody("alice", prOpener)) as {
        comment: { user: { login: string; id: number } };
      };
      parsed.comment.user = { login, id };
      return JSON.stringify(parsed);
    };

    it("is null before any webhook and after an unsigned or badly signed one", async () => {
      expect(controller.lastWebhookAt()).toBeNull();
      await postWithDelivery(commentBody(), "issue_comment");
      await postWithDelivery(commentBody(), "issue_comment", sign(commentBody(), "wrong"));
      expect(controller.lastWebhookAt()).toBeNull();
    });

    it("is set once the HMAC is valid, even when the event is later rejected", async () => {
      const body = asApp("other-app[bot]", 4242);
      expect((await postWithDelivery(body, "issue_comment", sign(body))).status).toBe(403);
      expect(controller.lastWebhookAt()).toBe(new Date(1_000_000).toISOString());
      clock.now = 2_000_000;
      const ok = commentBody("alice");
      await postWithDelivery(ok, "issue_comment", sign(ok));
      expect(controller.lastWebhookAt()).toBe(new Date(2_000_000).toISOString());
    });

    it("logs github_webhook.rejected with reason signature", async () => {
      const info = spyOn(logger, "info").mockImplementation(() => logger);
      await postWithDelivery(commentBody(), "issue_comment", sign(commentBody(), "wrong"));
      expect(info.mock.calls).toEqual([
        [
          "github_webhook.rejected",
          { event: "issue_comment", deliveryId: "delivery-1", reason: "signature" },
        ],
      ]);
      info.mockRestore();
    });

    it("logs reason self_event for the bot's own comment", async () => {
      const info = spyOn(logger, "info").mockImplementation(() => logger);
      const body = asApp("acme-bot[bot]", 7);
      expect((await postWithDelivery(body, "issue_comment", sign(body))).status).toBe(200);
      expect(info.mock.calls).toEqual([
        [
          "github_webhook.rejected",
          { event: "issue_comment", deliveryId: "delivery-1", reason: "self_event" },
        ],
      ]);
      info.mockRestore();
    });

    it("logs reason not_bot_pr for a PR somebody else opened", async () => {
      const info = spyOn(logger, "info").mockImplementation(() => logger);
      const body = commentBody("alice", "human-author");
      expect((await postWithDelivery(body, "issue_comment", sign(body))).status).toBe(200);
      expect(info.mock.calls).toEqual([
        [
          "github_webhook.rejected",
          { event: "issue_comment", deliveryId: "delivery-1", reason: "not_bot_pr" },
        ],
      ]);
      info.mockRestore();
    });

    it("logs reason not_trusted for a signed comment from another App on the bot's PR", async () => {
      const info = spyOn(logger, "info").mockImplementation(() => logger);
      const body = asApp("other-app[bot]", 4242);
      expect((await postWithDelivery(body, "issue_comment", sign(body))).status).toBe(403);
      expect(enqueueComment).not.toHaveBeenCalled();
      expect(info.mock.calls).toEqual([
        [
          "github_webhook.rejected",
          { event: "issue_comment", deliveryId: "delivery-1", reason: "not_trusted" },
        ],
      ]);
      info.mockRestore();
    });

    it("does not log a rejection for an accepted webhook", async () => {
      const info = spyOn(logger, "info").mockImplementation(() => logger);
      const body = commentBody("alice");
      expect((await postWithDelivery(body, "issue_comment", sign(body))).status).toBe(200);
      expect(info).not.toHaveBeenCalled();
      info.mockRestore();
    });
  });

  describe("actor trust", () => {
    const rebuild = (settings: Partial<typeof SETTINGS>) => {
      const inboxService = {
        enqueueComment,
        enqueueReview,
        enqueueCiResult,
      } as unknown as InboxService;
      const intake = { findTaskByPrUrl: findByPrUrl } as unknown as TaskIntake;
      controller = new GitHubWebhookController(
        inboxService,
        intake,
        { ...SETTINGS, ...settings },
        () => clock.now,
      );
      const a = new Hono();
      a.post("/webhook/github", (c) => controller.handleWebhook(c));
      app = a;
    };

    const asUser = (login: string, id: number) => {
      const parsed = JSON.parse(commentBody("alice")) as {
        comment: { user: { login: string; id: number } };
      };
      parsed.comment.user = { login, id };
      return JSON.stringify(parsed);
    };

    it("accepts a trusted user's comment with no trusted orgs and ignores a stranger's", async () => {
      rebuild({ trustedOrgs: [], trustedUsers: ["carol"] });
      getUserIdByLogin.mockImplementation((login: string) =>
        Promise.resolve(login === "carol" ? 50 : null),
      );

      const trusted = asUser("carol", 50);
      expect((await post(trusted, "issue_comment", sign(trusted))).status).toBe(200);
      expect(enqueueComment).toHaveBeenCalledTimes(1);

      const stranger = asUser("mallory", 999);
      expect((await post(stranger, "issue_comment", sign(stranger))).status).toBe(403);
      expect(enqueueComment).toHaveBeenCalledTimes(1);
      expect(fetchOrgMembers).not.toHaveBeenCalled();
    });

    it("matches a trusted user by numeric id, not by login", async () => {
      rebuild({ trustedOrgs: [], trustedUsers: ["carol"] });
      getUserIdByLogin.mockResolvedValue(50);
      // Someone who took the login "carol" later has a different id.
      const impostor = asUser("carol", 51);
      expect((await post(impostor, "issue_comment", sign(impostor))).status).toBe(403);
      expect(enqueueComment).not.toHaveBeenCalled();
    });

    it("accepts a member of any trusted org", async () => {
      rebuild({ trustedOrgs: ["acme", "widgets"] });
      fetchOrgMembers.mockImplementation(((org: string) =>
        Promise.resolve(new Set(org === "widgets" ? [77] : [1]) as ReadonlySet<number>)) as never);
      const body = asUser("dave", 77);
      expect((await post(body, "issue_comment", sign(body))).status).toBe(200);
      expect(fetchOrgMembers).toHaveBeenCalledTimes(2);
      expect(enqueueComment).toHaveBeenCalledTimes(1);
    });

    it("skips an unresolvable trusted user and still trusts the orgs", async () => {
      rebuild({ trustedOrgs: ["acme"], trustedUsers: ["typo-login"] });
      getUserIdByLogin.mockResolvedValue(null);
      const body = commentBody("alice");
      expect((await post(body, "issue_comment", sign(body))).status).toBe(200);
    });

    it("returns 503 when the user lookup fails, then retries", async () => {
      rebuild({ trustedOrgs: [], trustedUsers: ["carol"] });
      getUserIdByLogin.mockRejectedValueOnce(new Error("boom"));
      getUserIdByLogin.mockResolvedValue(50);
      const body = asUser("carol", 50);
      expect((await post(body, "issue_comment", sign(body))).status).toBe(503);
      expect((await post(body, "issue_comment", sign(body))).status).toBe(200);
    });

    it("returns 503 when only users are configured and none resolves", async () => {
      rebuild({ trustedOrgs: [], trustedUsers: ["ghost"] });
      getUserIdByLogin.mockResolvedValue(null);
      const body = asUser("ghost", 5);
      expect((await post(body, "issue_comment", sign(body))).status).toBe(503);
    });

    it("resolves each trusted user once while the cache is fresh, and again after the TTL", async () => {
      rebuild({ trustedOrgs: [], trustedUsers: ["carol"] });
      getUserIdByLogin.mockResolvedValue(50);
      const body = asUser("carol", 50);
      await Promise.all([
        post(body, "issue_comment", sign(body)),
        post(body, "issue_comment", sign(body)),
      ]);
      clock.now += 6 * 60 * 60 * 1000 - 1;
      await post(body, "issue_comment", sign(body));
      expect(getUserIdByLogin).toHaveBeenCalledTimes(1);
      clock.now += 2;
      await post(body, "issue_comment", sign(body));
      expect(getUserIdByLogin).toHaveBeenCalledTimes(2);
    });

    it("still exempts the bot's own workflow_run when only users are trusted", async () => {
      rebuild({ trustedOrgs: [], trustedUsers: ["carol"] });
      getUserIdByLogin.mockResolvedValue(50);
      const body = workflowRunBody("failure", [42], 7, "acme-bot[bot]");
      expect((await post(body, "workflow_run", sign(body))).status).toBe(200);
      expect(enqueueCiResult).toHaveBeenCalledTimes(1);
    });
  });
});
