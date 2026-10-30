import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { SQL } from "bun";
import { sql } from "drizzle-orm";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
mock.module("../../config", () => ({ config: { databaseUrl: TEST_DATABASE_URL } }));

const { db } = await import("../../db");
const { ApiTaskRepository } = await import("../apiTask.repository");
const { TaskRepository } = await import("../task.repository");
const { InboxRepository, apiSessionTarget } = await import("../inbox.repository");
const { migrate } = await import("drizzle-orm/bun-sql/migrator");

const repo = new ApiTaskRepository();
const taskRepo = new TaskRepository();
const inboxRepo = new InboxRepository();
const T0 = "2026-10-07T12:00:00.000Z";

// An API create: assign with a sequence key, as TaskIntake does it.
const create = async (o: { createdBy?: string } = {}) => {
  const t = await taskRepo.assign({
    source: "api",
    key: { sequencePrefix: "DBX-API-" },
    title: "Add a thing",
    description: "Please",
    flags: ["FOO"],
    url: (ref) => `https://api.example/api/tasks/${ref.key}`,
    target: (ref) => apiSessionTarget(ref.id),
    createdBy: o.createdBy,
  });
  return { taskId: t.id, key: t.key };
};

// An API message: a comment round through the follow-up transaction.
const appendMessage = async (p: { task: { id: string; key: string }; body: string }) => {
  const result = await inboxRepo.appendFollowUp({
    taskId: p.task.id,
    message: {
      source: "api",
      kind: "comment",
      external_id: crypto.randomUUID(),
      payload: {
        target_id: p.task.id,
        body: p.body,
        pr: null,
        created_at: T0,
        task_id: p.task.id,
        task_key: p.task.key,
      },
    },
    replyTargets: [apiSessionTarget(p.task.id)],
    ciResultMax: 0,
  });
  if (!("roundId" in result)) throw new Error(`dropped: ${result.dropped}`);
  return result;
};

// Pins every DB timestamp of a task to T0 (+ offsets for inbox rows) so whole
// records compare exactly.
async function freeze(taskId: string): Promise<void> {
  await db.execute(
    sql`UPDATE tasks SET created_at = ${T0}, updated_at = ${T0} WHERE id = ${taskId}`,
  );
  await db.execute(
    sql`UPDATE inbox SET created_at = ${T0}, updated_at = ${T0} WHERE task_id = ${taskId}`,
  );
}

async function addRound(
  taskId: string,
  o: { kind?: string; status: string; outcome?: string | null; minutesAgo: number },
): Promise<string> {
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO inbox (task_id, source, kind, external_id, payload, status, outcome, created_at, updated_at)
         VALUES (${taskId}, 'api', ${o.kind ?? "comment"}, ${crypto.randomUUID()}, '{}'::jsonb,
                 ${o.status}, ${o.outcome ?? null},
                 now() - (${`${o.minutesAgo} minutes`})::interval,
                 now() - (${`${o.minutesAgo} minutes`})::interval)
    RETURNING id;`);
  return (row as { id: string }).id;
}

describe("ApiTaskRepository", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
    await db.execute(sql`ALTER SEQUENCE api_task_key_seq RESTART`);
  });

  describe("assign (API create)", () => {
    it("inserts the task, the assignment row and task_created in one transaction", async () => {
      const { taskId, key } = await create();
      expect(key).toBe("DBX-API-1");
      await freeze(taskId);

      const record = await repo.findById(taskId);
      const [assignment] = await db.execute<{ id: string }>(
        sql`SELECT id FROM inbox WHERE task_id = ${taskId}`,
      );
      const roundId = (assignment as { id: string }).id;
      expect(record).toEqual({
        id: taskId,
        key: "DBX-API-1",
        source: "api",
        title: "Add a thing",
        description: "Please",
        external_url: "https://api.example/api/tasks/DBX-API-1",
        metadata: { experimentalFlags: ["FOO"] },
        sandbox_id: null,
        pr_urls: [],
        created_by: null,
        creator_name: null,
        state: "queued",
        rounds: [
          {
            id: roundId,
            source: "api",
            kind: "assignment",
            status: "pending",
            outcome: null,
            failure_reason: null,
            created_at: T0,
          },
        ],
        created_at: new Date(T0),
        updated_at: new Date(T0),
      });

      const inbox = await db.execute(
        sql`SELECT source, kind, external_id, payload, reply_targets FROM inbox`,
      );
      expect([...inbox]).toEqual([
        {
          source: "api",
          kind: "assignment",
          external_id: "DBX-API-1",
          payload: {
            title: "Add a thing",
            description: "Please",
            external_url: "https://api.example/api/tasks/DBX-API-1",
            target_id: taskId,
            task_id: taskId,
            task_key: "DBX-API-1",
          },
          reply_targets: [{ id: taskId, spec: { kind: "api_session" } }],
        },
      ]);
      const events = await db.execute(
        sql`SELECT origin, type, inbox_id, seq, data FROM task_events`,
      );
      expect([...events]).toEqual([
        {
          origin: "control_plane",
          type: "task_created",
          inbox_id: roundId,
          seq: null,
          data: { title: "Add a thing", description: "Please", experimental_flags: ["FOO"] },
        },
      ]);
    });

    it("gives concurrent creates distinct keys", async () => {
      const keys = (await Promise.all([create(), create(), create()])).map((r) => r.key).sort();
      expect(keys).toEqual(["DBX-API-1", "DBX-API-2", "DBX-API-3"]);
    });

    it("rolls back the task and inbox row when the event insert fails", async () => {
      await db.execute(
        sql`ALTER TABLE task_events ADD CONSTRAINT test_block CHECK (type <> 'task_created')`,
      );
      try {
        await expect(create()).rejects.toThrow();
        const [n] = await db.execute<{ n: number }>(
          sql`SELECT (SELECT count(*) FROM tasks)::int + (SELECT count(*) FROM inbox)::int AS n`,
        );
        expect(n).toEqual({ n: 0 });
      } finally {
        await db.execute(sql`ALTER TABLE task_events DROP CONSTRAINT test_block`);
      }
    });
  });

  describe("appendFollowUp (API message)", () => {
    it("inserts a comment row and message_queued atomically", async () => {
      const { taskId, key } = await create();
      const { roundId } = await appendMessage({ task: { id: taskId, key }, body: "more" });
      const [row] = await db.execute(
        sql`SELECT source, kind, payload, reply_targets FROM inbox WHERE id = ${roundId}`,
      );
      expect(row).toEqual({
        source: "api",
        kind: "comment",
        payload: {
          target_id: taskId,
          body: "more",
          pr: null,
          created_at: T0,
          task_id: taskId,
          task_key: key,
        },
        reply_targets: [{ id: taskId, spec: { kind: "api_session" } }],
      });
      const events = await db.execute(
        sql`SELECT type, inbox_id, data FROM task_events ORDER BY id`,
      );
      expect([...events].slice(1)).toEqual([
        { type: "message_queued", inbox_id: roundId, data: { body: "more" } },
      ]);
    });

    it("rolls back the comment row when the event insert fails", async () => {
      const { taskId, key } = await create();
      await db.execute(
        sql`ALTER TABLE task_events ADD CONSTRAINT test_block CHECK (type <> 'message_queued')`,
      );
      try {
        await expect(appendMessage({ task: { id: taskId, key }, body: "x" })).rejects.toThrow();
        const [n] = await db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM inbox WHERE kind = 'comment'`,
        );
        expect(n).toEqual({ n: 0 });
      } finally {
        await db.execute(sql`ALTER TABLE task_events DROP CONSTRAINT test_block`);
      }
    });
  });

  describe("derived task state", () => {
    const stateOf = async (taskId: string) => (await repo.findById(taskId))?.state;
    const bare = async (sandboxId: string | null) => {
      const { taskId } = await create();
      await db.execute(sql`DELETE FROM inbox WHERE task_id = ${taskId}`);
      await db.execute(sql`UPDATE tasks SET sandbox_id = ${sandboxId} WHERE id = ${taskId}`);
      return taskId;
    };

    it("queued: a round is pending and there is no sandbox", async () => {
      const t = await bare(null);
      await addRound(t, { status: "pending", minutesAgo: 1 });
      expect(await stateOf(t)).toBe("queued");
    });
    it("queued: a round is delivered and there is no sandbox", async () => {
      const t = await bare(null);
      await addRound(t, { status: "delivered", minutesAgo: 1 });
      expect(await stateOf(t)).toBe("queued");
    });
    it("running: a round is open and the sandbox is set", async () => {
      const t = await bare("sbx");
      await addRound(t, { status: "responded", outcome: "failed", minutesAgo: 0 });
      await addRound(t, { status: "delivered", minutesAgo: 5 });
      expect(await stateOf(t)).toBe("running");
    });
    it("failed: no open round and the latest is failed", async () => {
      const t = await bare(null);
      await addRound(t, { status: "responded", outcome: "completed", minutesAgo: 5 });
      await addRound(t, { status: "failed", minutesAgo: 1 });
      expect(await stateOf(t)).toBe("failed");
    });
    it("failed: no open round and the latest has outcome failed", async () => {
      const t = await bare(null);
      await addRound(t, { status: "responded", outcome: "failed", minutesAgo: 1 });
      expect(await stateOf(t)).toBe("failed");
    });
    it.each(["completed", "partial_failure", "no_action", null])(
      "idle: no open round and the latest is responded with outcome %p",
      async (outcome) => {
        const t = await bare("sbx");
        await addRound(t, { status: "failed", minutesAgo: 5 });
        await addRound(t, { status: "responded", outcome, minutesAgo: 1 });
        expect(await stateOf(t)).toBe("idle");
      },
    );
    it("restart superseding a follow-up, then a successful re-run, gives idle", async () => {
      const { taskId } = await create();
      await addRound(taskId, { status: "pending", minutesAgo: 0 });
      await taskRepo.restartTaskWithInbox({
        taskId,
        inboxPayload: { title: "t", description: null, external_url: "u", target_id: taskId },
        inboxReplyTargets: [{ id: taskId, spec: { kind: "api_session" } }],
      });
      // The re-run completes later than the superseded follow-up's failure.
      await db.execute(sql`
        UPDATE inbox SET status = 'responded', outcome = 'completed', updated_at = now() + interval '1 minute'
         WHERE task_id = ${taskId} AND kind = 'assignment'`);
      expect(await stateOf(taskId)).toBe("idle");
    });
  });

  describe("list", () => {
    it("filters by source, state, created_by and pages newest first with before", async () => {
      const [tok] = await db.execute<{ id: string }>(
        sql`INSERT INTO api_tokens (name, secret_hash) VALUES ('frodo', 'h') RETURNING id`,
      );
      const tokenId = (tok as { id: string }).id;
      const a = await create({ createdBy: tokenId });
      const b = await create();
      const c = await create({ createdBy: tokenId });
      await db.execute(sql`
        INSERT INTO tasks (source, external_id, key, title, external_url)
             VALUES ('linear', 'issue-1', 'ABC-1', 'lin', 'https://linear.app/x/issue/ABC-1')`);

      const keys = async (f: Parameters<typeof repo.list>[0]) =>
        (await repo.list(f)).map((r) => r.key);
      expect(await keys({ limit: 10 })).toEqual(["ABC-1", c.key, b.key, a.key]);
      expect(await keys({ limit: 10, source: "linear" })).toEqual(["ABC-1"]);
      expect(await keys({ limit: 10, createdBy: tokenId })).toEqual([c.key, a.key]);
      expect(await keys({ limit: 10, createdBy: null })).toEqual([]);
      // Move b to idle so the state filter has something to exclude.
      await db.execute(sql`UPDATE inbox SET status = 'responded' WHERE task_id = ${b.taskId}`);
      expect(await keys({ limit: 10, state: "queued" })).toEqual([c.key, a.key]);
      expect(await keys({ limit: 10, state: "idle" })).toEqual(["ABC-1", b.key]);
      expect(await keys({ limit: 1, before: c.taskId })).toEqual([b.key]);
      expect((await repo.list({ limit: 10, createdBy: tokenId }))[0]?.creator_name).toBe("frodo");
    });
  });

  describe("restartTaskWithInbox (API)", () => {
    it("applies title, description and flags and writes task_restarted in the same transaction", async () => {
      const { taskId } = await create();
      const followUp = await addRound(taskId, { status: "pending", minutesAgo: 0 });
      const res = await taskRepo.restartTaskWithInbox({
        taskId,
        inboxPayload: { title: "New", description: "D2", external_url: "u", target_id: taskId },
        inboxReplyTargets: [{ id: taskId, spec: { kind: "api_session" } }],
        api: { title: "New", description: "D2", experimentalFlags: ["BAR"] },
      });
      expect(res).toEqual({
        prevSandboxId: null,
        assignmentId: expect.any(String),
        supersededRoundIds: [followUp],
      });
      const record = await repo.findById(taskId);
      expect({
        title: record?.title,
        description: record?.description,
        metadata: record?.metadata,
      }).toEqual({
        title: "New",
        description: "D2",
        metadata: { experimentalFlags: ["BAR"] },
      });
      const events = await db.execute(
        sql`SELECT type, inbox_id, data FROM task_events ORDER BY id`,
      );
      expect([...events].slice(1)).toEqual([
        {
          type: "task_restarted",
          inbox_id: res.assignmentId,
          data: {
            title: "New",
            description: "D2",
            experimental_flags: ["BAR"],
            superseded_round_ids: [followUp],
          },
        },
      ]);
    });

    it("rolls back the whole restart when the event insert fails", async () => {
      const { taskId } = await create();
      await db.execute(sql`UPDATE tasks SET sandbox_id = 'sbx-old' WHERE id = ${taskId}`);
      await db.execute(
        sql`ALTER TABLE task_events ADD CONSTRAINT test_block CHECK (type <> 'task_restarted')`,
      );
      try {
        await expect(
          taskRepo.restartTaskWithInbox({
            taskId,
            inboxPayload: { title: "New", description: null, external_url: "u", target_id: taskId },
            inboxReplyTargets: [{ id: taskId, spec: { kind: "api_session" } }],
            api: { title: "New", description: null, experimentalFlags: [] },
          }),
        ).rejects.toThrow();
        expect((await repo.findById(taskId))?.title).toBe("Add a thing");
        expect((await repo.findById(taskId))?.sandbox_id).toBe("sbx-old");
      } finally {
        await db.execute(sql`ALTER TABLE task_events DROP CONSTRAINT test_block`);
      }
    });
  });

  it("getStreamState", async () => {
    const { taskId } = await create();
    expect(await repo.getStreamState(taskId)).toEqual({ state: "queued", sandbox_live: false });
    expect(await repo.getStreamState("0192f000-0000-7000-8000-000000000999")).toBeNull();
  });

  // task_events.id is taken at INSERT but visible only at COMMIT. A reader that
  // advances its cursor past a committed id must never later see a smaller one
  // appear, so every per-task log writer serializes on the tasks row and ids are
  // handed out in commit order.
  describe("event log ordering", () => {
    const other = new SQL(TEST_DATABASE_URL);
    afterAll(async () => {
      await other.close();
    });

    const PENDING = Symbol("pending");
    const settledWithin = <T>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);

    // Runs a recordEventCursor-shaped write (UPDATE tasks, then a daemon event)
    // on a second connection and keeps its transaction open until release().
    async function holdDaemonWrite(taskId: string) {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let written!: () => void;
      const ready = new Promise<void>((r) => {
        written = r;
      });
      const done = other.begin(async (tx) => {
        await tx`UPDATE tasks SET last_observed_event_seq = 1 WHERE id = ${taskId}`;
        await tx`INSERT INTO task_events (task_id, origin, type, seq, data)
                 VALUES (${taskId}, 'daemon', 'agent_action', 1, '{}'::jsonb)`;
        written();
        await gate;
      });
      await ready;
      return { release, done };
    }

    const logTypes = async (taskId: string) =>
      [
        ...(await db.execute<{ type: string }>(
          sql`SELECT type FROM task_events WHERE task_id = ${taskId} ORDER BY id`,
        )),
      ].map((r) => r.type);

    async function expectSerialized(
      taskId: string,
      write: () => Promise<unknown>,
      cpType: string,
    ): Promise<void> {
      const holder = await holdDaemonWrite(taskId);
      const pending = write();
      try {
        expect(await settledWithin(pending, 150)).toBe(PENDING);
      } finally {
        holder.release();
        await holder.done;
        await pending;
      }
      expect(await logTypes(taskId)).toEqual(["task_created", "agent_action", cpType]);
    }

    it("an API message waits for a concurrent per-task writer to commit", async () => {
      const { taskId, key } = await create();
      await expectSerialized(
        taskId,
        () => appendMessage({ task: { id: taskId, key }, body: "more" }),
        "message_queued",
      );
    });

    it("failTaskInbox waits for a concurrent per-task writer to commit", async () => {
      const { taskId } = await create();
      await db.execute(sql`UPDATE tasks SET owner_id = 'pod-a' WHERE id = ${taskId}`);
      await expectSerialized(
        taskId,
        () => inboxRepo.failTaskInbox({ taskId, ownerId: "pod-a", reason: "boom" }),
        "round_failed",
      );
    });

    it("markFailed waits for a concurrent per-task writer to commit", async () => {
      const { taskId } = await create();
      await db.execute(sql`UPDATE tasks SET owner_id = 'pod-a' WHERE id = ${taskId}`);
      const [round] = await db.execute<{ id: string }>(
        sql`SELECT id FROM inbox WHERE task_id = ${taskId}`,
      );
      const inboxId = (round as { id: string }).id;
      await expectSerialized(
        taskId,
        () =>
          inboxRepo.markFailed({
            inboxId,
            ownerId: "pod-a",
            reason: "pvc_missing",
            userMessage: "gone",
          }),
        "round_failed",
      );
    });
  });
});
