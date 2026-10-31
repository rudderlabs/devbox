import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import type { Task } from "../db/schema";
import type { TaskRef } from "../integrations/intake";
import type { Person, TaskSource } from "../integrations/types";
import { logger } from "../logger";
import type { HarnessEvent } from "../types/harnessEvent";
import type { AssignmentPayload } from "../types/inboxMessage";
import {
  type AssignmentContent,
  isUniqueViolation,
  type ReplyTarget,
  taskIdentity,
} from "./inbox.repository";
import {
  insertCpEventIfApi,
  insertDaemonEvent,
  type SqlExecutor,
  type Tx,
} from "./taskEvent.repository";

function asRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

export class TaskRepository {
  // TaskIntake.assign's transaction. Inserts the task, or finds it by
  // (source, external_id) and locks it, then compares the stored delegation
  // (the assignment row's reply target) with the incoming one: when both carry
  // an order, one not above the stored order is a duplicate; otherwise the
  // same id is. A duplicate changes nothing; anything else restarts the task.
  // A new task gets its assignment row and, for API tasks, task_created.
  // Returns the preempted sandbox for the caller to kill after commit, and on
  // a restart the replaced delegation's target id.
  async assign(p: {
    source: TaskSource;
    externalId?: string; // required with a hint key; a sequence key is its own
    key: { hint: string } | { sequencePrefix: string };
    title: string;
    description: string | null;
    flags: string[];
    url: (t: TaskRef) => string;
    target: (t: TaskRef) => ReplyTarget;
    requester?: Person;
    createdBy?: string;
  }): Promise<
    TaskRef & {
      result: "created" | "restarted" | "duplicate";
      prevSandboxId: string | null;
      prevTargetId?: string;
    }
  > {
    return db.transaction(async (tx) => {
      // In a savepoint so a key collision leaves the transaction usable: a
      // concurrent insert can take the key between the check and the insert,
      // and the retry then sees it.
      const insert = () => tx.transaction((sp) => this.insertTask(sp, p));
      const inserted = await insert().catch((err) => {
        if (!isUniqueViolation(err, "tasks_key_lower_uniq")) throw err;
        return insert();
      });

      if (inserted) {
        const t = { id: inserted.id, key: inserted.key };
        const target = p.target(t);
        const payload: AssignmentPayload = {
          title: p.title,
          description: p.description,
          external_url: inserted.url,
          target_id: target.id,
          ...taskIdentity(t),
        };
        // external_id is the task's: the platform's id, or the API task key.
        const [round] = asRows<{ id: string }>(
          await tx.execute(sql`
            INSERT INTO inbox (task_id, source, kind, external_id, payload, reply_targets)
                 VALUES (${t.id}, ${p.source}, 'assignment', ${inserted.externalId},
                         ${JSON.stringify(payload)}::text::jsonb,
                         ${JSON.stringify([target])}::text::jsonb)
            RETURNING id;`),
        );
        if (!round) throw new Error("assign: inbox insert returned no row");
        await insertCpEventIfApi(tx, {
          taskId: t.id,
          type: "task_created",
          inboxId: round.id,
          data: { title: p.title, description: p.description, experimental_flags: p.flags },
        });
        return { ...t, result: "created", prevSandboxId: null };
      }

      const [t] = asRows<TaskRef>(
        await tx.execute(sql`
          SELECT id, key FROM tasks
           WHERE source = ${p.source} AND external_id = ${p.externalId ?? null}
             FOR NO KEY UPDATE`),
      );
      if (!t) throw new Error("assign: task not found after a conflicting insert");
      // Read after the lock, so a restart that committed meanwhile is seen.
      const [stored] = asRows<{ target: ReplyTarget | null }>(
        await tx.execute(sql`
          SELECT reply_targets->0 AS target FROM inbox
           WHERE task_id = ${t.id} AND kind = 'assignment' LIMIT 1`),
      );
      const prev = stored?.target ?? null;
      const next = p.target(t);
      const duplicate =
        prev !== null &&
        (typeof prev.order === "number" && typeof next.order === "number"
          ? next.order <= prev.order
          : next.id === prev.id);
      if (duplicate) return { ...t, result: "duplicate", prevSandboxId: null };

      const url = p.url(t);
      const { prevSandboxId } = await this.restartTaskWithInbox(
        {
          taskId: t.id,
          inboxPayload: {
            title: p.title,
            description: p.description,
            external_url: url,
            target_id: next.id,
          },
          inboxReplyTargets: [next],
          delegation: { flags: p.flags, requester: p.requester },
        },
        tx,
      );
      return { ...t, result: "restarted", prevSandboxId, prevTargetId: prev?.id };
    });
  }

  // assign's insert. Picks the key: a hint is used as is unless another task
  // holds it (case-insensitively), then `${SOURCE}-${hint}`; a sequence key is
  // the prefix plus api_task_key_seq. Returns null when (source, external_id)
  // already exists.
  private async insertTask(
    ex: SqlExecutor,
    p: Parameters<TaskRepository["assign"]>[0],
  ): Promise<(TaskRef & { externalId: string; url: string }) | null> {
    const picked =
      "hint" in p.key
        ? sql`CASE WHEN EXISTS (
                SELECT 1 FROM tasks
                 WHERE lower(key) = lower(${p.key.hint})
                   AND NOT (source = ${p.source} AND external_id = ${p.externalId ?? null})
              ) THEN ${`${p.source.toUpperCase()}-${p.key.hint}`}::text ELSE ${p.key.hint}::text END`
        : sql`${p.key.sequencePrefix}::text || nextval('api_task_key_seq')::text`;
    const [pick] = asRows<TaskRef>(
      await ex.execute(sql`SELECT uuidv7()::text AS id, ${picked} AS key`),
    );
    if (!pick) throw new Error("assign: key selection returned no row");
    const externalId = p.externalId ?? pick.key;
    const url = p.url(pick);
    const metadataJson = JSON.stringify({ experimentalFlags: p.flags, requester: p.requester });
    const [row] = asRows<{ id: string }>(
      await ex.execute(sql`
        INSERT INTO tasks (id, source, external_id, key, title, external_url, metadata, created_by)
             VALUES (${pick.id}, ${p.source}, ${externalId}, ${pick.key}, ${p.title}, ${url},
                     ${metadataJson}::text::jsonb, ${p.createdBy ?? null})
        ON CONFLICT (source, external_id) DO NOTHING
        RETURNING id;`),
    );
    return row ? { ...pick, externalId, url } : null;
  }

  // Restart: assign's newer delegation, or TaskIntake.restart (API). PREEMPTS
  // any in-flight run and restarts from scratch, in one tx (the caller's, when
  // given: assign already holds the task row lock):
  //   1. Reset the task to a clean slate — pvc_name / sandbox_id / owner_id /
  //      heartbeat_at cleared, cursor reset. The old owner pod self-evicts on
  //      its next owner-guarded write (owner_id gone).
  //   2. Re-pend the task's single `assignment` inbox row (one per task, created
  //      by assign) with a fresh id plus the new event's payload +
  //      reply_targets. The inbox id is the daemon-visible run
  //      identity (`inbox/<id>.json`) and feeds the harness PR branch suffixes;
  //      the logical task row id and assignment external_id remain stable.
  //   3. Dead-letter every still-open NON-assignment inbox row (pending
  //      comment / review rows) so it no longer pins the idle reaper or gets
  //      re-delivered.
  //      Not owner-guarded — it forcibly supersedes whatever pod ran the old round.
  //   4. With `api`: also set the new title and experimental flags in step 1,
  //      and write `task_restarted` to the log. With `delegation`: also set the
  //      payload's title and URL and the new flags and requester in step 1.
  //
  // Returns `prevSandboxId` — the preempted sandbox the caller must kill;
  // `assignmentId` — the re-pended assignment row's new id (null if the task
  // has none); and `supersededRoundIds` — the rows dead-lettered in step 3.
  // Duplicate deliveries do not route here; assign compares delegations first.
  async restartTaskWithInbox(
    params: {
      taskId: string;
      inboxPayload: AssignmentContent;
      inboxReplyTargets: ReplyTarget[];
      api?: { title: string; description: string | null; experimentalFlags: string[] };
      delegation?: { flags: string[]; requester?: Person };
    },
    tx?: Tx,
  ): Promise<{
    prevSandboxId: string | null;
    assignmentId: string | null;
    supersededRoundIds: string[];
  }> {
    if (!tx) return db.transaction((t) => this.restartTaskWithInbox(params, t));
    const { api, delegation } = params;
    const payloadJson = JSON.stringify(params.inboxPayload);
    // An API restart or a re-delegation also applies the new title and flags
    // (a re-delegation its URL and requester too, dropping a stale one). The
    // description lives on the assignment payload (step 2).
    const flags = api?.experimentalFlags ?? delegation?.flags;
    const definition = JSON.stringify({
      experimentalFlags: flags,
      requester: delegation?.requester,
    });
    const definitionSet =
      flags === undefined
        ? sql`, metadata = metadata - 'retryCount'`
        : sql`, title = ${params.inboxPayload.title},
              metadata = (metadata - 'retryCount' - 'requester') || ${definition}::text::jsonb
              ${delegation ? sql`, external_url = ${params.inboxPayload.external_url}` : sql``}`;
    const replyTargetsJson = JSON.stringify(params.inboxReplyTargets ?? []);

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
             ${definitionSet},
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
  // rollbacks and rolling overlaps stay safe without draining.
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
  // releaseLease. Returns the tasks renewed: one missing was taken over.
  async heartbeatOwnedBy(ownerId: string): Promise<{ id: string }[]> {
    return db
      .update(schema.tasks)
      .set({ heartbeatAt: sql`now()` })
      .where(eq(schema.tasks.ownerId, ownerId))
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
  // Each advance also renews the lease, so a long run of slow but successful
  // sends can't outlive it mid-reconcile.
  async recordEventCursor(params: {
    taskId: string;
    ownerId: string;
    event: HarnessEvent;
  }): Promise<{ id: string }[]> {
    const { event } = params;
    return db.transaction(async (tx) => {
      const result = await tx.execute<{ id: string; source: string }>(sql`
        UPDATE tasks
           SET last_observed_event_seq = ${event.seq}, heartbeat_at = now(), updated_at = now()
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
  // other state-advancing repo method. A URL already there still returns the
  // row; `firstTime` (PG18 `old.`) says whether this call added it.
  async appendPrUrl(params: {
    taskId: string;
    ownerId: string;
    prUrl: string;
    repo: string;
    branch: string;
    commitSha: string;
  }): Promise<{ id: string; firstTime: boolean }[]> {
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
      .returning({
        id: schema.tasks.id,
        firstTime: sql<boolean>`old.pr_urls IS DISTINCT FROM new.pr_urls`,
      });
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

  // tasks.external_id is the platform's id (the Linear issue UUID, the API
  // task key).
  async findByExternalId(source: TaskSource, externalId: string): Promise<Task | null> {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.source, source), eq(schema.tasks.externalId, externalId)))
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
  source: TaskSource;
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
