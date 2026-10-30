import { sql } from "drizzle-orm";
import { db } from "../db";
import type { Task } from "../db/schema";
import { logger } from "../logger";
import type {
  AssignmentPayload,
  InboxKind,
  InboxMessage,
  InboxSource,
  TaskIdentity,
} from "../types/inboxMessage";
import { insertCpEventIfApi, type SqlExecutor, type Tx } from "./taskEvent.repository";

// Re-export contract types so existing repo-import sites stay valid without
// reaching into types/ directly.
export type {
  AssignmentPayload,
  CiResultPayload,
  CommentPayload,
  InboxKind,
  InboxMessage,
  InboxSource,
  PrScope,
  ReviewPayload,
  ReviewPrScope,
  TaskIdentity,
} from "../types/inboxMessage";

// ──── Reply-target types — CP-internal routing, NOT part of the wire ────
// ──── contract. Daemon never sees these.                            ────

// Per-target routing spec — discriminated by `kind` at the target level
// (distinct from the inbox row's `kind`). Linear emits route to the agent
// session, not to individual activities — `linear_session` covers both
// assignment-run progress + completion and comment-reply posts. The session id
// itself lives in the enclosing ReplyTarget.id; the assignment row's entry is
// the canonical store, refreshed on re-delegation.
export type ReplyTargetSpec =
  | {
      kind: "issue_comment";
      owner: string;
      repo: string;
      prNumber: number;
      commentId: number;
      quotedUser?: string;
      quotedBody?: string;
    }
  | {
      kind: "review_comment";
      owner: string;
      repo: string;
      prNumber: number;
      commentId: number;
      inReplyTo: number;
      path: string;
      line: number;
      startLine?: number;
    }
  | { kind: "review_body"; owner: string; repo: string; prNumber: number; reviewId: number }
  | { kind: "linear_session" }
  // API tasks: replies are delivered nowhere — the task_events log is the channel.
  | { kind: "api_session" };

export type ReplyTarget = {
  // Mirrors the corresponding payload.*.target_id so a targeted agent_response
  // event from the daemon routes to the right thread.
  id: string;
  spec: ReplyTargetSpec;
  // An assignment's delegation order, when the platform has one: a delegation
  // whose order is not above the stored one is a duplicate (TaskIntake.assign).
  order?: number;
};

// A row to insert: the wire message without its id, per (source, kind) arm so
// source, kind and payload stay paired.
type WithoutId<M> = M extends InboxMessage ? Omit<M, "id"> : never;
export type NewInboxMessage = WithoutId<InboxMessage>;

// A Postgres unique violation (23505) on `constraint`. drizzle wraps the
// driver's error in `cause`.
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = (err as { cause?: unknown })?.cause ?? err;
  const pg = e as { errno?: unknown; constraint?: unknown };
  return pg.errno === "23505" && pg.constraint === constraint;
}

// Assignment content as callers build it. The identity fields are stamped by
// the repository from the tasks row (see TaskRepository).
export type AssignmentContent = Omit<AssignmentPayload, keyof TaskIdentity>;

export function taskIdentity(task: Pick<Task, "id" | "key">): TaskIdentity {
  return { task_id: task.id, task_key: task.key };
}

export function apiSessionTarget(taskId: string): ReplyTarget {
  return { id: taskId, spec: { kind: "api_session" } };
}

// Row lifecycle. pending → delivered → responded; failed is the CP-side
// delivery dead-letter (terminal branch off pending). responded + failed are
// terminal — the reaper frees the sandbox once no row is pending/delivered.
export type InboxStatus = "pending" | "delivered" | "responded" | "failed";

// Persisted row = the wire contract (InboxMessage) plus CP-internal metadata:
// task ownership, reply routing, delivery state, timestamps. The `& InboxMessage`
// intersection preserves the (source, kind) tagged union so `row.kind ===
// "assignment"` still narrows `row.payload` to `AssignmentPayload`.
export type InboxRow = InboxMessage & {
  task_id: string;
  reply_targets: ReplyTarget[];
  status: InboxStatus;
  failure_reason: string | null;
  outcome: string | null;
  created_at: Date;
  updated_at: Date;
};

// Raw row shape returned from db.execute (snake_case, untyped jsonb).
type RawInboxRow = {
  id: string;
  task_id: string;
  external_id: string;
  source: string;
  kind: string;
  payload: unknown;
  reply_targets: unknown;
  status: string;
  failure_reason: string | null;
  outcome: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapRow(raw: RawInboxRow): InboxRow {
  return {
    id: raw.id,
    task_id: raw.task_id,
    source: raw.source as InboxSource,
    external_id: raw.external_id,
    kind: raw.kind as InboxKind,
    payload: raw.payload,
    reply_targets: (Array.isArray(raw.reply_targets) ? raw.reply_targets : []) as ReplyTarget[],
    status: raw.status as InboxStatus,
    failure_reason: raw.failure_reason,
    outcome: raw.outcome,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  } as unknown as InboxRow;
}

function asRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

export class InboxRepository {
  // INSERT (synthetic uuid PK auto-generated). Idempotent on
  // (source, kind, external_id) via the unique index. Returns the synthetic id
  // on insert, null on conflict. Given a transaction, it inserts in a
  // savepoint, so a unique violation leaves that transaction usable.
  async appendInbox(
    params: {
      taskId: string;
      message: NewInboxMessage;
      replyTargets: ReplyTarget[];
    },
    tx?: Tx,
  ): Promise<{ id: string } | null> {
    const { source, kind, external_id, payload } = params.message;
    // bun-sql JSON-encodes a JS string param, so `${jsonStr}::jsonb` would
    // store a JSON *string scalar*, not the array/object. Casting via
    // `::text::jsonb` forces PG to parse the raw text into proper jsonb.
    const payloadJson = JSON.stringify(payload);
    const replyTargetsJson = JSON.stringify(params.replyTargets ?? []);
    const insert = (ex: SqlExecutor) =>
      ex.execute<{ id: string }>(sql`
        INSERT INTO inbox (task_id, source, kind, external_id, payload, reply_targets)
             VALUES (${params.taskId}, ${source}, ${kind}, ${external_id},
                     ${payloadJson}::text::jsonb, ${replyTargetsJson}::text::jsonb)
        ON CONFLICT (source, kind, external_id) DO NOTHING
        RETURNING id;
      `);
    try {
      const result = await (tx ? tx.transaction(insert) : insert(db));
      return asRows<{ id: string }>(result)[0] ?? null;
    } catch (err) {
      // Until phase 3 drops it, the old (source, external_id) index also
      // rejects a row whose id another kind of the same source already uses,
      // with a 23505 instead of DO NOTHING. Dedupe it as before; phase 3
      // removes this with the index.
      if (isUniqueViolation(err, "inbox_source_external_uniq")) return null;
      throw err;
    }
  }

  // TaskIntake.followUp's transaction. Locks the task row first: tasks before
  // inbox, and task_events ids handed out in commit order per task. Drops the
  // round when `prUrl` is no longer one of the task's PRs (a restart cleared
  // it) or when the CI loop breaker trips, and as a duplicate when the round is
  // already stored. message_queued is written for an inserted API message.
  async appendFollowUp(p: {
    taskId: string;
    message: NewInboxMessage;
    replyTargets: ReplyTarget[];
    prUrl?: string;
    ciResultMax: number;
  }): Promise<{ roundId: string } | { dropped: "duplicate" | "stale" | "ci_limit" }> {
    const { message } = p;
    const hasPr =
      p.prUrl === undefined
        ? sql`true`
        : sql`pr_urls @> jsonb_build_array(jsonb_build_object('url', ${p.prUrl}::text))`;
    return db.transaction(async (tx) => {
      const [task] = asRows<{ has_pr: boolean }>(
        await tx.execute(
          sql`SELECT ${hasPr} AS has_pr FROM tasks WHERE id = ${p.taskId} FOR NO KEY UPDATE`,
        ),
      );
      if (!task) throw new Error(`appendFollowUp: task ${p.taskId} not found`);
      if (!task.has_pr) {
        logger.info("follow-up dropped: the PR is no longer on the task", {
          taskId: p.taskId,
          prUrl: p.prUrl,
        });
        return { dropped: "stale" };
      }

      // Loop breaker. harness fixes CI → pushes → CI re-runs → may fail again,
      // ad infinitum. Once a task has accumulated `ciResultMax` ci_result rows,
      // stop forwarding new failures. Every row counts regardless of status: a
      // 'failed' or 'responded' row is still a CI failure the harness saw. The
      // count runs under the task lock, so concurrent webhooks can't overshoot.
      // 0 / negative disables the breaker.
      if (message.kind === "ci_result" && p.ciResultMax > 0) {
        const [count] = asRows<{ n: number }>(
          await tx.execute(sql`
            SELECT COUNT(*)::int AS n FROM inbox
             WHERE task_id = ${p.taskId} AND source = 'github' AND kind = 'ci_result';
          `),
        );
        const seen = count?.n ?? 0;
        if (seen >= p.ciResultMax) {
          // external_id is workflow_run:<run>:<attempt>:<pr>.
          const [, runId, , prNumber] = message.external_id.split(":").map(Number);
          logger.warn("ci_result loop breaker tripped — dropping CI failure", {
            taskId: p.taskId,
            seen,
            max: p.ciResultMax,
            runId,
            prNumber,
          });
          return { dropped: "ci_limit" };
        }
      }

      const row = await this.appendInbox(
        { taskId: p.taskId, message, replyTargets: p.replyTargets },
        tx,
      );
      if (!row) return { dropped: "duplicate" };
      if (message.source === "api" && message.kind === "comment") {
        await insertCpEventIfApi(tx, {
          taskId: p.taskId,
          type: "message_queued",
          inboxId: row.id,
          data: { body: message.payload.body },
        });
      }
      return { roundId: row.id };
    });
  }

  // Rows still awaiting delivery to the sandbox (status = 'pending').
  async listPendingByTask(taskId: string): Promise<InboxRow[]> {
    const result = await db.execute<RawInboxRow>(sql`
      SELECT * FROM inbox
       WHERE task_id = ${taskId} AND status = 'pending'
       ORDER BY created_at ASC;
    `);
    return asRows<RawInboxRow>(result).map(mapRow);
  }

  // Every non-terminal row of a task (pending or delivered).
  async listNonTerminalByTask(taskId: string): Promise<InboxRow[]> {
    const result = await db.execute<RawInboxRow>(sql`
      SELECT * FROM inbox
       WHERE task_id = ${taskId} AND status IN ('pending', 'delivered')
       ORDER BY created_at ASC;
    `);
    return asRows<RawInboxRow>(result).map(mapRow);
  }

  async getById(id: string): Promise<InboxRow | null> {
    const result = await db.execute<RawInboxRow>(sql`
      SELECT * FROM inbox WHERE id = ${id} LIMIT 1;
    `);
    const row = asRows<RawInboxRow>(result)[0];
    return row ? mapRow(row) : null;
  }

  // Task-scoped lookup. The dispatcher resolves event.inbox_id (a value
  // written by the sandbox) — a plain getById would happily return a row
  // belonging to a different task (confused-deputy). Filtering on task_id
  // makes a cross-task inbox_id resolve to null instead.
  async getByIdForTask(id: string, taskId: string): Promise<InboxRow | null> {
    const result = await db.execute<RawInboxRow>(sql`
      SELECT * FROM inbox WHERE id = ${id} AND task_id = ${taskId} LIMIT 1;
    `);
    const row = asRows<RawInboxRow>(result)[0];
    return row ? mapRow(row) : null;
  }

  // The task's assignment row. A restart re-pends it under a new id, which is
  // how hooks tell whether their run is still the current one.
  async getAssignment(taskId: string): Promise<InboxRow | null> {
    const result = await db.execute<RawInboxRow>(sql`
      SELECT * FROM inbox WHERE task_id = ${taskId} AND kind = 'assignment' LIMIT 1;
    `);
    const row = asRows<RawInboxRow>(result)[0];
    return row ? mapRow(row) : null;
  }

  // pending → delivered. Owner-guarded (a stale-lease pod must not advance a
  // row it no longer owns) and status-guarded (a re-sweep can't regress a row
  // already past 'pending').
  async markDelivered(params: { inboxId: string; ownerId: string }): Promise<void> {
    await db.execute(sql`
      UPDATE inbox i
         SET status = 'delivered', updated_at = now()
        FROM tasks t
       WHERE i.id = ${params.inboxId}
         AND i.task_id = t.id
         AND t.owner_id = ${params.ownerId}
         AND i.status = 'pending';
    `);
  }

  // Dead-letters every non-terminal inbox row of a task (status 'pending' or
  // 'delivered' → 'failed' + reason) in one statement. Owner-guarded. Both
  // task-failure paths (provision failure, sandbox crash/timeout) call this so
  // a failed task cannot leave a row stuck pre-terminal — a non-terminal row
  // pins the idle reaper, and on a no-sandbox provision failure a 'pending'
  // row would otherwise stay claimable forever. Returns the rows it failed, in
  // arrival order: the caller logs them and sends the failure message only to
  // those rows.
  async failTaskInbox(params: {
    taskId: string;
    ownerId: string;
    reason: string;
  }): Promise<InboxRow[]> {
    return db.transaction(async (tx) => {
      // Lock the task row first so task_events ids are handed out in commit
      // order per task for stable event cursors. Tasks before inbox,
      // the same order as restartTaskWithInbox.
      await tx.execute(sql`SELECT 1 FROM tasks WHERE id = ${params.taskId} FOR NO KEY UPDATE`);
      const result = await tx.execute<RawInboxRow>(sql`
        WITH failed AS (
          UPDATE inbox i
             SET status = 'failed', failure_reason = ${params.reason}, updated_at = now()
            FROM tasks t
           WHERE i.task_id = ${params.taskId}
             AND i.task_id = t.id
             AND t.owner_id = ${params.ownerId}
             AND i.status IN ('pending', 'delivered')
          RETURNING i.*
        )
        SELECT * FROM failed ORDER BY created_at ASC;
      `);
      const failed = asRows<RawInboxRow>(result).map(mapRow);
      // Write one round_failed event per failed row in the same transaction.
      for (const row of failed) {
        await insertCpEventIfApi(tx, {
          taskId: params.taskId,
          type: "round_failed",
          inboxId: row.id,
          data: { reason: params.reason },
        });
      }
      return failed;
    });
  }

  // Per-row CP-side delivery dead-letter (status → 'failed' + failure_reason).
  // Owner-guarded. `failTaskInbox` is task-scoped (fails every open row);
  // `markFailed` is the per-row variant so a PVC-missing comment row fails on
  // its own while siblings hit the path independently. A 'failed' row is
  // terminal and does not pin the idle reaper.
  async markFailed(params: {
    inboxId: string;
    ownerId: string;
    reason: string;
    // The text the user sees; becomes round_failed.data.reason.
    userMessage: string;
  }): Promise<{ id: string }[]> {
    return db.transaction(async (tx) => {
      // Lock the row's task first so task_events ids are handed out in commit
      // order per task for stable event cursors. Tasks before inbox,
      // the same order as restartTaskWithInbox.
      await tx.execute(sql`
        SELECT t.id FROM inbox i JOIN tasks t ON t.id = i.task_id
         WHERE i.id = ${params.inboxId}
           FOR NO KEY UPDATE OF t`);
      const result = await tx.execute<{ id: string; task_id: string }>(sql`
        UPDATE inbox i
           SET status = 'failed', failure_reason = ${params.reason}, updated_at = now()
          FROM tasks t
         WHERE i.id = ${params.inboxId}
           AND i.task_id = t.id
           AND t.owner_id = ${params.ownerId}
           AND i.status NOT IN ('responded', 'failed')
        RETURNING i.id, i.task_id;
      `);
      const rows = asRows<{ id: string; task_id: string }>(result);
      for (const row of rows) {
        await insertCpEventIfApi(tx, {
          taskId: row.task_id,
          type: "round_failed",
          inboxId: row.id,
          data: { reason: params.userMessage },
        });
      }
      return rows.map((r) => ({ id: r.id }));
    });
  }

  // Marks the row's round done (status → 'responded') so the reaper guard
  // clears. Owner-guarded — a stale-lease pod fails the join and gets 0 rows.
  // Terminal rows (responded/failed) also return 0; a failed row must not
  // regress to responded.
  async markResponded(params: {
    inboxId: string;
    ownerId: string;
    outcome: string | null;
  }): Promise<{ id: string }[]> {
    const result = await db.execute<{ id: string }>(sql`
      UPDATE inbox i
         SET status = 'responded', outcome = ${params.outcome}, updated_at = now()
        FROM tasks t
       WHERE i.id = ${params.inboxId}
         AND i.task_id = t.id
         AND t.owner_id = ${params.ownerId}
         AND i.status IN ('pending', 'delivered')
      RETURNING i.id;
    `);
    return asRows<{ id: string }>(result);
  }
}

export const inboxRepository = new InboxRepository();
