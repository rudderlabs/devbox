import { type SQL, sql } from "drizzle-orm";
import { db } from "../db";
import type { ApiRound, ApiTaskState } from "../types/api";
import type { AssignmentPayload, CommentPayload } from "../types/inboxMessage";
import { apiSessionTarget, taskIdentity } from "./inbox.repository";
import { insertCpEventIfApi } from "./taskEvent.repository";

// API read model and the API task write transactions.

export type ApiTaskRecord = {
  id: string;
  key: string;
  source: "linear" | "api";
  title: string;
  description: string | null;
  external_url: string;
  metadata: unknown;
  sandbox_id: string | null;
  pr_urls: unknown;
  created_by: string | null;
  creator_name: string | null;
  state: ApiTaskState;
  rounds: ApiRound[];
  created_at: Date;
  updated_at: Date;
};

export type ApiTaskListFilter = {
  source?: "linear" | "api";
  // undefined = no filter; null = matches nothing (created_by=me with auth off).
  createdBy?: string | null;
  state?: ApiTaskState;
  before?: string;
  limit: number;
};

// One task-state expression is shared by the `state` field and the ?state=
// filter. The latest round is the greatest updated_at: markResponded and
// failTaskInbox bump it on the terminal transition, while a restart keeps the
// assignment row's original created_at.
const STATE_JOINS = sql`
  LEFT JOIN LATERAL (
    SELECT true AS present FROM inbox i
     WHERE i.task_id = t.id AND i.status IN ('pending', 'delivered')
     LIMIT 1
  ) open_round ON true
  LEFT JOIN LATERAL (
    SELECT i.status, i.outcome FROM inbox i
     WHERE i.task_id = t.id
     ORDER BY i.updated_at DESC, i.id DESC
     LIMIT 1
  ) latest ON true`;

const STATE_SQL = sql`
  CASE
    WHEN open_round.present AND t.sandbox_id IS NULL THEN 'queued'
    WHEN open_round.present THEN 'running'
    WHEN latest.status = 'failed' OR latest.outcome = 'failed' THEN 'failed'
    ELSE 'idle'
  END`;

// JS toISOString() format, so rounds[].created_at matches the other timestamps.
const isoUtc = (col: SQL) =>
  sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const RESOURCE_SELECT = sql`
  SELECT t.id, t.key, t.source, t.title, t.external_url, t.metadata, t.sandbox_id, t.pr_urls,
         t.created_by, t.created_at, t.updated_at,
         tok.name AS creator_name,
         assignment.payload->>'description' AS description,
         ${STATE_SQL} AS state,
         COALESCE(rounds.items, '[]'::jsonb) AS rounds
    FROM tasks t
    LEFT JOIN api_tokens tok ON tok.id = t.created_by
    LEFT JOIN LATERAL (
      SELECT payload FROM inbox WHERE task_id = t.id AND kind = 'assignment' LIMIT 1
    ) assignment ON true
    ${STATE_JOINS}
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id, 'source', r.source, 'kind', r.kind, 'status', r.status,
               'outcome', r.outcome, 'failure_reason', r.failure_reason,
               'created_at', ${isoUtc(sql`r.created_at`)})
             ORDER BY r.created_at DESC, r.id DESC) AS items
        FROM (SELECT * FROM inbox
               WHERE task_id = t.id
               ORDER BY created_at DESC, id DESC
               LIMIT 20) r
    ) rounds ON true`;

function asRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

export class ApiTaskRepository {
  async findById(id: string): Promise<ApiTaskRecord | null> {
    const rows = await db.execute<ApiTaskRecord>(sql`${RESOURCE_SELECT} WHERE t.id = ${id}`);
    return asRows<ApiTaskRecord>(rows)[0] ?? null;
  }

  async findByKey(key: string): Promise<ApiTaskRecord | null> {
    const rows = await db.execute<ApiTaskRecord>(sql`${RESOURCE_SELECT} WHERE t.key = ${key}`);
    return asRows<ApiTaskRecord>(rows)[0] ?? null;
  }

  // Newest first. UUIDv7 ids are time-ordered, so `before` pages by id.
  async list(f: ApiTaskListFilter): Promise<ApiTaskRecord[]> {
    const conds: SQL[] = [];
    if (f.source) conds.push(sql`s.source = ${f.source}`);
    if (f.createdBy === null) conds.push(sql`false`);
    else if (f.createdBy !== undefined) conds.push(sql`s.created_by = ${f.createdBy}`);
    if (f.state) conds.push(sql`s.state = ${f.state}`);
    if (f.before) conds.push(sql`s.id < ${f.before}`);
    const where = conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
    const rows = await db.execute<ApiTaskRecord>(sql`
      SELECT * FROM (${RESOURCE_SELECT}) s ${where} ORDER BY s.id DESC LIMIT ${f.limit}`);
    return asRows<ApiTaskRecord>(rows);
  }

  async getStreamState(
    taskId: string,
  ): Promise<{ state: ApiTaskState; sandbox_live: boolean } | null> {
    const rows = await db.execute<{ state: ApiTaskState; sandbox_live: boolean }>(sql`
      SELECT ${STATE_SQL} AS state, (t.sandbox_id IS NOT NULL) AS sandbox_live
        FROM tasks t ${STATE_JOINS}
       WHERE t.id = ${taskId}`);
    return asRows<{ state: ApiTaskState; sandbox_live: boolean }>(rows)[0] ?? null;
  }

  // POST /api/tasks: the tasks row, the assignment inbox row and task_created
  // in ONE transaction. The key comes from api_task_key_seq.
  async createApiTask(p: {
    keyPrefix: string;
    publicBaseUrl: string;
    title: string;
    description: string | null;
    experimentalFlags: string[];
    createdBy: string | null;
  }): Promise<{ taskId: string; key: string }> {
    return db.transaction(async (tx) => {
      const [seq] = asRows<{ n: string }>(
        await tx.execute(sql`SELECT nextval('api_task_key_seq')::text AS n`),
      );
      if (!seq) throw new Error("createApiTask: nextval returned no row");
      const key = `${p.keyPrefix}${seq.n}`;
      const externalUrl = `${p.publicBaseUrl}/api/tasks/${key}`;
      const metadataJson = JSON.stringify({ experimentalFlags: p.experimentalFlags });
      const [task] = asRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO tasks (source, external_id, key, title, external_url, metadata, created_by)
               VALUES ('api', ${key}, ${key}, ${p.title}, ${externalUrl},
                       ${metadataJson}::text::jsonb, ${p.createdBy})
          RETURNING id;`),
      );
      if (!task) throw new Error("createApiTask: tasks insert returned no row");

      const payload: AssignmentPayload = {
        title: p.title,
        description: p.description,
        external_url: externalUrl,
        target_id: task.id,
        ...taskIdentity({ id: task.id, key }),
      };
      const [round] = asRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO inbox (task_id, source, kind, external_id, payload, reply_targets)
               VALUES (${task.id}, 'api', 'assignment', ${key},
                       ${JSON.stringify(payload)}::text::jsonb,
                       ${JSON.stringify([apiSessionTarget(task.id)])}::text::jsonb)
          RETURNING id;`),
      );
      if (!round) throw new Error("createApiTask: inbox insert returned no row");

      await insertCpEventIfApi(tx, {
        taskId: task.id,
        type: "task_created",
        inboxId: round.id,
        data: {
          title: p.title,
          description: p.description,
          experimental_flags: p.experimentalFlags,
        },
      });
      return { taskId: task.id, key };
    });
  }

  // POST /api/tasks/:ref/messages: a comment row (external_id = a new UUID)
  // and message_queued in ONE transaction. A round in progress doesn't block
  // it: the new row queues behind it, as on Linear.
  async appendApiMessage(p: {
    task: { id: string; key: string };
    body: string;
    createdAt: string;
  }): Promise<{ roundId: string }> {
    const payload: CommentPayload = {
      target_id: p.task.id,
      body: p.body,
      pr: null,
      created_at: p.createdAt,
      ...taskIdentity(p.task),
    };
    return db.transaction(async (tx) => {
      // Lock the task row first: task_events ids must be handed out in commit
      // order per task, or an event cursor can skip past a still-open insert.
      // Every other per-task log writer starts with UPDATE tasks.
      await tx.execute(sql`SELECT 1 FROM tasks WHERE id = ${p.task.id} FOR NO KEY UPDATE`);
      const [round] = asRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO inbox (task_id, source, kind, external_id, payload, reply_targets)
               VALUES (${p.task.id}, 'api', 'comment', ${crypto.randomUUID()},
                       ${JSON.stringify(payload)}::text::jsonb,
                       ${JSON.stringify([apiSessionTarget(p.task.id)])}::text::jsonb)
          RETURNING id;`),
      );
      if (!round) throw new Error("appendApiMessage: inbox insert returned no row");
      await insertCpEventIfApi(tx, {
        taskId: p.task.id,
        type: "message_queued",
        inboxId: round.id,
        data: { body: p.body },
      });
      return { roundId: round.id };
    });
  }
}

export const apiTaskRepository = new ApiTaskRepository();
