import { sql } from "drizzle-orm";
import { db } from "../db";
import type { HarnessEvent } from "../types/harnessEvent";

// The progress log for API tasks. Every write goes through the two helpers
// below, called inside the transaction of the action that causes the event.
// Both are no-ops for non-API tasks; Linear tasks do not use this event log.

export type SqlExecutor = Pick<typeof db, "execute">;
// A transaction handle, for writes that also run inside a caller's transaction.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CpEventType =
  | "task_created"
  | "message_queued"
  | "task_restarted"
  | "sandbox_started"
  | "round_failed";

export type TaskEventRow = {
  id: number;
  task_id: string;
  origin: "daemon" | "control_plane";
  type: string;
  inbox_id: string | null;
  seq: number | null;
  data: unknown;
  created_at: Date;
};

type RawTaskEventRow = Omit<TaskEventRow, "id" | "seq"> & {
  id: number | string;
  seq: number | string | null;
};

function asRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

// Inserts a control_plane event iff the task is an API task. The source check
// is in SQL, so callers never branch on source themselves.
// The caller's transaction must already hold the tasks row lock (UPDATE tasks or
// FOR NO KEY UPDATE), so ids are assigned in commit order per task. The lock is
// not taken here: that would invert the tasks-then-inbox lock order.
export async function insertCpEventIfApi(
  ex: SqlExecutor,
  p: { taskId: string; type: CpEventType; inboxId: string | null; data: unknown },
): Promise<void> {
  // ::text::jsonb — bun-sql JSON-encodes string params (see TaskRepository).
  await ex.execute(sql`
    INSERT INTO task_events (task_id, origin, type, inbox_id, data)
    SELECT t.id, 'control_plane', ${p.type}, ${p.inboxId}, ${JSON.stringify(p.data)}::text::jsonb
      FROM tasks t
     WHERE t.id = ${p.taskId} AND t.source = 'api';
  `);
}

// Stores a daemon event as received. The caller (recordEventCursor) has
// already checked that the task is an API task and the cursor advanced.
export async function insertDaemonEvent(
  ex: SqlExecutor,
  p: { taskId: string; event: HarnessEvent },
): Promise<void> {
  await ex.execute(sql`
    INSERT INTO task_events (task_id, origin, type, inbox_id, seq, data)
         VALUES (${p.taskId}, 'daemon', ${p.event.type}, ${p.event.inbox_id ?? null},
                 ${p.event.seq}, ${JSON.stringify(p.event)}::text::jsonb);
  `);
}

export class TaskEventRepository {
  // One page of the log after the cursor. Served by the (task_id, id) index.
  async listAfter(taskId: string, after: number, limit: number): Promise<TaskEventRow[]> {
    const rows = await db.execute<RawTaskEventRow>(sql`
      SELECT id, task_id, origin, type, inbox_id, seq, data, created_at
        FROM task_events
       WHERE task_id = ${taskId} AND id > ${after}
       ORDER BY id ASC
       LIMIT ${limit};
    `);
    return asRows<RawTaskEventRow>(rows).map((r) => ({
      ...r,
      id: Number(r.id),
      seq: r.seq === null ? null : Number(r.seq),
    }));
  }
}

export const taskEventRepository = new TaskEventRepository();
