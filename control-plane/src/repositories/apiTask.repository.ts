import { type SQL, sql } from "drizzle-orm";
import { db } from "../db";
import type { TaskSource } from "../integrations/types";
import type { ApiRound, ApiTaskState } from "../types/api";

// The API read model. API tasks are written through TaskIntake.

export type ApiTaskRecord = {
  id: string;
  key: string;
  source: TaskSource;
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
  source?: TaskSource;
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

  // Case-insensitive, like the key's unique index (lower(key)).
  async findByKey(key: string): Promise<ApiTaskRecord | null> {
    const rows = await db.execute<ApiTaskRecord>(
      sql`${RESOURCE_SELECT} WHERE lower(t.key) = lower(${key})`,
    );
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
}

export const apiTaskRepository = new ApiTaskRepository();
