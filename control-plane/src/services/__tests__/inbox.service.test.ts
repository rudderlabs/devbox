import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Task } from "../../db/schema";
import type { InboxRepository, InboxRow } from "../../repositories/inbox.repository";
import type { LinearTokenProvider } from "../linearTokenProvider";
import type { SandboxManager } from "../sandboxManager.service";

// Pin the two config values InboxService reads (podId, the ci_result cap) so
// results do not depend on the environment the suite runs in.
mock.module("../../config", () => ({
  config: {
    podId: "pod-test",
    github: { ciResultMaxPerTask: 20 },
  },
}));

const emitAction = mock(() => Promise.resolve());
const emitError = mock(() => Promise.resolve());
const emitResponse = mock(() => Promise.resolve());
const emitThought = mock(() => Promise.resolve());
const setIssueStarted = mock(() => Promise.resolve());
const attachUrlToIssue = mock(() => Promise.resolve());
const uploadIssueAttachment = mock(() => Promise.resolve());

mock.module("../../clients/linear", () => ({
  emitAction,
  emitError,
  emitResponse,
  emitThought,
  setIssueStarted,
  attachUrlToIssue,
  uploadIssueAttachment,
  getIssueHumanAssignee: mock(() => Promise.resolve(null)),
  parseLinearIssueIdentifier: (url: string | null | undefined): string | null => {
    if (!url) return null;
    const m = url.match(/\/issue\/([^/?#]+)/);
    return m?.[1] ? m[1].toUpperCase() : null;
  },
  requireLinearTicketId: (url: string | null | undefined): string => {
    if (!url) throw new Error("expected Linear URL");
    const m = url.match(/\/issue\/([^/?#]+)/);
    if (!m?.[1]) throw new Error("expected Linear URL");
    return m[1].toUpperCase();
  },
}));

const addIssueCommentReaction = mock(() => Promise.resolve());
const addReviewCommentReaction = mock(() => Promise.resolve());
const postIssueComment = mock(() => Promise.resolve({ id: 1, url: "u" }));
const postReviewCommentReply = mock(() => Promise.resolve({ id: 1, url: "u" }));

// Mock the full export surface of the ../../clients/github barrel. bun's
// mock.module is process-global; the module split alone did NOT contain it --
// in CI this mock reached github.test.ts and failed 25 of its tests. The suite
// now runs with --isolate (package.json "test"), which gives every file a fresh
// module registry, so this cannot leak. Do not drop that flag.
mock.module("../../clients/github", () => ({
  addIssueCommentReaction,
  addReviewCommentReaction,
  postIssueComment,
  postReviewCommentReply,
  getReviewComments: mock(() => Promise.resolve([])),
  fetchOrgMembers: mock(() => Promise.resolve(new Set())),
  addPrAssignees: mock(() => Promise.resolve({ assigned: [] })),
  getUserById: mock(() => Promise.resolve({ login: "", id: 0 })),
  getUserIdByLogin: mock(() => Promise.resolve(null)),
  requestReviewers: mock(() => Promise.resolve()),
  parsePrUrl: () => null,
}));

const { InboxService, WORKSPACE_MISSING_MESSAGE } = await import("../inbox.service");

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  source: "linear",
  externalId: "issue-1",
  key: "XYZ-1",
  createdBy: null,
  title: "t",
  externalUrl: "https://linear.app/x/issue/XYZ-1",
  metadata: {},
  ownerId: "pod-test",
  heartbeatAt: new Date(),
  sandboxId: "sbx-1",
  pvcName: "pvc-1",
  prUrls: [],
  lastObservedEventSeq: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const ghCommentRow = (id: string): InboxRow => ({
  id,
  task_id: "task-1",
  source: "github",
  external_id: `ext-${id}`,
  kind: "comment",
  payload: {
    target_id: `ext-${id}`,
    body: "fix this",
    task_id: "task-1",
    task_key: "XYZ-1",
    pr: { repo: "r", pr_url: "https://github.com/o/r/pull/7" },
    created_at: "",
  },
  reply_targets: [
    {
      id: `ext-${id}`,
      spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 7, commentId: 555 },
    },
  ],
  status: "pending",
  failure_reason: null,
  outcome: null,
  created_at: new Date(),
  updated_at: new Date(),
});

describe("InboxService", () => {
  let inboxRepo: InboxRepository;
  let sandboxManager: SandboxManager;
  let linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">;
  let listPendingByTask: ReturnType<typeof mock>;
  let listNonTerminalByTask: ReturnType<typeof mock>;
  let markDelivered: ReturnType<typeof mock>;
  let markFailed: ReturnType<typeof mock>;
  let appendInbox: ReturnType<typeof mock>;
  let countCiResultsByTask: ReturnType<typeof mock>;
  let writeHarnessFile: ReturnType<typeof mock>;
  let killSandbox: ReturnType<typeof mock>;
  let getById: ReturnType<typeof mock>;
  let service: InstanceType<typeof InboxService>;

  beforeEach(() => {
    for (const m of [
      emitAction,
      emitError,
      emitResponse,
      setIssueStarted,
      addIssueCommentReaction,
      addReviewCommentReaction,
    ]) {
      m.mockReset();
      m.mockResolvedValue(undefined);
    }
    postIssueComment.mockReset();
    postIssueComment.mockResolvedValue({ id: 1, url: "u" });
    postReviewCommentReply.mockReset();
    postReviewCommentReply.mockResolvedValue({ id: 1, url: "u" });

    listPendingByTask = mock(() => Promise.resolve([] as InboxRow[]));
    listNonTerminalByTask = mock(() => Promise.resolve([] as InboxRow[]));
    markDelivered = mock(() => Promise.resolve());
    markFailed = mock(() => Promise.resolve([{ id: "x" }]));
    appendInbox = mock(() => Promise.resolve({ id: "inbox-new" }));
    countCiResultsByTask = mock(() => Promise.resolve(0));
    getById = mock((id: string) => Promise.resolve(ghCommentRow(id)));
    inboxRepo = {
      listPendingByTask,
      listNonTerminalByTask,
      getById,
      markDelivered,
      markFailed,
      appendInbox,
      countCiResultsByTask,
    } as unknown as InboxRepository;

    writeHarnessFile = mock(() => Promise.resolve());
    killSandbox = mock(() => Promise.resolve());
    sandboxManager = {
      writeHarnessFile,
      killSandbox,
    } as unknown as SandboxManager;

    linearTokenProvider = {
      getAuthorizedLinearClient: mock(() => Promise.resolve({})),
    } as unknown as Pick<LinearTokenProvider, "getAuthorizedLinearClient">;

    service = new InboxService(inboxRepo, sandboxManager, linearTokenProvider);
  });

  describe("sweepUndelivered", () => {
    it("does nothing when there are no pending rows", async () => {
      await service.sweepUndelivered(makeTask());
      expect(writeHarnessFile).not.toHaveBeenCalled();
    });

    it("writes each pending row and marks it delivered when the sandbox is alive", async () => {
      listPendingByTask.mockResolvedValue([ghCommentRow("a"), ghCommentRow("b")]);

      await service.sweepUndelivered(makeTask());

      expect(writeHarnessFile).toHaveBeenCalledTimes(2);
      const firstCall = writeHarnessFile.mock.calls[0] as unknown as [string, string, string];
      expect(firstCall[0]).toBe("sbx-1");
      expect(firstCall[1]).toBe("inbox/a.json");
      const written = JSON.parse(firstCall[2]) as { id: string; reply_targets?: unknown };
      expect(written.id).toBe("a");
      // reply_targets must NOT be written to the sandbox file.
      expect(written.reply_targets).toBeUndefined();
      expect(markDelivered).toHaveBeenCalledTimes(2);
    });

    it("throws when the task has no attached sandbox (caller must recreate first)", async () => {
      listPendingByTask.mockResolvedValue([ghCommentRow("a")]);

      await expect(service.sweepUndelivered(makeTask({ sandboxId: null }))).rejects.toThrow(
        "no sandbox to deliver to",
      );
      expect(writeHarnessFile).not.toHaveBeenCalled();
    });

    it("logs and rethrows when writeHarnessFile fails", async () => {
      listPendingByTask.mockResolvedValue([ghCommentRow("a")]);
      writeHarnessFile.mockImplementation(() => Promise.reject(new Error("write boom")));

      await expect(service.sweepUndelivered(makeTask())).rejects.toThrow("write boom");
      expect(markDelivered).not.toHaveBeenCalled();
    });
  });

  describe("deadLetterWorkspaceMissing", () => {
    it("dead-letters every open row when the PVC has been pruned", async () => {
      listNonTerminalByTask.mockResolvedValue([ghCommentRow("a")]);

      await service.deadLetterWorkspaceMissing(makeTask({ sandboxId: null }));

      expect(postIssueComment).toHaveBeenCalledTimes(1);
      expect(addIssueCommentReaction).toHaveBeenCalledWith("o", "r", 555, "confused");
      expect(markFailed).toHaveBeenCalledWith({
        inboxId: "a",
        ownerId: "pod-test",
        reason: "workspace_missing",
        userMessage: WORKSPACE_MISSING_MESSAGE,
      });
    });

    it("API rows: no Linear or GitHub post, row failed with the user message", async () => {
      const row = {
        ...ghCommentRow("r1"),
        source: "api",
        reply_targets: [{ id: "task-1", spec: { kind: "api_session" } }],
      } as InboxRow;
      listNonTerminalByTask.mockResolvedValue([row]);
      getById.mockResolvedValue(row);
      await service.deadLetterWorkspaceMissing(makeTask({ source: "api", sandboxId: null }));
      expect(emitError).not.toHaveBeenCalled();
      expect(postIssueComment).not.toHaveBeenCalled();
      expect(markFailed).toHaveBeenCalledWith({
        inboxId: "r1",
        ownerId: "pod-test",
        reason: "workspace_missing",
        userMessage: WORKSPACE_MISSING_MESSAGE,
      });
    });

    it("suppresses the workspace-missing signal after reassignment supersedes the row", async () => {
      listNonTerminalByTask.mockResolvedValue([
        {
          id: "a",
          task_id: "task-1",
          source: "linear",
          external_id: "activity-1",
          kind: "comment",
          payload: {
            target_id: "sess-old",
            body: "follow-up",
            task_key: "XYZ-1",
            pr: null,
          },
          reply_targets: [{ id: "sess-old", spec: { kind: "linear_session" } }],
          status: "pending",
          failure_reason: null,
          outcome: null,
          created_at: new Date(),
          updated_at: new Date(),
        } as InboxRow,
      ]);
      // The re-check from DB finds the row already superseded → skip it.
      getById.mockResolvedValueOnce({
        id: "a",
        task_id: "task-1",
        source: "linear",
        external_id: "activity-1",
        kind: "comment",
        payload: { target_id: "sess-old", body: "follow-up", task_key: "XYZ-1", pr: null },
        reply_targets: [{ id: "sess-old", spec: { kind: "linear_session" } }],
        status: "failed",
        failure_reason: "superseded by re-delegation",
        created_at: new Date(),
        updated_at: new Date(),
      });

      await service.deadLetterWorkspaceMissing(makeTask({ sandboxId: null }));

      expect(postIssueComment).not.toHaveBeenCalled();
      expect(addIssueCommentReaction).not.toHaveBeenCalled();
      expect(emitError).not.toHaveBeenCalled();
      expect(markFailed).not.toHaveBeenCalled();
    });
  });

  describe("enqueueComment", () => {
    it("appends a kind='comment' row and fires a 👀 reaction", async () => {
      await service.enqueueComment({
        task: makeTask(),
        commentId: 555,
        body: "@harness fix this",
        spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 7, commentId: 555 },
        createdAt: "2026-04-23T10:00:00Z",
      });

      const arg = appendInbox.mock.calls[0]?.[0] as {
        message: {
          source: string;
          kind: string;
          external_id: string;
          payload: { target_id: string; task_key: string; created_at: string };
        };
        replyTargets: Array<{ id: string }>;
      };
      expect(arg.message.source).toBe("github");
      expect(arg.message.kind).toBe("comment");
      expect(arg.message.external_id).toBe("555");
      expect(arg.message.payload.target_id).toBe("555");
      expect(arg.message.payload).toMatchObject({
        task_id: "task-1",
        task_key: "XYZ-1",
      });
      // The comment's created_at is carried into the payload for temporal scoping.
      expect(arg.message.payload.created_at).toBe("2026-04-23T10:00:00Z");
      expect(arg.replyTargets[0]?.id).toBe("555");
    });
  });

  describe("enqueueReview", () => {
    it("appends a kind='review' row with N+1 reply targets", async () => {
      await service.enqueueReview({
        task: makeTask(),
        reviewId: 999,
        reviewBody: "looks good overall",
        inlineComments: [
          { id: 11, path: "a.ts", line: 3, startLine: 1, body: "nit" },
          { id: 12, path: "b.ts", line: 9, body: "rename" },
        ],
        owner: "o",
        repo: "r",
        prNumber: 7,
        reviewerLogin: "reviewer",
        createdAt: "2026-04-23T10:00:00Z",
      });

      const arg = appendInbox.mock.calls[0]?.[0] as {
        message: {
          kind: string;
          payload: {
            created_at: string;
            reviewer_login?: string;
            pr: { owner?: string; repo: string; prNumber?: number; pr_url: string };
            inline_comments: Array<{
              target_id: string;
              path: string;
              line: number;
              start_line?: number;
              body: string;
            }>;
          };
        };
        replyTargets: Array<{
          id: string;
          spec: {
            kind: string;
            startLine?: number;
          };
        }>;
      };
      expect(arg.message.kind).toBe("review");
      // The review's submitted_at is carried into the payload for temporal scoping.
      expect(arg.message.payload.created_at).toBe("2026-04-23T10:00:00Z");
      expect(arg.message.payload.reviewer_login).toBe("reviewer");
      expect(arg.message.payload.pr).toEqual({
        owner: "o",
        repo: "r",
        prNumber: 7,
        pr_url: "https://github.com/o/r/pull/7",
      });
      // 2 inline + 1 review_body
      expect(arg.replyTargets).toHaveLength(3);
      expect(arg.message.payload.inline_comments[0]).toMatchObject({
        target_id: "11",
        path: "a.ts",
        line: 3,
        start_line: 1,
      });
      expect(arg.message.payload.inline_comments[1]?.start_line).toBeUndefined();
      expect(arg.replyTargets[0]).toMatchObject({
        id: "11",
        spec: { kind: "review_comment", startLine: 1 },
      });
      expect(arg.replyTargets[1]?.spec.startLine).toBeUndefined();
    });
  });

  describe("enqueueLinearComment", () => {
    it("activity UUID is the external_id; agent session id is the reply target + payload target_id", async () => {
      await service.enqueueLinearComment({
        task: makeTask(),
        agentActivityId: "act-1",
        agentSessionId: "sess-1",
        body: "any update?",
      });

      const arg = appendInbox.mock.calls[0]?.[0] as {
        message: {
          source: string;
          external_id: string;
          payload: { task_key: string; target_id: string };
        };
        replyTargets: Array<{ id: string; spec: { kind: string } }>;
      };
      expect(arg.message.source).toBe("linear");
      expect(arg.message.external_id).toBe("act-1");
      expect(arg.message.payload).toMatchObject({
        task_id: "task-1",
        task_key: "XYZ-1",
      });
      // Replies route to the session, not the activity.
      expect(arg.message.payload.target_id).toBe("sess-1");
      expect(arg.replyTargets[0]?.id).toBe("sess-1");
      expect(arg.replyTargets[0]?.spec.kind).toBe("linear_session");
    });
  });

  describe("enqueueCiResult", () => {
    it("appends a kind='ci_result' row with correct payload and reply target", async () => {
      await service.enqueueCiResult({
        task: makeTask(),
        runId: 123456789,
        runAttempt: 2,
        workflowName: "CI",
        workflowPath: ".github/workflows/ci.yml",
        conclusion: "success",
        runUrl: "https://github.com/o/r/actions/runs/123456789",
        headSha: "abc123",
        headBranch: "devbox/XYZ-1234-fix",
        owner: "o",
        repo: "r",
        prNumber: 42,
      });

      const arg = appendInbox.mock.calls[0]?.[0] as {
        message: {
          source: string;
          kind: string;
          external_id: string;
          payload: {
            target_id: string;
            workflow_name: string;
            workflow_path: string;
            conclusion: string;
            run_url: string;
            head_sha: string;
            head_branch: string;
            task_key: string;
            pr: { repo: string; pr_url: string };
          };
        };
        replyTargets: Array<{
          id: string;
          spec: { kind: string; owner: string; repo: string; prNumber: number; commentId: number };
        }>;
      };
      expect(arg.message.source).toBe("github");
      expect(arg.message.kind).toBe("ci_result");
      expect(arg.message.external_id).toBe("workflow_run:123456789:2:42");
      expect(arg.message.payload.target_id).toBe("123456789");
      expect(arg.message.payload.workflow_name).toBe("CI");
      expect(arg.message.payload.workflow_path).toBe(".github/workflows/ci.yml");
      expect(arg.message.payload.conclusion).toBe("success");
      expect(arg.message.payload.run_url).toBe("https://github.com/o/r/actions/runs/123456789");
      expect(arg.message.payload.head_sha).toBe("abc123");
      expect(arg.message.payload.head_branch).toBe("devbox/XYZ-1234-fix");
      expect(arg.message.payload).toMatchObject({
        task_id: "task-1",
        task_key: "XYZ-1",
      });
      expect(arg.message.payload.pr).toEqual({
        repo: "r",
        pr_url: "https://github.com/o/r/pull/42",
      });
      expect(arg.replyTargets).toHaveLength(1);
      expect(arg.replyTargets[0]).toMatchObject({
        id: "123456789",
        spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 42, commentId: 0 },
      });
    });

    const ciParams = {
      task: makeTask(),
      runId: 123456789,
      runAttempt: 2,
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      conclusion: "failure",
      runUrl: "https://github.com/o/r/actions/runs/123456789",
      headSha: "abc123",
      headBranch: "devbox/XYZ-1234-fix",
      owner: "o",
      repo: "r",
      prNumber: 42,
    };

    it("enqueues when under the loop-breaker threshold", async () => {
      countCiResultsByTask.mockResolvedValue(19); // < 20
      await service.enqueueCiResult(ciParams);
      expect(appendInbox).toHaveBeenCalledTimes(1);
    });

    it("drops the CI failure once the loop-breaker threshold is reached", async () => {
      countCiResultsByTask.mockResolvedValue(20); // >= 20
      await service.enqueueCiResult(ciParams);
      expect(appendInbox).not.toHaveBeenCalled();
    });
  });

  describe("enqueue paths carry task_id and task_key from the task row", () => {
    const apiTask = makeTask({
      id: "task-api",
      source: "api",
      key: "DBX-API-7",
      externalUrl: "https://cp.example/api/tasks/DBX-API-7",
    });
    const identity = { task_id: "task-api", task_key: "DBX-API-7" };
    const spec = {
      kind: "issue_comment" as const,
      owner: "o",
      repo: "r",
      prNumber: 7,
      commentId: 555,
    };

    it("enqueueComment", async () => {
      await service.enqueueComment({
        task: apiTask,
        commentId: 555,
        body: "@harness fix",
        spec,
        createdAt: "2026-10-07T12:00:00Z",
      });
      expect(appendInbox).toHaveBeenCalledWith({
        taskId: "task-api",
        message: {
          source: "github",
          kind: "comment",
          external_id: "555",
          payload: {
            target_id: "555",
            body: "@harness fix",
            pr: { repo: "r", pr_url: "https://github.com/o/r/pull/7" },
            created_at: "2026-10-07T12:00:00Z",
            ...identity,
          },
        },
        replyTargets: [{ id: "555", spec }],
      });
    });

    it("enqueueReview", async () => {
      await service.enqueueReview({
        task: apiTask,
        reviewId: 88,
        reviewBody: "@harness",
        inlineComments: [{ id: 11, path: "a.ts", line: 3, body: "nit" }],
        owner: "o",
        repo: "r",
        prNumber: 7,
        reviewerLogin: "rev",
        createdAt: "2026-10-07T12:00:00Z",
      });
      expect(appendInbox).toHaveBeenCalledWith({
        taskId: "task-api",
        message: {
          source: "github",
          kind: "review",
          external_id: "88",
          payload: {
            review_body: { target_id: "88", body: "@harness" },
            inline_comments: [
              { target_id: "11", path: "a.ts", line: 3, start_line: undefined, body: "nit" },
            ],
            pr: { owner: "o", repo: "r", prNumber: 7, pr_url: "https://github.com/o/r/pull/7" },
            reviewer_login: "rev",
            created_at: "2026-10-07T12:00:00Z",
            ...identity,
          },
        },
        replyTargets: [
          {
            id: "11",
            spec: {
              kind: "review_comment",
              owner: "o",
              repo: "r",
              prNumber: 7,
              commentId: 11,
              inReplyTo: 11,
              path: "a.ts",
              line: 3,
              startLine: undefined,
            },
          },
          {
            id: "88",
            spec: { kind: "review_body", owner: "o", repo: "r", prNumber: 7, reviewId: 88 },
          },
        ],
      });
    });

    it("enqueueCiResult", async () => {
      await service.enqueueCiResult({
        task: apiTask,
        runId: 9,
        runAttempt: 1,
        workflowName: "CI",
        workflowPath: ".github/workflows/ci.yml",
        conclusion: "failure",
        runUrl: "https://github.com/o/r/actions/runs/9",
        headSha: "abc",
        headBranch: "devbox/DBX-API-7-x",
        owner: "o",
        repo: "r",
        prNumber: 7,
      });
      expect(appendInbox).toHaveBeenCalledWith({
        taskId: "task-api",
        message: {
          source: "github",
          kind: "ci_result",
          external_id: "workflow_run:9:1:7",
          payload: {
            target_id: "9",
            workflow_name: "CI",
            workflow_path: ".github/workflows/ci.yml",
            conclusion: "failure",
            run_url: "https://github.com/o/r/actions/runs/9",
            head_sha: "abc",
            head_branch: "devbox/DBX-API-7-x",
            pr: { repo: "r", pr_url: "https://github.com/o/r/pull/7" },
            ...identity,
          },
        },
        replyTargets: [
          {
            id: "9",
            spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 7, commentId: 0 },
          },
        ],
      });
    });

    it("enqueueLinearComment", async () => {
      await service.enqueueLinearComment({
        task: makeTask({ id: "task-1", key: "XYZ-1" }),
        agentActivityId: "act-1",
        agentSessionId: "sess-2",
        body: "follow-up",
      });
      expect(appendInbox).toHaveBeenCalledWith({
        taskId: "task-1",
        message: {
          source: "linear",
          kind: "comment",
          external_id: "act-1",
          payload: {
            target_id: "sess-2",
            body: "follow-up",
            pr: null,
            created_at: "",
            task_id: "task-1",
            task_key: "XYZ-1",
          },
        },
        replyTargets: [{ id: "sess-2", spec: { kind: "linear_session" } }],
      });
    });
  });
});
