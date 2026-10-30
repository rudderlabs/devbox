import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import type { Task } from "../db/schema";
import { logger } from "../logger";
import type { HarnessEvent } from "../types/harnessEvent";
import type { AssignmentContent, ReplyTarget } from "./inbox.repository";
import { insertCpEventIfApi, insertDaemonEvent } from "./taskEvent.repository";

export class TaskRepository {
  // Single tx for a Linear `created` event. UPSERT the tasks row (infra) +
  // INSERT the assignment inbox row (work content + reply destinations).
  // Returns the task id and an insert-vs-update bit (`created`).
  //
  // A re-delegation conflict refreshes the display fields + metadata only — the
  // inbox INSERT keys off the Linear issue UUID, so it DO-NOTHINGs and the
  // assignment row is left untouched. The caller branches on `created` and
  // routes a re-delegation to `restartTaskWithInbox` — duplicate-webhook
  // detection (same session id) is the caller's job via
  // `inboxRepo.getAssignmentReplyTargetId(taskId)`.
  async upsertFromAgentSessionWithInbox(params: {
    taskExternalId: string;
    taskKey: string;
    taskTitle: string;
    taskExternalUrl: string;
    inboxPayload: AssignmentContent;
    inboxReplyTargets: ReplyTarget[];
    metadata: unknown;
  }): Promise<{ taskId: string; created: boolean }> {
    // bun-sql JSON-encodes a JS string param, so `${jsonStr}::jsonb` would
    // store a JSON *string scalar* rather than the array/object. Casting via
    // `::text::jsonb` forces PG to parse the raw text into proper jsonb.
    // `?? {}` / `?? []` guard against `JSON.stringify(undefined)` returning
    // `undefined`, which would bind as SQL NULL and violate NOT NULL.
    const metadataJson = JSON.stringify(params.metadata ?? {});
    const payloadJson = JSON.stringify(params.inboxPayload);
    const replyTargetsJson = JSON.stringify(params.inboxReplyTargets ?? []);

    return db.transaction(async (tx) => {
      // 1. UPSERT tasks. RETURNING (xmax = 0) AS created: xmax=0 means a fresh
      //    INSERT, non-zero means an ON CONFLICT UPDATE path was taken.
      const taskRows = await tx.execute<{ id: string; key: string; created: boolean }>(sql`
        INSERT INTO tasks (source, external_id, key, title, external_url, metadata)
             VALUES ('linear', ${params.taskExternalId}, ${params.taskKey}, ${params.taskTitle},
                     ${params.taskExternalUrl}, ${metadataJson}::text::jsonb)
        ON CONFLICT (source, external_id) DO UPDATE
           SET title = EXCLUDED.title,
               external_url = EXCLUDED.external_url,
               -- MERGE, don't replace. A duplicate created-webhook redelivery
               -- passes metadata={}; a blind = EXCLUDED.metadata would wipe the
               -- durable retry budget (metadata.retryCount), silently resetting
               -- the sandbox-retry cap. The jsonb || keeps existing keys while
               -- still letting a real EXCLUDED value overlay. A genuine
               -- re-delegation resets the budget via restartTaskWithInbox.
               metadata = tasks.metadata || EXCLUDED.metadata,
               updated_at = now()
        RETURNING id, key, (xmax = 0) AS created;
      `);
      const taskRow = Array.isArray(taskRows) ? taskRows[0] : undefined;
      if (!taskRow)
        throw new Error("upsertFromAgentSessionWithInbox: tasks upsert returned no row");

      // 2. INSERT inbox. external_id is the Linear issue UUID, so a re-delegation
      //    conflicts here and DO NOTHING leaves the assignment row untouched — the
      //    caller routes the re-delegation to restartTaskWithInbox instead.
      await tx.execute(sql`
        INSERT INTO inbox (task_id, source, kind, external_id, payload, reply_targets)
             VALUES (${taskRow.id}, 'linear', 'assignment', ${params.taskExternalId},
                     ${payloadJson}::text::jsonb || jsonb_build_object(
                       'task_id', ${taskRow.id}::text,
                       'task_key', ${taskRow.key}::text),
                     ${replyTargetsJson}::text::jsonb)
        ON CONFLICT (source, external_id) DO NOTHING;
      `);

      return { taskId: taskRow.id, created: taskRow.created };
    });
  }

  // Re-delegation restart. The caller routes here when
  // upsertFromAgentSessionWithInbox returned `created: false` AND the prior
  // session id differs from the event's. PREEMPTS any in-flight run and
  // restarts from scratch, in one tx:
  //   1. Reset the task to a clean slate — pvc_name / sandbox_id / owner_id /
  //      heartbeat_at cleared, cursor reset. The old owner pod self-evicts on
  //      its next owner-guarded write (owner_id gone).
  //   2. Re-pend the task's single `assignment` inbox row (one per task, created
  //      by upsertFromAgentSessionWithInbox) with a fresh id plus the new
  //      event's payload + reply_targets. The inbox id is the daemon-visible run
  //      identity (`inbox/<id>.json`) and feeds the harness PR branch suffixes;
  //      the logical task row id and assignment external_id remain stable.
  //   3. Dead-letter every still-open NON-assignment inbox row (pending
  //      comment / review rows) so it no longer pins the idle reaper or gets
  //      re-delivered.
  //      Not owner-guarded — it forcibly supersedes whatever pod ran the old round.
  //   4. With `api`: also set the new title and experimental flags in step 1,
  //      and write `task_restarted` to the log.
  //
  // Returns `prevSandboxId` — the preempted sandbox the caller must kill;
  // `assignmentId` — the re-pended assignment row's new id (null if the task
  // has none); and `supersededRoundIds` — the rows dead-lettered in step 3.
  // Duplicate webhook deliveries do not route here; the service checks the
  // prior session first.
  async restartTaskWithInbox(params: {
    taskId: string;
    inboxPayload: AssignmentContent;
    inboxReplyTargets: ReplyTarget[];
    api?: { title: string; description: string | null; experimentalFlags: string[] };
  }): Promise<{
    prevSandboxId: string | null;
    assignmentId: string | null;
    supersededRoundIds: string[];
  }> {
    const payloadJson = JSON.stringify(params.inboxPayload);
    // An API restart also applies the new title and flags. The
    // description lives on the assignment payload (step 2).
    const apiSet = params.api
      ? sql`, title = ${params.api.title},
              metadata = jsonb_set(metadata - 'retryCount', '{experimentalFlags}',
                                   ${JSON.stringify(params.api.experimentalFlags)}::text::jsonb)`
      : sql`, metadata = metadata - 'retryCount'`;
    const replyTargetsJson = JSON.stringify(params.inboxReplyTargets ?? []);

    return db.transaction(async (tx) => {
      // 1. Reset the task to a clean slate. PG18 `RETURNING old.sandbox_id` is
      //    the preempted sandbox the caller kills.
      const taskRows = await tx.execute<{ prev_sandbox_id: string | null }>(sql`
        UPDATE tasks
           SET pvc_name = NULL,
               sandbox_id = NULL,
               owner_id = NULL,
               heartbeat_at = NULL,
               last_observed_event_seq = 0,
               pr_urls = '[]'::jsonb
               -- Clean slate also resets the sandbox-retry budget (retryCount
               -- is dropped in the metadata fragment) — a genuine
               -- re-delegation is a fresh attempt, not a continuation.
               ${apiSet},
               updated_at = now()
         WHERE id = ${params.taskId}
        RETURNING old.sandbox_id AS prev_sandbox_id;
      `);
      const taskRow = Array.isArray(taskRows) ? taskRows[0] : undefined;
      if (!taskRow) throw new Error("restartTaskWithInbox: task not found");

      // 2. Re-pend the task's single `assignment` inbox row with a new id plus
      //    the new event's payload + reply targets — this drives the fresh run.
      //    The row remains the one assignment for this task / Linear issue, but
      //    the daemon sees a new run identity via `inbox/<id>.json`.
      const reRows = await tx.execute<{ id: string }>(sql`
        UPDATE inbox i
           SET id = uuidv7(),
               status = 'pending',
               failure_reason = NULL,
               -- a re-run never inherits the previous run's outcome
               outcome = NULL,
               payload = ${payloadJson}::text::jsonb || jsonb_build_object(
                 'task_id', t.id::text, 'task_key', t.key),
               reply_targets = ${replyTargetsJson}::text::jsonb,
               updated_at = now()
          FROM tasks t
         WHERE t.id = i.task_id
           AND i.task_id = ${params.taskId}
           AND i.kind = 'assignment'
        RETURNING i.id;
      `);
      const assignmentId = (Array.isArray(reRows) ? reRows[0]?.id : undefined) ?? null;

      // 3. Dead-letter every still-open NON-assignment inbox row (pending
      //    comment / review rows). The re-pended `assignment` row (step 2)
      //    is excluded by `kind <> 'assignment'`.
      const supRows = await tx.execute<{ id: string }>(sql`
        UPDATE inbox
           SET status = 'failed',
               failure_reason = 'superseded by re-delegation',
               updated_at = now()
         WHERE task_id = ${params.taskId}
           AND status IN ('pending', 'delivered')
           AND kind <> 'assignment'
        RETURNING id;
      `);
      const supersededRoundIds = (Array.isArray(supRows) ? supRows : []).map((r) => r.id);

      if (params.api) {
        await insertCpEventIfApi(tx, {
          taskId: params.taskId,
          type: "task_restarted",
          inboxId: assignmentId,
          data: {
            title: params.api.title,
            description: params.api.description,
            experimental_flags: params.api.experimentalFlags,
            superseded_round_ids: supersededRoundIds,
          },
        });
      }
      return { prevSandboxId: taskRow.prev_sandbox_id, assignmentId, supersededRoundIds };
    });
  }

  // Retry reset — RESUME, not restart. The backing sandbox failed (terminal /
  // absent pod, dead execd); we spin up a NEW sandbox on the SAME PVC and pick up
  // where the dead one left off. So, unlike restartTaskWithInbox, this KEEPS
  // pvc_name, the event cursor (last_observed_event_seq), and pr_urls — the
  // workspace, the .harness state dir (events.jsonl, inbox files) and the open PRs
  // all live on the preserved PVC. ONLY sandbox_id is cleared, so the
  // recreate-from-PVC path mints a fresh sandbox against that same PVC, and the
  // durable retry counter (metadata.retryCount) is bumped — both in the SAME
  // owner-guarded UPDATE so the bump is atomic and only lands while the lease is
  // ours (0 rows → lease lost → null, count bump rolled back with it).
  //
  // OWNER-GUARDED, and it RELEASES the lease (owner_id / heartbeat_at cleared) so
  // the task re-enters the claim pool: claimNext re-provisions it (on this pod or
  // any other), which keeps the retry within the global maxConcurrentSandboxes cap
  // instead of bypassing it with a direct dispatch. Safe because the retry counter
  // is DURABLE in metadata — it survives the handoff, so the cap stays fleet-wide
  // no matter which pod runs the next attempt (a released task can't multiply it).
  // Returns true if the requeue landed, false if the lease was lost (a sibling
  // reclaimed it) — the caller self-evicts on false. The dead sandbox is killed by
  // the caller BEFORE this runs, so the preempted sandbox id is not reported here.
  //
  // The inbox rows are left UNTOUCHED: a 'delivered' row keeps its id and status,
  // and claimNext re-claims the task on it (it accepts 'pending' or 'delivered').
  // sweepUndelivered then recreates the sandbox from the PVC for any non-terminal
  // row — so the interrupted round resumes without re-pending.
  async requeueForRetry(params: {
    taskId: string;
    ownerId: string;
    retryCount: number;
  }): Promise<boolean> {
    // Clear sandbox_id (PVC / cursor / pr_urls preserved → resume) AND release the
    // lease so the pool can re-claim it; metadata.retryCount bumped atomically.
    // 0 rows → lease lost → false (the count bump is dropped with the un-matched row).
    const rows = await db.execute<{ id: string }>(sql`
      UPDATE tasks
         SET sandbox_id = NULL,
             owner_id = NULL,
             heartbeat_at = NULL,
             metadata = jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{retryCount}',
               to_jsonb(${params.retryCount}::int),
               true
             ),
             updated_at = now()
       WHERE id = ${params.taskId}
         AND owner_id = ${params.ownerId}
      RETURNING id;
    `);
    return (Array.isArray(rows) ? rows.length : 0) > 0;
  }

  // Merged claim + stale-lease reclaim. Single atomic CTE with one predicate:
  // the task has at least one non-terminal inbox row (`pending` or `delivered`)
  // AND is either unowned or stale-leased. Including `delivered` is what lets a
  // new pod adopt an in-flight task whose row already advanced past `pending`
  // before the prior owner died — without it, a graceful restart leaves the
  // task orphaned (heartbeat backdated by `stop()`, but nothing to claim
  // because the row is already 'delivered'). The adopt path in `runTask`
  // re-attaches the existing sandbox; the next reconcile tick resumes event
  // consumption from `last_observed_event_seq`. The global
  // `maxConcurrentSandboxes` cap still gates FRESH provisions (sandbox_id IS
  // NULL); tasks that already hold a sandbox are always claimable (reconcile /
  // deliver), otherwise an in-flight task could starve behind the cap.
  //
  // SOFT CAP: `running` is an unlocked count snapshot read under READ COMMITTED,
  // and FOR UPDATE SKIP LOCKED locks only the single row each pod claims, NOT the
  // rows it counts. So N pods running claimNext concurrently each see the same
  // `running.n`; when only one slot remains they can each admit a distinct fresh
  // provision, overshooting maxConcurrentSandboxes by up to (replica count − 1).
  // A sandbox-failure wave (node/zone loss requeues many tasks into the recreate
  // window at once) is the case most likely to trigger it. This is accepted as a
  // BEST-EFFORT ceiling — size the cluster with headroom ≈ replica count rather
  // than to the exact cap. Hardening it (SERIALIZABLE + retry, or an advisory-lock
  // token bucket) is deferred; the overshoot is bounded and transient.
  //
  // The `running` count includes tasks currently consuming or about to consume
  // a sandbox slot. A task is mid-provision once it is claimed (owner set, fresh
  // heartbeat) but its sandbox_id is still NULL because `attachSandboxResources`
  // hasn't run yet — `createSandboxWithPvc` is slow. Counting only sandbox_id IS
  // NOT NULL would miss that window, so under a backlog `claimNext` would keep
  // claiming past the cap → unbounded concurrent provisioning. The count is the
  // sum of two disjoint terms (the second is qualified `sandbox_id IS NULL` so a
  // task that holds a sandbox AND a pending row is not double-counted):
  //   (a) tasks that already hold a sandbox; and
  //   (b) claimed-but-unprovisioned tasks — owner set, heartbeat fresh,
  //       sandbox_id still NULL, and a non-terminal ('pending'|'delivered') inbox
  //       row (about to provision). 'delivered' is included because the sandbox-
  //       failure RETRY path releases a task whose in-flight row is still
  //       'delivered' (requeueForRetry never re-pends), and claimNext re-claims it
  //       on that delivered row; throughout its recreate-from-PVC window sandbox_id
  //       is NULL, so excluding 'delivered' here would let a retry wave over-admit
  //       past the cap. Matches the claimable predicate's IN ('pending','delivered').
  //
  // Only tasks of `sources` (the sources this build has an integration for) are
  // claimed, so an older image never takes a task of a source it doesn't know:
  // rollbacks and rolling overlaps stay safe without draining (§10).
  async claimNext(params: {
    ownerId: string;
    leaseTimeoutMs: number;
    maxConcurrentSandboxes: number;
    sources: Task["source"][];
  }): Promise<Task | null> {
    const leaseCutoff = `${params.leaseTimeoutMs} milliseconds`;
    const rows = await db.execute<RawTaskRow>(sql`
      WITH running AS (
        SELECT count(*) AS n FROM tasks t
         WHERE t.sandbox_id IS NOT NULL
            OR (
              t.sandbox_id IS NULL
              AND t.owner_id IS NOT NULL
              AND t.heartbeat_at IS NOT NULL
              AND t.heartbeat_at >= now() - (${leaseCutoff})::interval
              AND EXISTS (
                SELECT 1 FROM inbox i
                 WHERE i.task_id = t.id
                   AND i.status IN ('pending', 'delivered')
              )
            )
      ),
      claimable AS (
        SELECT t.id
        FROM tasks t, running
        WHERE t.source IN ${params.sources}
          AND EXISTS (
                SELECT 1 FROM inbox i
                 WHERE i.task_id = t.id
                   AND i.status IN ('pending', 'delivered')
              )
          AND (
                t.owner_id IS NULL
             OR t.heartbeat_at IS NULL
             OR t.heartbeat_at < now() - (${leaseCutoff})::interval
              )
          AND (t.sandbox_id IS NOT NULL OR running.n < ${params.maxConcurrentSandboxes})
        -- FIFO fairness: claim the task whose oldest still-open (non-terminal)
        -- inbox row arrived earliest.
        ORDER BY (
          SELECT min(i.created_at) FROM inbox i
           WHERE i.task_id = t.id
             AND i.status IN ('pending', 'delivered')
        ) ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tasks
         SET owner_id     = ${params.ownerId},
             heartbeat_at = now(),
             updated_at   = now()
        FROM claimable
       WHERE tasks.id = claimable.id
      RETURNING tasks.*;
    `);

    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return null;
    return mapTaskRow(row as RawTaskRow);
  }

  // Tasks this pod owns with a sandbox attached — the reconcile loop iterates
  // these every tick. Comment-pickup tasks with sandbox_id NULL are reconciled
  // via claimNext + sweep, not here. Filtered to `sources` like claimNext.
  async listInFlightOwnedBy(ownerId: string, sources: Task["source"][]): Promise<Task[]> {
    return db
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.ownerId, ownerId),
          sql`${schema.tasks.sandboxId} IS NOT NULL`,
          inArray(schema.tasks.source, sources),
        ),
      );
  }

  // As long as a pod owns a task it heartbeats; if it loses interest it calls
  // releaseLease.
  async heartbeatOwnedBy(ownerId: string): Promise<void> {
    await db
      .update(schema.tasks)
      .set({ heartbeatAt: sql`now()` })
      .where(eq(schema.tasks.ownerId, ownerId));
  }

  // One task's heartbeat, renewed right before its reconcile. Owner-guarded:
  // 0 rows means the lease was taken over.
  async heartbeatTask(params: { taskId: string; ownerId: string }): Promise<{ id: string }[]> {
    return db
      .update(schema.tasks)
      .set({ heartbeatAt: sql`now()` })
      .where(this.ownedByUs(params.taskId, params.ownerId))
      .returning({ id: schema.tasks.id });
  }

  // Backdate heartbeats on own tasks so survivors become immediately
  // reclaimable instead of waiting the full LEASE_TIMEOUT_MS.
  async backdateHeartbeatsOwnedBy(ownerId: string): Promise<void> {
    await db
      .update(schema.tasks)
      .set({ heartbeatAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.tasks.ownerId, ownerId));
  }

  // Stamps sandbox_id and pvc_name on a claimed task. Fresh-provision path.
  async attachSandboxResources(params: {
    taskId: string;
    ownerId: string;
    sandboxId: string;
    pvcName: string;
  }): Promise<{ id: string }[]> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.tasks)
        .set({
          sandboxId: params.sandboxId,
          pvcName: params.pvcName,
          updatedAt: new Date(),
        })
        .where(this.ownedByUs(params.taskId, params.ownerId))
        .returning({ id: schema.tasks.id });
      // A successful fresh provision emits sandbox_started.
      if (rows.length === 1) {
        await insertCpEventIfApi(tx, {
          taskId: params.taskId,
          type: "sandbox_started",
          inboxId: null,
          data: { mode: "fresh" },
        });
      }
      return rows;
    });
  }

  // Owner-guarded lease release. alsoClearSandbox=true also nulls sandbox_id.
  // Returns 0 rows on stale-lease takeover.
  async releaseLease(params: {
    taskId: string;
    ownerId: string;
    alsoClearSandbox?: boolean;
  }): Promise<{ id: string }[]> {
    return db
      .update(schema.tasks)
      .set({
        ownerId: null,
        heartbeatAt: null,
        ...(params.alsoClearSandbox ? { sandboxId: null } : {}),
        updatedAt: new Date(),
      })
      .where(this.ownedByUs(params.taskId, params.ownerId))
      .returning({ id: schema.tasks.id });
  }

  // Owner-guarded + monotonic-guarded cursor advance, and — for API tasks — the
  // task_events insert, in one transaction. That makes the log
  // exactly-once without a unique key: a crash before commit leaves neither;
  // a replay of a passed event, a pod without the lease, and the old owner
  // after a restart (owner_id cleared) all change 0 rows and log nothing.
  // Returns 0 rows when the lease is lost OR the cursor is already past seq.
  async recordEventCursor(params: {
    taskId: string;
    ownerId: string;
    event: HarnessEvent;
  }): Promise<{ id: string }[]> {
    const { event } = params;
    return db.transaction(async (tx) => {
      const result = await tx.execute<{ id: string; source: string }>(sql`
        UPDATE tasks
           SET last_observed_event_seq = ${event.seq}, updated_at = now()
         WHERE id = ${params.taskId}
           AND owner_id = ${params.ownerId}
           AND last_observed_event_seq < ${event.seq}
        RETURNING id, source;
      `);
      const advanced = Array.isArray(result) ? result : [];
      if (advanced.length === 1 && advanced[0]?.source === "api") {
        await insertDaemonEvent(tx, { taskId: params.taskId, event });
      }
      return advanced.map((r) => ({ id: r.id }));
    });
  }

  // Owner-guarded append to pr_urls; dedupes on (url) within the array.
  // Returns 0 rows on stale-lease takeover — the caller (EventDispatcher's
  // pr_opened case) treats that as a self-eviction signal, matching every
  // other state-advancing repo method.
  async appendPrUrl(params: {
    taskId: string;
    ownerId: string;
    prUrl: string;
    repo: string;
    branch: string;
    commitSha: string;
  }): Promise<{ id: string }[]> {
    const entry = sql`jsonb_build_object(
      'repo', ${params.repo}::text,
      'url', ${params.prUrl}::text,
      'branch', ${params.branch}::text,
      'commit_sha', ${params.commitSha}::text
    )`;
    return db
      .update(schema.tasks)
      .set({
        prUrls: sql`
          CASE
            WHEN EXISTS (
              SELECT 1 FROM jsonb_array_elements(${schema.tasks.prUrls}) e
               WHERE e->>'url' = ${params.prUrl}
            )
            THEN ${schema.tasks.prUrls}
            ELSE COALESCE(${schema.tasks.prUrls}, '[]'::jsonb) || jsonb_build_array(${entry})
          END
        `,
        updatedAt: new Date(),
      })
      .where(this.ownedByUs(params.taskId, params.ownerId))
      .returning({ id: schema.tasks.id });
  }

  // GitHub webhook PR → task lookup. GIN-indexed. LIMIT 2 (not 1) so that a PR
  // url claimed by more than one task — the signature of pr_urls cross-pollution
  // (a foreign pr_opened written to the wrong task) — is detectable. We can't
  // know which task is correct, so log it loudly and return the oldest; the
  // warning is what lets an operator catch a confused-deputy poisoning early
  // instead of silently mis-routing every comment on that PR.
  async findByPrUrl(prUrl: string): Promise<Task | null> {
    const rows = await db.execute(sql`
      SELECT * FROM tasks
       WHERE pr_urls @> jsonb_build_array(jsonb_build_object('url', ${prUrl}::text))
       ORDER BY created_at ASC
       LIMIT 2;
    `);
    const list = Array.isArray(rows) ? (rows as RawTaskRow[]) : [];
    if (list.length > 1) {
      logger.warn("findByPrUrl: PR url owned by multiple tasks (pr_urls cross-pollution?)", {
        prUrl,
        taskIds: list.map((r) => r.id),
      });
    }
    const row = list[0];
    return row ? mapTaskRow(row) : null;
  }

  // tasks.external_id IS the Linear issue UUID. Replaces findByAgentSessionId.
  async findByLinearIssueId(issueId: string): Promise<Task | null> {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.source, "linear"), eq(schema.tasks.externalId, issueId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getById(taskId: string): Promise<Task | null> {
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
    return rows[0] ?? null;
  }

  // Owner-scoped re-fetch. Used by reconcileOne between events: a stale-lease
  // takeover in the gap returns null here, so the loop self-evicts BEFORE the
  // next eventDispatcher.handle() instead of surfacing the takeover one
  // handle() too late.
  async getByIdOwnedBy(taskId: string, ownerId: string): Promise<Task | null> {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(this.ownedByUs(taskId, ownerId))
      .limit(1);
    return rows[0] ?? null;
  }

  // Owner-guarded sandbox-id write. Returns 0 rows on stale-lease takeover.
  async setSandboxId(params: {
    taskId: string;
    ownerId: string;
    sandboxId: string | null;
  }): Promise<{ id: string }[]> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.tasks)
        .set({ sandboxId: params.sandboxId, updatedAt: new Date() })
        .where(this.ownedByUs(params.taskId, params.ownerId))
        .returning({ id: schema.tasks.id });
      // Only caller: runTask's recreate-from-PVC path, so a non-null id is a resume.
      if (rows.length === 1 && params.sandboxId !== null) {
        await insertCpEventIfApi(tx, {
          taskId: params.taskId,
          type: "sandbox_started",
          inboxId: null,
          data: { mode: "resume" },
        });
      }
      return rows;
    });
  }

  // Idle reaper. Kills the sandbox of a task whose every inbox row has reached
  // a terminal status ('responded' / 'failed') and whose most recent inbox-row
  // activity is older than `idleMs`. Clears owner_id + sandbox_id +
  // heartbeat_at; PVC stays. Returns the sandbox ids for the caller to kill.
  //
  // The idle clock is `max(inbox.updated_at)` for the task — that column is
  // last bumped when the round's inbox row reached its terminal status
  // (markResponded / failTaskInbox), so the window counts from when the work
  // actually completed, not from CP's event-processing time. A row still
  // 'pending'/'delivered' pins the sandbox via the NOT EXISTS guard.
  //
  // Owner-scoped: every pod runs this every tick, so it must only reap a task
  // THIS pod owns, or one that is genuinely orphaned (no owner, or a stale
  // lease) — otherwise pod A would reap a sandbox pod B is actively working.
  async reapIdleTasks(params: {
    ownerId: string;
    leaseTimeoutMs: number;
    idleMs: number;
  }): Promise<Array<{ id: string; sandboxId: string }>> {
    const idle = `${params.idleMs} milliseconds`;
    const leaseCutoff = `${params.leaseTimeoutMs} milliseconds`;
    const rows = await db.execute<{ id: string; sandbox_id: string }>(sql`
      WITH claimed AS (
        SELECT tasks.id, tasks.sandbox_id
        FROM tasks
        WHERE tasks.sandbox_id IS NOT NULL
          AND (
            tasks.owner_id = ${params.ownerId}
            OR tasks.owner_id IS NULL
            OR tasks.heartbeat_at IS NULL
            OR tasks.heartbeat_at < now() - (${leaseCutoff})::interval
          )
          AND NOT EXISTS (
            SELECT 1 FROM inbox i
            WHERE i.task_id = tasks.id
              AND i.status IN ('pending', 'delivered')
          )
          AND (SELECT max(i.updated_at) FROM inbox i WHERE i.task_id = tasks.id)
              < now() - (${idle})::interval
        ORDER BY (SELECT max(i.updated_at) FROM inbox i WHERE i.task_id = tasks.id) ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tasks
         SET sandbox_id   = NULL,
             owner_id     = NULL,
             heartbeat_at = NULL,
             updated_at   = now()
        FROM claimed
       WHERE tasks.id = claimed.id
      RETURNING tasks.id, claimed.sandbox_id;
    `);
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: r.id,
      sandboxId: r.sandbox_id,
    }));
  }

  // Guard: the task is still ours. Any UPDATE that advances state must filter
  // on this to prevent a GC-paused pod from clobbering a peer's adopted work.
  private ownedByUs(taskId: string, ownerId: string) {
    return and(eq(schema.tasks.id, taskId), eq(schema.tasks.ownerId, ownerId));
  }
}

// Raw row shape from db.execute (snake_case).
type RawTaskRow = {
  id: string;
  source: "linear" | "api";
  external_id: string;
  key: string;
  created_by: string | null;
  title: string;
  external_url: string;
  metadata: unknown;
  owner_id: string | null;
  heartbeat_at: Date | null;
  sandbox_id: string | null;
  pvc_name: string | null;
  pr_urls: unknown;
  last_observed_event_seq: number | string;
  created_at: Date;
  updated_at: Date;
};

function mapTaskRow(row: RawTaskRow): Task {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    key: row.key,
    createdBy: row.created_by,
    title: row.title,
    externalUrl: row.external_url,
    metadata: row.metadata,
    ownerId: row.owner_id,
    heartbeatAt: row.heartbeat_at,
    sandboxId: row.sandbox_id,
    pvcName: row.pvc_name,
    prUrls: row.pr_urls,
    lastObservedEventSeq: Number(row.last_observed_event_seq),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const taskRepository = new TaskRepository();
