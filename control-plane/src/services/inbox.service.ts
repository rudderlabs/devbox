import { config } from "../config";
import type { Task } from "../db/schema";
import { deliverToRound } from "../integrations/http";
import type { TaskIntake } from "../integrations/intake";
import type { Integration, IntegrationName } from "../integrations/types";
import { logger } from "../logger";
import type {
  InboxRepository,
  InboxRow,
  ReplyTarget,
  ReplyTargetSpec,
} from "../repositories/inbox.repository";
import type { InboxMessage } from "../types/inboxMessage";
import type { IntegrationHooks } from "./integrationHooks";
import type { SandboxManager } from "./sandboxManager.service";

// InboxService builds the GitHub and Linear follow-up rounds (comment, review,
// CI result, Linear comment) and queues them through TaskIntake.followUp; it
// owns the sweep that delivers pending rows to the sandbox (recreating it from
// the preserved PVC when it has been reaped), and the PVC-missing per-row
// dead-letter.
export const WORKSPACE_MISSING_MESSAGE =
  "The workspace for this task has been cleaned up and can no longer be resumed. " +
  "Please reach out to the harness team or open a new ticket to continue.";

export class InboxService {
  constructor(
    private inboxRepo: InboxRepository,
    private sandboxManager: SandboxManager,
    private integrations: Record<IntegrationName, Integration>,
    private hooks: IntegrationHooks,
    private intake: Pick<TaskIntake, "followUp">,
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
    const prUrl = `https://github.com/${params.spec.owner}/${params.spec.repo}/pull/${params.spec.prNumber}`;
    await this.intake.followUp({
      task: params.task,
      message: {
        source: "github",
        kind: "comment",
        external_id: externalId,
        payload: {
          target_id: externalId, // matches reply_targets[0].id
          body: params.body,
          pr: { repo: params.spec.repo, pr_url: prUrl },
          created_at: params.createdAt,
        },
      },
      targets: [{ id: externalId, spec: params.spec }],
      prUrl,
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
    const prUrl = `https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}`;

    const payload = {
      review_body: { target_id: reviewIdStr, body: params.reviewBody },
      inline_comments: params.inlineComments.map((c) => ({
        target_id: String(c.id),
        path: c.path,
        line: c.line,
        start_line: c.startLine,
        body: c.body,
      })),
      pr: { owner: params.owner, repo: params.repo, prNumber: params.prNumber, pr_url: prUrl },
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

    await this.intake.followUp({
      task: params.task,
      message: { source: "github", kind: "review", external_id: reviewIdStr, payload },
      targets: replyTargets,
      prUrl,
    });
  }

  // Linear `prompted` — a follow-up comment on the agent session. Same inbox
  // path as a GitHub comment; the single reply target routes to the Linear
  // session. Idempotent on the Linear activity UUID — a duplicate redelivery
  // is dropped.
  async enqueueLinearComment(params: {
    task: Pick<Task, "id" | "key">;
    agentActivityId: string;
    agentSessionId: string;
    body: string;
  }): Promise<void> {
    await this.intake.followUp({
      task: params.task,
      message: {
        source: "linear",
        kind: "comment",
        // Linear activity UUID — drives idempotency at (source, kind, external_id).
        external_id: params.agentActivityId,
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
      },
      targets: [{ id: params.agentSessionId, spec: { kind: "linear_session" } }],
    });
  }

  // GitHub `workflow_run` completed — one row per task whose PR URL matches.
  // external_id includes runAttempt (re-runs share runId but bump attempt) and
  // prNumber (one run can touch multiple PRs). followUp applies the per-task
  // loop breaker.
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
    const runIdStr = String(params.runId);
    const externalId = `workflow_run:${params.runId}:${params.runAttempt}:${params.prNumber}`;
    const prUrl = `https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}`;
    await this.intake.followUp({
      task: params.task,
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
          pr: { repo: params.repo, pr_url: prUrl },
        },
      },
      targets: [
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
      prUrl,
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
