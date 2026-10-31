import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";

mock.module("../../config", () => ({
  config: { databaseUrl: TEST_DATABASE_URL },
}));

const { db, schema } = await import("../../db");
const { InboxRepository } = await import("../inbox.repository");
const { migrate } = await import("drizzle-orm/bun-sql/migrator");

const repo = new InboxRepository();

const linearTarget = (targetId: string) => ({
  id: targetId,
  spec: { kind: "linear_session" as const },
});

const assignmentPayload = {
  title: "t",
  description: "d",
  task_id: "task-1",
  task_key: "T-1",
  external_url: "https://linear.app/x/issue/T-1",
  target_id: "agent-session-1",
};

async function insertTask(
  overrides: { externalId?: string; ownerId?: string | null; source?: "linear" | "api" } = {},
): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.tasks)
    .values({
      source: overrides.source ?? "linear",
      externalId: overrides.externalId ?? `ext-${crypto.randomUUID()}`,
      key: `T-${crypto.randomUUID()}`,
      title: "t",
      externalUrl: "https://linear.app/x/issue/T-1",
      ownerId: overrides.ownerId ?? null,
    })
    .returning({ id: schema.tasks.id });
  if (!row) throw new Error("task insert returned no row");
  return row;
}

async function insertRow(
  taskId: string,
  o: { source: string; kind: string; status: string },
): Promise<{ id: string }> {
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO inbox (task_id, source, kind, external_id, payload, status)
         VALUES (${taskId}, ${o.source}, ${o.kind}, ${crypto.randomUUID()}, '{}'::jsonb, ${o.status})
    RETURNING id;`);
  if (!row) throw new Error("insert failed");
  return row as { id: string };
}

describe("InboxRepository", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
    await db.execute(sql`ALTER SEQUENCE api_task_key_seq RESTART`);
  });

  describe("appendInbox", () => {
    it("inserts a row and returns the synthetic id", async () => {
      const task = await insertTask();

      const result = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "ext-1",
          payload: assignmentPayload,
        },
        replyTargets: [linearTarget("sess-1")],
      });

      expect(result?.id).toBeTruthy();
    });

    it("is idempotent on (source, external_id) — returns null on conflict", async () => {
      const task = await insertTask();
      await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "dup",
          payload: assignmentPayload,
        },
        replyTargets: [linearTarget("sess-1")],
      });

      const second = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "dup",
          payload: assignmentPayload,
        },
        replyTargets: [linearTarget("sess-1")],
      });
      expect(second).toBeNull();

      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM inbox`);
      expect(Number(rows[0]?.n)).toBe(1);
    });

    const ghComment = (externalId: string) => ({
      source: "github" as const,
      kind: "comment" as const,
      external_id: externalId,
      payload: {
        target_id: externalId,
        body: "@bot fix",
        task_id: "task-1",
        task_key: "T-1",
        pr: { repo: "r", pr_url: "https://github.com/o/r/pull/7" },
        created_at: "",
      },
    });

    it("a redelivered comment adds nothing, even after its round finished", async () => {
      const task = await insertTask();
      const first = await repo.appendInbox({
        taskId: task.id,
        message: ghComment("555"),
        replyTargets: [],
      });
      await db.execute(sql`UPDATE inbox SET status = 'responded'`);

      expect(
        await repo.appendInbox({ taskId: task.id, message: ghComment("555"), replyTargets: [] }),
      ).toBeNull();
      const rows = await db.execute<{ id: string; status: string }>(
        sql`SELECT id, status FROM inbox`,
      );
      expect([...rows]).toEqual([{ id: first?.id as string, status: "responded" }]);
    });

    it("dedupes across kinds: a review whose id equals a stored comment id is dropped", async () => {
      // characterization: changes once the old index is dropped. The
      // (source, kind, external_id) index allows this row, but the old
      // (source, external_id) one still rejects it.
      const task = await insertTask();
      await repo.appendInbox({ taskId: task.id, message: ghComment("555"), replyTargets: [] });

      const review = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "github",
          kind: "review",
          external_id: "555",
          payload: {
            review_body: { target_id: "555", body: "@bot" },
            inline_comments: [],
            task_id: "task-1",
            task_key: "T-1",
            pr: { repo: "r", pr_url: "https://github.com/o/r/pull/7" },
            created_at: "",
          },
        },
        replyTargets: [],
      });

      expect(review).toBeNull();
      const kinds = await db.execute<{ kind: string }>(sql`SELECT kind FROM inbox`);
      expect([...kinds]).toEqual([{ kind: "comment" }]);
    });

    it("dedupes on (source, kind, external_id) once the old index is gone", async () => {
      // A later release drops inbox_source_external_uniq; here it goes in a
      // transaction that is rolled back, so the insert's conflict target
      // must be the new index.
      const task = await insertTask();
      const review = {
        source: "github" as const,
        kind: "review" as const,
        external_id: "555",
        payload: {
          review_body: { target_id: "555", body: "@bot" },
          inline_comments: [],
          task_id: "task-1",
          task_key: "T-1",
          pr: { repo: "r", pr_url: "https://github.com/o/r/pull/7" },
          created_at: "",
        },
      };
      const results: unknown[] = [];
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(sql`DROP INDEX inbox_source_external_uniq`);
          for (const message of [ghComment("555"), ghComment("555"), review]) {
            results.push(
              await repo.appendInbox({ taskId: task.id, message, replyTargets: [] }, tx),
            );
          }
          tx.rollback();
        }),
      ).rejects.toThrow(TransactionRollbackError);
      expect(results).toEqual([{ id: expect.any(String) }, null, { id: expect.any(String) }]);
    });
  });

  describe("listPendingByTask", () => {
    it("returns only status='pending' rows (excludes delivered + failed)", async () => {
      const task = await insertTask({ ownerId: "pod-a" });

      // failTaskInbox is whole-task — dead-letter the `failed` row while it is
      // the only non-terminal row, before the others are inserted.
      const failed = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "f",
          payload: assignmentPayload,
        },
        replyTargets: [],
      });
      if (!failed) throw new Error("insert failed");
      await repo.failTaskInbox({ taskId: task.id, ownerId: "pod-a", reason: "pvc missing" });

      const delivered = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "d",
          payload: assignmentPayload,
        },
        replyTargets: [],
      });
      if (!delivered) throw new Error("insert failed");
      await repo.markDelivered({ inboxId: delivered.id, ownerId: "pod-a" });

      const pending = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "p",
          payload: assignmentPayload,
        },
        replyTargets: [],
      });
      if (!pending) throw new Error("insert failed");

      const list = await repo.listPendingByTask(task.id);
      expect(list.map((r) => r.id)).toEqual([pending.id]);
    });
  });

  describe("markDelivered", () => {
    it("pending → delivered; owner-guarded", async () => {
      const task = await insertTask({ ownerId: "pod-a" });
      const row = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "x",
          payload: assignmentPayload,
        },
        replyTargets: [],
      });
      if (!row) throw new Error("insert failed");

      // Owner mismatch → no-op, row stays pending.
      await repo.markDelivered({ inboxId: row.id, ownerId: "pod-x" });
      expect((await repo.getById(row.id))?.status).toBe("pending");

      // Owner match → delivered.
      await repo.markDelivered({ inboxId: row.id, ownerId: "pod-a" });
      expect((await repo.getById(row.id))?.status).toBe("delivered");
    });
  });

  describe("failTaskInbox", () => {
    it("fails every non-terminal row (pending + delivered); owner-guarded", async () => {
      const task = await insertTask({ ownerId: "pod-a" });
      const pendingRow = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "p",
          payload: assignmentPayload,
        },
        replyTargets: [],
      });
      const deliveredRow = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "d",
          payload: assignmentPayload,
        },
        replyTargets: [],
      });
      if (!pendingRow || !deliveredRow) throw new Error("inserts failed");
      await repo.markDelivered({ inboxId: deliveredRow.id, ownerId: "pod-a" });

      // Owner mismatch → 0 rows, nothing failed.
      const wrongOwner = await repo.failTaskInbox({
        taskId: task.id,
        ownerId: "pod-x",
        reason: "pvc missing",
      });
      expect(wrongOwner).toEqual([]);
      expect((await repo.getById(pendingRow.id))?.status).toBe("pending");

      // Owner match → both non-terminal rows flip to 'failed'.
      const failed = await repo.failTaskInbox({
        taskId: task.id,
        ownerId: "pod-a",
        reason: "pvc missing",
      });
      expect(failed.map((r) => r.id).sort()).toEqual([pendingRow.id, deliveredRow.id].sort());
      expect((await repo.getById(pendingRow.id))?.status).toBe("failed");
      expect((await repo.getById(pendingRow.id))?.failure_reason).toBe("pvc missing");
      expect((await repo.getById(deliveredRow.id))?.status).toBe("failed");
      expect(await repo.listPendingByTask(task.id)).toEqual([]);
    });

    it("returns the rows it failed, whole, in arrival order", async () => {
      const task = await insertTask({ ownerId: "pod-a" });
      const ids: string[] = [];
      for (const external_id of ["first", "second"]) {
        const row = await repo.appendInbox({
          taskId: task.id,
          message: {
            source: "linear",
            kind: "assignment",
            external_id,
            payload: assignmentPayload,
          },
          replyTargets: [linearTarget(`s-${external_id}`)],
        });
        if (!row) throw new Error("insert failed");
        ids.push(row.id);
      }

      const failed = await repo.failTaskInbox({ taskId: task.id, ownerId: "pod-a", reason: "x" });

      expect(failed as unknown[]).toEqual(await Promise.all(ids.map((id) => repo.getById(id))));
      expect(failed[0]?.reply_targets).toEqual([linearTarget("s-first")]);
    });

    it("does not touch an already-responded row", async () => {
      const task = await insertTask({ ownerId: "pod-a" });
      const row = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "r",
          payload: assignmentPayload,
        },
        replyTargets: [linearTarget("s")],
      });
      if (!row) throw new Error("insert failed");
      await repo.markResponded({ inboxId: row.id, ownerId: "pod-a", outcome: null });

      expect(await repo.failTaskInbox({ taskId: task.id, ownerId: "pod-a", reason: "x" })).toEqual(
        [],
      );
      expect((await repo.getById(row.id))?.status).toBe("responded");
    });
  });

  describe("getByIdForTask", () => {
    it("returns the row when it belongs to the task", async () => {
      const task = await insertTask();
      const row = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "owned",
          payload: assignmentPayload,
        },
        replyTargets: [linearTarget("sess-1")],
      });
      if (!row) throw new Error("insert failed");

      const found = await repo.getByIdForTask(row.id, task.id);
      expect(found?.id).toBe(row.id);
    });

    it("returns null when the row belongs to a different task (confused deputy)", async () => {
      const taskA = await insertTask({ externalId: "task-a" });
      const taskB = await insertTask({ externalId: "task-b" });
      const rowA = await repo.appendInbox({
        taskId: taskA.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "a-row",
          payload: assignmentPayload,
        },
        replyTargets: [linearTarget("sess-a")],
      });
      if (!rowA) throw new Error("insert failed");

      // A cross-task inbox_id must not resolve — getById would, getByIdForTask
      // must not.
      expect(await repo.getById(rowA.id)).not.toBeNull();
      expect(await repo.getByIdForTask(rowA.id, taskB.id)).toBeNull();
    });
  });

  describe("getAssignment", () => {
    it("returns the task's assignment row, never another round or another task's", async () => {
      const task = await insertTask();
      const other = await insertTask();
      await insertRow(task.id, { source: "github", kind: "comment", status: "pending" });
      const assignment = await insertRow(task.id, {
        source: "linear",
        kind: "assignment",
        status: "delivered",
      });

      expect((await repo.getAssignment(task.id))?.id).toBe(assignment.id);
      expect(await repo.getAssignment(other.id)).toBeNull();
    });
  });

  describe("markResponded", () => {
    it("owner match → status 'responded' + 1 row; owner mismatch / re-fire → 0 rows", async () => {
      const task = await insertTask({ ownerId: "pod-a" });
      const row = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "r",
          payload: assignmentPayload,
        },
        replyTargets: [linearTarget("sess-1")],
      });
      if (!row) throw new Error("insert failed");

      // Owner mismatch → 0 rows, status untouched.
      const wrongOwner = await repo.markResponded({
        inboxId: row.id,
        ownerId: "pod-x",
        outcome: null,
      });
      expect(wrongOwner).toEqual([]);
      expect((await repo.getById(row.id))?.status).toBe("pending");

      // Owner match → 1 row, status flips to 'responded'.
      const marked = await repo.markResponded({ inboxId: row.id, ownerId: "pod-a", outcome: null });
      expect(marked).toHaveLength(1);
      expect((await repo.getById(row.id))?.status).toBe("responded");

      // Already responded → 0 rows (idempotent re-fire).
      const again = await repo.markResponded({ inboxId: row.id, ownerId: "pod-a", outcome: null });
      expect(again).toEqual([]);
    });

    it("stores the completed event's status as outcome", async () => {
      const task = await insertTask({ ownerId: "pod-a" });
      const r = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "linear",
          kind: "assignment",
          external_id: "r",
          payload: assignmentPayload,
        },
        replyTargets: [],
      });
      if (!r) throw new Error("insert failed");
      await repo.markResponded({ inboxId: r.id, ownerId: "pod-a", outcome: "partial_failure" });
      const [row] = await db.execute<{ status: string; outcome: string | null }>(
        sql`SELECT status, outcome FROM inbox WHERE id = ${r.id}`,
      );
      expect(row).toEqual({ status: "responded", outcome: "partial_failure" });
    });
  });

  describe("markFailed", () => {
    it("owner match → status 'failed' + reason; owner mismatch / terminal → 0 rows", async () => {
      const task = await insertTask({ ownerId: "pod-a" });
      const row = await repo.appendInbox({
        taskId: task.id,
        message: {
          source: "github",
          kind: "comment",
          external_id: "c-1",
          payload: {
            target_id: "c-1",
            body: "b",
            task_id: "task-1",
            task_key: "T-1",
            pr: null,
            created_at: "",
          },
        },
        replyTargets: [linearTarget("c-1")],
      });
      if (!row) throw new Error("insert failed");

      // Owner mismatch → 0 rows, status untouched.
      const wrongOwner = await repo.markFailed({
        inboxId: row.id,
        ownerId: "pod-x",
        reason: "workspace_missing",
        userMessage: "msg",
      });
      expect(wrongOwner).toEqual([]);
      expect((await repo.getById(row.id))?.status).toBe("pending");

      // Owner match → 1 row, status flips to 'failed' + reason set.
      const marked = await repo.markFailed({
        inboxId: row.id,
        ownerId: "pod-a",
        reason: "workspace_missing",
        userMessage: "msg",
      });
      expect(marked).toHaveLength(1);
      const failed = await repo.getById(row.id);
      expect(failed?.status).toBe("failed");
      expect(failed?.failure_reason).toBe("workspace_missing");

      // Already terminal → 0 rows (no regression).
      const again = await repo.markFailed({
        inboxId: row.id,
        ownerId: "pod-a",
        reason: "workspace_missing",
        userMessage: "msg",
      });
      expect(again).toEqual([]);

      // A failed row is no longer pending — the sweep skips it.
      expect(await repo.listPendingByTask(task.id)).toEqual([]);
    });
  });

  describe("round_failed events", () => {
    const events = () =>
      db.execute<Record<string, unknown>>(
        sql`SELECT origin, type, inbox_id, seq::int AS seq, data FROM task_events ORDER BY id`,
      );

    it("failTaskInbox writes one round_failed per failed row of an API task, whatever the row's source", async () => {
      const task = await insertTask({ ownerId: "pod-a", source: "api" });
      const a = await insertRow(task.id, {
        source: "api",
        kind: "assignment",
        status: "delivered",
      });
      const c = await insertRow(task.id, { source: "github", kind: "comment", status: "pending" });
      await insertRow(task.id, { source: "api", kind: "comment", status: "responded" });

      await repo.failTaskInbox({ taskId: task.id, ownerId: "pod-a", reason: "Task failed." });

      const rows = [...(await events())];
      const byInbox = (x: Record<string, unknown>, y: Record<string, unknown>) =>
        String(x.inbox_id).localeCompare(String(y.inbox_id));
      expect(rows.sort(byInbox)).toEqual(
        [
          {
            origin: "control_plane",
            type: "round_failed",
            inbox_id: a.id,
            seq: null,
            data: { reason: "Task failed." },
          },
          {
            origin: "control_plane",
            type: "round_failed",
            inbox_id: c.id,
            seq: null,
            data: { reason: "Task failed." },
          },
        ].sort(byInbox),
      );
    });

    it("failTaskInbox on a Linear task writes nothing", async () => {
      const task = await insertTask({ ownerId: "pod-a" });
      await insertRow(task.id, { source: "linear", kind: "assignment", status: "delivered" });
      await repo.failTaskInbox({ taskId: task.id, ownerId: "pod-a", reason: "x" });
      expect([...(await events())]).toEqual([]);
    });

    it("markFailed writes round_failed with the user-facing message", async () => {
      const task = await insertTask({ ownerId: "pod-a", source: "api" });
      const r = await insertRow(task.id, { source: "api", kind: "comment", status: "pending" });
      await repo.markFailed({
        inboxId: r.id,
        ownerId: "pod-a",
        reason: "workspace_missing",
        userMessage: "The workspace is gone.",
      });
      expect([...(await events())]).toEqual([
        {
          origin: "control_plane",
          type: "round_failed",
          inbox_id: r.id,
          seq: null,
          data: { reason: "The workspace is gone." },
        },
      ]);
    });

    it("a lost lease fails nothing and logs nothing", async () => {
      const task = await insertTask({ ownerId: "pod-b", source: "api" });
      await insertRow(task.id, { source: "api", kind: "assignment", status: "delivered" });
      expect(await repo.failTaskInbox({ taskId: task.id, ownerId: "pod-a", reason: "x" })).toEqual(
        [],
      );
      expect([...(await events())]).toEqual([]);
    });
  });
});
