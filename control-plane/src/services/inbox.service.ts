import { config } from "../config";
import type { Task } from "../db/schema";
import type { Integration, IntegrationName } from "../integrations/types";
import { logger } from "../logger";
import type {
  InboxRepository,
  InboxRow,
  ReplyTarget,
  ReplyTargetSpec,
  ReviewPayload,
} from "../repositories/inbox.repository";
import { taskIdentity } from "../repositories/inbox.repository";
import type { InboxMessage } from "../types/inboxMessage";
import type { SandboxManager } from "./sandboxManager.service";

// InboxService owns inbox enqueue (comment/review/Linear-comment), the sweep
// that delivers pending rows to the sandbox (recreating it from the preserved
// PVC when it has been reaped), and the PVC-missing per-row dead-letter.
export const WORKSPACE_MISSING_MESSAGE =
  "The workspace for this task has been cleaned up and can no longer be resumed. " +
  "Please reach out to the harness team or open a new ticket to continue.";

export class InboxService {
  constructor(
    private inboxRepo: InboxRepository,
    private sandboxManager: SandboxManager,
    private integrations: Record<IntegrationName, Integration>,
  ) {}

  // ──── Enqueue paths ────

  // GitHub @harness comment (solo issue_comment or standalone review_comment).
  async enqueueComment(params: {
    task: Pick<Task, "id" | "key">;
    commentId: number;
    body: string;
    spec: Extract<ReplyTargetSpec, { kind: "issue_comment" | "review_comment" }>;
    // ISO-8601 creation time of the comment; "" when unknown.
    createdAt: string;
  }): Promise<void> {
    const externalId = String(params.commentId);
    await this.inboxRepo.appendInbox({
      taskId: params.task.id,
      message: {
        source: "github",
        kind: "comment",
        external_id: externalId,
        payload: {
          target_id: externalId, // matches reply_targets[0].id
          body: params.body,
          ...taskIdentity(params.task),
          pr: {
            repo: params.spec.repo,
            pr_url: `https://github.com/${params.spec.owner}/${params.spec.repo}/pull/${params.spec.prNumber}`,
          },
          created_at: params.createdAt,
        },
      },
      replyTargets: [{ id: externalId, spec: params.spec }],
    });
  }

  // GitHub submitted review — the review body + every inline comment batched
  // into ONE inbox row with N+1 reply targets.
  async enqueueReview(params: {
    task: Pick<Task, "id" | "key">;
    reviewId: number;
    reviewBody: string;
    inlineComments: Array<{
      id: number;
      path: string;
      line: number;
      startLine?: number;
      body: string;
    }>;
    owner: string;
    repo: string;
    prNumber: number;
    reviewerLogin: string;
    // ISO-8601 submission time of the review; "" when unknown.
    createdAt: string;
  }): Promise<void> {
    const reviewIdStr = String(params.reviewId);

    const payload: ReviewPayload = {
      review_body: { target_id: reviewIdStr, body: params.reviewBody },
      inline_comments: params.inlineComments.map((c) => ({
        target_id: String(c.id),
        path: c.path,
        line: c.line,
        start_line: c.startLine,
        body: c.body,
      })),
      ...taskIdentity(params.task),
      pr: {
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        pr_url: `https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}`,
      },
      reviewer_login: params.reviewerLogin,
      created_at: params.createdAt,
    };

    // reply_targets carry the routing spec. target.id MUST equal the
    // corresponding payload.*.target_id so a targeted agent_response routes
    // to the right thread.
    const replyTargets: ReplyTarget[] = [
      ...params.inlineComments.map((c) => ({
        id: String(c.id),
        spec: {
          kind: "review_comment" as const,
          owner: params.owner,
          repo: params.repo,
          prNumber: params.prNumber,
          commentId: c.id,
          inReplyTo: c.id,
          path: c.path,
          line: c.line,
          startLine: c.startLine,
        },
      })),
      {
        id: reviewIdStr,
        spec: {
          kind: "review_body" as const,
          owner: params.owner,
          repo: params.repo,
          prNumber: params.prNumber,
          reviewId: params.reviewId,
        },
      },
    ];

    await this.inboxRepo.appendInbox({
      taskId: params.task.id,
      message: {
        source: "github",
        kind: "review",
        external_id: reviewIdStr,
        payload,
      },
      replyTargets,
    });
  }

  // Linear `prompted` — a follow-up comment on the agent session. Same inbox
  // path as a GitHub comment; the single reply target routes to the Linear
  // session. Idempotent on the Linear activity UUID — a duplicate redelivery
  // is a no-op insert.
  async enqueueLinearComment(params: {
    task: Pick<Task, "id" | "key">;
    agentActivityId: string;
    agentSessionId: string;
    body: string;
  }): Promise<void> {
    await this.inboxRepo.appendInbox({
      taskId: params.task.id,
      message: {
        source: "linear",
        kind: "comment",
        // Linear activity UUID — drives idempotency at (source, external_id).
        external_id: params.agentActivityId,
        payload: {
          // Replies route to the Linear agent session — matches reply_targets[0].id.
          target_id: params.agentSessionId,
          body: params.body,
          ...taskIdentity(params.task),
          // Linear comment isn't PR-scoped — lives on the agent session.
          pr: null,
          // Linear-sourced → the daemon never injects PR discussion (gated on
          // source == "github"), so there is no comment timestamp to scope by.
          created_at: "",
        },
      },
      replyTargets: [{ id: params.agentSessionId, spec: { kind: "linear_session" } }],
    });
  }

  // GitHub `workflow_run` completed — one row per task whose PR URL matches.
  // external_id includes runAttempt (re-runs share runId but bump attempt) and
  // prNumber (one run can touch multiple PRs) for the global (source, external_id)
  // unique index.
  async enqueueCiResult(params: {
    task: Pick<Task, "id" | "key">;
    runId: number;
    runAttempt: number;
    workflowName: string;
    workflowPath: string;
    conclusion: string;
    runUrl: string;
    headSha: string;
    headBranch: string;
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<void> {
    // Loop breaker. harness fixes CI → pushes → CI re-runs → may fail again,
    // ad infinitum. Once a task has accumulated `ciResultMaxPerTask` ci_result
    // rows, stop forwarding new failures to the harness. The count/insert is
    // not transactional, so concurrent webhooks for one task may overshoot by a
    // few — fine for a circuit breaker. 0 / negative disables the breaker.
    const max = config.github.ciResultMaxPerTask;
    if (max > 0) {
      const seen = await this.inboxRepo.countCiResultsByTask(params.task.id);
      if (seen >= max) {
        logger.warn("ci_result loop breaker tripped — dropping CI failure", {
          taskId: params.task.id,
          seen,
          max,
          runId: params.runId,
          prNumber: params.prNumber,
        });
        return;
      }
    }

    const runIdStr = String(params.runId);
    const externalId = `workflow_run:${params.runId}:${params.runAttempt}:${params.prNumber}`;
    await this.inboxRepo.appendInbox({
      taskId: params.task.id,
      message: {
        source: "github",
        kind: "ci_result",
        external_id: externalId,
        payload: {
          target_id: runIdStr,
          workflow_name: params.workflowName,
          workflow_path: params.workflowPath,
          conclusion: params.conclusion,
          run_url: params.runUrl,
          head_sha: params.headSha,
          head_branch: params.headBranch,
          ...taskIdentity(params.task),
          pr: {
            repo: params.repo,
            pr_url: `https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}`,
          },
        },
      },
      replyTargets: [
        {
          id: runIdStr,
          spec: {
            kind: "issue_comment",
            owner: params.owner,
            repo: params.repo,
            prNumber: params.prNumber,
            // commentId: 0 is the sentinel for "post new comment" (no existing
            // comment to reply to — the dispatcher posts a fresh PR comment).
            commentId: 0,
          },
        },
      ],
    });
  }

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
      await this.handlePvcMissing(latest);
    }
  }

  // PVC-missing per-row dead-letter. Marks the row failed first, so the sweep
  // skips it, then hands a workspace_missing failure to the round's integration
  // only if this call transitioned the row (a racing restart or a late
  // `completed` gets no contradictory notice). One notice per row, no target-id
  // dedupe (unlike failTask); reply_targets[0] is the round's thread, and the
  // integration words the notice by round kind. At most once: there is no
  // cursor to hold, so a delivery error (RetryableError included) is logged and
  // dropped, and the task's remaining rows still dead-letter.
  private async handlePvcMissing(entry: InboxRow): Promise<void> {
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
    const target = entry.reply_targets[0];
    if (marked.length === 0 || !target) return;
    await this.integrations[entry.source]
      .deliver({ signal: new AbortController().signal, log: logger }, target, {
        type: "failure",
        cause: "workspace_missing",
        round: entry,
      })
      .catch((err) => logErr(`workspace_missing notice failed for inbox ${entry.id}`, err));
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
