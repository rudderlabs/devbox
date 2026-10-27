import { sql } from "drizzle-orm";
import { db } from "../db";
import type { Task } from "../db/schema";
import type {
  AssignmentPayload,
  InboxKind,
  InboxMessage,
  InboxSource,
  TaskIdentity,
} from "../types/inboxMessage";
import { insertCpEventIfApi } from "./taskEvent.repository";

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
};

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
  // (source, external_id) via the unique index. Returns the synthetic id on
  // insert, null on conflict.
  //
  // `message` is the wire contract sans `id` — the tagged union forbids
  // invalid (source, kind) combos at the type level.
  async appendInbox(params: {
    taskId: string;
    message: Omit<InboxMessage, "id">;
    replyTargets: ReplyTarget[];
  }): Promise<{ id: string } | null> {
    const { source, kind, external_id, payload } = params.message;
    // bun-sql JSON-encodes a JS string param, so `${jsonStr}::jsonb` would
    // store a JSON *string scalar*, not the array/object. Casting via
    // `::text::jsonb` forces PG to parse the raw text into proper jsonb.
    const payloadJson = JSON.stringify(payload);
    const replyTargetsJson = JSON.stringify(params.replyTargets ?? []);
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO inbox (task_id, source, kind, external_id, payload, reply_targets)
           VALUES (${params.taskId}, ${source}, ${kind}, ${external_id},
                   ${payloadJson}::text::jsonb, ${replyTargetsJson}::text::jsonb)
      ON CONFLICT (source, external_id) DO NOTHING
      RETURNING id;
    `);
    return asRows<{ id: string }>(result)[0] ?? null;
  }

  // Count of ci_result rows already forwarded for a task — the loop breaker's
  // denominator. Counts every ci_result row regardless of status: a 'failed'
  // or 'responded' row still represents a CI failure harness already saw, so
  // it must count toward the runaway threshold. Enqueue is idempotent on
  // (source, external_id) = workflow_run:run:attempt:pr, so a redelivered
  // webhook does not inflate this count.
  async countCiResultsByTask(taskId: string): Promise<number> {
    const result = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM inbox
       WHERE task_id = ${taskId} AND source = 'github' AND kind = 'ci_result';
    `);
    return asRows<{ n: number }>(result)[0]?.n ?? 0;
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

  // Every non-terminal row of a task (pending or delivered). failTask walks
  // these to broadcast the failure message to each reply target before
  // dead-lettering.
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

  // Reply target id for task-scoped CP-originated emits (provisioning
  // lifecycle). Reads the first entry of the assignment row's reply_targets —
  // the canonical store, written on `created` and overwritten on
  // re-delegation. An assignment row carries exactly one reply target by
  // construction. Returns null when the assignment row is missing or its
  // reply_targets is empty.
  async getAssignmentReplyTargetId(taskId: string): Promise<string | null> {
    const result = await db.execute<{ target_id: string | null }>(sql`
      SELECT reply_targets->0->>'id' AS target_id
        FROM inbox
       WHERE task_id = ${taskId} AND kind = 'assignment'
       LIMIT 1;
    `);
    const row = Array.isArray(result)
      ? (result[0] as { target_id: string | null } | undefined)
      : undefined;
    return row?.target_id ?? null;
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
  // row would otherwise stay claimable forever. Returns the affected row ids
  // for the caller to log.
  async failTaskInbox(params: {
    taskId: string;
    ownerId: string;
    reason: string;
  }): Promise<{ id: string }[]> {
    return db.transaction(async (tx) => {
      // Lock the task row first so task_events ids are handed out in commit
      // order per task for stable event cursors. Tasks before inbox,
      // the same order as restartTaskWithInbox.
      await tx.execute(sql`SELECT 1 FROM tasks WHERE id = ${params.taskId} FOR NO KEY UPDATE`);
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE inbox i
           SET status = 'failed', failure_reason = ${params.reason}, updated_at = now()
          FROM tasks t
         WHERE i.task_id = ${params.taskId}
           AND i.task_id = t.id
           AND t.owner_id = ${params.ownerId}
           AND i.status IN ('pending', 'delivered')
        RETURNING i.id;
      `);
      const failed = asRows<{ id: string }>(result);
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
