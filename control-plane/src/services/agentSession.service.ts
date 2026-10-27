import { emitAction, emitResponse, requireLinearTicketId } from "../clients/linear";
import { logger } from "../logger";
import type {
  AssignmentContent,
  InboxRepository,
  ReplyTarget,
} from "../repositories/inbox.repository";
import type { TaskRepository } from "../repositories/task.repository";
import type { HandleAgentSessionResult, ParsedAgentSessionEvent } from "../types/agentSession";
import { parseExperimentalFlags } from "./experimentalFlags";
import type { InboxService } from "./inbox.service";
import type { LinearTokenProvider } from "./linearTokenProvider";
import type { SandboxManager } from "./sandboxManager.service";

const RESTARTED_BODY = [
  "🔄 **Restarting from scratch.**",
  "",
  "This issue already finished a run — re-delegating kicks off a fresh attempt from a clean slate.",
].join("\n");

const STOP_NOT_SUPPORTED_BODY = "Stop is not supported yet — work will continue.";

export class AgentSessionService {
  private readonly taskRepo: TaskRepository;
  private readonly inboxRepo: InboxRepository;
  private readonly linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">;
  private readonly sandboxManager: SandboxManager;
  private readonly inboxService: InboxService;

  constructor(
    taskRepo: TaskRepository,
    inboxRepo: InboxRepository,
    linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">,
    sandboxManager: SandboxManager,
    inboxService: InboxService,
  ) {
    this.taskRepo = taskRepo;
    this.inboxRepo = inboxRepo;
    this.linearTokenProvider = linearTokenProvider;
    this.sandboxManager = sandboxManager;
    this.inboxService = inboxService;
  }

  async handleEvent(event: ParsedAgentSessionEvent): Promise<HandleAgentSessionResult> {
    switch (event.action) {
      case "created": {
        const { flags: experimentalFlags, strippedDescription } = parseExperimentalFlags(
          event.issue.description,
        );
        const taskKey = requireLinearTicketId(event.issue.url);
        const inboxPayload: AssignmentContent = {
          title: event.issue.title,
          description: strippedDescription,
          external_url: event.issue.url,
          target_id: event.agentSessionId,
        };
        const inboxReplyTargets: ReplyTarget[] = [
          { id: event.agentSessionId, spec: { kind: "linear_session" } },
        ];

        // Single tx: upsert the tasks row (infra) + insert the assignment inbox
        // row. The inbox row's reply_targets[0].id is the canonical Linear
        // agent session id; on a re-delegation `restartTaskWithInbox`
        // overwrites it with the freshly-minted session and rotates the inbox
        // id. Inbox row uses the Linear issue UUID as external_id; its id is the
        // daemon-visible run identity.
        const { taskId, created } = await this.taskRepo.upsertFromAgentSessionWithInbox({
          taskExternalId: event.issue.id,
          taskKey,
          taskTitle: event.issue.title,
          taskExternalUrl: event.issue.url,
          inboxPayload,
          inboxReplyTargets,
          metadata: { experimentalFlags },
        });

        if (created) {
          // Fresh task — Linear sees Evaluating to satisfy the 10s SLA.
          this.fireAndForgetEmitAction(event.agentSessionId, "Evaluating", "task", "created-ack");
          return { status: "ok" };
        }

        // Conflict path — distinguish a duplicate webhook redelivery (same
        // session id as the row already carries) from a genuine re-delegation
        // (new session id). The upsert above DO-NOTHING'd the inbox INSERT, so
        // the assignment row's existing reply_targets still carries the prior
        // session id.
        const prevSessionId = await this.inboxRepo.getAssignmentReplyTargetId(taskId);
        if (prevSessionId !== event.agentSessionId) {
          // Genuine re-delegation — Linear minted a NEW agent session for a new
          // `created` event. Preempt any in-flight run and restart from scratch:
          // restartTaskWithInbox resets the task + re-pends the `assignment` inbox
          // row (with the new session id in reply_targets). Kill the preempted
          // sandbox (if the run was still live) so the slot frees right away;
          // the old owner pod self-evicts on its next owner-guarded write. Then
          // ack the restart.
          logger.info("re-delegation detected; restarting task from clean slate", {
            taskId,
            previousSessionId: prevSessionId,
            currentSessionId: event.agentSessionId,
          });
          const { prevSandboxId } = await this.taskRepo.restartTaskWithInbox({
            taskId,
            inboxPayload,
            inboxReplyTargets,
          });
          if (prevSandboxId) {
            this.fireAndForgetKillSandbox(prevSandboxId);
          }
          this.fireAndForgetEmitResponse(event.agentSessionId, RESTARTED_BODY, "restart-ack");
          this.fireAndForgetEmitAction(event.agentSessionId, "Evaluating", "task", "restart-ack");
        }
        // else: prevSessionId === event.agentSessionId — a duplicate webhook
        // delivery of an already-processed delegation (Linear redelivers the same
        // `created` event, same agent session id). The run is already (re)started
        // and acked by the first delivery; no-op rather than run the restart
        // twice (which would kill the freshly-provisioned sandbox). Fall through
        // to the 200 below so Linear stops retrying.
        return { status: "ok" };
      }

      case "prompted": {
        // Immediate "Evaluating" ack — fired FIRST so Linear's 10s SLA is
        // satisfied regardless of how long the task lookup + inbox enqueue
        // take. The daemon's own status update is minutes away (claim →
        // recreate-from-PVC → sweep), too late to serve as the ack. Fired
        // unconditionally: a duplicate `prompted` redelivery re-acks, which
        // is harmless on Linear's side.
        this.fireAndForgetEmitAction(event.agentSessionId, "Evaluating", "", "prompted-ack");

        // follow-up comment on the agent session → a kind='comment'
        // inbox row, the same path as a GitHub comment. Route by Linear issue id
        // (Linear mints a fresh agent session per re-prompt). Unknown issue →
        // session_not_found so the webhook returns 503 and Linear retries after
        // the `created` event lands.
        const task = await this.taskRepo.findByLinearIssueId(event.issue.id);
        if (!task) return { status: "session_not_found" };

        // enqueueLinearComment INSERTs the inbox row (idempotent on activityId).
        // The new comment row's reply_targets carry the fresh session id, so
        // replies route correctly; the assignment row's reply_targets is the
        // canonical session id for task-scoped lifecycle / failure emits and
        // remains the one from `created` until the next re-delegation.
        // The sweep handles sandbox recreate-from-PVC; a pruned workspace
        // surfaces a PVC-missing error.
        await this.inboxService.enqueueLinearComment({
          task,
          agentActivityId: event.activityId,
          agentSessionId: event.agentSessionId,
          body: event.activityBody,
        });
        return { status: "ok" };
      }

      case "stop_requested": {
        // Linear cancel button → `agentActivity.signal === "stop"`. Cancellation
        // isn't wired up yet; emit a response so the user sees the limitation.
        // Webhook returns 200 — any non-200 triggers Linear retries — and the
        // user-visible message goes via emitResponse.
        this.fireAndForgetEmitResponse(
          event.agentSessionId,
          STOP_NOT_SUPPORTED_BODY,
          "stop-not-supported",
        );
        return { status: "ok" };
      }

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        throw new Error(`unhandled agent session action: ${(event as { action: string }).action}`);
      }
    }
  }

  // Voids the whole chain (including auth fetch) so the webhook handler never
  // blocks on Linear API — preserves Linear's 5s response / 10s SLA.
  private fireAndForgetEmitResponse(sessionId: string, body: string, logContext: string): void {
    void this.linearTokenProvider
      .getAuthorizedLinearClient()
      .then((client) => emitResponse(client, sessionId, body))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`emitResponse(${logContext}) failed`, {
          agentSessionId: sessionId,
          message: msg,
        });
      });
  }

  private fireAndForgetEmitAction(
    sessionId: string,
    action: string,
    parameter: string,
    logContext: string,
  ): void {
    void this.linearTokenProvider
      .getAuthorizedLinearClient()
      .then((client) => emitAction(client, sessionId, action, parameter))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`emitAction(${logContext}) failed`, {
          agentSessionId: sessionId,
          message: msg,
        });
      });
  }

  // Fire-and-forget — the webhook handler must not block on the sandbox API.
  // Kills a preempted sandbox when a re-delegation restarts a task.
  private fireAndForgetKillSandbox(sandboxId: string): void {
    void this.sandboxManager.killSandbox(sandboxId).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("killSandbox(preempted re-delegation) failed", {
        sandboxId,
        message: msg,
      });
    });
  }
}
