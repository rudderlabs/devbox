import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import type { Task } from "../../db/schema";
import type { TaskIntake, TaskRef } from "../../integrations/intake";
import type { ReplyTarget } from "../../repositories/inbox.repository";
import type { AgentSessionCreated, AgentSessionPrompted } from "../../types/agentSession";
import type { InboxService } from "../inbox.service";
import type { LinearTokenProvider } from "../linearTokenProvider";

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
  let intake: TaskIntake;
  let linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">;
  let inboxService: InboxService;
  let assign: ReturnType<typeof mock>;
  let findTask: ReturnType<typeof mock>;
  let enqueueLinearComment: ReturnType<typeof mock>;
  let getAuthorizedLinearClient: ReturnType<typeof mock>;
  let service: InstanceType<typeof AgentSessionService>;

  type AssignArg = {
    source: string;
    externalId: string;
    key: { hint: string };
    title: string;
    description: string | null;
    flags: string[];
    url: (t: TaskRef) => string;
    target: (t: TaskRef) => ReplyTarget;
  };
  const ref = { id: "task-1", key: "ISS-1" };

  beforeEach(() => {
    emitResponse.mockReset();
    emitResponse.mockResolvedValue(undefined);
    emitAction.mockReset();
    emitAction.mockResolvedValue(undefined);

    assign = mock(() => Promise.resolve({ taskId: "task-1", key: "ISS-1", result: "created" }));
    findTask = mock(() => Promise.resolve(foundTask));
    intake = { assign, findTask } as unknown as TaskIntake;

    getAuthorizedLinearClient = mock(() => Promise.resolve({} as unknown as LinearClient));
    linearTokenProvider = { getAuthorizedLinearClient } as unknown as Pick<
      LinearTokenProvider,
      "getAuthorizedLinearClient"
    >;

    enqueueLinearComment = mock(() => Promise.resolve());
    inboxService = { enqueueLinearComment } as unknown as InboxService;

    service = new AgentSessionService(intake, linearTokenProvider, inboxService);
  });

  describe("handleEvent created", () => {
    it("writes task + inbox row and emits Evaluating on fresh insert", async () => {
      const result = await service.handleEvent(createdEvent());

      expect(result).toEqual({ status: "ok" });
      expect(assign).toHaveBeenCalledTimes(1);
      const arg = assign.mock.calls[0]?.[0] as AssignArg;
      expect(arg.source).toBe("linear");
      expect(arg.externalId).toBe("issue-1");
      expect(arg.key).toEqual({ hint: "ISS-1" });
      expect(arg.url(ref)).toBe("https://linear.app/x/issue/ISS-1");
      expect(arg.description).toBe("desc");
      expect(arg.flags).toEqual([]);
      // The agent session id is the delegation id: the assignment row's reply
      // target (intake stamps it as payload.target_id too).
      expect(arg.target(ref)).toEqual({ id: "sess-1", spec: { kind: "linear_session" } });

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
      const arg = assign.mock.calls[0]?.[0] as AssignArg;
      expect(arg.flags).toEqual(["FAST_PATH", "TRACE2"]);
      expect(arg.description).toBe("Please validate the new path.\n\n\n#devbox:exp:lowercase\n");
    });

    it("restarts on a new agent session id: acks the restart", async () => {
      assign.mockResolvedValue({ taskId: "task-1", key: "ISS-1", result: "restarted" });

      const result = await service.handleEvent(createdEvent());

      expect(result).toEqual({ status: "ok" });
      expect(assign).toHaveBeenCalledTimes(1);

      await flushMicrotasks();
      const respArgs = emitResponse.mock.calls[0] as unknown as [unknown, string, string];
      expect(respArgs[1]).toBe("sess-1");
      expect(respArgs[2]).toContain("Restarting");
      const actArgs = emitAction.mock.calls[0] as unknown as [unknown, string, string, string];
      expect(actArgs[2]).toBe("Evaluating");
      expect(actArgs[3]).toBe("task");
    });

    it("ignores a duplicate webhook redelivery (same agent session id): no restart", async () => {
      // Linear redelivers the same `created` event — the existing assignment
      // row's reply_targets already carries the event's session id, so it is
      // not a new delegation. No restart, no re-emit.
      assign.mockResolvedValue({ taskId: "task-1", key: "ISS-1", result: "duplicate" });

      const result = await service.handleEvent(createdEvent());

      expect(result).toEqual({ status: "ok" });

      await flushMicrotasks();
      expect(emitResponse).not.toHaveBeenCalled();
      expect(emitAction).not.toHaveBeenCalled();
    });

    it("does not throw when linear emit fails (fire-and-forget)", async () => {
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
      expect(findTask).toHaveBeenCalledWith("linear", "issue-1");
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

    it("a redelivered prompted re-acks and enqueues again (the inbox drops the duplicate row)", async () => {
      await service.handleEvent(promptedEvent());
      await service.handleEvent(promptedEvent());
      await flushMicrotasks();
      expect(enqueueLinearComment).toHaveBeenCalledTimes(2);
      expect(enqueueLinearComment.mock.calls[1]).toEqual(enqueueLinearComment.mock.calls[0]);
      expect(emitAction).toHaveBeenCalledTimes(2);
    });

    it("fires the Evaluating ack even when the task is not yet known (session_not_found)", async () => {
      findTask.mockResolvedValue(null);

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
