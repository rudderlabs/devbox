import type { RetryableError } from "../integrations/outbound";
import type { IntegrationName } from "../integrations/types";
import { logger } from "../logger";
import type { HarnessEvent } from "../types/harnessEvent";

const WARN_EVERY_MS = 10 * 60 * 1000;

type Hold = {
  inboxId: string;
  seq: number;
  integration: IntegrationName;
  since: number;
  nextAttemptAt: number;
  warnedAt: number;
};

// Events whose send failed before anything went out. A held task
// stops at that event, so it holds at most one: keyed by task, the hold is
// (taskId, inboxId, seq) and a different event starts a new one. In memory and
// with no time limit: the reconcile loop drops a hold when the cursor moves
// past its event or the task leaves this pod.
export class ReplyHolds {
  private readonly byTask = new Map<string, Hold>();

  // Records (or renews) a hold. The next attempt honours Retry-After, else it
  // is the next tick. Warns `reply_held` at most every 10 min per task.
  hold(
    taskId: string,
    event: Pick<HarnessEvent, "inbox_id" | "seq">,
    integration: IntegrationName,
    err: RetryableError,
  ): void {
    const now = Date.now();
    const { inbox_id: inboxId, seq } = event;
    const prev = this.byTask.get(taskId);
    const h =
      prev?.inboxId === inboxId && prev.seq === seq
        ? prev
        : { inboxId, seq, integration, since: now, nextAttemptAt: now, warnedAt: -1 };
    h.nextAttemptAt = now + (err.retryAfterMs ?? 0);
    if (h.warnedAt < 0 || now - h.warnedAt >= WARN_EVERY_MS) {
      h.warnedAt = now;
      logger.warn("reply held: its send failed before anything was sent; retrying", {
        event: "reply_held",
        taskId,
        integration,
        heldForMin: Math.floor((now - h.since) / 60_000),
        reason: err.message,
      });
    }
    this.byTask.set(taskId, h);
  }

  // True while the task's held event waits out its Retry-After.
  waiting(taskId: string): boolean {
    const h = this.byTask.get(taskId);
    return h !== undefined && Date.now() < h.nextAttemptAt;
  }

  release(taskId: string): void {
    this.byTask.delete(taskId);
  }

  // Drops the holds of tasks this pod no longer owns.
  retain(ownedIds: Set<string>): void {
    for (const id of this.byTask.keys()) if (!ownedIds.has(id)) this.byTask.delete(id);
  }

  // One integration's held tasks and oldest hold age, for its status body.
  of(integration: IntegrationName): { heldTasks: number; oldestHoldAgeMs: number } {
    const now = Date.now();
    const out = { heldTasks: 0, oldestHoldAgeMs: 0 };
    for (const h of this.byTask.values()) {
      if (h.integration !== integration) continue;
      out.heldTasks += 1;
      out.oldestHoldAgeMs = Math.max(out.oldestHoldAgeMs, now - h.since);
    }
    return out;
  }
}
