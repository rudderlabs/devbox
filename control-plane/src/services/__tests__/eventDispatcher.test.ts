import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LinearClient } from "@linear/sdk";
// Type-only import — erased at link time, so it can't collide with the
// mock.module barrel factories below, and it pins the real contract.
import type { LinearHumanUser } from "../../clients/linearApi";
import type { Task } from "../../db/schema";
import type { InboxRepository, InboxRow, InboxStatus } from "../../repositories/inbox.repository";
import type { TaskRepository } from "../../repositories/task.repository";
import type { HarnessEvent } from "../../types/harnessEvent";
import type { LinearTokenProvider } from "../linearTokenProvider";
import type { SandboxManager } from "../sandboxManager.service";
import type { SlackNotifierService } from "../slackNotifier.service";

mock.module("../../config", () => ({
  config: {
    podId: "pod-test",
    github: { webhooks: { botLogin: "harness" } },
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

mock.module("../../clients/linear", () => ({
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

// Mock the full export surface of the ../../clients/github barrel. bun's
// mock.module is process-global; the module split alone did NOT contain it --
// in CI this mock reached github.test.ts and failed 25 of its tests. The suite
// now runs with --isolate (package.json "test"), which gives every file a fresh
// module registry, so this cannot leak. Do not drop that flag.
mock.module("../../clients/github", () => ({
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
}));

const { EventDispatcher } = await import("../eventDispatcher");
const { config: mockedConfig } = (await import("../../config")) as unknown as {
  config: {
    github: { webhooks: { botLogin: string } | undefined };
  };
};

// The assignee mirror is detached (void'd) from the pr_opened case — settle its
// promise chain before asserting on its mocks.
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

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

describe("EventDispatcher", () => {
  let taskRepo: TaskRepository;
  let inboxRepo: InboxRepository;
  let sandboxManager: SandboxManager;
  let linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">;
  let appendPrUrl: ReturnType<typeof mock>;
  let getByIdForTask: ReturnType<typeof mock>;
  let markResponded: ReturnType<typeof mock>;
  let notifyTerminal: ReturnType<typeof mock>;
  let slackNotifier: SlackNotifierService;
  let dispatcher: InstanceType<typeof EventDispatcher>;

  beforeEach(() => {
    for (const m of [
      emitThought,
      emitAction,
      emitResponse,
      emitError,
      setIssueStarted,
      attachUrlToIssue,
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

    appendPrUrl = mock(() => Promise.resolve([{ id: "task-1" }]));
    taskRepo = { appendPrUrl } as unknown as TaskRepository;

    getByIdForTask = mock(() => Promise.resolve(linearRow()));
    markResponded = mock(() => Promise.resolve([{ id: "inbox-1" }]));
    inboxRepo = {
      getByIdForTask,
      markResponded,
    } as unknown as InboxRepository;

    sandboxManager = {} as unknown as SandboxManager;
    linearTokenProvider = {
      getAuthorizedLinearClient: mock(() => Promise.resolve({} as unknown as LinearClient)),
    } as unknown as Pick<LinearTokenProvider, "getAuthorizedLinearClient">;

    notifyTerminal = mock(() => Promise.resolve());
    slackNotifier = { notifyTerminal } as unknown as SlackNotifierService;

    dispatcher = new EventDispatcher(
      taskRepo,
      inboxRepo,
      sandboxManager,
      linearTokenProvider,
      slackNotifier,
    );
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
      getByIdForTask.mockResolvedValue(apiRow());
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
      getByIdForTask.mockResolvedValue(apiRow("comment"));
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
      getByIdForTask.mockResolvedValue(apiRow());
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
      );
    });

    it("completed assignment: no run archive, no Slack", async () => {
      getByIdForTask.mockResolvedValue(apiRow());
      await dispatcher.handle(
        { seq: 3, ts: "t", type: "completed", inbox_id: "inbox-1", status: "completed" },
        apiTask(),
      );
      await flushMicrotasks();
      expect(notifyTerminal).not.toHaveBeenCalled();
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
      getByIdForTask.mockResolvedValue({
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
      getByIdForTask.mockResolvedValue({
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

    it("foreign / unknown inbox_id → cross-task leak: aborts, no emit", async () => {
      // A foreign inbox_id resolving to null means this task's stream is
      // carrying an event it doesn't own (cross-task leak). The dispatcher
      // aborts the whole reconcile — never routes the emit, never advances the
      // cursor — so a leaked stream halts loudly instead of smuggling an emit
      // onto some other task's UI.
      getByIdForTask.mockResolvedValue(null);
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
      expect(getByIdForTask).toHaveBeenCalledWith("foreign-inbox", "task-1");
    });
  });

  describe("pr_opened", () => {
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

    it("self-evicts when appendPrUrl returns 0 rows (lease lost); skips attachUrlToIssue", async () => {
      appendPrUrl.mockResolvedValue([]);
      const result = await dispatcher.handle(prEvent(), makeTask());
      await flushMicrotasks();
      expect(result).toBe("self_evict");
      // attachUrlToIssue must NOT run after a lost-lease self-evict.
      expect(attachUrlToIssue).not.toHaveBeenCalled();
      // Nor may the assignee mirror — the sibling pod now owns this task.
      expect(getIssueHumanAssignee).not.toHaveBeenCalled();
      expect(addPrAssignees).not.toHaveBeenCalled();
    });

    it("posts the onboarding comment after appendPrUrl succeeds", async () => {
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
      );
    });

    it("posts no onboarding comment when GitHub webhooks are off", async () => {
      const webhooks = mockedConfig.github.webhooks;
      mockedConfig.github.webhooks = undefined;
      try {
        const result = await dispatcher.handle(prEvent(), makeTask());
        expect(result).toBe("ok");
        expect(postIssueComment).not.toHaveBeenCalled();
      } finally {
        mockedConfig.github.webhooks = webhooks;
      }
    });

    describe("linear assignee mirror", () => {
      const human = (gitHubUserId: string | null): LinearHumanUser => ({
        id: "usr-1",
        name: "Ada Lovelace",
        displayName: "ada",
        email: "ada@acme.com",
        gitHubUserId,
      });

      it("numeric gitHubUserId → resolves the login via getUserById and assigns it", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("583231"));
        getUserById.mockResolvedValue({ login: "octocat", id: 583231 });
        addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });

        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();

        expect(result).toBe("ok");
        expect(getIssueHumanAssignee).toHaveBeenCalledWith(expect.anything(), "issue-1");
        expect(getUserById).toHaveBeenCalledWith("583231");
        expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
      });

      it("non-numeric gitHubUserId is treated as a login directly (no getUserById)", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("octocat"));
        addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });

        await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();

        expect(getUserById).not.toHaveBeenCalled();
        expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
      });

      it("no human assignee → no GitHub calls, still ok", async () => {
        getIssueHumanAssignee.mockResolvedValue(null);
        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();
        expect(result).toBe("ok");
        expect(getUserById).not.toHaveBeenCalled();
        expect(addPrAssignees).not.toHaveBeenCalled();
      });

      it("assignee without a Linear↔GitHub connection (gitHubUserId null) → skip", async () => {
        getIssueHumanAssignee.mockResolvedValue(human(null));
        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();
        expect(result).toBe("ok");
        expect(addPrAssignees).not.toHaveBeenCalled();
      });

      it("empty login from a malformed getUserById response → skip, no assignees POST", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("583231"));
        getUserById.mockResolvedValue({ login: "", id: 0 });
        await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();
        expect(addPrAssignees).not.toHaveBeenCalled();
      });

      it("getUserById rejection is swallowed: result ok, no assignees POST", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("583231"));
        getUserById.mockRejectedValue(new Error("github down"));
        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();
        expect(result).toBe("ok");
        expect(addPrAssignees).not.toHaveBeenCalled();
      });

      it("case-folded comparison: canonical-cased response is not a false drop", async () => {
        getIssueHumanAssignee.mockResolvedValue(human("OctoCat"));
        addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
        const result = await dispatcher.handle(prEvent(), makeTask());
        await flushMicrotasks();
        expect(result).toBe("ok");
        expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["OctoCat"]);
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
      });
    });

    it("foreign inbox_id → cross-task leak: aborts, no appendPrUrl / attach / onboarding", async () => {
      // The seed of the cross-task pr_urls pollution: a pr_opened emitted in a
      // stream whose round belongs to a DIFFERENT task (confused-deputy emit, or
      // a crossed sandbox binding) must NOT write that PR into this task's
      // pr_urls — findByPrUrl would then mis-route every comment on it. A foreign
      // inbox_id resolves to null → the dispatcher returns "abort" so reconcile
      // halts the whole stream (no side effect applied, cursor not advanced).
      getByIdForTask.mockResolvedValue(null);
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
      getByIdForTask.mockResolvedValue(ghCommentRow());
      await dispatcher.handle(responseEvent("555"), makeTask());
      expect(postIssueComment).toHaveBeenCalledWith("o", "r", 1, "good catch, fixing");
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
      getByIdForTask.mockResolvedValue(row);
      await dispatcher.handle(responseEvent("555"), makeTask());
      expect(postReviewCommentReply).toHaveBeenCalledWith("o", "r", 1, 555, "good catch, fixing");
    });

    it("routes a linear_session target to emitResponse using target.id (the session id)", async () => {
      const row = ghCommentRow();
      row.source = "linear";
      // reply_targets[0].id IS the session id by construction.
      row.reply_targets = [{ id: "sess-1", spec: { kind: "linear_session" } }];
      getByIdForTask.mockResolvedValue(row);
      await dispatcher.handle(responseEvent("sess-1"), makeTask());
      expect(emitResponse).toHaveBeenCalledWith(expect.anything(), "sess-1", "good catch, fixing");
    });

    it("drops a target_id absent from reply_targets (no throw, no post)", async () => {
      getByIdForTask.mockResolvedValue(ghCommentRow());
      const result = await dispatcher.handle(responseEvent("not-a-target"), makeTask());
      expect(result).toBe("ok");
      expect(postIssueComment).not.toHaveBeenCalled();
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

    const ghReviewRow = (
      overrides: Partial<Extract<InboxRow, { kind: "review" }>> = {},
    ): Extract<InboxRow, { kind: "review" }> => ({
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
      getByIdForTask.mockResolvedValue(linearRow({ status: "responded" }));
      await dispatcher.handle(completedEvent(), makeTask());
      expect(markResponded).not.toHaveBeenCalled();
    });

    it("posts a Slack completion update on the first transition (assignment round)", async () => {
      await dispatcher.handle(completedEvent(), makeTask());
      expect(notifyTerminal).toHaveBeenCalledTimes(1);
      expect(notifyTerminal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "task-1" }),
        "completed",
      );
    });

    it("forwards the event status to the Slack notify (partial_failure)", async () => {
      await dispatcher.handle({ ...completedEvent(), status: "partial_failure" }, makeTask());
      expect(notifyTerminal).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "partial_failure",
      );
    });

    it("does NOT post to Slack on an idempotent re-fire (already responded)", async () => {
      getByIdForTask.mockResolvedValue(linearRow({ status: "responded" }));
      await dispatcher.handle(completedEvent(), makeTask());
      expect(notifyTerminal).not.toHaveBeenCalled();
    });

    it("does NOT post to Slack when markResponded returns 0 rows (lease lost)", async () => {
      markResponded.mockResolvedValue([]);
      await dispatcher.handle(completedEvent(), makeTask());
      expect(notifyTerminal).not.toHaveBeenCalled();
    });

    it("does NOT post to Slack for a comment/review round (kind !== assignment)", async () => {
      getByIdForTask.mockResolvedValue({ ...linearRow(), kind: "comment" } as InboxRow);
      await dispatcher.handle(
        { seq: 1, ts: "t", type: "completed", inbox_id: "inbox-1" },
        makeTask(),
      );
      expect(notifyTerminal).not.toHaveBeenCalled();
      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("re-requests review from the original reviewer on the first completed review transition", async () => {
      getByIdForTask.mockResolvedValue(ghReviewRow());

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).toHaveBeenCalledTimes(1);
      expect(requestReviewers).toHaveBeenCalledWith("o", "r", 7, ["reviewer"]);
    });

    it("falls back to review reply_targets for historical review rows without payload PR coordinates", async () => {
      const row = ghReviewRow();
      row.payload.pr = { repo: "r", pr_url: "not-a-github-url" };
      getByIdForTask.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).toHaveBeenCalledWith("o", "r", 7, ["reviewer"]);
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
      getByIdForTask.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).toHaveBeenCalledWith("oc", "rc", 8, ["reviewer"]);
    });

    it("falls back to parsing review payload pr_url when reply_targets are unavailable", async () => {
      const row = ghReviewRow();
      row.payload.pr = { repo: "r", pr_url: "https://github.com/fallback/repo/pull/9" };
      row.reply_targets = [];
      getByIdForTask.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).toHaveBeenCalledWith("fallback", "repo", 9, ["reviewer"]);
    });

    it("does not re-request review on an idempotent review completion re-fire", async () => {
      getByIdForTask.mockResolvedValue(ghReviewRow({ status: "responded" }));

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("does not re-request review when markResponded returns 0 rows", async () => {
      getByIdForTask.mockResolvedValue(ghReviewRow());
      markResponded.mockResolvedValue([]);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("skips review re-request when reviewer_login is missing", async () => {
      const row = ghReviewRow();
      delete row.payload.reviewer_login;
      getByIdForTask.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("skips review re-request when reviewer_login is blank", async () => {
      const row = ghReviewRow();
      row.payload.reviewer_login = " ";
      getByIdForTask.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("skips review re-request when PR coordinates cannot be resolved", async () => {
      const row = ghReviewRow();
      row.payload.pr = { repo: "r", pr_url: "not-a-github-url" };
      row.reply_targets = [];
      getByIdForTask.mockResolvedValue(row);

      await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("swallows request-reviewer failures and still returns ok", async () => {
      getByIdForTask.mockResolvedValue(ghReviewRow());
      requestReviewers.mockRejectedValue(new Error("GitHub unavailable"));

      const result = await dispatcher.handle(completedEvent(), makeTask());
      await flushMicrotasks();

      expect(result).toBe("ok");
      expect(requestReviewers).toHaveBeenCalledWith("o", "r", 7, ["reviewer"]);
    });

    it("does not crash when markResponded returns 0 rows (lease lost; warned)", async () => {
      markResponded.mockResolvedValue([]);
      await dispatcher.handle(completedEvent(), makeTask());
      expect(markResponded).toHaveBeenCalled();
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
});
