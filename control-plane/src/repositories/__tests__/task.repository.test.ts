import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { sql } from "drizzle-orm";
import type { HarnessEvent } from "../../types/harnessEvent";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";

mock.module("../../config", () => ({
  config: { databaseUrl: TEST_DATABASE_URL },
}));

const { db, schema } = await import("../../db");
const { TaskRepository } = await import("../task.repository");
const { TaskEventRepository, insertCpEventIfApi } = await import("../taskEvent.repository");
const { migrate } = await import("drizzle-orm/bun-sql/migrator");

const repo = new TaskRepository();

const linearTarget = (targetId: string) => ({
  id: targetId,
  spec: { kind: "linear_session" as const },
});

const assignmentPayload = {
  title: "Fix auth",
  description: "desc",
  task_key: "ISS-1",
  external_url: "https://linear.app/x/issue/ISS-1",
  target_id: "agent-session-1",
};

const assignmentContent = {
  title: "Fix auth",
  description: "desc",
  external_url: "https://linear.app/x/issue/ISS-1",
  target_id: "agent-session-1",
};

// Inserts a bare tasks row directly. Returns the synthetic id.
async function insertTask(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.tasks)
    .values({
      source: (overrides.source as "linear" | "api") ?? "linear",
      externalId: (overrides.externalId as string) ?? `ext-${crypto.randomUUID()}`,
      key: (overrides.key as string) ?? `T-${crypto.randomUUID()}`,
      createdBy: (overrides.createdBy as string | null) ?? null,
      title: (overrides.title as string) ?? "t",
      externalUrl: (overrides.externalUrl as string) ?? "https://linear.app/x/issue/T-1",
      ownerId: (overrides.ownerId as string | null) ?? null,
      heartbeatAt: (overrides.heartbeatAt as Date | null) ?? null,
      sandboxId: (overrides.sandboxId as string | null) ?? null,
      pvcName: (overrides.pvcName as string | null) ?? null,
      lastObservedEventSeq: (overrides.lastObservedEventSeq as number | undefined) ?? 0,
      metadata: sql`${JSON.stringify(overrides.metadata ?? {})}::text::jsonb`,
    })
    .returning({ id: schema.tasks.id });
  if (!row) throw new Error("insert returned no row");
  return row;
}

// Inserts an inbox row for `taskId`. Defaults to a 'pending' row (so the task
// is claimable). `status` + `updatedAtSecondsAgo` let the reaper tests stage a
// terminal, suitably-aged row.
async function insertInboxRow(
  taskId: string,
  overrides: {
    externalId?: string;
    replyTargets?: unknown;
    status?: string;
    updatedAtSecondsAgo?: number;
  } = {},
): Promise<{ id: string }> {
  const replyTargets = overrides.replyTargets ?? [linearTarget("sess-x")];
  const updatedAt =
    overrides.updatedAtSecondsAgo !== undefined
      ? sql`now() - (${`${overrides.updatedAtSecondsAgo} seconds`})::interval`
      : sql`now()`;
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO inbox (task_id, source, kind, external_id, payload, reply_targets, status, updated_at)
         VALUES (${taskId}, 'linear', 'assignment', ${overrides.externalId ?? `inb-${crypto.randomUUID()}`},
                 ${JSON.stringify(assignmentPayload)}::text::jsonb, ${JSON.stringify(replyTargets)}::text::jsonb,
                 ${overrides.status ?? "pending"}, ${updatedAt})
    RETURNING id;
  `);
  if (!row) throw new Error("inbox insert returned no row");
  return row as { id: string };
}

describe("TaskRepository", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
    await db.execute(sql`ALTER SEQUENCE api_task_key_seq RESTART`);
  });

  describe("upsertFromAgentSessionWithInbox", () => {
    it("inserts task + inbox row in one tx, created=true on fresh insert", async () => {
      const result = await repo.upsertFromAgentSessionWithInbox({
        taskKey: "ISS-1",
        taskExternalId: "issue-1",
        taskTitle: "Fix auth",
        taskExternalUrl: "https://linear.app/x/issue/ISS-1",
        inboxPayload: assignmentContent,
        inboxReplyTargets: [linearTarget("sess-1")],
        metadata: { experimentalFlags: ["FAST_PATH"] },
      });

      expect(result.created).toBe(true);

      const tasks = await db.select().from(schema.tasks);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe("Fix auth");
      expect(tasks[0]?.externalUrl).toBe("https://linear.app/x/issue/ISS-1");
      expect(tasks[0]?.metadata).toEqual({ experimentalFlags: ["FAST_PATH"] });

      const inboxRows = await db.execute<{ kind: string; reply_targets: unknown }>(
        sql`SELECT kind, reply_targets FROM inbox`,
      );
      expect(inboxRows).toHaveLength(1);
      expect(inboxRows[0]?.kind).toBe("assignment");
    });

    it("sets tasks.key on insert and never changes it on conflict", async () => {
      const first = await repo.upsertFromAgentSessionWithInbox({
        taskExternalId: "issue-1",
        taskKey: "ISS-1",
        taskTitle: "Fix auth",
        taskExternalUrl: "https://linear.app/x/issue/ISS-1",
        inboxPayload: assignmentContent,
        inboxReplyTargets: [linearTarget("sess-1")],
        metadata: {},
      });
      // The issue moved team: new URL, new identifier. The stored key stays.
      await repo.upsertFromAgentSessionWithInbox({
        taskExternalId: "issue-1",
        taskKey: "XYZ-9",
        taskTitle: "Fix auth",
        taskExternalUrl: "https://linear.app/x/issue/XYZ-9",
        inboxPayload: assignmentContent,
        inboxReplyTargets: [linearTarget("sess-2")],
        metadata: {},
      });
      const row = await repo.getById(first.taskId);
      expect({ key: row?.key, createdBy: row?.createdBy }).toEqual({
        key: "ISS-1",
        createdBy: null,
      });
    });

    it("created=false on conflict; inbox INSERT is a no-op; existing reply_targets persist", async () => {
      await repo.upsertFromAgentSessionWithInbox({
        taskKey: "ISS-1",
        taskExternalId: "issue-1",
        taskTitle: "Fix auth",
        taskExternalUrl: "https://linear.app/x/issue/ISS-1",
        inboxPayload: assignmentContent,
        inboxReplyTargets: [linearTarget("sess-1")],
        metadata: {},
      });

      // Seed a durable retry budget on the existing row. A duplicate `created`
      // redelivery passes metadata={}; the upsert MERGES (metadata || EXCLUDED),
      // so the budget must be PRESERVED — a blind overwrite would silently reset
      // the sandbox-retry cap.
      await db.execute(sql`
        UPDATE tasks SET metadata = '{"retryCount":2}'::jsonb WHERE external_id = 'issue-1';
      `);

      const result = await repo.upsertFromAgentSessionWithInbox({
        taskKey: "ISS-1",
        taskExternalId: "issue-1",
        taskTitle: "Fix auth v2",
        taskExternalUrl: "https://linear.app/x/issue/ISS-1",
        inboxPayload: assignmentContent,
        inboxReplyTargets: [linearTarget("sess-2")],
        metadata: {},
      });

      expect(result.created).toBe(false);

      const [task] = await db.select().from(schema.tasks);
      expect(task?.title).toBe("Fix auth v2");
      // retryCount survives the duplicate-redelivery upsert (merge, not replace).
      expect((task?.metadata as { retryCount?: number })?.retryCount).toBe(2);

      // Still exactly one inbox row — INSERT was DO NOTHING on conflict, so
      // the existing reply_targets carrying "sess-1" are preserved (the
      // caller reads this via inboxRepo.getAssignmentReplyTargetId for
      // duplicate-webhook detection).
      const rows = await db.execute<{
        id: string;
        reply_targets: Array<{ id: string }>;
      }>(sql`SELECT id, reply_targets FROM inbox`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reply_targets[0]?.id).toBe("sess-1");
    });
  });

  describe("restartTaskWithInbox", () => {
    it("stamps task_id/task_key on the assignment payload from the task row", async () => {
      const { taskId } = await repo.upsertFromAgentSessionWithInbox({
        taskExternalId: "issue-1",
        taskKey: "ISS-1",
        taskTitle: "Fix auth",
        taskExternalUrl: "https://linear.app/x/issue/ISS-1",
        inboxPayload: assignmentContent,
        inboxReplyTargets: [linearTarget("sess-1")],
        metadata: {},
      });
      const created = await db.execute<{ payload: unknown }>(
        sql`SELECT payload FROM inbox WHERE task_id = ${taskId}`,
      );
      expect(created[0]?.payload).toEqual({
        ...assignmentContent,
        task_id: taskId,
        task_key: "ISS-1",
      });

      await repo.restartTaskWithInbox({
        taskId,
        inboxPayload: { ...assignmentContent, title: "Fix auth v2" },
        inboxReplyTargets: [linearTarget("sess-2")],
      });
      const restarted = await db.execute<{ payload: unknown }>(
        sql`SELECT payload FROM inbox WHERE task_id = ${taskId}`,
      );
      expect(restarted[0]?.payload).toEqual({
        ...assignmentContent,
        title: "Fix auth v2",
        task_id: taskId,
        task_key: "ISS-1",
      });
    });

    it("rotates and re-pends the task's single assignment inbox row, dead-letters open siblings, and resets the task", async () => {
      // Seed a task + assignment inbox row, then stage an in-flight run.
      const { taskId } = await repo.upsertFromAgentSessionWithInbox({
        taskKey: "ISS-1",
        taskExternalId: "issue-1",
        taskTitle: "Fix auth",
        taskExternalUrl: "https://linear.app/x/issue/ISS-1",
        inboxPayload: assignmentContent,
        inboxReplyTargets: [linearTarget("sess-1")],
        metadata: {},
      });
      await db.execute(sql`
        UPDATE tasks
           SET owner_id = 'pod-a', heartbeat_at = now(), sandbox_id = 'sb-old',
               pvc_name = 'pvc-old', last_observed_event_seq = 42,
               metadata = '{"retryCount":3}'::jsonb,
               pr_urls = '[{"repo":"api","url":"https://github.com/o/r/pull/1","branch":"devbox/old","commit_sha":"abc"}]'::jsonb
         WHERE id = ${taskId};
      `);
      await db.execute(sql`UPDATE inbox SET status = 'delivered' WHERE task_id = ${taskId};`);
      const [beforeAssignment] = await db.execute<{ id: string }>(
        sql`SELECT id FROM inbox WHERE task_id = ${taskId} AND kind = 'assignment';`,
      );
      if (!beforeAssignment) throw new Error("missing seeded assignment row");
      await db.execute(sql`
        INSERT INTO inbox (task_id, source, kind, external_id, payload, reply_targets, status)
             VALUES (${taskId}, 'linear', 'comment', 'activity-1',
                     ${JSON.stringify({ body: "old comment" })}::text::jsonb,
                     ${JSON.stringify([linearTarget("sess-1")])}::text::jsonb,
                     'pending'),
                    (${taskId}, 'github', 'review', 'review-1',
                     ${JSON.stringify({ body: "old review" })}::text::jsonb,
                     ${JSON.stringify([{ id: "review-1", spec: { kind: "github_review" } }])}::text::jsonb,
                     'delivered');
      `);

      const result = await repo.restartTaskWithInbox({
        taskId,
        inboxPayload: assignmentContent,
        inboxReplyTargets: [linearTarget("sess-2")],
      });

      // The preempted sandbox is returned for the caller to kill.
      expect(result).toEqual({
        prevSandboxId: "sb-old",
        assignmentId: expect.any(String),
        supersededRoundIds: expect.any(Array),
      });

      // Task reset to a clean pending run; lease + sandbox + pvc + cursor cleared.
      const [task] = await db.select().from(schema.tasks);
      expect(task?.id).toBe(taskId);
      expect(task?.sandboxId).toBeNull();
      expect(task?.ownerId).toBeNull();
      expect(task?.heartbeatAt).toBeNull();
      expect(task?.pvcName).toBeNull();
      expect(Number(task?.lastObservedEventSeq)).toBe(0);
      expect(task?.prUrls).toEqual([]);
      // Re-delegation is a fresh attempt → the durable retry budget is dropped.
      expect((task?.metadata as { retryCount?: number })?.retryCount).toBeUndefined();

      // Still exactly one `assignment` inbox row for the Linear issue. The row
      // id rotates because it is the daemon-visible run identity, while
      // external_id stays the Linear issue id for idempotency.
      const assignments = await db.execute<{
        id: string;
        status: string;
        kind: string;
        external_id: string;
        reply_targets: unknown;
      }>(
        sql`SELECT id, status, kind, external_id, reply_targets FROM inbox WHERE kind = 'assignment';`,
      );
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.id).not.toBe(beforeAssignment.id);
      expect(assignments[0]?.status).toBe("pending");
      expect(assignments[0]?.kind).toBe("assignment");
      expect(assignments[0]?.external_id).toBe("issue-1");
      const rt = assignments[0]?.reply_targets as Array<{ id: string; spec: { kind: string } }>;
      expect(rt[0]?.id).toBe("sess-2");
      expect(rt[0]?.spec.kind).toBe("linear_session");

      const superseded = await db.execute<{
        kind: string;
        status: string;
        failure_reason: string | null;
      }>(
        sql`SELECT kind, status, failure_reason FROM inbox WHERE kind <> 'assignment' ORDER BY kind;`,
      );
      expect(superseded).toEqual([
        {
          kind: "comment",
          status: "failed",
          failure_reason: "superseded by re-delegation",
        },
        {
          kind: "review",
          status: "failed",
          failure_reason: "superseded by re-delegation",
        },
      ]);
    });
  });

  describe("requeueForRetry", () => {
    it("owner-guarded RESUME: keeps pvc/cursor/pr_urls + inbox rows, only drops sandbox_id + releases the lease", async () => {
      const { taskId } = await repo.upsertFromAgentSessionWithInbox({
        taskKey: "ISS-1",
        taskExternalId: "issue-1",
        taskTitle: "Fix auth",
        taskExternalUrl: "https://linear.app/x/issue/ISS-1",
        inboxPayload: assignmentContent,
        inboxReplyTargets: [linearTarget("sess-1")],
        metadata: {},
      });
      const prUrls = [
        {
          repo: "api",
          url: "https://github.com/o/r/pull/1",
          branch: "devbox/old",
          commit_sha: "abc",
        },
      ];
      await db.execute(sql`
        UPDATE tasks
           SET owner_id = 'pod-a', heartbeat_at = now(), sandbox_id = 'sb-old',
               pvc_name = 'pvc-old', last_observed_event_seq = 42,
               pr_urls = ${JSON.stringify(prUrls)}::text::jsonb
         WHERE id = ${taskId};
      `);
      await db.execute(sql`UPDATE inbox SET status = 'delivered' WHERE task_id = ${taskId};`);
      const [beforeAssignment] = await db.execute<{ id: string }>(
        sql`SELECT id FROM inbox WHERE task_id = ${taskId} AND kind = 'assignment';`,
      );
      if (!beforeAssignment) throw new Error("missing seeded assignment row");
      // A 'responded' sibling must stay terminal (only in-flight rows resume).
      await db.execute(sql`
        INSERT INTO inbox (task_id, source, kind, external_id, payload, reply_targets, status)
             VALUES (${taskId}, 'linear', 'comment', 'activity-1',
                     ${JSON.stringify({ body: "done comment" })}::text::jsonb,
                     ${JSON.stringify([linearTarget("sess-1")])}::text::jsonb,
                     'responded');
      `);

      // Wrong owner → no-op + false (lease lost / sibling took over). The retry
      // count bump is part of the same guarded UPDATE, so it must NOT land either.
      const wrong = await repo.requeueForRetry({ taskId, ownerId: "pod-b", retryCount: 1 });
      expect(wrong).toBe(false);
      const [stillOwned] = await db.select().from(schema.tasks);
      expect(stillOwned?.ownerId).toBe("pod-a");
      expect(stillOwned?.sandboxId).toBe("sb-old");
      expect((stillOwned?.metadata as { retryCount?: number })?.retryCount).toBeUndefined();

      // Correct owner → sandbox_id dropped + lease released + count stamped, true returned.
      const result = await repo.requeueForRetry({ taskId, ownerId: "pod-a", retryCount: 2 });
      expect(result).toBe(true);

      const [task] = await db.select().from(schema.tasks);
      expect(task?.sandboxId).toBeNull();
      // RESUME: the PVC, cursor and PRs are PRESERVED — the new sandbox picks up
      // the same workspace where the dead one left off.
      expect(task?.pvcName).toBe("pvc-old");
      expect(Number(task?.lastObservedEventSeq)).toBe(42);
      expect(task?.prUrls).toEqual(prUrls);
      // Durable retry counter persisted in metadata.
      expect((task?.metadata as { retryCount?: number })?.retryCount).toBe(2);
      // Lease RELEASED — the task re-enters the claim pool (any pod re-provisions
      // it within the concurrency cap); the durable count makes that safe.
      expect(task?.ownerId).toBeNull();
      expect(task?.heartbeatAt).toBeNull();

      // Inbox rows are UNTOUCHED: the in-flight assignment keeps its id + status
      // (claimNext re-claims on a 'delivered' row, runTask recreates the sandbox).
      const assignments = await db.execute<{
        id: string;
        status: string;
        external_id: string;
        payload: unknown;
      }>(sql`SELECT id, status, external_id, payload FROM inbox WHERE kind = 'assignment';`);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.id).toBe(beforeAssignment.id);
      expect(assignments[0]?.status).toBe("delivered");
      expect(assignments[0]?.external_id).toBe("issue-1");
      expect(assignments[0]?.payload).toEqual({
        ...assignmentContent,
        task_id: taskId,
        task_key: "ISS-1",
      });

      // Sibling untouched too.
      const [sibling] = await db.execute<{ status: string }>(
        sql`SELECT status FROM inbox WHERE kind = 'comment';`,
      );
      expect(sibling?.status).toBe("responded");
    });
  });

  describe("claimNext", () => {
    it("returns null when no task has a pending inbox row", async () => {
      await insertTask({ externalId: "no-inbox" });
      expect(
        await repo.claimNext({
          ownerId: "pod-a",
          leaseTimeoutMs: 10_000,
          maxConcurrentSandboxes: 100,
        }),
      ).toBeNull();
    });

    it("claims an unowned task that has a pending inbox row", async () => {
      const t = await insertTask({ externalId: "fresh" });
      await insertInboxRow(t.id);

      const task = await repo.claimNext({
        ownerId: "pod-a",
        leaseTimeoutMs: 10_000,
        maxConcurrentSandboxes: 100,
      });

      expect(task?.id).toBe(t.id);
      expect(task?.ownerId).toBe("pod-a");
      expect(task?.heartbeatAt).toBeInstanceOf(Date);
    });

    it("skips a fresh-leased task even with a pending inbox row", async () => {
      const t = await insertTask({ ownerId: "pod-other", heartbeatAt: new Date() });
      await insertInboxRow(t.id);

      expect(
        await repo.claimNext({
          ownerId: "pod-a",
          leaseTimeoutMs: 10_000,
          maxConcurrentSandboxes: 100,
        }),
      ).toBeNull();
    });

    it("adopts a stale-leased task with a pending inbox row", async () => {
      const t = await insertTask({ ownerId: "pod-dead" });
      await insertInboxRow(t.id);
      await db
        .update(schema.tasks)
        .set({ heartbeatAt: sql`now() - interval '1 hour'` })
        .where(sql`id = ${t.id}`);

      const task = await repo.claimNext({
        ownerId: "pod-live",
        leaseTimeoutMs: 10_000,
        maxConcurrentSandboxes: 100,
      });
      expect(task?.id).toBe(t.id);
      expect(task?.ownerId).toBe("pod-live");
    });

    it("adopts a stale-leased task whose only inbox row is 'delivered' (pod-restart recovery)", async () => {
      // Pod-restart scenario: old owner backdated its heartbeat in stop(), but
      // the in-flight task's inbox row already advanced to 'delivered' before
      // the restart. The sandbox is still alive — the new pod must adopt and
      // resume cursor consumption.
      const t = await insertTask({ ownerId: "pod-dead", sandboxId: "sbx-inflight" });
      const inb = await insertInboxRow(t.id);
      await db.execute(sql`UPDATE inbox SET status = 'delivered' WHERE id = ${inb.id}`);
      await db
        .update(schema.tasks)
        .set({ heartbeatAt: sql`now() - interval '1 hour'` })
        .where(sql`id = ${t.id}`);

      const task = await repo.claimNext({
        ownerId: "pod-live",
        leaseTimeoutMs: 10_000,
        maxConcurrentSandboxes: 100,
      });
      expect(task?.id).toBe(t.id);
      expect(task?.ownerId).toBe("pod-live");
    });

    it("skips a delivered-only task whose lease is fresh (in-flight, healthy owner)", async () => {
      const t = await insertTask({
        ownerId: "pod-other",
        heartbeatAt: new Date(),
        sandboxId: "sbx-1",
      });
      const inb = await insertInboxRow(t.id);
      await db.execute(sql`UPDATE inbox SET status = 'delivered' WHERE id = ${inb.id}`);

      expect(
        await repo.claimNext({
          ownerId: "pod-a",
          leaseTimeoutMs: 10_000,
          maxConcurrentSandboxes: 100,
        }),
      ).toBeNull();
    });

    it("orders by the oldest pending inbox row first (FIFO)", async () => {
      const a = await insertTask({ externalId: "a" });
      const b = await insertTask({ externalId: "b" });
      await insertInboxRow(a.id);
      await insertInboxRow(b.id);
      // Make b's pending inbox row the older one — it should be claimed first.
      await db.execute(
        sql`UPDATE inbox SET created_at = now() - interval '1 hour' WHERE task_id = ${b.id}`,
      );

      const task = await repo.claimNext({
        ownerId: "pod-a",
        leaseTimeoutMs: 10_000,
        maxConcurrentSandboxes: 100,
      });
      expect(task?.id).toBe(b.id);
    });

    it("concurrency cap gates a fresh provision (sandbox_id NULL)", async () => {
      // One task already holds a sandbox slot.
      await insertTask({ externalId: "running", sandboxId: "sbx-1" });
      const fresh = await insertTask({ externalId: "fresh" });
      await insertInboxRow(fresh.id);

      expect(
        await repo.claimNext({
          ownerId: "pod-a",
          leaseTimeoutMs: 10_000,
          maxConcurrentSandboxes: 1,
        }),
      ).toBeNull();
    });

    it("a task that already holds a sandbox is claimable even at the cap", async () => {
      const t = await insertTask({ externalId: "has-sbx", sandboxId: "sbx-1" });
      await insertInboxRow(t.id);

      const task = await repo.claimNext({
        ownerId: "pod-a",
        leaseTimeoutMs: 10_000,
        maxConcurrentSandboxes: 1,
      });
      expect(task?.id).toBe(t.id);
    });

    it("a claimed-but-unprovisioned task counts toward the cap", async () => {
      // A task mid-provision: claimed (owner set, fresh heartbeat), pending
      // inbox row, but sandbox_id still NULL because attachSandboxResources
      // hasn't run yet. It is consuming a sandbox slot — claimNext must NOT
      // claim a second fresh task while it occupies the only slot.
      const provisioning = await insertTask({
        externalId: "provisioning",
        ownerId: "pod-busy",
        heartbeatAt: new Date(),
      });
      await insertInboxRow(provisioning.id);

      const fresh = await insertTask({ externalId: "fresh" });
      await insertInboxRow(fresh.id);

      // Cap of 1, the in-flight provision occupies it → no fresh claim.
      expect(
        await repo.claimNext({
          ownerId: "pod-a",
          leaseTimeoutMs: 10_000,
          maxConcurrentSandboxes: 1,
        }),
      ).toBeNull();
    });

    it("a claimed-but-unprovisioned task with a DELIVERED row counts toward the cap (retry recreate window)", async () => {
      // The sandbox-failure RETRY path: requeueForRetry released the task (now
      // re-claimed: owner set, fresh heartbeat) with sandbox_id NULL and its
      // in-flight assignment row still 'delivered' (never re-pended). During its
      // recreate-from-PVC window it IS about to consume a slot, so it must count —
      // otherwise a retry wave over-admits past the cap.
      const recreating = await insertTask({
        externalId: "recreating",
        ownerId: "pod-busy",
        heartbeatAt: new Date(),
      });
      await insertInboxRow(recreating.id, { status: "delivered" });

      const fresh = await insertTask({ externalId: "fresh" });
      await insertInboxRow(fresh.id);

      // Cap of 1, the in-flight recreate occupies it → no fresh claim.
      expect(
        await repo.claimNext({
          ownerId: "pod-a",
          leaseTimeoutMs: 10_000,
          maxConcurrentSandboxes: 1,
        }),
      ).toBeNull();
    });

    it("a stale-leased mid-provision task does NOT count toward the cap", async () => {
      // Same shape as above but the heartbeat is stale — the prior owner is
      // dead, that slot is not really in use, so a fresh provision may proceed.
      const stale = await insertTask({ externalId: "stale-provision", ownerId: "pod-dead" });
      await insertInboxRow(stale.id);
      await db
        .update(schema.tasks)
        .set({ heartbeatAt: sql`now() - interval '1 hour'` })
        .where(sql`id = ${stale.id}`);

      const fresh = await insertTask({ externalId: "fresh" });
      await insertInboxRow(fresh.id);
      // Make the stale task's pending row the oldest so it sorts first if
      // eligible; we then assert a claim still happens at cap 1.
      await db.execute(
        sql`UPDATE inbox SET created_at = now() - interval '2 hours' WHERE task_id = ${stale.id}`,
      );

      const task = await repo.claimNext({
        ownerId: "pod-a",
        leaseTimeoutMs: 10_000,
        maxConcurrentSandboxes: 1,
      });
      // A claim succeeds — the stale lease did not consume the only slot.
      expect(task?.id).toBe(stale.id);
    });

    it("a task holding a sandbox AND a pending row is not double-counted", async () => {
      // The task both holds a sandbox and has a pending inbox row. It must
      // count as exactly ONE slot, not two — so with cap 2 a second fresh
      // provision is still allowed.
      const inflight = await insertTask({
        externalId: "inflight",
        ownerId: "pod-busy",
        heartbeatAt: new Date(),
        sandboxId: "sbx-inflight",
      });
      await insertInboxRow(inflight.id);

      const fresh = await insertTask({ externalId: "fresh" });
      await insertInboxRow(fresh.id);

      const task = await repo.claimNext({
        ownerId: "pod-a",
        leaseTimeoutMs: 10_000,
        maxConcurrentSandboxes: 2,
      });
      // running.n == 1 (not 2) → the fresh task is claimable.
      expect(task?.id).toBe(fresh.id);
    });
  });

  describe("releaseLease", () => {
    it("owner-guarded; clears owner_id + heartbeat_at", async () => {
      const t = await insertTask({ ownerId: "pod-a", heartbeatAt: new Date(), sandboxId: "sbx-1" });

      const wrong = await repo.releaseLease({ taskId: t.id, ownerId: "pod-other" });
      expect(wrong).toEqual([]);

      const right = await repo.releaseLease({ taskId: t.id, ownerId: "pod-a" });
      expect(right).toEqual([{ id: t.id }]);

      const [row] = await db.select().from(schema.tasks);
      expect(row?.ownerId).toBeNull();
      expect(row?.heartbeatAt).toBeNull();
      expect(row?.sandboxId).toBe("sbx-1"); // not cleared without flag
    });

    it("alsoClearSandbox=true nulls sandbox_id too", async () => {
      const t = await insertTask({ ownerId: "pod-a", heartbeatAt: new Date(), sandboxId: "sbx-1" });
      await repo.releaseLease({ taskId: t.id, ownerId: "pod-a", alsoClearSandbox: true });
      const [row] = await db.select().from(schema.tasks);
      expect(row?.sandboxId).toBeNull();
    });
  });

  describe("recordEventCursor", () => {
    const ev = (seq: number, inboxId: string | null = null): HarnessEvent =>
      ({
        seq,
        ts: "2026-10-07T12:00:00Z",
        type: "agent_action",
        inbox_id: inboxId ?? "0192f000-0000-7000-8000-0000000000aa",
        target_id: "t",
        body: `step ${seq}`,
      }) as HarnessEvent;

    const events = () =>
      db.execute<Record<string, unknown>>(
        sql`SELECT task_id, origin, type, inbox_id, seq::int AS seq, data FROM task_events ORDER BY id`,
      );

    it("advances the cursor; owner-guarded + monotonic-guarded (Linear: logs nothing)", async () => {
      const t = await insertTask({ ownerId: "pod-a", lastObservedEventSeq: 2 });
      expect(
        await repo.recordEventCursor({ taskId: t.id, ownerId: "pod-x", event: ev(5) }),
      ).toEqual([]);
      expect(
        await repo.recordEventCursor({ taskId: t.id, ownerId: "pod-a", event: ev(5) }),
      ).toEqual([{ id: t.id }]);
      expect(
        await repo.recordEventCursor({ taskId: t.id, ownerId: "pod-a", event: ev(3) }),
      ).toEqual([]);
      const [row] = await db.select().from(schema.tasks);
      expect(row?.lastObservedEventSeq).toBe(5);
      expect(await events()).toEqual([]);
    });

    it("API task: one log row per event, holding the full event", async () => {
      const t = await insertTask({ source: "api", ownerId: "pod-a" });
      await repo.recordEventCursor({ taskId: t.id, ownerId: "pod-a", event: ev(1) });
      await repo.recordEventCursor({ taskId: t.id, ownerId: "pod-a", event: ev(1) }); // replay: cursor already past
      expect(await events()).toEqual([
        {
          task_id: t.id,
          origin: "daemon",
          type: "agent_action",
          inbox_id: "0192f000-0000-7000-8000-0000000000aa",
          seq: 1,
          data: ev(1),
        },
      ]);
    });

    it("a crash before commit leaves no cursor advance and no row; the replay writes once", async () => {
      const t = await insertTask({ source: "api", ownerId: "pod-a" });
      // A non-uuid inbox_id makes the log INSERT fail inside the transaction:
      // the stand-in for a crash between the cursor update and the commit.
      await expect(
        repo.recordEventCursor({ taskId: t.id, ownerId: "pod-a", event: ev(1, "not-a-uuid") }),
      ).rejects.toThrow();
      expect((await repo.getById(t.id))?.lastObservedEventSeq).toBe(0);
      expect(await events()).toEqual([]);

      await repo.recordEventCursor({ taskId: t.id, ownerId: "pod-a", event: ev(1) });
      expect((await repo.getById(t.id))?.lastObservedEventSeq).toBe(1);
      expect(await events()).toEqual([
        {
          task_id: t.id,
          origin: "daemon",
          type: "agent_action",
          inbox_id: "0192f000-0000-7000-8000-0000000000aa",
          seq: 1,
          data: ev(1),
        },
      ]);
    });

    it("a pod without the lease writes nothing", async () => {
      const t = await insertTask({ source: "api", ownerId: "pod-b" });
      expect(
        await repo.recordEventCursor({ taskId: t.id, ownerId: "pod-a", event: ev(1) }),
      ).toEqual([]);
      expect(await events()).toEqual([]);
    });

    it("after a restart the old owner writes nothing and the new run's seq 1 is logged", async () => {
      const t = await insertTask({ source: "api", ownerId: "pod-a", lastObservedEventSeq: 5 });
      await insertInboxRow(t.id, { status: "delivered" });
      await repo.restartTaskWithInbox({
        taskId: t.id,
        inboxPayload: { title: "t", description: null, external_url: "u", target_id: t.id },
        inboxReplyTargets: [{ id: t.id, spec: { kind: "api_session" } }],
      });
      expect(
        await repo.recordEventCursor({ taskId: t.id, ownerId: "pod-a", event: ev(6) }),
      ).toEqual([]);
      await db.execute(sql`UPDATE tasks SET owner_id = 'pod-b' WHERE id = ${t.id}`);
      await repo.recordEventCursor({ taskId: t.id, ownerId: "pod-b", event: ev(1) });
      expect(await events()).toEqual([
        {
          task_id: t.id,
          origin: "daemon",
          type: "agent_action",
          inbox_id: "0192f000-0000-7000-8000-0000000000aa",
          seq: 1,
          data: ev(1),
        },
      ]);
    });
  });

  describe("TaskEventRepository.listAfter", () => {
    it("pages by id after the cursor, ascending", async () => {
      const t = await insertTask({ source: "api" });
      for (const type of ["a", "b", "c"]) {
        await insertCpEventIfApi(db, {
          taskId: t.id,
          type: "round_failed",
          inboxId: null,
          data: { type },
        });
      }
      await db.execute(sql`UPDATE task_events SET created_at = '2026-10-07T12:00:00Z'`);
      const page = await new TaskEventRepository().listAfter(t.id, 1, 1);
      expect(page).toEqual([
        {
          id: 2,
          task_id: t.id,
          origin: "control_plane",
          type: "round_failed",
          inbox_id: null,
          seq: null,
          data: { type: "b" },
          created_at: new Date("2026-10-07T12:00:00Z"),
        },
      ]);
    });
  });

  describe("appendPrUrl", () => {
    it("appends to pr_urls, dedupes on url, returns the row id", async () => {
      const t = await insertTask({ ownerId: "pod-a" });

      const first = await repo.appendPrUrl({
        taskId: t.id,
        ownerId: "pod-a",
        prUrl: "https://github.com/o/r/pull/1",
        repo: "r",
        branch: "b",
        commitSha: "abc",
      });
      expect(first).toEqual([{ id: t.id }]);
      // Re-append same url — should not duplicate.
      await repo.appendPrUrl({
        taskId: t.id,
        ownerId: "pod-a",
        prUrl: "https://github.com/o/r/pull/1",
        repo: "r",
        branch: "b",
        commitSha: "abc",
      });
      await repo.appendPrUrl({
        taskId: t.id,
        ownerId: "pod-a",
        prUrl: "https://github.com/o/r/pull/2",
        repo: "r2",
        branch: "b2",
        commitSha: "def",
      });

      const [row] = await db.select().from(schema.tasks);
      const urls = (row?.prUrls as Array<{ url: string }> | undefined)?.map((e) => e.url);
      expect(urls).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
    });

    it("owner-guarded: returns 0 rows on stale-lease takeover", async () => {
      const t = await insertTask({ ownerId: "pod-a" });
      const wrong = await repo.appendPrUrl({
        taskId: t.id,
        ownerId: "pod-other",
        prUrl: "https://github.com/o/r/pull/1",
        repo: "r",
        branch: "b",
        commitSha: "abc",
      });
      expect(wrong).toEqual([]);

      const [row] = await db.select().from(schema.tasks);
      expect(row?.prUrls).toEqual([]); // not written
    });
  });

  describe("setSandboxId / getById / findByLinearIssueId / findByPrUrl", () => {
    it("setSandboxId owner-guarded", async () => {
      const t = await insertTask({ ownerId: "pod-a" });
      expect(await repo.setSandboxId({ taskId: t.id, ownerId: "pod-x", sandboxId: "s" })).toEqual(
        [],
      );
      expect(await repo.setSandboxId({ taskId: t.id, ownerId: "pod-a", sandboxId: "s" })).toEqual([
        { id: t.id },
      ]);
    });

    it("getById returns the row or null", async () => {
      const t = await insertTask();
      expect((await repo.getById(t.id))?.id).toBe(t.id);
      expect(await repo.getById(crypto.randomUUID())).toBeNull();
    });

    it("getByIdOwnedBy returns the row only for the owning pod", async () => {
      const t = await insertTask({ ownerId: "pod-a" });
      expect((await repo.getByIdOwnedBy(t.id, "pod-a"))?.id).toBe(t.id);
      // Takeover: a different owner sees null → reconcileOne self-evicts.
      expect(await repo.getByIdOwnedBy(t.id, "pod-other")).toBeNull();
    });

    it("findByLinearIssueId matches on source + external_id", async () => {
      const t = await insertTask({ externalId: "linear-uuid-1" });
      expect((await repo.findByLinearIssueId("linear-uuid-1"))?.id).toBe(t.id);
      expect(await repo.findByLinearIssueId("nope")).toBeNull();
    });

    it("findByPrUrl matches via the GIN-indexed jsonb predicate", async () => {
      const t = await insertTask({ ownerId: "pod-a" });
      await repo.appendPrUrl({
        taskId: t.id,
        ownerId: "pod-a",
        prUrl: "https://github.com/o/r/pull/9",
        repo: "r",
        branch: "b",
        commitSha: "sha",
      });
      expect((await repo.findByPrUrl("https://github.com/o/r/pull/9"))?.id).toBe(t.id);
      expect(await repo.findByPrUrl("https://github.com/o/r/pull/404")).toBeNull();
    });
  });

  describe("listInFlightOwnedBy", () => {
    it("listInFlightOwnedBy returns owned tasks with a sandbox attached", async () => {
      const withSbx = await insertTask({ externalId: "a", ownerId: "pod-a", sandboxId: "sbx-a" });
      await insertTask({ externalId: "b", ownerId: "pod-a" }); // no sandbox
      await insertTask({ externalId: "c", ownerId: "pod-b", sandboxId: "sbx-c" }); // other pod

      const ids = (await repo.listInFlightOwnedBy("pod-a")).map((r) => r.id);
      expect(ids).toEqual([withSbx.id]);
    });
  });

  describe("heartbeatOwnedBy / backdateHeartbeatsOwnedBy", () => {
    it("heartbeat updates only rows owned by us", async () => {
      const mine = await insertTask({
        externalId: "mine",
        ownerId: "pod-a",
        heartbeatAt: new Date("2020-01-01"),
      });
      const theirs = await insertTask({
        externalId: "theirs",
        ownerId: "pod-b",
        heartbeatAt: new Date("2020-01-01"),
      });

      await repo.heartbeatOwnedBy("pod-a");

      const rows = await db.select().from(schema.tasks);
      expect(rows.find((r) => r.id === mine.id)?.heartbeatAt?.getFullYear()).toBeGreaterThan(2020);
      expect(rows.find((r) => r.id === theirs.id)?.heartbeatAt?.getFullYear()).toBe(2020);
    });

    it("backdate makes own heartbeats immediately stale", async () => {
      const t = await insertTask({ ownerId: "pod-a", heartbeatAt: new Date() });
      await insertInboxRow(t.id);

      await repo.backdateHeartbeatsOwnedBy("pod-a");
      const task = await repo.claimNext({
        ownerId: "pod-b",
        leaseTimeoutMs: 10_000,
        maxConcurrentSandboxes: 100,
      });
      expect(task?.id).toBe(t.id);
      expect(task?.ownerId).toBe("pod-b");
    });
  });

  describe("attachSandboxResources", () => {
    it("stamps sandbox_id + pvc_name, owner-guarded", async () => {
      const t = await insertTask({ ownerId: "pod-a" });

      expect(
        await repo.attachSandboxResources({
          taskId: t.id,
          ownerId: "pod-x",
          sandboxId: "sbx-1",
          pvcName: "pvc-1",
        }),
      ).toEqual([]);

      expect(
        await repo.attachSandboxResources({
          taskId: t.id,
          ownerId: "pod-a",
          sandboxId: "sbx-1",
          pvcName: "pvc-1",
        }),
      ).toEqual([{ id: t.id }]);

      const [row] = await db.select().from(schema.tasks);
      expect(row?.sandboxId).toBe("sbx-1");
      expect(row?.pvcName).toBe("pvc-1");
    });
  });

  describe("reapIdleTasks", () => {
    it("reaps a task whose inbox rows are all terminal and idle past idleMs", async () => {
      const idle = await insertTask({
        externalId: "idle",
        ownerId: "pod-a",
        heartbeatAt: new Date(),
        sandboxId: "sbx-idle",
      });
      // Terminal inbox row, updated_at backdated past the idle window.
      await insertInboxRow(idle.id, { status: "responded", updatedAtSecondsAgo: 60 });

      const reaped = await repo.reapIdleTasks({
        ownerId: "pod-a",
        leaseTimeoutMs: 60_000,
        idleMs: 1000,
      });
      expect(reaped).toEqual([{ id: idle.id, sandboxId: "sbx-idle" }]);

      const [row] = await db.select().from(schema.tasks);
      expect(row?.ownerId).toBeNull();
      expect(row?.sandboxId).toBeNull();
      expect(row?.heartbeatAt).toBeNull();
    });

    it("does NOT reap a task with a pending inbox row, even when idle", async () => {
      const pinned = await insertTask({
        externalId: "pinned",
        ownerId: "pod-a",
        sandboxId: "sbx-pin",
      });
      // Pending row with an old updated_at — the pending status pins the
      // sandbox regardless of how stale the row is.
      await insertInboxRow(pinned.id, { updatedAtSecondsAgo: 60 });

      const reaped = await repo.reapIdleTasks({
        ownerId: "pod-a",
        leaseTimeoutMs: 60_000,
        idleMs: 1000,
      });
      expect(reaped).toEqual([]);
    });

    it("ignores a task whose inbox rows were updated within the idle window", async () => {
      const fresh = await insertTask({
        externalId: "fresh",
        ownerId: "pod-a",
        sandboxId: "sbx-fresh",
      });
      // Terminal but freshly updated — not idle yet.
      await insertInboxRow(fresh.id, { status: "responded" });

      const reaped = await repo.reapIdleTasks({
        ownerId: "pod-a",
        leaseTimeoutMs: 60_000,
        idleMs: 60_000,
      });
      expect(reaped).toEqual([]);
    });

    it("idle clock counts from the most recent inbox row's updated_at", async () => {
      // Two terminal rows — one old, one recent. max(updated_at) is the recent
      // one, so the task is NOT yet idle.
      const task = await insertTask({
        externalId: "two-rows",
        ownerId: "pod-a",
        sandboxId: "sbx-two",
      });
      await insertInboxRow(task.id, {
        externalId: "old",
        status: "responded",
        updatedAtSecondsAgo: 3600,
      });
      await insertInboxRow(task.id, {
        externalId: "recent",
        status: "responded",
        updatedAtSecondsAgo: 5,
      });

      const reaped = await repo.reapIdleTasks({
        ownerId: "pod-a",
        leaseTimeoutMs: 60_000,
        idleMs: 60_000,
      });
      expect(reaped).toEqual([]);
    });

    it("does NOT reap a live, fresh-heartbeat task owned by a different pod", async () => {
      // The reaper runs on every pod. A task pod-b owns and is heartbeating
      // must not be reaped by pod-a — without the owner filter it would be
      // (idle, all inbox rows terminal).
      const peer = await insertTask({
        externalId: "peer-owned",
        ownerId: "pod-b",
        heartbeatAt: new Date(),
        sandboxId: "sbx-peer",
      });
      await insertInboxRow(peer.id, { status: "responded", updatedAtSecondsAgo: 60 });

      const reaped = await repo.reapIdleTasks({
        ownerId: "pod-a",
        leaseTimeoutMs: 60_000,
        idleMs: 1000,
      });
      expect(reaped).toEqual([]);
    });

    it("DOES reap an idle task whose owner's lease has gone stale (orphaned)", async () => {
      // A different pod owned it but stopped heartbeating — orphaned, so any
      // pod's reaper may reclaim it.
      const orphan = await insertTask({
        externalId: "orphan",
        ownerId: "pod-b",
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        sandboxId: "sbx-orphan",
      });
      await insertInboxRow(orphan.id, { status: "responded", updatedAtSecondsAgo: 60 });

      const reaped = await repo.reapIdleTasks({
        ownerId: "pod-a",
        leaseTimeoutMs: 60_000,
        idleMs: 1000,
      });
      expect(reaped).toEqual([{ id: orphan.id, sandboxId: "sbx-orphan" }]);
    });
  });

  describe("sandbox_started events", () => {
    const events = () =>
      db.execute<Record<string, unknown>>(
        sql`SELECT type, inbox_id, data FROM task_events ORDER BY id`,
      );

    it("attachSandboxResources logs mode fresh for an API task", async () => {
      const t = await insertTask({ source: "api", ownerId: "pod-a" });
      await repo.attachSandboxResources({
        taskId: t.id,
        ownerId: "pod-a",
        sandboxId: "sbx",
        pvcName: "pvc",
      });
      expect([...(await events())]).toEqual([
        { type: "sandbox_started", inbox_id: null, data: { mode: "fresh" } },
      ]);
    });

    it("setSandboxId logs mode resume for an API task, and nothing when clearing", async () => {
      const t = await insertTask({ source: "api", ownerId: "pod-a" });
      await repo.setSandboxId({ taskId: t.id, ownerId: "pod-a", sandboxId: "sbx-2" });
      await repo.setSandboxId({ taskId: t.id, ownerId: "pod-a", sandboxId: null });
      expect([...(await events())]).toEqual([
        { type: "sandbox_started", inbox_id: null, data: { mode: "resume" } },
      ]);
    });

    it("a lost lease or a Linear task logs nothing", async () => {
      const api = await insertTask({ source: "api", ownerId: "pod-b" });
      const lin = await insertTask({ ownerId: "pod-a" });
      await repo.attachSandboxResources({
        taskId: api.id,
        ownerId: "pod-a",
        sandboxId: "s",
        pvcName: "p",
      });
      await repo.attachSandboxResources({
        taskId: lin.id,
        ownerId: "pod-a",
        sandboxId: "s",
        pvcName: "p",
      });
      expect([...(await events())]).toEqual([]);
    });
  });
});
