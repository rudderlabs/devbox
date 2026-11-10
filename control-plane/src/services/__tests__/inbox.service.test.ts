import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Task } from "../../db/schema";
import { fakeDefinitions, NO_WEBHOOK } from "../../integrations/__tests__/fakeIntegrations";
import type { LinearTokenProvider } from "../../integrations/linear/tokenProvider";
import type { InboxRepository, InboxRow } from "../../repositories/inbox.repository";
import type { SandboxManager } from "../sandboxManager.service";

// Pin the config value InboxService reads (podId) so results do not depend on
// the environment the suite runs in.
mock.module("../../config", () => ({
  config: {
    podId: "pod-test",
  },
}));

const emitAction = mock(() => Promise.resolve());
const emitError = mock(() => Promise.resolve());
const emitResponse = mock(() => Promise.resolve());
const emitThought = mock(() => Promise.resolve());
const setIssueStarted = mock(() => Promise.resolve());
const attachUrlToIssue = mock(() => Promise.resolve());
const uploadIssueAttachment = mock(() => Promise.resolve());

mock.module("../../integrations/linear/client", () => ({
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

// Mock the full export surface of the GitHub integration's client barrel. bun's
// mock.module is process-global; the module split alone did NOT contain it --
// in CI this mock reached github.test.ts and failed 25 of its tests. The suite
// now runs with --isolate (package.json "test"), which gives every file a fresh
// module registry, so this cannot leak. Do not drop that flag.
mock.module("../../integrations/github/client", () => ({
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
  githubTokenState: () => ({ source: "env", expiresAt: null, readAt: null, lastError: null }),
}));

const { InboxService } = await import("../inbox.service");
const { WORKSPACE_MISSING_MESSAGE } = await import("../../integrations/outbound");
const { LinearIntegration } = await import("../../integrations/linear");
const { GithubIntegration } = await import("../../integrations/github");
const { ApiIntegration } = await import("../../integrations/api");
const { IntegrationRegistry, parseIntegrationConfigs } = await import("../integrationRegistry");
const { BackgroundWork } = await import("../backgroundWork");
const { ReplyHolds } = await import("../replyHolds");
const { LinearTokenError } = await import("../../integrations/linear/oauth");

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
  let writeHarnessFile: ReturnType<typeof mock>;
  let killSandbox: ReturnType<typeof mock>;
  let getById: ReturnType<typeof mock>;
  let linear: InstanceType<typeof LinearIntegration>;
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
    getById = mock((id: string) => Promise.resolve(ghCommentRow(id)));
    inboxRepo = {
      listPendingByTask,
      listNonTerminalByTask,
      getById,
      markDelivered,
      markFailed,
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

    linear = new LinearIntegration(
      linearTokenProvider,
      { status: async () => ({}) as never },
      NO_WEBHOOK,
    );
    const defs = fakeDefinitions({
      linear,
      api: new ApiIntegration(),
      github: new GithubIntegration(
        { botLogin: "harness" },
        { status: () => ({}) as never },
        NO_WEBHOOK,
      ),
    });
    const registry = new IntegrationRegistry(defs, parseIntegrationConfigs(defs, {}), {
      taskRepo: {} as never,
      inboxRepo,
      sandboxManager,
      background: new BackgroundWork(),
      holds: new ReplyHolds(),
    });
    service = new InboxService(inboxRepo, sandboxManager, registry);
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
      expect(addIssueCommentReaction).toHaveBeenCalledWith(
        "o",
        "r",
        555,
        "confused",
        expect.any(AbortSignal),
      );
      expect(markFailed).toHaveBeenCalledWith({
        inboxId: "a",
        ownerId: "pod-test",
        reason: "workspace_missing",
        userMessage: WORKSPACE_MISSING_MESSAGE,
      });
    });

    it("finishes a dead-lettered assignment's round: outcome failed, first transition, no archive", async () => {
      const onRoundFinished = spyOn(linear, "onRoundFinished");
      const assignment = {
        ...ghCommentRow("as"),
        source: "linear",
        kind: "assignment",
        reply_targets: [{ id: "sess-1", spec: { kind: "linear_session" } }],
      } as InboxRow;
      listNonTerminalByTask.mockResolvedValue([assignment, ghCommentRow("c")]);
      getById.mockImplementation((id: string) =>
        Promise.resolve(id === "as" ? assignment : ghCommentRow(id)),
      );

      await service.deadLetterWorkspaceMissing(makeTask({ sandboxId: null }));
      await new Promise<void>((r) => setTimeout(r, 0));

      expect(onRoundFinished).toHaveBeenCalledTimes(1);
      const [ctx, , round, outcome] = onRoundFinished.mock.calls[0] as unknown as [
        { firstTransition: boolean; archive(): Promise<Uint8Array | null> },
        Task,
        InboxRow,
        string,
      ];
      expect(round.id).toBe("as");
      expect(outcome).toBe("failed");
      expect(ctx.firstTransition).toBe(true);
      expect(await ctx.archive()).toBeNull();
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

    // One open row per kind on a Linear task. getById echoes each row so the
    // per-row status re-check passes.
    const stageRows = (rows: InboxRow[]) => {
      listNonTerminalByTask.mockResolvedValue(rows);
      getById.mockImplementation((id: string) =>
        Promise.resolve(rows.find((r) => r.id === id) ?? null),
      );
    };
    const linearRow = (id: string, sessionId: string, kind = "comment"): InboxRow =>
      ({
        ...ghCommentRow(id),
        source: "linear",
        kind,
        reply_targets: [{ id: sessionId, spec: { kind: "linear_session" } }],
      }) as InboxRow;

    it("notifies each row by kind: Linear session error, review-comment reply + 😕, review body as a PR comment, CI silent", async () => {
      stageRows([
        linearRow("lin", "sess-2"),
        {
          ...ghCommentRow("rc"),
          reply_targets: [
            {
              id: "556",
              spec: {
                kind: "review_comment",
                owner: "o",
                repo: "r",
                prNumber: 7,
                commentId: 556,
                inReplyTo: 556,
                path: "a.ts",
                line: 3,
              },
            },
          ],
        },
        {
          ...ghCommentRow("rev"),
          kind: "review",
          reply_targets: [
            {
              id: "11",
              spec: {
                kind: "review_comment",
                owner: "o",
                repo: "r",
                prNumber: 8,
                commentId: 11,
                inReplyTo: 11,
                path: "b.ts",
                line: 9,
              },
            },
            {
              id: "88",
              spec: { kind: "review_body", owner: "o", repo: "r", prNumber: 8, reviewId: 88 },
            },
          ],
        } as InboxRow,
        {
          ...ghCommentRow("ci"),
          kind: "ci_result",
          reply_targets: [
            {
              id: "9001",
              spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 9, commentId: 0 },
            },
          ],
        } as InboxRow,
      ]);

      await service.deadLetterWorkspaceMissing(makeTask({ sandboxId: null }));

      expect(emitError).toHaveBeenCalledTimes(1);
      expect(emitError).toHaveBeenCalledWith(
        expect.anything(),
        "sess-2",
        WORKSPACE_MISSING_MESSAGE,
      );
      expect(postReviewCommentReply).toHaveBeenCalledTimes(1);
      expect(postReviewCommentReply).toHaveBeenCalledWith(
        "o",
        "r",
        7,
        556,
        WORKSPACE_MISSING_MESSAGE,
        expect.any(AbortSignal),
      );
      expect(addReviewCommentReaction).toHaveBeenCalledTimes(1);
      expect(addReviewCommentReaction).toHaveBeenCalledWith(
        "o",
        "r",
        556,
        "confused",
        expect.any(AbortSignal),
      );
      // Only the review body posts; its inline comments and the CI row get nothing.
      expect(postIssueComment).toHaveBeenCalledTimes(1);
      expect(postIssueComment).toHaveBeenCalledWith(
        "o",
        "r",
        8,
        WORKSPACE_MISSING_MESSAGE,
        expect.any(AbortSignal),
      );
      expect(addIssueCommentReaction).not.toHaveBeenCalled();
      expect(markFailed.mock.calls.map((c) => (c[0] as { inboxId: string }).inboxId)).toEqual([
        "lin",
        "rc",
        "rev",
        "ci",
      ]);
    });

    it("posts per row, not per target: two Linear rows on one session get two errors", async () => {
      // failTask dedupes by target id; this path does not.
      stageRows([linearRow("a", "sess-1", "assignment"), linearRow("b", "sess-1")]);

      await service.deadLetterWorkspaceMissing(makeTask({ sandboxId: null }));

      expect(emitError).toHaveBeenCalledTimes(2);
      expect(markFailed).toHaveBeenCalledTimes(2);
    });

    it("marks the row before posting, and posts nothing when markFailed transitions nothing", async () => {
      const order: string[] = [];
      postIssueComment.mockImplementation(() => {
        order.push("post");
        return Promise.resolve({ id: 1, url: "u" });
      });
      addIssueCommentReaction.mockImplementation(() => {
        order.push("react");
        return Promise.resolve();
      });
      // Row b went terminal under us (a racing restart or a late `completed`).
      markFailed.mockImplementation(({ inboxId }: { inboxId: string }) => {
        order.push(`mark ${inboxId}`);
        return Promise.resolve(inboxId === "a" ? [{ id: "a" }] : []);
      });
      stageRows([ghCommentRow("a"), ghCommentRow("b")]);

      await service.deadLetterWorkspaceMissing(makeTask({ sandboxId: null }));

      expect(order).toEqual(["mark a", "post", "react", "mark b"]);
    });

    it("a Linear token failure drops only that row's notice: every row is marked failed, later rows still post", async () => {
      stageRows([linearRow("a", "sess-1"), ghCommentRow("b")]);
      (linearTokenProvider.getAuthorizedLinearClient as ReturnType<typeof mock>).mockRejectedValue(
        new LinearTokenError("Linear token request failed: Unable to connect"),
      );

      await service.deadLetterWorkspaceMissing(makeTask({ sandboxId: null }));

      expect(emitError).not.toHaveBeenCalled();
      expect(markFailed.mock.calls.map((c) => (c[0] as { inboxId: string }).inboxId)).toEqual([
        "a",
        "b",
      ]);
      expect(postIssueComment).toHaveBeenCalledWith(
        "o",
        "r",
        7,
        WORKSPACE_MISSING_MESSAGE,
        expect.any(AbortSignal),
      );
    });
  });
});
