import { config } from "../config";
import type { Task } from "../db/schema";
import { deliverToRound } from "../integrations/http";
import { WORKSPACE_MISSING_MESSAGE } from "../integrations/outbound";
import type { Integration } from "../integrations/types";
import { logger } from "../logger";
import type { InboxRepository, InboxRow } from "../repositories/inbox.repository";
import type { InboxMessage } from "../types/inboxMessage";
import type { IntegrationHooks } from "./integrationHooks";
import type { SandboxManager } from "./sandboxManager.service";

// InboxService owns the sweep that delivers pending rows to the sandbox
// (recreating it from the preserved PVC when it has been reaped), and the
// PVC-missing per-row dead-letter. Integrations build their own rounds and
// queue them through their TaskService.
export class InboxService {
  constructor(
    private inboxRepo: InboxRepository,
    private sandboxManager: SandboxManager,
    private integrations: Readonly<Record<string, Integration>>,
    private hooks: IntegrationHooks,
  ) {}

  // ──── Sweep ────

  // Delivers the task's pending inbox rows to its LIVE sandbox, then marks each
  // delivered. The caller guarantees a live sandbox: reconcileOne verifies its
  // liveness this tick, and runTask's recreate-from-PVC path recreates + persists
  // the sandbox before calling here. Delivered rows need nothing (their files are
  // already on the sandbox / PVC).
  //
  // A writeFile failure propagates and aborts the current reconcile tick; the
  // row stays 'pending' and is re-swept next tick (at-least-once delivery).
  async sweepUndelivered(task: Task): Promise<void> {
    const pending = await this.inboxRepo.listPendingByTask(task.id);
    if (pending.length === 0) return;

    const sandboxId = task.sandboxId;
    if (!sandboxId) {
      // Caller contract violation — sweep only delivers to an attached sandbox.
      throw new Error(`sweepUndelivered: task ${task.id} has no sandbox to deliver to`);
    }

    for (const entry of pending) {
      // Re-check row status from DB to avoid acting on a stale pending snapshot
      // when reassignment has already failed/superseded the row.
      const latestEntry = await this.inboxRepo.getById(entry.id);
      if (!latestEntry || latestEntry.status !== "pending") continue;

      try {
        await this.sandboxManager.writeHarnessFile(
          sandboxId,
          `inbox/${entry.id}.json`,
          JSON.stringify(toInboxMessage(entry)),
        );
        await this.inboxRepo.markDelivered({ inboxId: entry.id, ownerId: config.podId });
      } catch (err) {
        logDebugErr(`sweepUndelivered: writeHarnessFile failed for inbox ${entry.id}`, err);
        throw err;
      }
    }
  }

  // A task whose PVC no longer exists cannot be resumed. Dead-letters every
  // still-open ('pending'/'delivered') row of the task (mark failed + per-row
  // user notice) so it stops pinning the reaper. Called by runTask's recreate-from-PVC
  // path when createSandboxFromExistingPvc reports the PVC gone.
  // Re-checks each row's status from DB so a row a reassignment superseded mid-tick
  // is left untouched.
  async deadLetterWorkspaceMissing(task: Task): Promise<void> {
    const rows = await this.inboxRepo.listNonTerminalByTask(task.id);
    for (const row of rows) {
      const latest = await this.inboxRepo.getById(row.id);
      if (!latest || (latest.status !== "pending" && latest.status !== "delivered")) continue;
      await this.handlePvcMissing(task, latest);
    }
  }

  // PVC-missing per-row dead-letter. Marks the row failed first, so the sweep
  // skips it, then hands a workspace_missing failure to the round's integration
  // only if this call transitioned the row (a racing restart or a late
  // `completed` gets no contradictory notice). One notice per row, no target-id
  // dedupe (unlike failTask); reply_targets[0] is the round's thread, and the
  // integration words the notice by round kind. At most once: there is no
  // cursor to hold, so a delivery error (RetryableError included) is logged and
  // dropped, and the task's remaining rows still dead-letter. A dead-lettered
  // assignment also finishes its round as failed (onRoundFinished, detached).
  private async handlePvcMissing(task: Task, entry: InboxRow): Promise<void> {
    const marked = await this.inboxRepo
      .markFailed({
        inboxId: entry.id,
        ownerId: config.podId,
        reason: "workspace_missing",
        userMessage: WORKSPACE_MISSING_MESSAGE,
      })
      .catch((err) => {
        logErr(`markFailed failed for inbox ${entry.id}`, err);
        return [];
      });
    if (marked.length === 0) return;
    if (entry.kind === "assignment") this.hooks.roundFinished(task, entry, "failed", true);
    const target = entry.reply_targets[0];
    if (!target) return;
    // A row whose integration is unknown or disabled gets no notice; it is
    // still failed. No cursor to hold, so a RetryableError is dropped too.
    await deliverToRound(
      this.integrations,
      entry,
      target,
      { type: "failure", cause: "workspace_missing", round: entry },
      { taskId: task.id },
    ).catch((err) => logErr(`workspace_missing notice for inbox ${entry.id} dropped`, err));
  }
}

function logErr(msg: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(msg, { message: e.message, stack: e.stack });
}

function logDebugErr(msg: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.debug(msg, { message: e.message, stack: e.stack });
}

// Strip CP-internal persistence metadata from a row, keeping only the wire
// contract fields the daemon expects to read from `inbox/<id>.json`.
function toInboxMessage(row: InboxRow): InboxMessage {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    external_id: row.external_id,
    payload: row.payload,
  } as InboxMessage;
}
