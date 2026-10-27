import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import type { Task } from "../../db/schema";
import type { InboxRepository } from "../../repositories/inbox.repository";
import type { TaskRepository } from "../../repositories/task.repository";
import type { AgentSessionCreated, AgentSessionPrompted } from "../../types/agentSession";
import type { InboxService } from "../inbox.service";
import type { LinearTokenProvider } from "../linearTokenProvider";
import type { SandboxManager } from "../sandboxManager.service";

const emitResponse = mock(() => Promise.resolve());
const emitAction = mock(() => Promise.resolve());

mock.module("../../clients/linear", () => ({
  emitResponse,
  emitAction,
  emitThought: mock(() => Promise.resolve()),
  emitError: mock(() => Promise.resolve()),
  setIssueStarted: mock(() => Promise.resolve()),
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

const { AgentSessionService } = await import("../agentSession.service");

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

const createdEvent = (): AgentSessionCreated => ({
  action: "created",
  agentSessionId: "sess-1",
  issue: {
    id: "issue-1",
    title: "Fix auth bug",
    description: "desc",
    url: "https://linear.app/x/issue/ISS-1",
  },
});

const promptedEvent = (): AgentSessionPrompted => ({
  action: "prompted",
  agentSessionId: "sess-1",
  activityBody: "follow-up question",
  issue: { id: "issue-1" },
  activityId: "activity-1",
});

const foundTask = {
  id: "task-1",
  key: "XYZ-1",
  externalUrl: "https://linear.app/acme/issue/XYZ-1/foo",
} as Task;

describe("AgentSessionService", () => {
  let taskRepo: TaskRepository;
  let inboxRepo: InboxRepository;
  let linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">;
  let sandboxManager: SandboxManager;
  let inboxService: InboxService;
  let upsertFromAgentSessionWithInbox: ReturnType<typeof mock>;
  let restartTaskWithInbox: ReturnType<typeof mock>;
  let findByLinearIssueId: ReturnType<typeof mock>;
  let getAssignmentReplyTargetId: ReturnType<typeof mock>;
  let enqueueLinearComment: ReturnType<typeof mock>;
  let getAuthorizedLinearClient: ReturnType<typeof mock>;
  let killSandbox: ReturnType<typeof mock>;
  let service: InstanceType<typeof AgentSessionService>;

  beforeEach(() => {
    emitResponse.mockReset();
    emitResponse.mockResolvedValue(undefined);
    emitAction.mockReset();
    emitAction.mockResolvedValue(undefined);

    upsertFromAgentSessionWithInbox = mock(() =>
      Promise.resolve({ taskId: "task-1", created: true }),
    );
    restartTaskWithInbox = mock(() =>
      Promise.resolve({
        prevSandboxId: null,
        assignmentId: null,
        supersededRoundIds: [] as string[],
      }),
    );
    findByLinearIssueId = mock(() => Promise.resolve(foundTask));
    taskRepo = {
      upsertFromAgentSessionWithInbox,
      restartTaskWithInbox,
      findByLinearIssueId,
    } as unknown as TaskRepository;

    getAssignmentReplyTargetId = mock(() => Promise.resolve(null as string | null));
    inboxRepo = { getAssignmentReplyTargetId } as unknown as InboxRepository;

    getAuthorizedLinearClient = mock(() => Promise.resolve({} as unknown as LinearClient));
    linearTokenProvider = { getAuthorizedLinearClient } as unknown as Pick<
      LinearTokenProvider,
      "getAuthorizedLinearClient"
    >;

    killSandbox = mock(() => Promise.resolve());
    sandboxManager = { killSandbox } as unknown as SandboxManager;

    enqueueLinearComment = mock(() => Promise.resolve());
    inboxService = { enqueueLinearComment } as unknown as InboxService;

    service = new AgentSessionService(
      taskRepo,
      inboxRepo,
      linearTokenProvider,
      sandboxManager,
      inboxService,
    );
  });

  describe("handleEvent created", () => {
    it("writes task + inbox row and emits Evaluating on fresh insert", async () => {
      upsertFromAgentSessionWithInbox.mockResolvedValue({
        taskId: "task-1",
        created: true,
      });

      const result = await service.handleEvent(createdEvent());

      expect(result).toEqual({ status: "ok" });
      expect(upsertFromAgentSessionWithInbox).toHaveBeenCalledTimes(1);
      const arg = upsertFromAgentSessionWithInbox.mock.calls[0]?.[0] as {
        taskExternalId: string;
        taskKey: string;
        taskTitle: string;
        taskExternalUrl: string;
        inboxPayload: {
          title: string;
          description: string | null;
          target_id: string;
        };
        inboxReplyTargets: Array<{ id: string; spec: { kind: string } }>;
        metadata: { experimentalFlags: string[] };
      };
      expect(arg.taskExternalId).toBe("issue-1");
      expect(arg.taskKey).toBe("ISS-1");
      expect(arg.taskExternalUrl).toBe("https://linear.app/x/issue/ISS-1");
      expect(arg.inboxPayload.description).toBe("desc");
      expect(arg.metadata.experimentalFlags).toEqual([]);
      // Agent session id is carried by the assignment row's reply_targets +
      // payload.target_id — the canonical store after dropping the column.
      expect(arg.inboxPayload.target_id).toBe("sess-1");
      expect(arg.inboxReplyTargets[0]?.id).toBe("sess-1");
      expect(arg.inboxReplyTargets[0]?.spec.kind).toBe("linear_session");

      await flushMicrotasks();
      expect(emitResponse).not.toHaveBeenCalled();
      const actionArgs = emitAction.mock.calls[0] as unknown as [unknown, string, string, string];
      expect(actionArgs[1]).toBe("sess-1");
      expect(actionArgs[2]).toBe("Evaluating");
    });

    it("stores experimental flags on task metadata and strips them from assignment payload", async () => {
      const event = createdEvent();
      event.issue.description = [
        "Please validate the new path.",
        "",
        "#devbox:exp:FAST_PATH",
        "#devbox:exp:lowercase",
        "#devbox:exp:TRACE2",
      ].join("\n");

      const result = await service.handleEvent(event);

      expect(result).toEqual({ status: "ok" });
      const arg = upsertFromAgentSessionWithInbox.mock.calls[0]?.[0] as {
        inboxPayload: { description: string | null };
        metadata: { experimentalFlags: string[] };
      };
      expect(arg.metadata.experimentalFlags).toEqual(["FAST_PATH", "TRACE2"]);
      expect(arg.inboxPayload.description).toBe(
        "Please validate the new path.\n\n\n#devbox:exp:lowercase\n",
      );
    });

    it("restarts on conflict (new agent session id): calls restartTaskWithInbox, acks restart", async () => {
      upsertFromAgentSessionWithInbox.mockResolvedValue({
        taskId: "task-1",
        created: false,
      });
      getAssignmentReplyTargetId.mockResolvedValue("sess-old");
      restartTaskWithInbox.mockResolvedValue({ prevSandboxId: null });

      const result = await service.handleEvent(createdEvent());

      expect(result).toEqual({ status: "ok" });
      expect(restartTaskWithInbox).toHaveBeenCalledTimes(1);
      const restartArg = restartTaskWithInbox.mock.calls[0]?.[0] as { taskId: string };
      expect(restartArg.taskId).toBe("task-1");

      await flushMicrotasks();
      const respArgs = emitResponse.mock.calls[0] as unknown as [unknown, string, string];
      expect(respArgs[1]).toBe("sess-1");
      expect(respArgs[2]).toContain("Restarting");
      const actArgs = emitAction.mock.calls[0] as unknown as [unknown, string, string, string];
      expect(actArgs[2]).toBe("Evaluating");
      expect(actArgs[3]).toBe("task");
    });

    it("kills the preempted sandbox when a re-delegation restarts a live run", async () => {
      upsertFromAgentSessionWithInbox.mockResolvedValue({
        taskId: "task-1",
        created: false,
      });
      getAssignmentReplyTargetId.mockResolvedValue("sess-old");
      restartTaskWithInbox.mockResolvedValue({ prevSandboxId: "sb-old" });

      const result = await service.handleEvent(createdEvent());

      expect(result).toEqual({ status: "ok" });
      await flushMicrotasks();
      expect(killSandbox).toHaveBeenCalledTimes(1);
      expect(killSandbox.mock.calls[0]?.[0]).toBe("sb-old");
    });

    it("ignores a duplicate webhook redelivery (same agent session id): no restart", async () => {
      // Linear redelivers the same `created` event — the existing assignment
      // row's reply_targets already carries the event's session id, so it is
      // not a new delegation. No restart, no sandbox kill, no re-emit.
      upsertFromAgentSessionWithInbox.mockResolvedValue({
        taskId: "task-1",
        created: false,
      });
      getAssignmentReplyTargetId.mockResolvedValue("sess-1");

      const result = await service.handleEvent(createdEvent());

      expect(result).toEqual({ status: "ok" });
      expect(restartTaskWithInbox).not.toHaveBeenCalled();

      await flushMicrotasks();
      expect(emitResponse).not.toHaveBeenCalled();
      expect(emitAction).not.toHaveBeenCalled();
      expect(killSandbox).not.toHaveBeenCalled();
    });

    it("does not throw when linear emit fails (fire-and-forget)", async () => {
      upsertFromAgentSessionWithInbox.mockResolvedValue({
        taskId: "task-1",
        created: true,
      });
      getAuthorizedLinearClient.mockImplementation(() => Promise.reject(new Error("boom")));

      const result = await service.handleEvent(createdEvent());

      expect(result).toEqual({ status: "ok" });
      await flushMicrotasks();
      expect(emitResponse).not.toHaveBeenCalled();
      expect(emitAction).not.toHaveBeenCalled();
    });
  });

  describe("handleEvent prompted", () => {
    it("routes by issue id, enqueues a Linear comment carrying the fresh session id, fires Evaluating ack", async () => {
      const result = await service.handleEvent(promptedEvent());

      expect(result).toEqual({ status: "ok" });
      expect(findByLinearIssueId).toHaveBeenCalledWith("issue-1");
      expect(enqueueLinearComment).toHaveBeenCalledWith({
        task: foundTask,
        agentActivityId: "activity-1",
        agentSessionId: "sess-1",
        body: "follow-up question",
      });

      await flushMicrotasks();
      // Empty parameter — Linear concatenates action+parameter; a non-empty
      // value renders a noisy suffix ("Evaluating task").
      expect(emitAction).toHaveBeenCalledWith(expect.anything(), "sess-1", "Evaluating", "");
    });

    it("fires the Evaluating ack even when the task is not yet known (session_not_found)", async () => {
      findByLinearIssueId.mockResolvedValue(null);

      const result = await service.handleEvent(promptedEvent());

      expect(result).toEqual({ status: "session_not_found" });
      expect(enqueueLinearComment).not.toHaveBeenCalled();
      await flushMicrotasks();
      expect(emitAction).toHaveBeenCalledWith(expect.anything(), "sess-1", "Evaluating", "");
    });
  });

  it("throws on unknown action", async () => {
    const bogus = { action: "deleted", workspaceId: "ws-1" } as unknown as AgentSessionCreated;
    await expect(service.handleEvent(bogus)).rejects.toThrow(
      "unhandled agent session action: deleted",
    );
  });
});
