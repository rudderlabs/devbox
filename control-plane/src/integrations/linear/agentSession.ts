import { emitAction, emitResponse, requireLinearTicketId } from "../../clients/linear";
import type { Task } from "../../db/schema";
import { logger } from "../../logger";
import type { ReplyTarget } from "../../repositories/inbox.repository";
import { parseExperimentalFlags } from "../../services/experimentalFlags";
import type { TaskService } from "../../services/task.service";
import type { LinearTokenProvider } from "./tokenProvider";
import type { HandleAgentSessionResult, ParsedAgentSessionEvent } from "./types";

const RESTARTED_BODY = [
  "🔄 **Restarting from scratch.**",
  "",
  "This issue already finished a run — re-delegating kicks off a fresh attempt from a clean slate.",
].join("\n");

const STOP_NOT_SUPPORTED_BODY = "Stop is not supported yet — work will continue.";

export class AgentSessionService {
  private readonly tasks: Pick<TaskService, "assign" | "findTask" | "enqueueRound">;
  private readonly linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">;

  constructor(
    tasks: Pick<TaskService, "assign" | "findTask" | "enqueueRound">,
    linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">,
  ) {
    this.tasks = tasks;
    this.linearTokenProvider = linearTokenProvider;
  }

  async handleEvent(event: ParsedAgentSessionEvent): Promise<HandleAgentSessionResult> {
    switch (event.action) {
      case "created": {
        const { flags, strippedDescription } = parseExperimentalFlags(event.issue.description);
        // The agent session is the delegation id: Linear mints a new one per
        // delegation and redelivers a `created` with the same one.
        const target: ReplyTarget = { id: event.agentSessionId, spec: { kind: "linear_session" } };

        // One transaction: insert the task and its assignment row, or compare
        // the stored session with this one. The same session is a redelivery
        // of a processed delegation (no change, no ack: a restart would kill
        // the freshly-provisioned sandbox); a new one is a re-delegation, which
        // preempts any in-flight run and restarts from a clean slate (the
        // TaskService kills the preempted sandbox).
        const { taskId, result, previousTargetId } = await this.tasks.assign({
          externalId: event.issue.id,
          key: { hint: requireLinearTicketId(event.issue.url) },
          title: event.issue.title,
          description: strippedDescription,
          flags,
          url: () => event.issue.url,
          target: () => target,
        });

        if (result === "created") {
          // Fresh task — Linear sees Evaluating to satisfy the 10s SLA.
          this.fireAndForgetEmitAction(event.agentSessionId, "Evaluating", "task", "created-ack");
        } else if (result === "restarted") {
          logger.info("re-delegation detected; restarting task from clean slate", {
            taskId,
            previousSessionId: previousTargetId,
            currentSessionId: event.agentSessionId,
          });
          this.fireAndForgetEmitResponse(event.agentSessionId, RESTARTED_BODY, "restart-ack");
          this.fireAndForgetEmitAction(event.agentSessionId, "Evaluating", "task", "restart-ack");
        }
        // A duplicate falls through to the 200 so Linear stops retrying.
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
        const task = await this.tasks.findTask(event.issue.id);
        if (!task) return { status: "session_not_found" };

        // enqueueLinearComment queues the round (idempotent on activityId).
        // The new comment row's reply_targets carry the fresh session id, so
        // replies route correctly; the assignment row's reply_targets is the
        // canonical session id for task-scoped lifecycle / failure emits and
        // remains the one from `created` until the next re-delegation.
        // The sweep handles sandbox recreate-from-PVC; a pruned workspace
        // surfaces a PVC-missing error.
        await this.enqueueLinearComment({
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

  // Linear `prompted` — a follow-up comment on the agent session. Same inbox
  // path as a GitHub comment; the single reply target routes to the Linear
  // session. Idempotent on the Linear activity UUID — a duplicate redelivery
  // is dropped.
  private async enqueueLinearComment(params: {
    task: Pick<Task, "id" | "key">;
    agentActivityId: string;
    agentSessionId: string;
    body: string;
  }): Promise<void> {
    await this.tasks.enqueueRound({
      task: params.task,
      kind: "comment",
      // Linear activity UUID — drives idempotency at (source, kind, external_id).
      externalId: params.agentActivityId,
      payload: {
        // Replies route to the Linear agent session — matches reply_targets[0].id.
        target_id: params.agentSessionId,
        body: params.body,
        // Linear comment isn't PR-scoped — lives on the agent session.
        pr: null,
        // Linear-sourced → the daemon never injects PR discussion (gated on
        // source == "github"), so there is no comment timestamp to scope by.
        created_at: "",
      },
      targets: [{ id: params.agentSessionId, spec: { kind: "linear_session" } }],
    });
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
}
