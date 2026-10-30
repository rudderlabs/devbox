import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const taskSource = pgEnum("task_source", ["linear", "api"]);

// API task keys are `${API_TASK_KEY_PREFIX}${nextval}`. The sequence is not tied
// to the prefix, so changing the prefix never reuses a number.
export const apiTaskKeySeq = pgSequence("api_task_key_seq");

// Bearer tokens for /api. The id is also the first part of the token
// (dbx_<id>_<secret>); only an argon2id hash of the secret is stored.
export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  // A person or service. Display only.
  name: text("name").notNull().unique(),
  secretHash: text("secret_hash").notNull(),
  // Optional GitHub identity reserved for PR assignee mirroring.
  githubLogin: text("github_login"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// Pure infra. No status, no reply-destination data, no message routing.
// Task lifecycle is derived from `owner_id` + `sandbox_id` + presence of
// undelivered inbox rows.
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    source: taskSource("source").notNull(),
    externalId: text("external_id").notNull(),
    // The human task key (ABC-123, DBX-API-42). Sent to the harness as
    // task_key. Set once at creation and never re-derived from external_url.
    key: text("key").notNull(),
    // Creator token for API tasks. Null for Linear tasks and with auth off.
    createdBy: uuid("created_by").references(() => apiTokens.id),
    // Denormalized copies of fields the daemon also reads from the inbox
    // payload — kept on tasks so admin queries / dashboards are
    // self-describing without joining inbox.
    title: text("title").notNull(),
    externalUrl: text("external_url").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    ownerId: text("owner_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    sandboxId: text("sandbox_id"),
    // Per-task workspace volume (k8s PVC or Docker volume) minted at first
    // provision. Null until then. Persisted so a pod that adopts the task
    // can tear down the right PVC on terminate, even if it didn't mint it.
    pvcName: text("pvc_name"),
    // [{repo, url, branch, commit_sha}] — GIN-indexed for GH webhook PR→task
    // lookup, denormalized for the monorepo N-PR case.
    prUrls: jsonb("pr_urls").notNull().default([]),
    // Per-task cursor for events.jsonl. Advanced monotonically by
    // EventDispatcher after each event is handled. A real column (not metadata
    // jsonb) because it is load-bearing on every reconcile tick.
    lastObservedEventSeq: bigint("last_observed_event_seq", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tasks_source_external_id_uniq").on(t.source, t.externalId),
    // Keys are unique case-insensitively; readers match lower(key) = lower($1).
    uniqueIndex("tasks_key_lower_uniq").on(sql`lower(${t.key})`),
    // Heartbeat scans only care whether a pod owns the task.
    index("tasks_lease_idx").on(t.heartbeatAt).where(sql`${t.ownerId} IS NOT NULL`),
    // GitHub webhook PR→task lookup.
    index("tasks_pr_urls_gin_idx").using("gin", t.prUrls.op("jsonb_path_ops")),
    // listInFlightOwnedBy: tasks an owner pod holds with a live sandbox.
    index("tasks_owner_sandbox_idx").on(t.ownerId).where(sql`${t.sandboxId} IS NOT NULL`),
  ],
);

// One row per unit of work the daemon processes. Top-level columns hold
// lifecycle + identity + idempotency keys; everything kind-specific lives in
// the single `payload` jsonb, discriminated by `kind`. `reply_targets` is a
// top-level column so every row guarantees the shape regardless of kind.
export const inbox = pgTable(
  "inbox",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // Upstream system's id; paired with `source` for idempotency.
    externalId: text("external_id").notNull(),
    // 'linear' | 'github'.
    source: text("source").notNull(),
    // 'assignment' | 'comment' | 'review'.
    kind: text("kind").notNull(),
    // kind-discriminated work content (prompt body, titles, etc).
    payload: jsonb("payload").notNull(),
    // ReplyTarget[] — top-level (not nested in payload) so every row has it.
    // Carries reply destinations only; resolution state is the `status` column.
    replyTargets: jsonb("reply_targets").notNull().default([]),
    // Lifecycle: 'pending' (created, not delivered) → 'delivered' (written to
    // the sandbox inbox dir) → 'responded' (a terminal event processed it).
    // 'failed' is the CP-side delivery dead-letter (e.g. PVC missing) — a
    // separate terminal branch off 'pending'. 'responded' and 'failed' are
    // both terminal; the reaper guard frees the sandbox once no row is
    // 'pending'/'delivered'.
    status: text("status").notNull().default("pending"),
    // One-line delivery-failure reason, set alongside status='failed'.
    // Surfaced to the user once.
    failureReason: text("failure_reason"),
    // `status` of the round's `completed` event (completed | partial_failure |
    // no_action | failed). Null until then, and for rows from before 0006.
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency anchor: webhook retries / LB reroutes collapse via this.
    // Every ON CONFLICT targets (source, kind, external_id).
    uniqueIndex("inbox_source_kind_external_uniq").on(t.source, t.kind, t.externalId),
    // The stricter pre-phase-2 index, kept for one release so older pods'
    // ON CONFLICT (source, external_id) still has its arbiter. Phase 3 drops it.
    uniqueIndex("inbox_source_external_uniq").on(t.source, t.externalId),
    // Pending = not yet delivered or dead-lettered. Sweep + claimNext filter on this.
    index("inbox_pending_idx").on(t.taskId).where(sql`${t.status} = 'pending'`),
    index("inbox_task_created_idx").on(t.taskId, t.createdAt),
  ],
);

// Progress log for API tasks (daemon events + CP events). `id` is the API/SSE
// cursor. The daemon's `seq` restarts at 1 after a restart, so it is stored for
// information only and is not unique.
export const taskEvents = pgTable(
  "task_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // 'daemon' | 'control_plane'
    origin: text("origin").notNull(),
    type: text("type").notNull(),
    // The round this event belongs to, exposed as round_id. No FK: a restart
    // rotates the assignment row's id.
    inboxId: uuid("inbox_id"),
    seq: bigint("seq", { mode: "number" }),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("task_events_task_id_id_idx").on(t.taskId, t.id)],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type InboxRecord = typeof inbox.$inferSelect;
export type NewInboxRecord = typeof inbox.$inferInsert;
export type ApiToken = typeof apiTokens.$inferSelect;
export type TaskEvent = typeof taskEvents.$inferSelect;
