import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { type LinearClient, LinearError, RatelimitedLinearError } from "@linear/sdk";
import type { Task } from "../../db/schema";
import { fakeDefinitions, NO_WEBHOOK } from "../../integrations/__tests__/fakeIntegrations";
// Type-only import — erased at link time, so it can't collide with the
// mock.module barrel factories below, and it pins the real contract.
import type { LinearHumanUser } from "../../integrations/linear/api";
import type { LinearTokenProvider } from "../../integrations/linear/tokenProvider";
import type { HookCtx, Integration } from "../../integrations/types";
import type { InboxRepository, InboxRow, InboxStatus } from "../../repositories/inbox.repository";
import type { TaskRepository } from "../../repositories/task.repository";
import type { HarnessEvent } from "../../types/harnessEvent";
import type { ReviewPayload } from "../../types/inboxMessage";
import type { SandboxManager } from "../sandboxManager.service";
import type { SlackNotifierService } from "../slackNotifier.service";

mock.module("../../config", () => ({
  config: {
    podId: "pod-test",
  },
}));

const emitThought = mock(() => Promise.resolve());
const emitAction = mock(() => Promise.resolve());
const emitResponse = mock(() => Promise.resolve());
const emitError = mock(() => Promise.resolve());
const setIssueStarted = mock(() => Promise.resolve());
const attachUrlToIssue = mock(() => Promise.resolve());
const uploadIssueAttachment = mock(() => Promise.resolve());
const getIssueHumanAssignee = mock(() => Promise.resolve(null as LinearHumanUser | null));

mock.module("../../integrations/linear/client", () => ({
  emitThought,
  emitAction,
  emitResponse,
  emitError,
  setIssueStarted,
  attachUrlToIssue,
  uploadIssueAttachment,
  getIssueHumanAssignee,
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

const postIssueComment = mock(() => Promise.resolve({ id: 1, url: "u" }));
const postReviewCommentReply = mock(() => Promise.resolve({ id: 1, url: "u" }));
const addPrAssignees = mock(() => Promise.resolve({ assigned: [] as string[] }));
const getUserById = mock(() => Promise.resolve({ login: "", id: 0 }));
const requestReviewers = mock(() => Promise.resolve());

// Mock the full export surface of the GitHub integration's client barrel. bun's
// mock.module is process-global; the module split alone did NOT contain it --
// in CI this mock reached github.test.ts and failed 25 of its tests. The suite
// now runs with --isolate (package.json "test"), which gives every file a fresh
// module registry, so this cannot leak. Do not drop that flag.
mock.module("../../integrations/github/client", () => ({
  postIssueComment,
  postReviewCommentReply,
  addIssueCommentReaction: mock(() => Promise.resolve()),
  addReviewCommentReaction: mock(() => Promise.resolve()),
  getReviewComments: mock(() => Promise.resolve([])),
  fetchOrgMembers: mock(() => Promise.resolve(new Set())),
  addPrAssignees,
  getUserById,
  getUserIdByLogin: mock(() => Promise.resolve(null)),
  requestReviewers,
  parsePrUrl: (url: string) => {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], prNumber: Number(m[3]) } : null;
  },
  githubTokenState: () => ({ source: "env", expiresAt: null, readAt: null, lastError: null }),
}));

const { EventDispatcher } = await import("../eventDispatcher");
const { LinearIntegration } = await import("../../integrations/linear");
const { GithubIntegration } = await import("../../integrations/github");
const { ApiIntegration } = await import("../../integrations/api");
const { HttpError } = await import("../../integrations/http");
const { ReplyHolds } = await import("../replyHolds");
const { IntegrationRegistry, parseIntegrationConfigs } = await import("../integrationRegistry");
const { BackgroundWork } = await import("../backgroundWork");
const { LinearTokenError } = await import("../../integrations/linear/oauth");
const { logger } = await import("../../logger");

// What the token provider throws when Linear's token endpoint can't be reached
// (no answer, so no status): a later request may succeed.
const linearUnreachable = () =>
  new LinearTokenError("Linear token request failed: Unable to connect");
// Linear rejected the app's credentials: only an operator can fix that.
const linearRejected = () =>
  new LinearTokenError("Linear token request failed with status 400: invalid_client", {
    status: 400,
    code: "invalid_client",
  });

// The assignee mirror runs in BackgroundWork, apart from the pr_opened
// dispatch — settle its promise chain before asserting on its mocks.
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  source: "linear",
  externalId: "issue-1",
  key: "XYZ-1",
  createdBy: null,
  title: "t",
  externalUrl: "u",
  metadata: {},
  ownerId: "pod-test",
  heartbeatAt: new Date(),
  sandboxId: "sbx-1",
  pvcName: null,
  prUrls: [],
  lastObservedEventSeq: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const linearRow = (overrides: { status?: InboxStatus } = {}): InboxRow => ({
  id: "inbox-1",
  task_id: "task-1",
  source: "linear",
  external_id: "issue-1",
  kind: "assignment",
  payload: {
    title: "t",
    description: null,
    task_id: "task-1",
    task_key: "XYZ-1",
    external_url: "u",
    target_id: "sess-1",
  },
  reply_targets: [{ id: "sess-1", spec: { kind: "linear_session" } }],
  status: overrides.status ?? "delivered",
  failure_reason: null,
  outcome: null,
  created_at: new Date(),
  updated_at: new Date(),
});

const prEvent = (): Extract<HarnessEvent, { type: "pr_opened" }> => ({
  seq: 1,
  ts: "t",
  type: "pr_opened",
  inbox_id: "inbox-1",
  repo: "r",
  pr_url: "https://github.com/o/r/pull/1",
  branch: "b",
  commit_sha: "sha",
});

// The task once prEvent's PR is recorded on it.
const taskWithPr = (): Task =>
  makeTask({ prUrls: [{ repo: "r", url: prEvent().pr_url, branch: "b", commit_sha: "sha" }] });

describe("EventDispatcher", () => {
  let taskRepo: TaskRepository;
  let inboxRepo: InboxRepository;
  let sandboxManager: SandboxManager;
  let linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">;
  let appendPrUrl: ReturnType<typeof mock>;
  // The row the task-scoped lookup finds (null: none).
  let findRow: ReturnType<typeof mock>;
  let markResponded: ReturnType<typeof mock>;
  let notifyTerminal: ReturnType<typeof mock>;
  let extractArchive: ReturnType<typeof mock>;
  let slackNotifier: SlackNotifierService;
  let holds: InstanceType<typeof ReplyHolds>;
  let dispatcher: InstanceType<typeof EventDispatcher>;
  let background: InstanceType<typeof BackgroundWork>;

  // A registry of these integrations (null: off).
  const registryOf = (instances: Record<string, Integration | null>) => {
    const defs = fakeDefinitions(instances);
    return new IntegrationRegistry(defs, parseIntegrationConfigs(defs, {}), {
      taskRepo,
      inboxRepo,
      sandboxManager,
      background,
      holds,
    });
  };
  // The registry over the real integrations, with GitHub's webhooks (and so
  // its integration) on or off.
  const makeRegistry = (githubEnabled: boolean) =>
    registryOf({
      linear: new LinearIntegration(
        linearTokenProvider,
        { status: async () => ({}) as never },
        NO_WEBHOOK,
      ),
      api: new ApiIntegration(),
      github: githubEnabled
        ? new GithubIntegration(
            { botLogin: "harness" },
            { status: () => ({}) as never },
            NO_WEBHOOK,
          )
        : null,
    });
  // A dispatcher over this registry.
  const dispatcherOver = (
    registry: InstanceType<typeof IntegrationRegistry>,
    replyHolds: InstanceType<typeof ReplyHolds> = holds,
  ) =>
    new EventDispatcher(
      taskRepo,
      inboxRepo,
      sandboxManager,
      slackNotifier,
      registry,
      replyHolds,
      background,
    );
  const withGithubOff = () => dispatcherOver(makeRegistry(false));

  beforeEach(() => {
    for (const m of [
      emitThought,
      emitAction,
      emitResponse,
      emitError,
      setIssueStarted,
      attachUrlToIssue,
      uploadIssueAttachment,
    ]) {
      m.mockReset();
      m.mockResolvedValue(undefined);
    }
    postIssueComment.mockReset();
    postIssueComment.mockResolvedValue({ id: 1, url: "u" });
    postReviewCommentReply.mockReset();
    postReviewCommentReply.mockResolvedValue({ id: 1, url: "u" });
    getIssueHumanAssignee.mockReset();
    getIssueHumanAssignee.mockResolvedValue(null);
    addPrAssignees.mockReset();
    addPrAssignees.mockResolvedValue({ assigned: [] });
    getUserById.mockReset();
    getUserById.mockResolvedValue({ login: "", id: 0 });
    requestReviewers.mockReset();
    requestReviewers.mockResolvedValue(undefined);

    appendPrUrl = mock(() => Promise.resolve([{ id: "task-1", firstTime: true }]));
    taskRepo = { appendPrUrl } as unknown as TaskRepository;

    findRow = mock(() => Promise.resolve(linearRow()));
    markResponded = mock(() => Promise.resolve([{ id: "inbox-1" }]));
    inboxRepo = {
      // The found row, with the task's assignment id read beside it.
      getByIdForTask: async (id: string, taskId: string) => {
        const row = (await findRow(id, taskId)) as InboxRow | null;
        return row && { row, assignmentId: "inbox-1" };
      },
      markResponded,
      getAssignment: mock(() => Promise.resolve(linearRow())),
    } as unknown as InboxRepository;

    extractArchive = mock(() => Promise.resolve(null as Uint8Array | null));
    sandboxManager = { extractArchive } as unknown as SandboxManager;
    linearTokenProvider = {
      getAuthorizedLinearClient: mock(() => Promise.resolve({} as unknown as LinearClient)),
    } as unknown as Pick<LinearTokenProvider, "getAuthorizedLinearClient">;

    notifyTerminal = mock(() => Promise.resolve());
    slackNotifier = { notifyTerminal } as unknown as SlackNotifierService;

    holds = new ReplyHolds();
    background = new BackgroundWork();
    dispatcher = dispatcherOver(makeRegistry(true));
  });

  describe("API tasks", () => {
    const apiTask = () => makeTask({ source: "api", key: "DBX-API-7" });
    const apiRow = (kind: "assignment" | "comment" = "assignment"): InboxRow =>
      ({
        ...linearRow(),
        source: "api",
        kind,
        reply_targets: [{ id: "task-1", spec: { kind: "api_session" } }],
      }) as InboxRow;

    it("never builds a Linear client", async () => {
      findRow.mockResolvedValue(apiRow());
      await dispatcher.handle(
        {
          seq: 1,
          ts: "t",
          type: "agent_thought",
          inbox_id: "inbox-1",
          target_id: "task-1",
          body: "x",
        },
        apiTask(),
      );
      expect(linearTokenProvider.getAuthorizedLinearClient).not.toHaveBeenCalled();
      expect(emitThought).not.toHaveBeenCalled();
    });

    it("agent_response to an api_session target posts nowhere", async () => {
      findRow.mockResolvedValue(apiRow("comment"));
      const r = await dispatcher.handle(
        {
          seq: 2,
          ts: "t",
          type: "agent_response",
          inbox_id: "inbox-1",
          target_id: "task-1",
          body: "done",
        },
        apiTask(),
      );
      expect(r).toBe("ok");
      expect(postIssueComment).not.toHaveBeenCalled();
      expect(postReviewCommentReply).not.toHaveBeenCalled();
      expect(emitResponse).not.toHaveBeenCalled();
    });

    it("pr_opened: onboarding comment only; no Linear attach or assignee mirror", async () => {
      findRow.mockResolvedValue(apiRow());
      await dispatcher.handle(prEvent(), apiTask());
      await flushMicrotasks();
      expect(attachUrlToIssue).not.toHaveBeenCalled();
      expect(getIssueHumanAssignee).not.toHaveBeenCalled();
      expect(postIssueComment).toHaveBeenCalledWith(
        "o",
        "r",
        1,
        [
          "👋 I'm **harness**. I opened this PR from task `DBX-API-7`.",
          "",
          "Mention `@harness` and I'll act on it — on a top-level PR comment,",
          "in a review summary, or on an inline comment on the diff. Without a mention I won't see it.",
        ].join("\n"),
        expect.any(AbortSignal),
      );
    });

    // The notifier skips non-Linear tasks itself (slackNotifier.service.test.ts).
    it("completed assignment: no run archive; Slack is left to the notifier", async () => {
      findRow.mockResolvedValue(apiRow());
      await dispatcher.handle(
        { seq: 3, ts: "t", type: "completed", inbox_id: "inbox-1", status: "completed" },
        apiTask(),
      );
      await flushMicrotasks();
      expect(extractArchive).not.toHaveBeenCalled();
      expect(notifyTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ source: "api" }),
        "completed",
      );
    });
  });

  describe("agent emits", () => {
    it("agent_thought → emitThought with the session id", async () => {
      await dispatcher.handle(
        {
          seq: 1,
          ts: "t",
          type: "agent_thought",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "plan",
        },
        makeTask(),
      );
      expect(emitThought).toHaveBeenCalledWith(expect.anything(), "sess-1", "plan");
    });

    it("agent_action → emitAction with body and empty parameter", async () => {
      // Linear renders `<action> <parameter>` concatenated. A non-empty
      // parameter would suffix a noisy "task" onto every action label
      // ("Planning task"). The daemon's body is the full label — parameter
      // stays empty.
      await dispatcher.handle(
        {
          seq: 1,
          ts: "t",
          type: "agent_action",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "Planning",
        },
        makeTask(),
      );
      expect(emitAction).toHaveBeenCalledWith(expect.anything(), "sess-1", "Planning", "");
    });

    it("agent_response / agent_error → corresponding emit", async () => {
      await dispatcher.handle(
        {
          seq: 1,
          ts: "t",
          type: "agent_response",
          inbox_id: "inbox-1",
          body: "done",
          target_id: "sess-1",
        },
        makeTask(),
      );
      await dispatcher.handle(
        {
          seq: 2,
          ts: "t",
          type: "agent_error",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "bad",
        },
        makeTask(),
      );
      expect(emitResponse).toHaveBeenCalledWith(expect.anything(), "sess-1", "done");
      expect(emitError).toHaveBeenCalledWith(expect.anything(), "sess-1", "bad");
    });

    it("github-sourced inbox row → progress emits are NOT forwarded to Linear", async () => {
      // A comment / review that came in from GitHub on a Linear-originated PR
      // carries only GH-shaped reply_targets — no linear_session — so the
      // forwarder's session-id lookup returns null and the emit drops. Final
      // replies route to GitHub via reply_targets.
      findRow.mockResolvedValue({
        ...linearRow(),
        source: "github",
        reply_targets: [
          {
            id: "999",
            spec: {
              kind: "issue_comment",
              owner: "o",
              repo: "r",
              prNumber: 1,
              commentId: 999,
            },
          },
        ],
      } as InboxRow);
      await dispatcher.handle(
        {
          seq: 1,
          ts: "t",
          type: "agent_thought",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "thinking",
        },
        makeTask(),
      );
      await dispatcher.handle(
        {
          seq: 2,
          ts: "t",
          type: "agent_action",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "Working on it",
        },
        makeTask(),
      );
      await dispatcher.handle(
        {
          seq: 3,
          ts: "t",
          type: "agent_error",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "oops",
        },
        makeTask(),
      );
      expect(emitThought).not.toHaveBeenCalled();
      expect(emitAction).not.toHaveBeenCalled();
      expect(emitError).not.toHaveBeenCalled();
    });

    it("inbox row with no linear_session reply target → agent emit dropped", async () => {
      // The session id now lives on inboxRow.reply_targets; if the row carries
      // only GH-shaped targets (no linear_session) the forward drops.
      findRow.mockResolvedValue({
        ...linearRow(),
        source: "github",
        reply_targets: [
          {
            id: "999",
            spec: {
              kind: "issue_comment",
              owner: "o",
              repo: "r",
              prNumber: 1,
              commentId: 999,
            },
          },
        ],
      } as InboxRow);
      await dispatcher.handle(
        {
          seq: 1,
          ts: "t",
          type: "agent_thought",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "x",
        },
        makeTask(),
      );
      expect(emitThought).not.toHaveBeenCalled();
    });

    it("Linear task: a token fetch failure posts nothing and holds the event", async () => {
      (linearTokenProvider.getAuthorizedLinearClient as ReturnType<typeof mock>).mockRejectedValue(
        linearUnreachable(),
      );
      expect(
        await dispatcher.handle(
          {
            seq: 1,
            ts: "t",
            type: "agent_thought",
            inbox_id: "inbox-1",
            target_id: "sess-1",
            body: "x",
          },
          makeTask(),
        ),
      ).toBe("hold");
      for (const m of [emitThought, emitAction, emitResponse, emitError, postIssueComment]) {
        expect(m).not.toHaveBeenCalled();
      }
    });

    it("Linear task: invalid_client is dropped, so the cursor advances", async () => {
      (linearTokenProvider.getAuthorizedLinearClient as ReturnType<typeof mock>).mockRejectedValue(
        linearRejected(),
      );
      const thought: HarnessEvent = {
        seq: 1,
        ts: "t",
        type: "agent_thought",
        inbox_id: "inbox-1",
        target_id: "sess-1",
        body: "x",
      };
      // reconcileOne advances past a dropped event; a held one is retried.
      expect(await dispatcher.handle(thought, makeTask())).toBe("dropped");
      expect(holds.of("linear").heldTasks).toBe(0);
      expect(emitThought).not.toHaveBeenCalled();
      // pr_opened records the PR and goes on without the Linear attach.
      expect(await dispatcher.handle(prEvent(), makeTask())).toBe("ok");
      expect(holds.of("linear").heldTasks).toBe(0);
      expect(appendPrUrl).toHaveBeenCalledTimes(1);
      expect(attachUrlToIssue).not.toHaveBeenCalled();
    });

    it("foreign / unknown inbox_id → cross-task leak: aborts, no emit", async () => {
      // A foreign inbox_id resolving to null means this task's stream is
      // carrying an event it doesn't own (cross-task leak). The dispatcher
      // aborts the whole reconcile — never routes the emit, never advances the
      // cursor — so a leaked stream halts loudly instead of smuggling an emit
      // onto some other task's UI.
      findRow.mockResolvedValue(null);
      const result = await dispatcher.handle(
        {
          seq: 1,
          ts: "t",
          type: "agent_thought",
          inbox_id: "foreign-inbox",
          target_id: "sess-1",
          body: "x",
        },
        makeTask(),
      );
      expect(result).toBe("abort");
      expect(emitThought).not.toHaveBeenCalled();
      expect(findRow).toHaveBeenCalledWith("foreign-inbox", "task-1");
    });
  });

  describe("agent_error routing", () => {
    // The harness's round-crash format (_emit_round_failure), aimed at the
    // round's primary target.
    const errorEvent = (targetId: string): Extract<HarnessEvent, { type: "agent_error" }> => ({
      seq: 1,
      ts: "t",
      type: "agent_error",
      inbox_id: "inbox-1",
      target_id: targetId,
      body: "⚠ Something went wrong — RuntimeError: boom",
    });
    const ghRow = (kind: string, target: InboxRow["reply_targets"][number]): InboxRow =>
      ({ ...linearRow(), source: "github", kind, reply_targets: [target] }) as InboxRow;

    it("a Linear comment round failure → emitError on the row's session", async () => {
      findRow.mockResolvedValue({ ...linearRow(), kind: "comment" } as InboxRow);
      expect(await dispatcher.handle(errorEvent("sess-1"), makeTask())).toBe("ok");
      expect(emitError).toHaveBeenCalledWith(
        expect.anything(),
        "sess-1",
        "⚠ Something went wrong — RuntimeError: boom",
      );
    });

    it("a GitHub comment or review round failure posts the generic retry message, not the error", async () => {
      findRow.mockResolvedValueOnce(
        ghRow("comment", {
          id: "555",
          spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 1, commentId: 555 },
        }),
      );
      expect(await dispatcher.handle(errorEvent("555"), makeTask())).toBe("ok");
      findRow.mockResolvedValueOnce(
        ghRow("review", {
          id: "88",
          spec: { kind: "review_body", owner: "o", repo: "r", prNumber: 1, reviewId: 88 },
        }),
      );
      expect(await dispatcher.handle(errorEvent("88"), makeTask())).toBe("ok");

      const retry =
        "⚠️ Something went wrong while working on this. Mention @harness in a new comment to retry.";
      // The comment's thread and the review summary (a top-level PR comment).
      expect(postIssueComment.mock.calls as unknown[]).toEqual([
        ["o", "r", 1, retry, expect.any(AbortSignal)],
        ["o", "r", 1, retry, expect.any(AbortSignal)],
      ]);
      expect(postReviewCommentReply).not.toHaveBeenCalled();
      expect(emitError).not.toHaveBeenCalled();
    });

    it("a CI round failure is posted nowhere", async () => {
      findRow.mockResolvedValue(
        ghRow("ci_result", {
          id: "9001",
          spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 1, commentId: 0 },
        }),
      );
      expect(await dispatcher.handle(errorEvent("9001"), makeTask())).toBe("ok");
      expect(postIssueComment).not.toHaveBeenCalled();
      expect(emitError).not.toHaveBeenCalled();
    });

    it("a GitHub comment round failure posts nothing when GitHub webhooks are off (no bot login)", async () => {
      findRow.mockResolvedValue(
        ghRow("comment", {
          id: "555",
          spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 1, commentId: 555 },
        }),
      );
      expect(await withGithubOff().handle(errorEvent("555"), makeTask())).toBe("ok");
      expect(postIssueComment).not.toHaveBeenCalled();
      expect(postReviewCommentReply).not.toHaveBeenCalled();
    });
  });

  describe("labelling", () => {
    it("labels each agent emit and hands it to the round's integration with the event's target", async () => {
      const delivered: unknown[] = [];
      const record = (name: "linear" | "api" | "github") => ({
        status: async () => ({}),
        deliver: async (_ctx: unknown, target: unknown, message: unknown) => {
          delivered.push([name, target, message]);
        },
      });
      const d = dispatcherOver(
        registryOf({ linear: record("linear"), api: record("api"), github: record("github") }),
        new ReplyHolds(),
      );
      const assignment = linearRow();
      const ghComment = {
        ...linearRow(),
        source: "github",
        kind: "comment",
        reply_targets: [
          {
            id: "555",
            spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 1, commentId: 555 },
          },
        ],
      } as InboxRow;
      const emit = (type: string, targetId: string, extra = {}) =>
        ({
          seq: 1,
          ts: "t",
          type,
          inbox_id: "inbox-1",
          target_id: targetId,
          body: "b",
          ...extra,
        }) as HarnessEvent;
      const cases: Array<[InboxRow, HarnessEvent, unknown]> = [
        [assignment, emit("agent_response", "sess-1"), { type: "reply", body: "b" }],
        [
          assignment,
          emit("agent_thought", "sess-1"),
          { type: "progress", kind: "thought", body: "b" },
        ],
        [
          assignment,
          emit("agent_action", "sess-1"),
          { type: "progress", kind: "action", body: "b" },
        ],
        [
          assignment,
          emit("agent_error", "sess-1", { retryable_assignment_failure: true }),
          { type: "progress", kind: "error", body: "b" },
        ],
        [
          assignment,
          emit("agent_error", "sess-1"),
          { type: "failure", cause: "round_failed", round: assignment, summary: "b" },
        ],
        [
          ghComment,
          emit("agent_error", "555"),
          { type: "failure", cause: "round_failed", round: ghComment, detail: "b" },
        ],
      ];
      for (const [row, event] of cases) {
        findRow.mockResolvedValueOnce(row);
        expect(await d.handle(event, makeTask())).toBe("ok");
      }
      // Routed by round.source (the task is a Linear task throughout).
      expect(delivered).toEqual(
        cases.map(([row, , message]) => [row.source, row.reply_targets[0], message]),
      );
    });
  });

  describe("pr_opened", () => {
    it("onPrOpened's isCurrent() compares the run read with the row to the task's assignment", async () => {
      let ctx: HookCtx | undefined;
      const d = dispatcherOver(
        registryOf({
          linear: {
            status: async () => ({}),
            deliver: async () => {},
            onPrOpened: async (c) => {
              ctx = c;
            },
          },
        }),
      );
      await d.handle(prEvent(), makeTask());
      expect(await ctx?.isCurrent()).toBe(true);
      // A restart re-pended the assignment under a new id.
      (inboxRepo.getAssignment as ReturnType<typeof mock>).mockResolvedValue({
        ...linearRow(),
        id: "inbox-2",
      });
      expect(await ctx?.isCurrent()).toBe(false);
    });

    it("appends the PR url and attaches it to the issue", async () => {
      const result = await dispatcher.handle(prEvent(), makeTask());
      expect(result).toBe("ok");
      expect(appendPrUrl).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        prUrl: "https://github.com/o/r/pull/1",
        repo: "r",
        branch: "b",
        commitSha: "sha",
      });
      expect(attachUrlToIssue).toHaveBeenCalledWith(
        expect.anything(),
        "issue-1",
        "https://github.com/o/r/pull/1",
        "r",
      );
    });

    it("Linear task: a token fetch failure holds the event at onPrOpened; the replay doesn't post again", async () => {
      (linearTokenProvider.getAuthorizedLinearClient as ReturnType<typeof mock>).mockRejectedValue(
        linearUnreachable(),
      );
      expect(await dispatcher.handle(prEvent(), makeTask())).toBe("hold");
      expect(appendPrUrl).toHaveBeenCalledTimes(1);
      expect(attachUrlToIssue).not.toHaveBeenCalled();
      // The held event comes back on later ticks, with the PR now recorded:
      // the code host's work, done before the hold, doesn't run again.
      appendPrUrl.mockResolvedValue([{ id: "task-1", firstTime: false }]);
      expect(await dispatcher.handle(prEvent(), taskWithPr())).toBe("hold");
      expect(appendPrUrl).toHaveBeenCalledTimes(2);
      expect(postIssueComment).toHaveBeenCalledTimes(1);
    });

    it("Linear task: a 429 or a refused connection on the attach holds the event", async () => {
      const rateLimited = new RatelimitedLinearError({
        response: { headers: new Headers({ "retry-after": "5" }) },
      } as never);
      const refused = Object.assign(new TypeError("Unable to connect"), { code: "ECONNREFUSED" });
      attachUrlToIssue
        .mockRejectedValueOnce(rateLimited)
        .mockRejectedValueOnce(new LinearError(refused as never));
      getIssueHumanAssignee.mockResolvedValue({
        id: "usr-1",
        name: "Ada Lovelace",
        displayName: "ada",
        email: "ada@acme.com",
        gitHubUserId: "octocat",
      });
      addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
      expect(await dispatcher.handle(prEvent(), makeTask())).toBe("hold");
      // The replay finds the PR recorded: no second comment or assignment.
      expect(await dispatcher.handle(prEvent(), taskWithPr())).toBe("hold");
      await flushMicrotasks();
      expect(attachUrlToIssue).toHaveBeenCalledTimes(2);
      expect(holds.of("linear").heldTasks).toBe(1);
      expect(postIssueComment).toHaveBeenCalledTimes(1);
      expect(addPrAssignees).toHaveBeenCalledTimes(1);
    });

    it("self-evicts when appendPrUrl returns 0 rows (lease lost), before onPrOpened", async () => {
      appendPrUrl.mockResolvedValue([]);
      const result = await dispatcher.handle(prEvent(), makeTask());
      await flushMicrotasks();
      expect(result).toBe("self_evict");
      // The sibling pod that owns the task now attaches the PR.
      expect(attachUrlToIssue).not.toHaveBeenCalled();
      // The code host ran before the lease loss showed; the new owner runs it
      // again, so the comment can appear twice.
      expect(postIssueComment).toHaveBeenCalledTimes(1);
    });

    it("runs the PR's host integration, then appendPrUrl, then the task's own onPrOpened", async () => {
      const order: string[] = [];
      postIssueComment.mockImplementation(async () => {
        order.push("comment");
        return { id: 1, url: "u" };
      });
      appendPrUrl.mockImplementation(async () => {
        order.push("append");
        return [{ id: "task-1", firstTime: true }];
      });
      attachUrlToIssue.mockImplementation(async () => {
        order.push("attach");
      });
      await dispatcher.handle(prEvent(), makeTask());
      expect(order).toEqual(["comment", "append", "attach"]);
    });

    it("passes appendPrUrl's firstTime to onPrOpened", async () => {
      const seen: boolean[] = [];
      const d = dispatcherOver(
        registryOf({
          linear: {
            status: async () => ({}),
            deliver: async () => {},
            onPrOpened: async (c) => {
              seen.push(c.firstTime);
            },
          },
        }),
      );
      await d.handle(prEvent(), makeTask());
      appendPrUrl.mockResolvedValue([{ id: "task-1", firstTime: false }]);
      await d.handle(prEvent(), makeTask());
      expect(seen).toEqual([true, false]);
    });

    it("posts the onboarding comment on a PR the task hasn't recorded", async () => {
      await dispatcher.handle(prEvent(), makeTask());
      expect(postIssueComment).toHaveBeenCalledTimes(1);
      expect(postIssueComment).toHaveBeenCalledWith(
        "o",
        "r",
        1,
        [
          "👋 I'm **harness**. I opened this PR from task `XYZ-1`.",
          "",
          "Mention `@harness` and I'll act on it — on a top-level PR comment,",
          "in a review summary, or on an inline comment on the diff. Without a mention I won't see it.",
        ].join("\n"),
        expect.any(AbortSignal),
      );
    });

    it("a second PR on a task that already records another gets its own comment and assignee", async () => {
      getIssueHumanAssignee.mockResolvedValue({
        id: "usr-1",
        name: "Ada Lovelace",
        displayName: "ada",
        email: "ada@acme.com",
        gitHubUserId: "octocat",
      });
      addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
      const task = makeTask({
        prUrls: [
          { repo: "r", url: "https://github.com/o/r/pull/99", branch: "b", commit_sha: "sha" },
        ],
      });
      expect(await dispatcher.handle(prEvent(), task)).toBe("ok");
      await flushMicrotasks();
      expect(postIssueComment).toHaveBeenCalledTimes(1);
      expect(postIssueComment).toHaveBeenCalledWith(
        "o",
        "r",
        1,
        expect.any(String),
        expect.any(AbortSignal),
      );
      expect(addPrAssignees).toHaveBeenCalledTimes(1);
      expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
    });

    it("while GitHub's integration is off (a personal token, no webhooks): no onboarding comment and no assignee", async () => {
      getIssueHumanAssignee.mockResolvedValue({
        id: "usr-1",
        name: "Ada Lovelace",
        displayName: "ada",
        email: "ada@acme.com",
        gitHubUserId: "octocat",
      });
      addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
      // GitHub, which does both on its pull requests, is off: nothing has an
      // instance to do them, and nobody is looked up.
      const result = await withGithubOff().handle(prEvent(), makeTask());
      await flushMicrotasks();
      expect(result).toBe("ok");
      expect(postIssueComment).not.toHaveBeenCalled();
      expect(getIssueHumanAssignee).not.toHaveBeenCalled();
      expect(addPrAssignees).not.toHaveBeenCalled();
      // The task's own integration still links the PR on the issue.
      expect(attachUrlToIssue).toHaveBeenCalledTimes(1);
    });

    // Resolving an account id to a login: integrations/github/__tests__/prOpened.test.ts.
    describe("PR assignee mirror", () => {
      const human = (gitHubUserId: string | null): LinearHumanUser => ({
        id: "usr-1",
        name: "Ada Lovelace",
        displayName: "ada",
        email: "ada@acme.com",
        gitHubUserId,
      });
      // The mirror's pr_assignee.result log lines.
      let info: ReturnType<typeof spyOn>;
      let warn: ReturnType<typeof spyOn>;
      beforeEach(() => {
        info = spyOn(logger, "info").mockImplementation(() => logger);
        warn = spyOn(logger, "warn").mockImplementation(() => logger);
      });
      afterEach(() => {
        info.mockRestore();
        warn.mockRestore();
      });
      const results = () =>
        [...info.mock.calls, ...warn.mock.calls]
          .map(([, meta]) => meta as Record<string, unknown> | undefined)
          .filter((meta) => meta?.event === "pr_assignee.result");
      const logged = {
        event: "pr_assignee.result",
        taskId: "task-1",
        prUrl: "https://github.com/o/r/pull/1",
      };

      it("runs in BackgroundWork, so shutdown waits for it", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("octocat"));
        let assigned = false;
        addPrAssignees.mockImplementation(() =>
          sleep(20).then(() => {
            assigned = true;
            return { assigned: ["octocat"] };
          }),
        );

        await dispatcher.handle(prEvent(), makeTask());
        await background.drain(sleep(500));

        expect(assigned).toBe(true);
      });

      it("no human assignee → no GitHub calls, still ok", async () => {
        getIssueHumanAssignee.mockResolvedValue(null);
        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();
        expect(result).toBe("ok");
        expect(getUserById).not.toHaveBeenCalled();
        expect(addPrAssignees).not.toHaveBeenCalled();
        expect(results()).toEqual([{ ...logged, status: "skipped", reason: "no_human_assignee" }]);
      });

      it("assignee without a Linear↔GitHub connection (gitHubUserId null) → skip", async () => {
        getIssueHumanAssignee.mockResolvedValue(human(null));
        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();
        expect(result).toBe("ok");
        expect(getIssueHumanAssignee).toHaveBeenCalledWith(expect.anything(), "issue-1");
        expect(addPrAssignees).not.toHaveBeenCalled();
        // The Linear account id, never the name or email.
        expect(results()).toEqual([
          { ...logged, status: "skipped", reason: "no_github_mapping", personId: "usr-1" },
        ]);
      });

      it("case-folded comparison: canonical-cased response is not a false drop", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("OctoCat"));
        addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();
        expect(result).toBe("ok");
        expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["OctoCat"]);
        expect(results()).toEqual([
          { ...logged, status: "assigned", requested: "OctoCat", assigned: ["octocat"] },
        ]);
      });

      it("non-github PR url → mirror skips without any lookup", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("octocat"));
        const event = { ...prEvent(), pr_url: "https://gitlab.com/o/r/pull/1" };
        await dispatcher.handle(event, makeTask());
        await flushMicrotasks();
        expect(getIssueHumanAssignee).not.toHaveBeenCalled();
        expect(addPrAssignees).not.toHaveBeenCalled();
      });

      it("addPrAssignees failure is swallowed: result ok, onboarding comment intact", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("octocat"));
        addPrAssignees.mockRejectedValue(new Error("github down"));

        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();

        expect(result).toBe("ok");
        expect(postIssueComment).toHaveBeenCalledTimes(1);
      });

      it("silent drop (login lacks push access, assigned empty) does not throw", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("octocat"));
        addPrAssignees.mockResolvedValue({ assigned: [] });

        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();
        expect(result).toBe("ok");
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
    });

    it("foreign inbox_id → cross-task leak: aborts, no appendPrUrl / attach / onboarding", async () => {
      // The seed of the cross-task pr_urls pollution: a pr_opened emitted in a
      // stream whose round belongs to a DIFFERENT task (confused-deputy emit, or
      // a crossed sandbox binding) must NOT write that PR into this task's
      // pr_urls — findByPrUrl would then mis-route every comment on it. A foreign
      // inbox_id resolves to null → the dispatcher returns "abort" so reconcile
      // halts the whole stream (no side effect applied, cursor not advanced).
      findRow.mockResolvedValue(null);
      const result = await dispatcher.handle(prEvent(), makeTask());
      expect(result).toBe("abort");
      expect(appendPrUrl).not.toHaveBeenCalled();
      expect(attachUrlToIssue).not.toHaveBeenCalled();
      expect(postIssueComment).not.toHaveBeenCalled();
    });
  });

  describe("agent_response targeted reply", () => {
    const ghCommentRow = (): InboxRow => ({
      id: "inbox-2",
      task_id: "task-1",
      source: "github",
      external_id: "555",
      kind: "comment",
      payload: {
        target_id: "555",
        body: "b",
        task_id: "task-1",
        task_key: "XYZ-1",
        pr: null,
        created_at: "",
      },
      reply_targets: [
        {
          id: "555",
          spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 1, commentId: 555 },
        },
      ],
      status: "delivered",
      failure_reason: null,
      outcome: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const responseEvent = (
      targetId: string,
    ): Extract<HarnessEvent, { type: "agent_response" }> => ({
      seq: 1,
      ts: "t",
      type: "agent_response",
      inbox_id: "inbox-2",
      body: "good catch, fixing",
      target_id: targetId,
    });

    it("routes an issue_comment target to postIssueComment", async () => {
      findRow.mockResolvedValue(ghCommentRow());
      await dispatcher.handle(responseEvent("555"), makeTask());
      expect(postIssueComment).toHaveBeenCalledWith(
        "o",
        "r",
        1,
        "good catch, fixing",
        expect.any(AbortSignal),
      );
      expect(emitResponse).not.toHaveBeenCalled();
    });

    it("routes a review_comment target to postReviewCommentReply", async () => {
      const row = ghCommentRow();
      row.reply_targets = [
        {
          id: "555",
          spec: {
            kind: "review_comment",
            owner: "o",
            repo: "r",
            prNumber: 1,
            commentId: 555,
            inReplyTo: 555,
            path: "a.ts",
            line: 9,
          },
        },
      ];
      findRow.mockResolvedValue(row);
      await dispatcher.handle(responseEvent("555"), makeTask());
      expect(postReviewCommentReply).toHaveBeenCalledWith(
        "o",
        "r",
        1,
        555,
        "good catch, fixing",
        expect.any(AbortSignal),
      );
    });

    it("routes a linear_session target to emitResponse using target.id (the session id)", async () => {
      const row = ghCommentRow();
      row.source = "linear";
      // reply_targets[0].id IS the session id by construction.
      row.reply_targets = [{ id: "sess-1", spec: { kind: "linear_session" } }];
      findRow.mockResolvedValue(row);
      await dispatcher.handle(responseEvent("sess-1"), makeTask());
      expect(emitResponse).toHaveBeenCalledWith(expect.anything(), "sess-1", "good catch, fixing");
    });

    it("a GitHub reply that fails before sending (429) holds; any other failure is dropped", async () => {
      findRow.mockResolvedValue(ghCommentRow());
      // githubFetch's error for a 429 carries the status and Retry-After.
      postIssueComment.mockRejectedValueOnce(
        new HttpError(
          'GitHub POST /repos/o/r/issues/1/comments failed: HTTP 429 {"message":"API rate limit exceeded"}',
          429,
          30_000,
        ),
      );
      expect(await dispatcher.handle(responseEvent("555"), makeTask())).toBe("hold");
      // A 5xx may have landed: dropped, the cursor advances past it.
      postIssueComment.mockRejectedValueOnce(
        new HttpError("GitHub POST /repos/o/r/issues/1/comments failed: HTTP 502 ", 502),
      );
      expect(await dispatcher.handle(responseEvent("555"), makeTask())).toBe("dropped");
      expect(postIssueComment).toHaveBeenCalledTimes(2);
    });

    it("Linear and GitHub refuse a target that isn't theirs: logged and dropped", async () => {
      const error = spyOn(logger, "error").mockImplementation(() => logger);
      try {
        // A Linear round carrying a GitHub thread, and a GitHub round carrying
        // a Linear session.
        findRow.mockResolvedValueOnce({ ...ghCommentRow(), source: "linear" });
        expect(await dispatcher.handle(responseEvent("555"), makeTask())).toBe("dropped");
        const row = ghCommentRow();
        row.reply_targets = [{ id: "555", spec: { kind: "linear_session" } }];
        findRow.mockResolvedValueOnce(row);
        expect(await dispatcher.handle(responseEvent("555"), makeTask())).toBe("dropped");

        expect(
          error.mock.calls.map(([msg, meta]) => [msg, (meta as { message?: string }).message]),
        ).toEqual([
          ["deliver reply failed", "not a Linear agent session target"],
          ["deliver reply failed", "not a GitHub PR thread target"],
        ]);
      } finally {
        error.mockRestore();
      }
      expect(linearTokenProvider.getAuthorizedLinearClient).not.toHaveBeenCalled();
      expect(emitResponse).not.toHaveBeenCalled();
      expect(postIssueComment).not.toHaveBeenCalled();
    });

    it("GitHub refuses a thread target without its owner or repo, or with a non-numeric PR number", async () => {
      const spec = { kind: "issue_comment", owner: "o", repo: "r", prNumber: 1, commentId: 555 };
      const { owner: _o, ...noOwner } = spec;
      const { repo: _r, ...noRepo } = spec;
      const error = spyOn(logger, "error").mockImplementation(() => logger);
      try {
        for (const bad of [noOwner, noRepo, { ...spec, prNumber: "1" }]) {
          const row = ghCommentRow();
          row.reply_targets = [{ id: "555", spec: bad }];
          findRow.mockResolvedValueOnce(row);
          expect(await dispatcher.handle(responseEvent("555"), makeTask())).toBe("dropped");
        }
        expect(error.mock.calls.map(([, meta]) => (meta as { message?: string }).message)).toEqual([
          "not a GitHub PR thread target",
          "not a GitHub PR thread target",
          "not a GitHub PR thread target",
        ]);
      } finally {
        error.mockRestore();
      }
      expect(postIssueComment).not.toHaveBeenCalled();
    });

    it("skips GitHub replies when GitHub webhooks are off: not posted, not held", async () => {
      findRow.mockResolvedValue(ghCommentRow());
      expect(await withGithubOff().handle(responseEvent("555"), makeTask())).toBe("ok");
      expect(postIssueComment).not.toHaveBeenCalled();
      expect(holds.of("github").heldTasks).toBe(0);
    });

    it("a Linear token failure does not hold a GitHub round's reply or completion on a Linear task", async () => {
      (linearTokenProvider.getAuthorizedLinearClient as ReturnType<typeof mock>).mockRejectedValue(
        linearUnreachable(),
      );
      findRow.mockResolvedValue(ghCommentRow());
      expect(await dispatcher.handle(responseEvent("555"), makeTask())).toBe("ok");
      expect(
        await dispatcher.handle(
          { seq: 2, ts: "t", type: "completed", inbox_id: "inbox-2" },
          makeTask(),
        ),
      ).toBe("ok");
      expect(postIssueComment).toHaveBeenCalledWith(
        "o",
        "r",
        1,
        "good catch, fixing",
        expect.any(AbortSignal),
      );
      expect(markResponded).toHaveBeenCalledWith({
        inboxId: "inbox-2",
        ownerId: "pod-test",
        outcome: null,
      });
      expect(linearTokenProvider.getAuthorizedLinearClient).not.toHaveBeenCalled();
    });

    it("drops a target_id absent from reply_targets (no throw, no post)", async () => {
      findRow.mockResolvedValue(ghCommentRow());
      const result = await dispatcher.handle(responseEvent("not-a-target"), makeTask());
      expect(result).toBe("ok");
      expect(postIssueComment).not.toHaveBeenCalled();
    });

    it("a send holds on the round's integration; the Linear client fetch on the task's", async () => {
      // A GitHub round on a Linear task: the 429 is GitHub's hold.
      findRow.mockResolvedValue(ghCommentRow());
      postIssueComment.mockRejectedValueOnce(new HttpError("HTTP 429", 429));
      expect(await dispatcher.handle(responseEvent("555"), makeTask())).toBe("hold");
      expect(holds.of("github").heldTasks).toBe(1);
      expect(holds.of("linear").heldTasks).toBe(0);
      // pr_opened's Linear client fetch is the task's (Linear's) hold.
      (linearTokenProvider.getAuthorizedLinearClient as ReturnType<typeof mock>).mockRejectedValue(
        linearUnreachable(),
      );
      expect(await dispatcher.handle(prEvent(), makeTask({ id: "task-2" }))).toBe("hold");
      expect(holds.of("linear").heldTasks).toBe(1);
    });

    it("a Linear send gets a per-call client bound to the send's signal", async () => {
      const row = ghCommentRow();
      row.source = "linear";
      row.reply_targets = [{ id: "sess-1", spec: { kind: "linear_session" } }];
      findRow.mockResolvedValue(row);
      expect(await dispatcher.handle(responseEvent("sess-1"), makeTask())).toBe("ok");
      expect(linearTokenProvider.getAuthorizedLinearClient).toHaveBeenCalledWith(
        expect.any(AbortSignal),
      );
    });
  });

  describe("completed", () => {
    // Bare terminal marker. Assignment rounds carry `status`; comment/review
    // rounds omit it. The completion message rides on the preceding
    // agent_response / agent_error emit (covered above).
    const completedEvent = (): Extract<HarnessEvent, { type: "completed" }> => ({
      seq: 1,
      ts: "t",
      type: "completed",
      inbox_id: "inbox-1",
      status: "completed",
    });

    type ReviewRow = InboxRow & { payload: ReviewPayload };
    const ghReviewRow = (overrides: Partial<ReviewRow> = {}): ReviewRow => ({
      id: "inbox-1",
      task_id: "task-1",
      source: "github",
      external_id: "88",
      kind: "review",
      payload: {
        review_body: { target_id: "88", body: "@devbox fix" },
        inline_comments: [],
        task_id: "task-1",
        task_key: "XYZ-1",
        pr: {
          owner: "o",
          repo: "r",
          prNumber: 7,
          pr_url: "https://github.com/o/r/pull/7",
        },
        reviewer_login: "reviewer",
        created_at: "2026-04-23T12:00:00Z",
      },
      reply_targets: [
        {
          id: "88",
          spec: { kind: "review_body", owner: "o", repo: "r", prNumber: 7, reviewId: 88 },
        },
      ],
      status: "delivered",
      failure_reason: null,
      outcome: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    });

    it("marks the inbox row responded even when status is omitted (comment/review path)", async () => {
      await dispatcher.handle(
        { seq: 1, ts: "t", type: "completed", inbox_id: "inbox-1" },
        makeTask(),
      );
      expect(markResponded).toHaveBeenCalledWith({
        inboxId: "inbox-1",
        ownerId: "pod-test",
        outcome: null,
      });
    });

    it("marks the inbox row responded", async () => {
      await dispatcher.handle(completedEvent(), makeTask());

      expect(markResponded).toHaveBeenCalledWith({
        inboxId: "inbox-1",
        ownerId: "pod-test",
        outcome: "completed",
      });
    });

    it("records the completed event's status as the round outcome", async () => {
      await dispatcher.handle(
        { seq: 9, ts: "t", type: "completed", inbox_id: "inbox-1", status: "partial_failure" },
        makeTask(),
      );
      expect(markResponded).toHaveBeenCalledWith({
        inboxId: "inbox-1",
        ownerId: "pod-test",
        outcome: "partial_failure",
      });
    });

    it("is a pure marker: does NOT emitResponse / emitError", async () => {
      // The message already went out via the generic agent_response/agent_error
      // forwarder; the marker only frees the sandbox.
      await dispatcher.handle(completedEvent(), makeTask());
      expect(emitResponse).not.toHaveBeenCalled();
      expect(emitError).not.toHaveBeenCalled();
    });

    it("failed status is still a bare marker: marks responded, no emit", async () => {
      await dispatcher.handle({ ...completedEvent(), status: "failed" }, makeTask());
      expect(emitError).not.toHaveBeenCalled();
      expect(emitResponse).not.toHaveBeenCalled();
      expect(markResponded).toHaveBeenCalled();
    });

    it("skips an inbox row already 'responded' (idempotent re-fire)", async () => {
      findRow.mockResolvedValue(linearRow({ status: "responded" }));
      await dispatcher.handle(completedEvent(), makeTask());
      expect(markResponded).not.toHaveBeenCalled();
    });

    it("uploads the run archive to the Linear issue for an assignment round", async () => {
      extractArchive.mockResolvedValue(new Uint8Array([1, 2]));
      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();
      expect(extractArchive).toHaveBeenCalledWith("sbx-1");
      expect(uploadIssueAttachment).toHaveBeenCalledWith(expect.anything(), {
        issueId: "issue-1",
        title: "Harness run archive",
        subtitle: "Task task-1",
        filename: "harness-run-task-1.tar.gz",
        contentType: "application/gzip",
        bytes: new Uint8Array([1, 2]),
        metadata: { taskId: "task-1" },
        signal: expect.any(AbortSignal),
      });
    });

    it("posts a Slack completion update on the first transition (assignment round)", async () => {
      await dispatcher.handle(completedEvent(), makeTask());
      expect(notifyTerminal).toHaveBeenCalledTimes(1);
      expect(notifyTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        "completed",
      );
    });

    it("runs the Slack post in BackgroundWork, so shutdown waits for it", async () => {
      let posted = false;
      notifyTerminal.mockImplementation(() =>
        sleep(20).then(() => {
          posted = true;
        }),
      );
      await dispatcher.handle(completedEvent(), makeTask());
      await background.drain(sleep(500));
      expect(posted).toBe(true);
    });

    it("forwards the event status to the Slack notify (partial_failure)", async () => {
      await dispatcher.handle({ ...completedEvent(), status: "partial_failure" }, makeTask());
      expect(notifyTerminal).toHaveBeenCalledWith(expect.anything(), "partial_failure");
    });

    it("does NOT post to Slack on an idempotent re-fire (already responded)", async () => {
      findRow.mockResolvedValue(linearRow({ status: "responded" }));
      await dispatcher.handle(completedEvent(), makeTask());
      expect(notifyTerminal).not.toHaveBeenCalled();
    });

    it("does NOT post to Slack when markResponded returns 0 rows (lease lost)", async () => {
      markResponded.mockResolvedValue([]);
      await dispatcher.handle(completedEvent(), makeTask());
      expect(notifyTerminal).not.toHaveBeenCalled();
    });

    it("does NOT post to Slack for a comment/review round (kind !== assignment)", async () => {
      findRow.mockResolvedValue({ ...linearRow(), kind: "comment" } as InboxRow);
      await dispatcher.handle(
        { seq: 1, ts: "t", type: "completed", inbox_id: "inbox-1" },
        makeTask(),
      );
      expect(notifyTerminal).not.toHaveBeenCalled();
      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("re-requests review from the original reviewer on the first completed review transition", async () => {
      findRow.mockResolvedValue(ghReviewRow());

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).toHaveBeenCalledTimes(1);
      expect(requestReviewers).toHaveBeenCalledWith(
        "o",
        "r",
        7,
        ["reviewer"],
        expect.any(AbortSignal),
      );
    });

    it("falls back to review reply_targets for historical review rows without payload PR coordinates", async () => {
      const row = ghReviewRow();
      row.payload.pr = { repo: "r", pr_url: "not-a-github-url" };
      findRow.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).toHaveBeenCalledWith(
        "o",
        "r",
        7,
        ["reviewer"],
        expect.any(AbortSignal),
      );
    });

    it("falls back to a review_comment reply_target when review_body is unavailable", async () => {
      const row = ghReviewRow();
      row.payload.pr = { repo: "r", pr_url: "not-a-github-url" };
      row.reply_targets = [
        {
          id: "11",
          spec: {
            kind: "review_comment",
            owner: "oc",
            repo: "rc",
            prNumber: 8,
            commentId: 11,
            inReplyTo: 11,
            path: "a.ts",
            line: 3,
          },
        },
      ];
      findRow.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).toHaveBeenCalledWith(
        "oc",
        "rc",
        8,
        ["reviewer"],
        expect.any(AbortSignal),
      );
    });

    it("falls back to parsing review payload pr_url when reply_targets are unavailable", async () => {
      const row = ghReviewRow();
      row.payload.pr = { repo: "r", pr_url: "https://github.com/fallback/repo/pull/9" };
      row.reply_targets = [];
      findRow.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).toHaveBeenCalledWith(
        "fallback",
        "repo",
        9,
        ["reviewer"],
        expect.any(AbortSignal),
      );
    });

    it("does not re-request review on an idempotent review completion re-fire", async () => {
      findRow.mockResolvedValue(ghReviewRow({ status: "responded" }));

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("does not re-request review when markResponded returns 0 rows", async () => {
      findRow.mockResolvedValue(ghReviewRow());
      markResponded.mockResolvedValue([]);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("skips review re-request when reviewer_login is missing", async () => {
      const row = ghReviewRow();
      delete row.payload.reviewer_login;
      findRow.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("skips review re-request when reviewer_login is blank", async () => {
      const row = ghReviewRow();
      row.payload.reviewer_login = " ";
      findRow.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("skips review re-request when PR coordinates cannot be resolved", async () => {
      const row = ghReviewRow();
      row.payload.pr = { repo: "r", pr_url: "not-a-github-url" };
      row.reply_targets = [];
      findRow.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("swallows request-reviewer failures and still returns ok", async () => {
      findRow.mockResolvedValue(ghReviewRow());
      requestReviewers.mockRejectedValue(new Error("GitHub unavailable"));

      const result = await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(result).toBe("ok");
      expect(requestReviewers).toHaveBeenCalledWith(
        "o",
        "r",
        7,
        ["reviewer"],
        expect.any(AbortSignal),
      );
    });

    it("does not crash when markResponded returns 0 rows (lease lost; warned)", async () => {
      markResponded.mockResolvedValue([]);
      await dispatcher.handle(completedEvent(), makeTask());
      expect(markResponded).toHaveBeenCalled();
    });

    it("Linear assignment: a token fetch failure no longer holds; it marks and notifies Slack", async () => {
      // Slack's mention comes from assignee(), which fails (logged) and the
      // post goes out without it; completed needs no Linear client.
      (linearTokenProvider.getAuthorizedLinearClient as ReturnType<typeof mock>).mockRejectedValue(
        linearUnreachable(),
      );
      expect(await dispatcher.handle(completedEvent(), makeTask())).toBe("ok");
      expect(markResponded).toHaveBeenCalled();
      expect(notifyTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        "completed",
      );
    });

    it("still marks responded when linearClient is null", async () => {
      // The marker frees the sandbox regardless of Linear availability — it
      // never touches linearClient.
      (linearTokenProvider.getAuthorizedLinearClient as ReturnType<typeof mock>).mockResolvedValue(
        null,
      );
      await dispatcher.handle(completedEvent(), makeTask());
      expect(markResponded).toHaveBeenCalled();
    });
  });

  // reconcileOne advances the cursor only after handle() returns, so a lost
  // lease or a crash in between dispatches the same events again.
  describe("replay (same event dispatched again)", () => {
    it("completed: the run archive uploads once; the already-responded replay skips it", async () => {
      extractArchive.mockResolvedValue(new Uint8Array([1]));
      const done: HarnessEvent = {
        seq: 5,
        ts: "t",
        type: "completed",
        inbox_id: "inbox-1",
        status: "completed",
      };
      await dispatcher.handle(done, makeTask());
      findRow.mockResolvedValue(linearRow({ status: "responded" }));
      await dispatcher.handle(done, makeTask());
      await flushMicrotasks();

      expect(markResponded).toHaveBeenCalledTimes(1);
      expect(extractArchive).toHaveBeenCalledTimes(1);
      expect(uploadIssueAttachment).toHaveBeenCalledTimes(1);
    });

    it("pr_opened: the Linear attach re-runs (appendPrUrl returns the row for a known URL)", async () => {
      await dispatcher.handle(prEvent(), makeTask());
      await dispatcher.handle(prEvent(), makeTask());
      expect(appendPrUrl).toHaveBeenCalledTimes(2);
      expect(attachUrlToIssue).toHaveBeenCalledTimes(2);
    });

    describe("pr_opened: the onboarding comment and the PR assignee mirror", () => {
      beforeEach(() => {
        getIssueHumanAssignee.mockResolvedValue({
          id: "usr-1",
          name: "Ada Lovelace",
          displayName: "ada",
          email: "ada@acme.com",
          gitHubUserId: "octocat",
        });
        addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
      });

      it("run again when a crash came before the PR was recorded", async () => {
        appendPrUrl.mockRejectedValueOnce(new Error("connection terminated"));
        await expect(dispatcher.handle(prEvent(), makeTask())).rejects.toThrow(
          "connection terminated",
        );
        await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();

        expect(postIssueComment).toHaveBeenCalledTimes(2);
        expect(addPrAssignees).toHaveBeenCalledTimes(2);
        expect(attachUrlToIssue).toHaveBeenCalledTimes(1);
      });

      it("don't run again once the PR is recorded", async () => {
        await dispatcher.handle(prEvent(), makeTask());
        appendPrUrl.mockResolvedValue([{ id: "task-1", firstTime: false }]);
        await dispatcher.handle(prEvent(), taskWithPr());
        await flushMicrotasks();

        expect(postIssueComment).toHaveBeenCalledTimes(1);
        expect(addPrAssignees).toHaveBeenCalledTimes(1);
        // The owner's onPrOpened (the idempotent Linear attach) runs every time.
        expect(attachUrlToIssue).toHaveBeenCalledTimes(2);
      });
    });

    it("agent_response and agent_error post again on every dispatch", async () => {
      const reply: HarnessEvent = {
        seq: 2,
        ts: "t",
        type: "agent_response",
        inbox_id: "inbox-1",
        target_id: "sess-1",
        body: "done",
      };
      const error: HarnessEvent = { ...reply, seq: 3, type: "agent_error", body: "bad" };
      for (const e of [reply, reply, error, error]) await dispatcher.handle(e, makeTask());
      expect(emitResponse).toHaveBeenCalledTimes(2);
      expect(emitError).toHaveBeenCalledTimes(2);
    });
  });
});
