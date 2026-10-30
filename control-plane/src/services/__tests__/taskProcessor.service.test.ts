import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { SandboxInfo } from "@alibaba-group/opensandbox";
import { SandboxApiException } from "@alibaba-group/opensandbox";
import type { LinearClient } from "@linear/sdk";
import type { Task } from "../../db/schema";
import { PvcNotFoundError, SandboxCreateError } from "../../errors";
import { fakeIntegrations } from "../../integrations/__tests__/fakeIntegrations";
import type { Integration, IntegrationName } from "../../integrations/types";
import type { InboxRepository } from "../../repositories/inbox.repository";
import type { TaskRepository } from "../../repositories/task.repository";
import type { HarnessEvent } from "../../types/harnessEvent";
import type { EventDispatcher } from "../eventDispatcher";
import type { InboxService } from "../inbox.service";
import type { LinearTokenProvider } from "../linearTokenProvider";
import type { SandboxManager } from "../sandboxManager.service";
import type { SlackNotifierService } from "../slackNotifier.service";

mock.module("../../config", () => ({
  config: {
    podId: "pod-test",
    taskPollIntervalMs: 5,
    leaseTimeoutMs: 1000,
    shutdownDrainMs: 5000,
    maxConcurrentSandboxes: 100,
    idleSandboxKillMs: 900_000,
    sandboxFilesUnavailableFailMs: 600_000,
    // 0 → an absent pod defers on its first sighting (records the grace start)
    // then fails on the next, which keeps the absent-grace tests deterministic.
    sandboxAbsentGraceMs: 0,
    // Small so the retry-cap test trips after a couple attempts.
    maxTaskRetries: 2,
    opensandbox: { sandboxResourceMemory: "256Mi" },
  },
}));

const waitFor = async (pred: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: condition not met within timeout");
};

const setIssueStarted = mock(() => Promise.resolve());
const emitAction = mock(() => Promise.resolve());
const emitThought = mock(() => Promise.resolve());
const emitError = mock(() => Promise.resolve());

mock.module("../../clients/linear", () => ({
  setIssueStarted,
  emitAction,
  emitThought,
  emitError,
  emitResponse: mock(() => Promise.resolve()),
  attachUrlToIssue: mock(() => Promise.resolve()),
  uploadIssueAttachment: mock(() => Promise.resolve()),
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

// taskProcessor.service imports the ../../clients/github barrel. Loading the
// real barrel here lets a later file's mock.module of it patch the shared
// ./githubApi exports, so github.test.ts gets stubs (order-dependent, Linux
// only). Mock the barrel before importing, like the other consumers' tests.
// The mock leaks to later files too, so it stubs every export they import.
// See control-plane/README.md (Conventions).
const postIssueComment = mock(() => Promise.resolve({ id: 1, url: "u" }));
const postReviewCommentReply = mock(() => Promise.resolve({ id: 1, url: "u" }));
mock.module("../../clients/github", () => ({
  addIssueCommentReaction: mock(() => Promise.resolve()),
  addReviewCommentReaction: mock(() => Promise.resolve()),
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

const { TaskProcessorService } = await import("../taskProcessor.service");
const { LinearIntegration } = await import("../../integrations/linear");
const { GithubIntegration } = await import("../../integrations/github");
const { ApiIntegration } = await import("../../integrations/api");
const { logger } = await import("../../logger");
const { ReplyHolds } = await import("../replyHolds");
const { IntegrationHooks } = await import("../integrationHooks");
const { EventDispatcher: RealEventDispatcher } = await import("../eventDispatcher");
const { InboxService: RealInboxService, WORKSPACE_MISSING_MESSAGE } = await import(
  "../inbox.service"
);
const { config: mockedConfig } = (await import("../../config")) as unknown as {
  config: { shutdownDrainMs: number; leaseTimeoutMs: number };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const { RetryableError } = await import("../../integrations/outbound");

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  source: "linear",
  externalId: "issue-1",
  key: "XYZ-1",
  createdBy: null,
  title: "t",
  externalUrl: "https://linear.app/x/issue/T-1",
  metadata: {},
  ownerId: "pod-test",
  heartbeatAt: new Date(),
  sandboxId: null,
  pvcName: null,
  prUrls: [],
  lastObservedEventSeq: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeSandboxInfo = (overrides: Partial<SandboxInfo> = {}): SandboxInfo => ({
  id: "sbx-1",
  image: { uri: "devbox-dev:local" },
  entrypoint: [],
  status: { state: "Running" },
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

// One non-terminal inbox row with a Linear session reply target — "surviving
// work" for retryTask's resume gate and a broadcast target for failTask.
// biome-ignore lint/suspicious/noExplicitAny: test stub shape, cast at use site
const survivingNonTerminalRow = (taskId = "task-1", externalId = "issue-1"): any => ({
  id: "inbox-1",
  task_id: taskId,
  source: "linear",
  external_id: externalId,
  kind: "assignment",
  payload: {},
  reply_targets: [{ id: "sess-1", spec: { kind: "linear_session" } }],
  status: "pending",
  failure_reason: null,
  outcome: null,
  created_at: new Date(),
  updated_at: new Date(),
});

describe("TaskProcessorService", () => {
  let heartbeatOwnedBy: ReturnType<typeof mock>;
  let claimNext: ReturnType<typeof mock>;
  let attachSandboxResources: ReturnType<typeof mock>;
  let backdateHeartbeatsOwnedBy: ReturnType<typeof mock>;
  let listInFlightOwnedBy: ReturnType<typeof mock>;
  let reapIdleTasks: ReturnType<typeof mock>;
  let recordEventCursor: ReturnType<typeof mock>;
  let releaseLease: ReturnType<typeof mock>;
  let requeueForRetry: ReturnType<typeof mock>;
  let getById: ReturnType<typeof mock>;
  let getByIdOwnedBy: ReturnType<typeof mock>;
  let failTaskInbox: ReturnType<typeof mock>;
  let getAuthorizedLinearClient: ReturnType<typeof mock>;
  let createSandboxWithPvc: ReturnType<typeof mock>;
  let createSandboxFromExistingPvc: ReturnType<typeof mock>;
  let setSandboxId: ReturnType<typeof mock>;
  let deadLetterWorkspaceMissing: ReturnType<typeof mock>;
  let attachSandbox: ReturnType<typeof mock>;
  let getSandboxInfo: ReturnType<typeof mock>;
  let getSandboxPodStatus: ReturnType<typeof mock>;
  let killSandbox: ReturnType<typeof mock>;
  let closeSandboxAndDeletePvc: ReturnType<typeof mock>;
  let readEvents: ReturnType<typeof mock>;
  let dispatcherHandle: ReturnType<typeof mock>;
  let sweepUndelivered: ReturnType<typeof mock>;
  let taskRepo: TaskRepository;
  let inboxRepo: InboxRepository;
  let linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">;
  let sandboxManager: SandboxManager;
  let eventDispatcher: EventDispatcher;
  let inboxService: InboxService;
  let notifyTerminal: ReturnType<typeof mock>;
  let slackNotifier: SlackNotifierService;
  let holds: InstanceType<typeof ReplyHolds>;
  let integrations: Record<IntegrationName, Integration> & {
    linear: InstanceType<typeof LinearIntegration>;
  };
  let hooks: InstanceType<typeof IntegrationHooks>;
  let service: InstanceType<typeof TaskProcessorService>;

  beforeEach(() => {
    setIssueStarted.mockReset();
    setIssueStarted.mockResolvedValue(undefined);
    emitAction.mockReset();
    emitAction.mockResolvedValue(undefined);
    emitThought.mockReset();
    emitThought.mockResolvedValue(undefined);
    emitError.mockReset();
    emitError.mockResolvedValue(undefined);
    postIssueComment.mockReset();
    postIssueComment.mockResolvedValue({ id: 1, url: "u" });
    postReviewCommentReply.mockReset();
    postReviewCommentReply.mockResolvedValue({ id: 1, url: "u" });

    // Renews every task the tests reconcile.
    heartbeatOwnedBy = mock(() => Promise.resolve([{ id: "task-1" }, { id: "task-2" }]));
    claimNext = mock(() => Promise.resolve(null));
    attachSandboxResources = mock(() => Promise.resolve([{ id: "task-1" }]));
    backdateHeartbeatsOwnedBy = mock(() => Promise.resolve());
    listInFlightOwnedBy = mock(() => Promise.resolve([] as Task[]));
    reapIdleTasks = mock(() => Promise.resolve([] as Array<{ id: string; sandboxId: string }>));
    recordEventCursor = mock(() => Promise.resolve([{ id: "task-1" }]));
    releaseLease = mock(() => Promise.resolve([{ id: "task-1" }]));
    requeueForRetry = mock(() => Promise.resolve(true));
    setSandboxId = mock(() => Promise.resolve([{ id: "task-1" }]));
    getById = mock((id: string) => Promise.resolve(makeTask({ id })));
    getByIdOwnedBy = mock((id: string) => Promise.resolve(makeTask({ id })));
    taskRepo = {
      heartbeatOwnedBy,
      claimNext,
      attachSandboxResources,
      backdateHeartbeatsOwnedBy,
      listInFlightOwnedBy,
      reapIdleTasks,
      recordEventCursor,
      releaseLease,
      requeueForRetry,
      setSandboxId,
      getById,
      getByIdOwnedBy,
    } as unknown as TaskRepository;

    failTaskInbox = mock(() => Promise.resolve([] as Array<{ id: string }>));
    inboxRepo = {
      failTaskInbox,
      getAssignment: mock(() => Promise.resolve(survivingNonTerminalRow())),
      // Default: one SURVIVING non-terminal row (with a Linear session reply
      // target). retryTask now treats "no surviving non-terminal row" as a clean
      // terminal (no requeue), so the retry-path tests need work left to resume;
      // this default gives them that. Tests exercising the no-surviving-work path
      // override this with [].
      listNonTerminalByTask: mock(() => Promise.resolve([survivingNonTerminalRow()])),
    } as unknown as InboxRepository;

    getAuthorizedLinearClient = mock(() => Promise.resolve({} as unknown as LinearClient));
    linearTokenProvider = { getAuthorizedLinearClient } as unknown as Pick<
      LinearTokenProvider,
      "getAuthorizedLinearClient"
    >;

    createSandboxWithPvc = mock(() =>
      Promise.resolve({ sandboxId: "sbx-1", pvcName: "devbox-pvc-task-1-aaaaaa" }),
    );
    createSandboxFromExistingPvc = mock(() => Promise.resolve("sbx-recreated"));
    attachSandbox = mock(() => Promise.resolve({} as unknown));
    getSandboxInfo = mock(() => Promise.resolve(makeSandboxInfo()));
    // Default: pod state unknown (null) so reconcile keeps its time-based defer
    // behaviour; the pod-terminal fast-fail tests override this per-case.
    getSandboxPodStatus = mock(() => Promise.resolve(null));
    killSandbox = mock(() => Promise.resolve());
    closeSandboxAndDeletePvc = mock(() => Promise.resolve());
    readEvents = mock(() => Promise.resolve([] as HarnessEvent[]));
    sandboxManager = {
      createSandboxWithPvc,
      createSandboxFromExistingPvc,
      attachSandbox,
      getSandboxInfo,
      getSandboxPodStatus,
      killSandbox,
      closeSandboxAndDeletePvc,
      readEvents,
    } as unknown as SandboxManager;

    dispatcherHandle = mock(() => Promise.resolve("ok" as const));
    eventDispatcher = { handle: dispatcherHandle } as unknown as EventDispatcher;

    sweepUndelivered = mock(() => Promise.resolve());
    deadLetterWorkspaceMissing = mock(() => Promise.resolve());
    inboxService = { sweepUndelivered, deadLetterWorkspaceMissing } as unknown as InboxService;

    notifyTerminal = mock(() => Promise.resolve());
    // Slack on with the default SLACK_NOTIFY_SOURCES (linear).
    slackNotifier = {
      notifyTerminal,
      notifies: (source: string) => source === "linear",
    } as unknown as SlackNotifierService;

    holds = new ReplyHolds();
    integrations = fakeIntegrations({
      linear: new LinearIntegration(linearTokenProvider, true, {
        status: async () => ({ configured: false }),
      }),
      api: new ApiIntegration(true),
      github: new GithubIntegration(true, { status: () => ({}) as never }),
    });
    hooks = new IntegrationHooks(integrations, inboxRepo);
    service = new TaskProcessorService(
      taskRepo,
      inboxRepo,
      sandboxManager,
      eventDispatcher,
      inboxService,
      slackNotifier,
      integrations,
      holds,
      ["linear", "api"],
      hooks,
    );
  });

  // failTask broadcasts to the reply targets of the rows failTaskInbox
  // dead-letters — stub one with a Linear session target so the user-facing
  // failure message reaches emitError.
  const stubLinearTarget = (task: Task): void => {
    failTaskInbox.mockResolvedValueOnce([survivingNonTerminalRow(task.id, task.externalId)]);
  };

  describe("API tasks", () => {
    const apiTask = () =>
      makeTask({
        source: "api",
        key: "DBX-API-1",
        sandboxId: null,
        pvcName: null,
        externalUrl: "https://cp/api/tasks/DBX-API-1",
      });

    it("fresh provision runs with no Linear calls", async () => {
      claimNext.mockResolvedValueOnce(apiTask()).mockResolvedValue(null);
      service.start();
      await waitFor(() => attachSandboxResources.mock.calls.length > 0);
      await service.stop();
      expect(createSandboxWithPvc).toHaveBeenCalledTimes(1);
      expect(setIssueStarted).not.toHaveBeenCalled();
      expect(emitAction).not.toHaveBeenCalled();
      expect(emitThought).not.toHaveBeenCalled();
      expect(getAuthorizedLinearClient).not.toHaveBeenCalled();
    });

    it("failTask posts nothing to an api_session target and still dead-letters", async () => {
      const t = apiTask();
      failTaskInbox.mockResolvedValue([
        {
          ...survivingNonTerminalRow(t.id, t.externalId),
          source: "api",
          reply_targets: [{ id: t.id, spec: { kind: "api_session" } }],
        },
      ]);
      createSandboxWithPvc.mockRejectedValueOnce(new Error("boom"));
      claimNext.mockResolvedValueOnce(t).mockResolvedValue(null);
      service.start();
      await waitFor(() => failTaskInbox.mock.calls.length > 0);
      await service.stop();
      expect(emitError).not.toHaveBeenCalled();
      expect(failTaskInbox).toHaveBeenCalledWith({
        taskId: t.id,
        ownerId: "pod-test",
        reason: "Task failed — check control-plane logs for details.",
      });
      expect(notifyTerminal).not.toHaveBeenCalled();
    });
  });

  describe("runTask — fresh provisioning", () => {
    it("creates a sandbox, stamps sandbox_id, asserts InProgress, emits no IDs thought", async () => {
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);

      service.start();
      await waitFor(() => attachSandboxResources.mock.calls.length > 0);
      await service.stop();

      expect(createSandboxWithPvc).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", source: "linear", experimentalFlags: [] }),
      );
      expect(attachSandboxResources).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        sandboxId: "sbx-1",
        pvcName: "devbox-pvc-task-1-aaaaaa",
      });
      expect(setIssueStarted).toHaveBeenCalledWith(expect.anything(), "issue-1");
      expect(emitAction).toHaveBeenCalledWith(expect.anything(), "sess-1", "Provisioning", "infra");
      // The post-create "Sandbox provisioned" thought is gone (spec §13).
      expect(emitThought).not.toHaveBeenCalled();
    });

    it("logs and still provisions when the team has no started state", async () => {
      setIssueStarted.mockRejectedValueOnce(
        new Error('No workflow state of type "started" for team t'),
      );
      const error = spyOn(logger, "error").mockImplementation(() => logger);
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);

      try {
        service.start();
        await waitFor(() => attachSandboxResources.mock.calls.length > 0);
        await service.stop();

        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenLastCalledWith("setIssueStarted failed for task task-1", {
          message: 'No workflow state of type "started" for team t',
          stack: expect.any(String),
        });
      } finally {
        error.mockRestore();
      }
      expect(setIssueStarted).toHaveBeenCalledWith(expect.anything(), "issue-1");
      expect(emitAction).toHaveBeenCalledWith(expect.anything(), "sess-1", "Provisioning", "infra");
      expect(attachSandboxResources).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        sandboxId: "sbx-1",
        pvcName: "devbox-pvc-task-1-aaaaaa",
      });
      expect(failTaskInbox).not.toHaveBeenCalled();
    });

    it("runs the owner's onTaskStarted once per assignment id, before the sandbox is created", async () => {
      const order: string[] = [];
      const onTaskStarted = mock(async () => {
        order.push("started");
      });
      (integrations.linear as Integration).onTaskStarted = onTaskStarted;
      const assignment = survivingNonTerminalRow();
      (inboxRepo as { getAssignment?: unknown }).getAssignment = mock(() =>
        Promise.resolve(assignment),
      );
      // The first provision defers on a transient 503; the re-claim provisions
      // the same assignment again.
      createSandboxWithPvc
        .mockImplementationOnce(() => {
          order.push("create");
          return Promise.reject(new SandboxApiException({ statusCode: 503 }));
        })
        .mockImplementation(() => {
          order.push("create");
          return Promise.resolve({ sandboxId: "sbx-1", pvcName: "devbox-pvc-task-1-aaaaaa" });
        });
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValueOnce(task).mockResolvedValue(null);

      service.start();
      await waitFor(() => attachSandboxResources.mock.calls.length > 0);
      await service.stop();

      expect(order).toEqual(["started", "create", "create"]);
      expect(onTaskStarted).toHaveBeenCalledWith(
        expect.anything(),
        task,
        assignment.reply_targets[0],
      );
    });

    it("threads experimental flags from task metadata into sandbox creation", async () => {
      const task = makeTask({
        sandboxId: null,
        metadata: { experimentalFlags: ["FAST_PATH", "lower", "TRACE2"] },
      });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);

      service.start();
      await waitFor(() => createSandboxWithPvc.mock.calls.length > 0);
      await service.stop();

      expect(createSandboxWithPvc).toHaveBeenCalledWith(
        expect.objectContaining({ experimentalFlags: ["FAST_PATH", "TRACE2"] }),
      );
    });

    it("calls closeSandboxAndDeletePvc when ownership was lost after create", async () => {
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      attachSandboxResources.mockResolvedValue([]);

      service.start();
      await waitFor(() => closeSandboxAndDeletePvc.mock.calls.length > 0);
      await service.stop();

      expect(closeSandboxAndDeletePvc).toHaveBeenCalledWith("sbx-1", "devbox-pvc-task-1-aaaaaa");
    });

    it("tears down the created sandbox + minted PVC when attachSandboxResources throws", async () => {
      // createSandboxWithPvc has already succeeded (real sandbox + minted PVC),
      // then attachSandboxResources hits a transient DB error and THROWS. The
      // sandbox + PVC must be cleaned up via closeSandboxAndDeletePvc — failTask
      // alone would read a still-NULL DB sandbox_id (attach is the persist) and leak.
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      attachSandboxResources.mockImplementation(() =>
        Promise.reject(new Error("transient DB error")),
      );

      service.start();
      await waitFor(() => closeSandboxAndDeletePvc.mock.calls.length > 0);
      await service.stop();

      // Cleanup used the locals from the create call, not the stale closure.
      expect(closeSandboxAndDeletePvc).toHaveBeenCalledWith("sbx-1", "devbox-pvc-task-1-aaaaaa");
      // The throw still falls through to the existing error handling.
      expect(releaseLease).toHaveBeenCalled();
    });

    it("retries by releasing lease when createSandboxWithPvc throws a transient error", async () => {
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      createSandboxWithPvc.mockImplementation(() =>
        Promise.reject(new SandboxApiException({ statusCode: 503 })),
      );

      service.start();
      await waitFor(() => releaseLease.mock.calls.length > 0);
      await service.stop();

      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
      });
      expect(failTaskInbox).not.toHaveBeenCalled();
      expect(emitError).not.toHaveBeenCalled();
    });

    it("fails the task with a scrubbed message when createSandboxWithPvc throws non-transiently", async () => {
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      createSandboxWithPvc.mockImplementation(() =>
        Promise.reject(new Error("docker daemon gone with token=abcd")),
      );
      // failTask broadcasts the message to the reply targets of the rows it
      // dead-letters — stub one row with the assignment row's Linear session target.
      failTaskInbox.mockResolvedValue([
        {
          id: "inbox-1",
          task_id: task.id,
          source: "linear",
          external_id: task.externalId,
          kind: "assignment",
          payload: {},
          reply_targets: [{ id: "sess-1", spec: { kind: "linear_session" } }],
          status: "pending",
          failure_reason: null,
          outcome: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      service.start();
      await waitFor(() => releaseLease.mock.calls.length > 0);
      await service.stop();

      // Linear error emit uses the generic message, not the raw error.
      const errArgs = emitError.mock.calls[0] as unknown as [unknown, string, string];
      expect(errArgs[2]).not.toContain("token=abcd");
      expect(errArgs[2]).toContain("control-plane logs");
      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
    });

    it("posts a Slack failure update when the task is hard-failed (rows dead-lettered)", async () => {
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      createSandboxWithPvc.mockImplementation(() => Promise.reject(new Error("provision boom")));
      // failTaskInbox returning a non-empty set = rows actually dead-lettered on
      // THIS call; that transition is the gate for the (at-most-once) Slack post.
      stubLinearTarget(task);

      service.start();
      await waitFor(() => notifyTerminal.mock.calls.length > 0);
      await service.stop();

      expect(notifyTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        "failed",
        expect.stringContaining("control-plane logs"),
      );
    });

    it("does NOT post to Slack when only a follow-up (non-assignment) round is dead-lettered", async () => {
      // A failing @harness comment/review/ci_result round appends a new inbox row
      // (kind !== "assignment") on the SAME Linear task. Its failure must NOT post
      // "❌ devbox failed" into the origin thread — only the top-level assignment
      // round notifies Slack (mirrors the completed path's kind gate).
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      createSandboxWithPvc.mockImplementation(() => Promise.reject(new Error("provision boom")));
      const commentRow = {
        id: "inbox-c",
        task_id: task.id,
        source: "github",
        external_id: "555",
        kind: "comment",
        payload: {},
        reply_targets: [{ id: "sess-1", spec: { kind: "linear_session" } }],
        status: "pending",
        failure_reason: null,
        outcome: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      failTaskInbox.mockResolvedValueOnce([commentRow]);

      service.start();
      await waitFor(() => releaseLease.mock.calls.length > 0);
      await service.stop();

      expect(failTaskInbox).toHaveBeenCalled();
      expect(notifyTerminal).not.toHaveBeenCalled();
    });

    it("does NOT post to Slack when failTaskInbox dead-letters no rows (re-fire / lost lease)", async () => {
      const task = makeTask({ sandboxId: null });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      createSandboxWithPvc.mockImplementation(() => Promise.reject(new Error("provision boom")));
      // Default failTaskInbox returns [] → no transition → no Slack post.
      service.start();
      await waitFor(() => releaseLease.mock.calls.length > 0);
      await service.stop();

      expect(notifyTerminal).not.toHaveBeenCalled();
    });
  });

  describe("handleTaskError — Sandbox.create failures", () => {
    const handle = () =>
      service as unknown as { handleTaskError(t: Task, e: unknown): Promise<void> };
    const clientAbort = () => {
      const e = new Error("The operation timed out.");
      e.name = "TimeoutError";
      return e;
    };

    it("client-side abort → spends a durable retry unit, kills nothing", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });

      await handle().handleTaskError(task, new SandboxCreateError("task-1", clientAbort()));

      expect(requeueForRetry).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        retryCount: 1,
      });
      expect(killSandbox).not.toHaveBeenCalled();
      expect(failTaskInbox).not.toHaveBeenCalled();
    });

    it("client-side abort past maxTaskRetries → fails the task", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1", metadata: { retryCount: 2 } });

      await handle().handleTaskError(task, new SandboxCreateError("task-1", clientAbort()));

      expect(requeueForRetry).not.toHaveBeenCalled();
      expect(failTaskInbox).toHaveBeenCalled();
    });

    it("transient server reply → deferred, no retry unit spent", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });
      const cause = new SandboxApiException({ statusCode: 503 });

      await handle().handleTaskError(task, new SandboxCreateError("task-1", cause));

      expect(requeueForRetry).not.toHaveBeenCalled();
      expect(failTaskInbox).not.toHaveBeenCalled();
    });

    it("unclassified error → failTask", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });

      await handle().handleTaskError(task, new Error("something else"));

      expect(failTaskInbox).toHaveBeenCalled();
      expect(requeueForRetry).not.toHaveBeenCalled();
    });

    it("any other reply (4xx) → also spends a retry unit rather than failing outright", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });
      const cause = new SandboxApiException({ statusCode: 400, message: "bad volume spec" });

      await handle().handleTaskError(task, new SandboxCreateError("task-1", cause));

      expect(requeueForRetry).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        retryCount: 1,
      });
      expect(failTaskInbox).not.toHaveBeenCalled();
    });
  });

  describe("handleTaskError — pruned workspace", () => {
    it("a throwing workspace-missing dead-letter is logged and the lease is still released", async () => {
      deadLetterWorkspaceMissing.mockRejectedValue(new Error("db connection reset"));
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });

      await (
        service as unknown as { handleTaskError(t: Task, e: unknown): Promise<void> }
      ).handleTaskError(task, new PvcNotFoundError("pvc-1"));

      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
    });

    it("a row whose integration is disabled gets no notice; it is still failed and the lease released", async () => {
      integrations.github = new GithubIntegration(false, { status: () => ({}) as never });
      const row = {
        ...survivingNonTerminalRow(),
        id: "gc",
        source: "github",
        kind: "comment",
        reply_targets: [
          {
            id: "555",
            spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 7, commentId: 555 },
          },
        ],
      };
      const markFailed = mock(() => Promise.resolve([{ id: "gc" }]));
      (inboxRepo.listNonTerminalByTask as ReturnType<typeof mock>).mockResolvedValue([row]);
      Object.assign(inboxRepo, { getById: mock(() => Promise.resolve(row)), markFailed });
      // The real dead-letter path in place of the stub.
      Object.assign(service, {
        inboxService: new RealInboxService(inboxRepo, sandboxManager, integrations, hooks, {
          followUp: mock(),
        }),
      });

      await (
        service as unknown as { handleTaskError(t: Task, e: unknown): Promise<void> }
      ).handleTaskError(
        makeTask({ sandboxId: null, pvcName: "pvc-1" }),
        new PvcNotFoundError("pvc-1"),
      );

      expect(postIssueComment).not.toHaveBeenCalled();
      expect(holds.of("github").heldTasks).toBe(0);
      expect(markFailed).toHaveBeenCalledWith({
        inboxId: "gc",
        ownerId: "pod-test",
        reason: "workspace_missing",
        userMessage: WORKSPACE_MISSING_MESSAGE,
      });
      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
    });
  });

  describe("dispatch", () => {
    it("a throw from handleTaskError itself is logged, not left unhandled", async () => {
      // Transient provision failure → releaseLeaseIfNoSandbox, whose release throws.
      createSandboxWithPvc.mockRejectedValue(new SandboxApiException({ statusCode: 503 }));
      releaseLease.mockRejectedValue(new Error("db connection reset"));
      const error = spyOn(logger, "error").mockImplementation(() => logger);
      claimNext.mockResolvedValueOnce(makeTask()).mockResolvedValue(null);
      try {
        service.start();
        await waitFor(() =>
          error.mock.calls.some(([msg]) => msg === "handleTaskError failed for task task-1"),
        );
        await service.stop();
      } finally {
        error.mockRestore();
      }
    });
  });

  describe("failTask — failure broadcast", () => {
    const MSG = "Task failed — check control-plane logs for details.";
    const failTask = (task: Task): Promise<void> =>
      (service as unknown as { failTask(t: Task, m: string): Promise<void> }).failTask(task, MSG);
    // biome-ignore lint/suspicious/noExplicitAny: test stub shape, cast at use site
    const row = (id: string, kind: string, source: string, replyTargets: unknown[]): any => ({
      ...survivingNonTerminalRow(),
      id,
      kind,
      source,
      reply_targets: replyTargets,
    });
    const reviewComment = (id: number, prNumber: number) => ({
      id: String(id),
      spec: {
        kind: "review_comment",
        owner: "o",
        repo: "r",
        prNumber,
        commentId: id,
        inReplyTo: id,
        path: "a.ts",
        line: 1,
      },
    });
    const issueComment = (id: string, prNumber: number, commentId: number) => ({
      id,
      spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber, commentId },
    });

    it("posts once per distinct target id across every open row, by target kind", async () => {
      failTaskInbox.mockResolvedValue([
        row("a", "assignment", "linear", [{ id: "sess-1", spec: { kind: "linear_session" } }]),
        // Same session as the assignment → deduped.
        row("lc", "comment", "linear", [{ id: "sess-1", spec: { kind: "linear_session" } }]),
        row("gc", "comment", "github", [issueComment("555", 7, 555)]),
        row("rv", "review", "github", [
          reviewComment(11, 8),
          reviewComment(12, 8),
          {
            id: "88",
            spec: { kind: "review_body", owner: "o", repo: "r", prNumber: 8, reviewId: 88 },
          },
        ]),
        // CI target: commentId 0 = "post a new PR comment".
        row("ci", "ci_result", "github", [issueComment("9001", 9, 0)]),
      ]);

      await failTask(makeTask());

      expect(emitError).toHaveBeenCalledTimes(1);
      expect(emitError).toHaveBeenCalledWith(expect.anything(), "sess-1", MSG);
      // PR comments for the comment, the review body and the CI row, in row order.
      const signal = expect.any(AbortSignal);
      expect(postIssueComment.mock.calls as unknown[]).toEqual([
        ["o", "r", 7, MSG, signal],
        ["o", "r", 8, MSG, signal],
        ["o", "r", 9, MSG, signal],
      ]);
      expect(postReviewCommentReply.mock.calls as unknown[]).toEqual([
        ["o", "r", 8, 11, MSG, signal],
        ["o", "r", 8, 12, MSG, signal],
      ]);
      expect(failTaskInbox).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        reason: MSG,
      });
    });

    it("dedupes per integration: equal target ids of two sources each get a notice", async () => {
      failTaskInbox.mockResolvedValue([
        row("a", "assignment", "linear", [{ id: "555", spec: { kind: "linear_session" } }]),
        row("gc", "comment", "github", [issueComment("555", 7, 555)]),
      ]);

      await failTask(makeTask());

      expect(emitError).toHaveBeenCalledWith(expect.anything(), "555", MSG);
      expect(postIssueComment).toHaveBeenCalledWith("o", "r", 7, MSG, expect.any(AbortSignal));
    });

    it("notices every row failTaskInbox dead-letters, whatever a separate read of the open rows saw", async () => {
      // A follow-up committed after such a read, or the read failing, must not
      // cost a dead-lettered row its notice, hook or Slack post.
      (inboxRepo.listNonTerminalByTask as ReturnType<typeof mock>).mockRejectedValue(
        new Error("connection reset"),
      );
      failTaskInbox.mockResolvedValue([
        row("a", "assignment", "linear", [{ id: "sess-1", spec: { kind: "linear_session" } }]),
        row("gc", "comment", "github", [issueComment("555", 7, 555)]),
      ]);

      await failTask(makeTask());

      expect(emitError).toHaveBeenCalledWith(expect.anything(), "sess-1", MSG);
      expect(postIssueComment).toHaveBeenCalledWith("o", "r", 7, MSG, expect.any(AbortSignal));
      expect(notifyTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        "failed",
        MSG,
      );
    });

    it("dead-letters before posting, and posts only to the rows it dead-lettered", async () => {
      const order: string[] = [];
      emitError.mockImplementation(() => {
        order.push("post");
        return Promise.resolve();
      });
      getByIdOwnedBy.mockResolvedValue(makeTask({ sandboxId: "sbx-live" }));
      killSandbox.mockImplementation(() => {
        order.push("kill");
        return Promise.resolve();
      });
      failTaskInbox.mockImplementation(() => {
        order.push("mark");
        // The GitHub round was responded by a late `completed` before
        // failTaskInbox ran: not transitioned, so not returned.
        return Promise.resolve([
          row("a", "assignment", "linear", [{ id: "sess-1", spec: { kind: "linear_session" } }]),
        ]);
      });
      releaseLease.mockImplementation(() => {
        order.push("release");
        return Promise.resolve([{ id: "task-1" }]);
      });

      await failTask(makeTask());

      expect(order).toEqual(["mark", "post", "kill", "release"]);
      expect(postIssueComment).not.toHaveBeenCalled();
    });

    it("finishes a dead-lettered assignment's round: outcome failed, first transition, no archive", async () => {
      const onRoundFinished = spyOn(integrations.linear, "onRoundFinished");
      failTaskInbox.mockResolvedValue([
        row("a", "assignment", "linear", [{ id: "sess-1", spec: { kind: "linear_session" } }]),
        row("gc", "comment", "github", [issueComment("555", 7, 555)]),
      ]);

      await failTask(makeTask());
      await waitFor(() => onRoundFinished.mock.calls.length > 0);

      expect(onRoundFinished).toHaveBeenCalledTimes(1);
      const [ctx, , round, outcome] = onRoundFinished.mock.calls[0] as unknown as [
        { firstTransition: boolean; archive(): Promise<Uint8Array | null> },
        Task,
        { id: string },
        string,
      ];
      expect(round.id).toBe("a");
      expect(outcome).toBe("failed");
      expect(ctx.firstTransition).toBe(true);
      expect(await ctx.archive()).toBeNull();
    });

    it("a row whose source has no integration is skipped; other rows post and the lease is released", async () => {
      failTaskInbox.mockResolvedValue([
        row("x", "comment", "unknown-source", [issueComment("777", 7, 777)]),
        row("gc", "comment", "github", [issueComment("555", 7, 555)]),
      ]);

      await failTask(makeTask());

      expect(postIssueComment.mock.calls as unknown[]).toEqual([
        ["o", "r", 7, MSG, expect.any(AbortSignal)],
      ]);
      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
    });

    it("a row whose integration is disabled gets no notice; it is still dead-lettered and the lease released", async () => {
      integrations.github = new GithubIntegration(false, { status: () => ({}) as never });
      failTaskInbox.mockResolvedValue([
        row("gc", "comment", "github", [issueComment("555", 7, 555)]),
      ]);

      await failTask(makeTask());

      expect(postIssueComment).not.toHaveBeenCalled();
      expect(holds.of("github").heldTasks).toBe(0);
      expect(failTaskInbox).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        reason: MSG,
      });
      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
    });

    it("a Linear token failure skips only the Linear post; GitHub and Slack posts, dead-letter and release go on", async () => {
      getAuthorizedLinearClient.mockRejectedValue(new Error("token refresh failed"));
      failTaskInbox.mockResolvedValue([
        row("a", "assignment", "linear", [{ id: "sess-1", spec: { kind: "linear_session" } }]),
        row("gc", "comment", "github", [issueComment("555", 7, 555)]),
      ]);

      await failTask(makeTask());

      expect(emitError).not.toHaveBeenCalled();
      expect(postIssueComment).toHaveBeenCalledWith("o", "r", 7, MSG, expect.any(AbortSignal));
      expect(failTaskInbox).toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
      // Sent without the assignee mention (its lookup fails; §13).
      expect(notifyTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        "failed",
        MSG,
      );
    });
  });

  describe("runTask — adoption (sandbox_id already set)", () => {
    it("attaches to the existing sandbox without provisioning a new one", async () => {
      const task = makeTask({ sandboxId: "sbx-alive" });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      listInFlightOwnedBy.mockResolvedValue([]);

      service.start();
      await waitFor(() => attachSandbox.mock.calls.length > 0);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      expect(attachSandbox).toHaveBeenCalledWith("sbx-alive");
      expect(createSandboxWithPvc).not.toHaveBeenCalled();
    });

    it("does NOT fail the task on attach 404 (best-effort attach)", async () => {
      const task = makeTask({ sandboxId: "sbx-gone" });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      attachSandbox.mockImplementation(() =>
        Promise.reject(new SandboxApiException({ statusCode: 404 })),
      );
      listInFlightOwnedBy.mockResolvedValue([]);

      service.start();
      await waitFor(() => attachSandbox.mock.calls.length > 0);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      expect(releaseLease).not.toHaveBeenCalled();
    });

    it("does NOT fail the task on attach 404 — reconcile's pod gate owns liveness", async () => {
      // Attach is best-effort now: a 404 means the sandbox is gone, but failing
      // is the reconcile pod-gate's job (absent pod → grace → fail). runTask just
      // logs and returns; it never dead-letters or releases.
      const task = makeTask({ sandboxId: "sbx-gone" });
      attachSandbox.mockImplementation(() =>
        Promise.reject(new SandboxApiException({ statusCode: 404 })),
      );

      const internal = service as unknown as { runTask(t: Task): Promise<void> };
      await internal.runTask(task);
      await internal.runTask(task);
      await internal.runTask(task);

      expect(releaseLease).not.toHaveBeenCalled();
      expect(failTaskInbox).not.toHaveBeenCalled();
      expect(killSandbox).not.toHaveBeenCalled();
    });
  });

  describe("runTask — recreate-from-PVC", () => {
    it("creates a sandbox from the PVC, persists it, then sweeps", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);

      service.start();
      await waitFor(() => sweepUndelivered.mock.calls.length > 0);
      await service.stop();

      expect(createSandboxFromExistingPvc).toHaveBeenCalledWith({
        taskId: "task-1",
        externalId: "issue-1",
        source: "linear",
        pvcName: "pvc-1",
        experimentalFlags: [],
      });
      expect(setSandboxId).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        sandboxId: "sbx-recreated",
      });
      // Sweep runs against the freshly-recreated sandbox.
      const sweptTask = sweepUndelivered.mock.calls[0]?.[0] as Task;
      expect(sweptTask.sandboxId).toBe("sbx-recreated");
    });

    it("leaves the sandbox for the new owner to adopt when the lease is lost mid-recreate", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });
      setSandboxId.mockResolvedValue([]);

      const internal = service as unknown as { runTask(t: Task): Promise<void> };
      await internal.runTask(task);

      expect(killSandbox).not.toHaveBeenCalled();
      expect(sweepUndelivered).not.toHaveBeenCalled();
    });

    it("threads task metadata experimental flags when recreating from PVC", async () => {
      const task = makeTask({
        sandboxId: null,
        pvcName: "pvc-1",
        metadata: { experimentalFlags: ["FAST_PATH", "bad-name"] },
      });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);

      service.start();
      await waitFor(() => createSandboxFromExistingPvc.mock.calls.length > 0);
      await service.stop();

      expect(createSandboxFromExistingPvc).toHaveBeenCalledWith(
        expect.objectContaining({ experimentalFlags: ["FAST_PATH"] }),
      );
    });

    it("releases the lease and retries on the next tick when create defers transiently", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });
      claimNext.mockResolvedValueOnce(task).mockResolvedValueOnce(task).mockResolvedValue(null);
      createSandboxFromExistingPvc
        .mockRejectedValueOnce(new SandboxApiException({ statusCode: 503 }))
        .mockResolvedValue("sbx-recreated");

      service.start();
      await waitFor(() => createSandboxFromExistingPvc.mock.calls.length >= 2);
      await service.stop();

      // First tick deferred (sandbox_id still null) → lease released for a re-claim.
      expect(releaseLease).toHaveBeenCalledWith({ taskId: "task-1", ownerId: "pod-test" });
      expect(failTaskInbox).not.toHaveBeenCalled();
      expect(killSandbox).not.toHaveBeenCalled();
    });

    it("does NOT release the lease when the sweep defers (sandbox already persisted)", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      sweepUndelivered.mockRejectedValueOnce(new SandboxApiException({ statusCode: 503 }));
      // setSandboxId persisted sbx-recreated, so the deferral check sees a sandbox.
      getByIdOwnedBy.mockResolvedValue(makeTask({ id: "task-1", sandboxId: "sbx-recreated" }));

      service.start();
      await waitFor(() => sweepUndelivered.mock.calls.length > 0);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      // sandbox_id was persisted before the sweep → don't release; next tick re-sweeps.
      expect(releaseLease).not.toHaveBeenCalled();
      expect(failTaskInbox).not.toHaveBeenCalled();
    });

    it("dead-letters and releases the lease when the PVC has been pruned", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      createSandboxFromExistingPvc.mockRejectedValue(new PvcNotFoundError("pvc-1"));

      service.start();
      await waitFor(() => deadLetterWorkspaceMissing.mock.calls.length > 0);
      await service.stop();

      expect(deadLetterWorkspaceMissing).toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
      expect(setSandboxId).not.toHaveBeenCalled();
      expect(sweepUndelivered).not.toHaveBeenCalled();
    });

    it("does not kill the sandbox when setSandboxId THROWS mid-recreate", async () => {
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      setSandboxId.mockRejectedValue(new Error("DB connection reset"));

      service.start();
      await waitFor(() => failTaskInbox.mock.calls.length > 0);
      await service.stop();

      expect(killSandbox).not.toHaveBeenCalled();
      expect(sweepUndelivered).not.toHaveBeenCalled();
    });

    it("kills the persisted sandbox when the sweep fails non-transiently (no leak)", async () => {
      // setSandboxId persisted sbx-recreated, so failTask kills it by reading the
      // task's CURRENT sandbox_id from the DB — not the stale dispatch-time closure
      // (still null), which would otherwise orphan the live sandbox.
      const task = makeTask({ sandboxId: null, pvcName: "pvc-1" });
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);
      sweepUndelivered.mockRejectedValue(new Error("write boom (non-transient)"));
      getByIdOwnedBy.mockResolvedValue(makeTask({ id: "task-1", sandboxId: "sbx-recreated" }));

      service.start();
      await waitFor(() => failTaskInbox.mock.calls.length > 0);
      await service.stop();

      expect(killSandbox).toHaveBeenCalledWith("sbx-recreated");
    });
  });

  describe("reconcile loop", () => {
    it("reconcile with no events.jsonl yet returns cleanly", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValue([task]);
      readEvents.mockResolvedValue([]);

      service.start();
      await waitFor(() => readEvents.mock.calls.length > 0);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      expect(dispatcherHandle).not.toHaveBeenCalled();
    });

    it("dispatches each event in seq order and advances the cursor", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);
      const events: HarnessEvent[] = [
        {
          seq: 1,
          ts: "t",
          type: "agent_action",
          inbox_id: "i",
          target_id: "tgt",
          body: "Planning",
        },
        {
          seq: 2,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "x",
        },
      ];
      readEvents.mockResolvedValueOnce(events).mockResolvedValue([]);

      service.start();
      await waitFor(() => dispatcherHandle.mock.calls.length >= 2);
      await service.stop();

      const seqs = recordEventCursor.mock.calls.map(
        (c: unknown[]) => (c[0] as { event: { seq: number } }).event.seq,
      );
      expect(seqs).toEqual([1, 2]);
    });

    it("self-evicts when the dispatcher returns 'self_evict' (lease lost mid-tick)", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);
      readEvents
        .mockResolvedValueOnce([
          { seq: 1, ts: "t", type: "agent_thought", inbox_id: "i", body: "x" },
          { seq: 2, ts: "t", type: "agent_thought", inbox_id: "i", body: "x" },
        ] as HarnessEvent[])
        .mockResolvedValue([]);
      dispatcherHandle.mockResolvedValueOnce("self_evict").mockResolvedValue("ok");

      service.start();
      await waitFor(() => dispatcherHandle.mock.calls.length >= 1);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      // First event self-evicted: cursor NOT advanced, 2nd event NOT dispatched.
      expect(dispatcherHandle.mock.calls.length).toBe(1);
      expect(recordEventCursor).not.toHaveBeenCalled();
    });

    it("re-fetches each event owner-scoped; null fetch self-evicts before next handle()", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);
      readEvents
        .mockResolvedValueOnce([
          { seq: 1, ts: "t", type: "agent_thought", inbox_id: "i", body: "x" },
          { seq: 2, ts: "t", type: "agent_thought", inbox_id: "i", body: "x" },
        ] as HarnessEvent[])
        .mockResolvedValue([]);
      // Owner-scoped re-fetch returns null → takeover detected in the gap.
      getByIdOwnedBy.mockResolvedValue(null);

      service.start();
      await waitFor(() => dispatcherHandle.mock.calls.length >= 1);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      // First event dispatched + cursor advanced; null re-fetch stops the 2nd.
      expect(dispatcherHandle.mock.calls.length).toBe(1);
      expect(getByIdOwnedBy).toHaveBeenCalledWith("task-1", "pod-test");
    });

    it("self-evicts when recordEventCursor returns 0 rows (lease lost)", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);
      readEvents
        .mockResolvedValueOnce([
          { seq: 1, ts: "t", type: "agent_thought", inbox_id: "i", body: "x" },
          { seq: 2, ts: "t", type: "agent_thought", inbox_id: "i", body: "x" },
        ] as HarnessEvent[])
        .mockResolvedValue([]);
      recordEventCursor.mockResolvedValue([]); // lease lost on first advance

      service.start();
      await waitFor(() => dispatcherHandle.mock.calls.length >= 1);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      // Only the first event was dispatched; loop self-evicted before the 2nd.
      expect(dispatcherHandle.mock.calls.length).toBe(1);
    });

    it("a dispatcher throw (e.g. a database error) holds the cursor and fails nothing", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);
      readEvents
        .mockResolvedValueOnce([
          { seq: 1, ts: "t", type: "agent_thought", inbox_id: "i", target_id: "s", body: "x" },
          { seq: 2, ts: "t", type: "agent_thought", inbox_id: "i", target_id: "s", body: "y" },
        ] as HarnessEvent[])
        .mockResolvedValue([]);
      dispatcherHandle.mockRejectedValueOnce(new Error("token refresh failed"));

      service.start();
      // assessReconcileError reads the pod (unknown here → log only).
      await waitFor(() => getSandboxPodStatus.mock.calls.length > 0);
      await service.stop();

      // The throw ends this task's tick: seq 2 is not dispatched and seq 1 is
      // re-read next tick from the unchanged cursor.
      expect(dispatcherHandle).toHaveBeenCalledTimes(1);
      expect(recordEventCursor).not.toHaveBeenCalled();
      expect(failTaskInbox).not.toHaveBeenCalled();
      expect(requeueForRetry).not.toHaveBeenCalled();
    });

    it("a hung send is cut at the send timeout: dropped, cursor advanced, the task stops, the tick goes on", async () => {
      const error = spyOn(logger, "error").mockImplementation(() => logger);
      try {
        const deliver = mock(() => new Promise<void>(() => {}));
        const round = { ...survivingNonTerminalRow(), source: "github", status: "delivered" };
        const dispatcher = new RealEventDispatcher(
          taskRepo,
          { getByIdForTask: mock(() => Promise.resolve(round)) } as unknown as InboxRepository,
          sandboxManager,
          slackNotifier,
          {
            ...integrations,
            github: { name: "github", enabled: true, status: async () => ({}), deliver },
          },
          holds,
          hooks,
          20, // send timeout (ms)
        );
        service = new TaskProcessorService(
          taskRepo,
          inboxRepo,
          sandboxManager,
          dispatcher,
          inboxService,
          slackNotifier,
          integrations,
          holds,
          ["linear", "api"],
          hooks,
        );
        const thought = (seq: number) => ({
          seq,
          ts: "t",
          type: "agent_thought",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "x",
        });
        listInFlightOwnedBy
          .mockResolvedValueOnce([
            makeTask({ id: "task-1", sandboxId: "sbx-1" }),
            makeTask({ id: "task-2", sandboxId: "sbx-2" }),
          ])
          .mockResolvedValue([]);
        readEvents.mockImplementation((sandboxId: string) =>
          Promise.resolve(sandboxId === "sbx-1" ? [thought(1), thought(2)] : [thought(1)]),
        );

        service.start();
        await waitFor(() => recordEventCursor.mock.calls.length >= 2);
        await service.stop();

        // task-1's seq 2 is never sent: the drop ended task-1's events; task-2 ran.
        const cursors = recordEventCursor.mock.calls.map((c: unknown[]) => {
          const p = c[0] as { taskId: string; event: { seq: number } };
          return [p.taskId, p.event.seq];
        });
        expect(cursors).toEqual([
          ["task-1", 1],
          ["task-2", 1],
        ]);
        expect(deliver).toHaveBeenCalledTimes(2);
      } finally {
        error.mockRestore();
      }
    });

    it("releases a stale hold when this pod claims the task", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      // Still owned, so only the claim can drop the hold.
      listInFlightOwnedBy.mockResolvedValue([task]);
      holds.hold("task-1", { seq: 1, inbox_id: "i" }, "github", new RetryableError("429", 60_000));
      claimNext.mockResolvedValueOnce(task).mockResolvedValue(null);

      service.start();
      await waitFor(() => attachSandbox.mock.calls.length > 0);
      await service.stop();

      expect(holds.of("github").heldTasks).toBe(0);
    });

    it("once shutdown starts, reconciles no further owned task and claims nothing", async () => {
      listInFlightOwnedBy.mockResolvedValue([
        makeTask({ id: "task-1", sandboxId: "sbx-1" }),
        makeTask({ id: "task-2", sandboxId: "sbx-2" }),
      ]);
      let stopping: Promise<void> | undefined;
      getSandboxInfo.mockImplementation(() => {
        stopping ??= service.stop();
        return Promise.resolve(makeSandboxInfo());
      });

      service.start();
      await waitFor(() => stopping !== undefined);
      await stopping;

      expect(getSandboxInfo).toHaveBeenCalledTimes(1);
      expect(claimNext).not.toHaveBeenCalled();
    });

    it("a hold stops before the cursor advances and is not a reconcile error", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);
      readEvents
        .mockResolvedValueOnce([
          { seq: 1, ts: "t", type: "agent_thought", inbox_id: "i", target_id: "s", body: "x" },
          { seq: 2, ts: "t", type: "agent_thought", inbox_id: "i", target_id: "s", body: "y" },
        ] as HarnessEvent[])
        .mockResolvedValue([]);
      dispatcherHandle.mockResolvedValueOnce("hold");

      service.start();
      await waitFor(() => dispatcherHandle.mock.calls.length >= 1);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      expect(dispatcherHandle).toHaveBeenCalledTimes(1);
      expect(recordEventCursor).not.toHaveBeenCalled();
      expect(getSandboxPodStatus).not.toHaveBeenCalled();
    });

    it("skips a held task's events while it waits out Retry-After (the sweep still runs)", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValue([task]);
      holds.hold("task-1", { seq: 1, inbox_id: "i" }, "github", new RetryableError("429", 60_000));

      service.start();
      await waitFor(() => sweepUndelivered.mock.calls.length >= 3);
      await service.stop();

      expect(readEvents).not.toHaveBeenCalled();
      expect(holds.of("github").heldTasks).toBe(1);
    });

    it("a dropped send advances the cursor, then ends this task's events for the tick", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);
      readEvents
        .mockResolvedValueOnce([
          { seq: 1, ts: "t", type: "agent_thought", inbox_id: "i", target_id: "s", body: "x" },
          { seq: 2, ts: "t", type: "agent_thought", inbox_id: "i", target_id: "s", body: "y" },
        ] as HarnessEvent[])
        .mockResolvedValue([]);
      dispatcherHandle.mockResolvedValueOnce("dropped");

      service.start();
      await waitFor(() => recordEventCursor.mock.calls.length >= 1);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      expect(dispatcherHandle).toHaveBeenCalledTimes(1);
      const seqs = recordEventCursor.mock.calls.map(
        (c: unknown[]) => (c[0] as { event: { seq: number } }).event.seq,
      );
      expect(seqs).toEqual([1]);
    });

    it("drops a hold once the cursor moves past its event, or once the task leaves this pod", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      // task-1 stays owned every tick, so only the cursor advance can drop its hold.
      listInFlightOwnedBy.mockResolvedValue([task]);
      readEvents
        .mockResolvedValueOnce([
          { seq: 1, ts: "t", type: "agent_thought", inbox_id: "i", target_id: "s", body: "x" },
        ] as HarnessEvent[])
        .mockResolvedValue([]);
      const err = new RetryableError("token fetch failed");
      holds.hold("task-1", { seq: 1, inbox_id: "i" }, "linear", err);
      holds.hold("task-gone", { seq: 3, inbox_id: "j" }, "linear", err);
      // The retry of task-1's held event succeeds; task-gone is not owned.
      service.start();
      await waitFor(() => recordEventCursor.mock.calls.length >= 1);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      expect(holds.of("linear").heldTasks).toBe(0);
    });

    it("renews every lease this pod holds at tick start; a task it didn't renew is skipped", async () => {
      const t1 = makeTask({ id: "task-1", sandboxId: "sbx-1" });
      const t2 = makeTask({ id: "task-2", sandboxId: "sbx-2" });
      listInFlightOwnedBy.mockResolvedValueOnce([t1, t2]).mockResolvedValue([]);
      const order: string[] = [];
      // task-2's lease was taken over.
      heartbeatOwnedBy.mockImplementation(() => {
        order.push("heartbeat");
        return Promise.resolve([{ id: "task-1" }, { id: "in-flight-provision" }]);
      });
      getSandboxInfo.mockImplementation((id: string) => {
        order.push(`reconcile ${id}`);
        return Promise.resolve(makeSandboxInfo());
      });

      service.start();
      await waitFor(() => order.length >= 2);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      expect(order.slice(0, 2)).toEqual(["heartbeat", "reconcile sbx-1"]);
      expect(order).not.toContain("reconcile sbx-2");
      expect(heartbeatOwnedBy).toHaveBeenCalledWith("pod-test");
    });

    describe("a reconcile longer than a quarter of the lease", () => {
      const thought = (seq: number) =>
        ({
          seq,
          ts: "t",
          type: "agent_thought",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "x",
        }) as HarnessEvent;
      let leaseMs: number;
      beforeEach(() => {
        leaseMs = mockedConfig.leaseTimeoutMs;
        mockedConfig.leaseTimeoutMs = 40; // renew after 10 ms
        listInFlightOwnedBy
          .mockResolvedValueOnce([makeTask({ sandboxId: "sbx-1" })])
          .mockResolvedValue([]);
        readEvents.mockResolvedValueOnce([thought(1), thought(2), thought(3)]);
      });
      afterEach(() => {
        mockedConfig.leaseTimeoutMs = leaseMs;
      });

      it("renews every lease again before a later event", async () => {
        const order: string[] = [];
        heartbeatOwnedBy.mockImplementation(() => {
          order.push("heartbeat");
          return Promise.resolve([{ id: "task-1" }]);
        });
        // Each send outlasts a quarter of the lease.
        dispatcherHandle.mockImplementation(async (event: HarnessEvent) => {
          order.push(`handle ${event.seq}`);
          await sleep(15);
          return "ok" as const;
        });

        service.start();
        await waitFor(() => recordEventCursor.mock.calls.length >= 3);
        await service.stop();

        expect(order.slice(order.indexOf("handle 1"), order.indexOf("handle 2"))).toContain(
          "heartbeat",
        );
      });

      it("stops the task's events once a renewal shows its lease taken over", async () => {
        // Ours until the first send; taken over by the renewal after it.
        heartbeatOwnedBy.mockImplementation(() =>
          Promise.resolve(dispatcherHandle.mock.calls.length > 0 ? [] : [{ id: "task-1" }]),
        );
        dispatcherHandle.mockImplementation(async () => {
          await sleep(15);
          return "ok" as const;
        });

        service.start();
        await waitFor(() => recordEventCursor.mock.calls.length >= 1);
        await sleep(50);
        await service.stop();

        expect(dispatcherHandle).toHaveBeenCalledTimes(1);
      });
    });

    it("never provisions a task twice on this pod: a re-claim while its provision runs is skipped", async () => {
      let release!: () => void;
      createSandboxWithPvc.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ sandboxId: "sbx-1", pvcName: "devbox-pvc-task-1-aaaaaa" });
          }),
      );
      // The lease of the running provision expired, so claimNext hands it back.
      claimNext
        .mockResolvedValueOnce(makeTask())
        .mockResolvedValueOnce(makeTask())
        .mockResolvedValue(null);

      service.start();
      await waitFor(() => claimNext.mock.calls.length >= 3);
      release();
      await waitFor(() => attachSandboxResources.mock.calls.length > 0);
      await service.stop();

      expect(createSandboxWithPvc).toHaveBeenCalledTimes(1);
    });

    it("once shutdown starts, dispatches no further event of the task in hand", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValue([task]);
      const thought = (seq: number) =>
        ({
          seq,
          ts: "t",
          type: "agent_thought",
          inbox_id: "inbox-1",
          target_id: "sess-1",
          body: "x",
        }) as HarnessEvent;
      readEvents.mockResolvedValue([thought(1), thought(2), thought(3)]);
      let stopping: Promise<void> | undefined;
      dispatcherHandle.mockImplementation(() => {
        stopping ??= service.stop();
        return Promise.resolve("ok" as const);
      });

      service.start();
      await waitFor(() => stopping !== undefined);
      await stopping;

      // The event in hand finishes and its cursor is kept; the rest wait.
      expect(dispatcherHandle).toHaveBeenCalledTimes(1);
      expect(recordEventCursor).toHaveBeenCalledTimes(1);
    });

    it("claims and lists only the configured task sources", async () => {
      service.start();
      await waitFor(() => claimNext.mock.calls.length > 0);
      await service.stop();

      expect(listInFlightOwnedBy).toHaveBeenCalledWith("pod-test", ["linear", "api"]);
      expect(claimNext).toHaveBeenCalledWith(
        expect.objectContaining({ sources: ["linear", "api"] }),
      );
    });

    it("calls sweepUndelivered before reading events", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);

      service.start();
      await waitFor(() => readEvents.mock.calls.length > 0);
      await service.stop();

      expect(sweepUndelivered).toHaveBeenCalled();
    });

    it("does NOT reset the durable retryCount on a clean reconcile (lifetime budget persists)", async () => {
      // retryCount is a LIFETIME sandbox-failure budget bounded by maxTaskRetries;
      // a clean reconcile must NOT wipe it (only a re-delegation resets it), else
      // an OOM-after-progress sandbox would reset its budget every cycle and retry
      // forever. So a clean tick performs no retry-budget mutation.
      const task = makeTask({ sandboxId: "sbx-1", metadata: { retryCount: 2 } });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);

      service.start();
      await waitFor(() => readEvents.mock.calls.length > 0);
      await new Promise<void>((r) => setTimeout(r, 30));
      await service.stop();

      expect(requeueForRetry).not.toHaveBeenCalled();
      expect(failTaskInbox).not.toHaveBeenCalled();
    });

    it("prunes in-memory grace/window timers for tasks this pod no longer owns", async () => {
      const maps = service as unknown as {
        sandboxAbsentSince: Map<string, number>;
        reconcileFilesUnavailableSince: Map<string, number>;
      };
      maps.sandboxAbsentSince.set("task-stale", 1);
      maps.reconcileFilesUnavailableSince.set("task-stale", 1);
      // This pod owns nothing now → the leftover timers must be pruned, else a
      // stale `since` from a prior ownership epoch would skip the grace/window on
      // a future re-claim's first fault (and leak for the process lifetime).
      listInFlightOwnedBy.mockResolvedValue([]);
      claimNext.mockResolvedValue(null);

      service.start();
      await waitFor(() => !maps.sandboxAbsentSince.has("task-stale"));
      await service.stop();

      expect(maps.sandboxAbsentSince.has("task-stale")).toBe(false);
      expect(maps.reconcileFilesUnavailableSince.has("task-stale")).toBe(false);
    });

    it("pod terminal (Failed) → retries (requeue + kill, not dead-lettered)", async () => {
      const task = makeTask({ sandboxId: "sbx-crash" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);
      // Dead execd refuses the connection (a NON-transient error) → sweep throws →
      // reconcileOne raises → the handler reads the pod and sees the terminal phase.
      // (A transient 5xx would instead route to the Files-API window, not the pod.)
      sweepUndelivered.mockRejectedValue(new Error("execd connection refused"));
      getSandboxPodStatus.mockResolvedValue({
        exists: true,
        phase: "Failed",
        terminatedReason: "Error",
        exitCode: 1,
        oomKilled: false,
      });
      requeueForRetry.mockResolvedValue(true);

      service.start();
      await waitFor(() => requeueForRetry.mock.calls.length > 0);
      await service.stop();

      // Reset to a clean slate + kill the dead sandbox — NOT dead-lettered/failed.
      expect(requeueForRetry).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        retryCount: 1,
      });
      expect(killSandbox).toHaveBeenCalledWith("sbx-crash");
      expect(failTaskInbox).not.toHaveBeenCalled();
    });

    it("crossed binding (task_id tag mismatch) → fails WITHOUT killing", async () => {
      const task = makeTask({ sandboxId: "sbx-cross" });
      listInFlightOwnedBy.mockResolvedValueOnce([task]).mockResolvedValue([]);
      // Pod is alive — liveness passes; the ownership guard catches the cross.
      getSandboxPodStatus.mockResolvedValue({ exists: true, phase: "Running", oomKilled: false });
      getSandboxInfo.mockResolvedValue(makeSandboxInfo({ metadata: { task_id: "other-task" } }));
      stubLinearTarget(task);

      service.start();
      await waitFor(() => releaseLease.mock.calls.length > 0);
      await service.stop();

      // A sibling task owns this sandbox — dead-letter + release, but DON'T kill.
      expect(killSandbox).not.toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
      const msg = (emitError.mock.calls[0] as unknown as [unknown, string, string])[2];
      expect(msg).toContain("binding was crossed");
    });
  });

  describe("assessReconcileError — the single detection + handling function", () => {
    const assess = (task: Task, err: unknown): Promise<void> =>
      (
        service as unknown as { assessReconcileError(t: Task, e: unknown): Promise<void> }
      ).assessReconcileError(task, err);
    // A dead execd refusing the connection — NOT a 5xx, so it routes to the pod read.
    const nonTransient = new Error("execd connection refused");

    it("transient 5xx → Files-API window, WITHOUT a pod read", async () => {
      const task = makeTask({ sandboxId: "sbx-warming" });
      await assess(task, new SandboxApiException({ statusCode: 503 }));
      // Hot warm-up path stays kubectl-free, and within the window it just defers.
      expect(getSandboxPodStatus).not.toHaveBeenCalled();
      expect(releaseLease).not.toHaveBeenCalled();
      expect(killSandbox).not.toHaveBeenCalled();
    });

    it("non-transient + terminal pod (Failed) → retries (requeue + kill, not failed)", async () => {
      const task = makeTask({ sandboxId: "sbx-crash" });
      getSandboxPodStatus.mockResolvedValue({ exists: true, phase: "Failed", oomKilled: false });
      requeueForRetry.mockResolvedValue(true);

      await assess(task, nonTransient);

      expect(requeueForRetry).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        retryCount: 1,
      });
      expect(killSandbox).toHaveBeenCalledWith("sbx-crash");
      expect(failTaskInbox).not.toHaveBeenCalled();
    });

    it("terminal pod but the dead-sandbox kill FAILS → defers (no requeue), so the live pod is not orphaned", async () => {
      const task = makeTask({ sandboxId: "sbx-crash" });
      getSandboxPodStatus.mockResolvedValue({ exists: true, phase: "Failed", oomKilled: false });
      // killSandbox must run BEFORE requeueForRetry; if it throws (non-404), we must
      // NOT clear sandbox_id / release the lease, else the live pod is orphaned with
      // no DB reference and (RWO PVC) blocks the re-provision. Next tick re-kills.
      killSandbox.mockRejectedValueOnce(new Error("kill API 503"));

      await assess(task, nonTransient);

      expect(killSandbox).toHaveBeenCalledWith("sbx-crash");
      expect(requeueForRetry).not.toHaveBeenCalled();
      expect(failTaskInbox).not.toHaveBeenCalled();
    });

    it("non-transient + alive pod → logs only, never fails or retries", async () => {
      const task = makeTask({ sandboxId: "sbx-1" });
      getSandboxPodStatus.mockResolvedValue({ exists: true, phase: "Running", oomKilled: false });

      await assess(task, nonTransient);

      expect(requeueForRetry).not.toHaveBeenCalled();
      expect(releaseLease).not.toHaveBeenCalled();
      expect(killSandbox).not.toHaveBeenCalled();
    });

    it("terminal pod but the lease was taken over → no kill, no requeue (don't destroy a sibling's adopted sandbox)", async () => {
      // The files-unavailable / absent windows span multiple ticks and can outlast
      // the lease; by the time retryTask runs, pod B may have stale-lease-claimed
      // the task and adopted its sandbox. retryTask must re-read owner-scoped and
      // bail when it no longer owns the task — killing here would destroy B's live
      // sandbox (the closure's sandboxId == B's adopted one).
      const task = makeTask({ sandboxId: "sbx-adopted-by-sibling" });
      getSandboxPodStatus.mockResolvedValue({ exists: true, phase: "Failed", oomKilled: false });
      getByIdOwnedBy.mockResolvedValue(null); // owner-scoped re-read: a sibling owns it now

      await assess(task, nonTransient);

      expect(killSandbox).not.toHaveBeenCalled();
      expect(requeueForRetry).not.toHaveBeenCalled();
      expect(releaseLease).not.toHaveBeenCalled();
    });

    it("terminal pod but NO surviving inbox work → clean terminal (kill + release), NOT a requeue/strand", async () => {
      // The task's round already completed (every inbox row terminal) while its
      // sandbox stayed alive; the pod then died in the post-completion idle window.
      // Requeuing would strand the row (nothing re-picks an owner-less, sandbox-less,
      // terminal-row task) and leak the PVC — so retryTask must clean-terminal it.
      const task = makeTask({ sandboxId: "sbx-done" });
      getSandboxPodStatus.mockResolvedValue({ exists: true, phase: "Failed", oomKilled: false });
      (inboxRepo.listNonTerminalByTask as ReturnType<typeof mock>).mockResolvedValue([]);

      await assess(task, nonTransient);

      // Dead sandbox killed + lease released (clears sandbox_id) — but NOT requeued,
      // and no retry-budget unit burned.
      expect(killSandbox).toHaveBeenCalledWith("sbx-done");
      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
      expect(requeueForRetry).not.toHaveBeenCalled();
    });

    it("non-transient + absent pod → defers on first sighting, retries once grace elapses", async () => {
      const task = makeTask({ sandboxId: "sbx-gone" });
      getSandboxPodStatus.mockResolvedValue({ exists: false, oomKilled: false });
      requeueForRetry.mockResolvedValue(true);

      // First sighting only starts the grace window.
      await assess(task, nonTransient);
      expect(requeueForRetry).not.toHaveBeenCalled();

      // grace=0 in the test config → the next sighting retries.
      await assess(task, nonTransient);
      expect(requeueForRetry).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        retryCount: 1,
      });
      expect(killSandbox).toHaveBeenCalledWith("sbx-gone");
    });

    it("retries exhausted → dead-letters + fails with the give-up message", async () => {
      const task = makeTask({ sandboxId: "sbx-oom" });
      stubLinearTarget(task);
      getSandboxPodStatus.mockResolvedValue({ exists: true, phase: "Failed", oomKilled: true });
      // The count is durable in tasks.metadata; requeueForRetry persists it. Mirror
      // that on the shared task object so the next assess() reads the bumped count
      // (the real reconcile re-loads the task each tick).
      requeueForRetry.mockImplementation((params: { retryCount: number }) => {
        task.metadata = { retryCount: params.retryCount };
        return Promise.resolve(true);
      });

      // maxTaskRetries=2 in the test config → attempts 1 and 2 retry…
      await assess(task, nonTransient);
      await assess(task, nonTransient);
      expect(failTaskInbox).not.toHaveBeenCalled();

      // …the 3rd gives up: dead-letter + release + the OOM-specific give-up message.
      await assess(task, nonTransient);
      expect(failTaskInbox).toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        alsoClearSandbox: true,
      });
      const msg = (emitError.mock.calls[0] as unknown as [unknown, string, string])[2];
      expect(msg).toContain("ran out of memory");
      expect(msg).toContain("256Mi");
    });
  });

  describe("Files-API unavailable window (execd dead behind a live pod)", () => {
    const assess = (task: Task, err: unknown): Promise<void> =>
      (
        service as unknown as { assessReconcileError(t: Task, e: unknown): Promise<void> }
      ).assessReconcileError(task, err);

    it("transient 5xx within the window → defers (no fail)", async () => {
      const task = makeTask({ sandboxId: "sbx-warming" });
      await assess(task, new SandboxApiException({ statusCode: 503 }));
      expect(releaseLease).not.toHaveBeenCalled();
      expect(killSandbox).not.toHaveBeenCalled();
    });

    it("transient 5xx past the window → retries (requeue + kill, not failed)", async () => {
      const task = makeTask({ sandboxId: "sbx-dead-execd" });
      requeueForRetry.mockResolvedValue(true);
      // Pre-seed the window start well in the past so this observation exceeds it.
      (
        service as unknown as { reconcileFilesUnavailableSince: Map<string, number> }
      ).reconcileFilesUnavailableSince.set(task.id, Date.now() - 700_000);

      await assess(task, new SandboxApiException({ statusCode: 503 }));

      expect(requeueForRetry).toHaveBeenCalledWith({
        taskId: "task-1",
        ownerId: "pod-test",
        retryCount: 1,
      });
      expect(killSandbox).toHaveBeenCalledWith("sbx-dead-execd");
      expect(failTaskInbox).not.toHaveBeenCalled();
    });
  });

  describe("idle reaper", () => {
    it("kills sandboxes returned by reapIdleTasks", async () => {
      reapIdleTasks.mockResolvedValueOnce([
        { id: "task-a", sandboxId: "sbx-a" },
        { id: "task-b", sandboxId: "sbx-b" },
      ]);

      service.start();
      await waitFor(() => killSandbox.mock.calls.length >= 2);
      await service.stop();

      const killed = killSandbox.mock.calls.map((c: unknown[]) => c[0]);
      expect(killed).toContain("sbx-a");
      expect(killed).toContain("sbx-b");
    });
  });

  describe("start/stop", () => {
    it("stop() is safe to call when never started", async () => {
      await service.stop();
      expect(backdateHeartbeatsOwnedBy).not.toHaveBeenCalled();
    });

    it("stop() waits for detached hooks and logs hook_abandoned for one that outlives the drain", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => logger);
      const drainMs = mockedConfig.shutdownDrainMs;
      mockedConfig.shutdownDrainMs = 100;
      try {
        let finished = false;
        service.start();
        await waitFor(() => heartbeatOwnedBy.mock.calls.length > 0);
        hooks.detach(
          "task-1",
          "onRoundFinished",
          sleep(20).then(() => {
            finished = true;
          }),
        );
        hooks.detach("task-2", "assignee", sleep(400));
        await service.stop();

        expect(finished).toBe(true);
        expect(warn.mock.calls.filter(([msg]) => msg === "hook abandoned at shutdown")).toEqual([
          [
            "hook abandoned at shutdown",
            { event: "hook_abandoned", taskId: "task-2", hook: "assignee" },
          ],
        ]);
      } finally {
        mockedConfig.shutdownDrainMs = drainMs;
        warn.mockRestore();
      }
    });

    it("stop() backdates heartbeats owned by this pod before resolving", async () => {
      service.start();
      await waitFor(() => heartbeatOwnedBy.mock.calls.length > 0);
      await service.stop();

      expect(backdateHeartbeatsOwnedBy).toHaveBeenCalledWith("pod-test");
    });
  });
});
