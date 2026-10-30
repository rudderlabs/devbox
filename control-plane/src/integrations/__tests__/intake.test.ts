import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { SQL } from "bun";
import { sql } from "drizzle-orm";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
mock.module("../../config", () => ({ config: { databaseUrl: TEST_DATABASE_URL } }));

const { db } = await import("../../db");
const { TaskRepository } = await import("../../repositories/task.repository");
const { InboxRepository } = await import("../../repositories/inbox.repository");
const { Intake } = await import("../intake");
const { migrate } = await import("drizzle-orm/bun-sql/migrator");

import type { ReplyTarget } from "../../repositories/inbox.repository";
import type { InboxMessageDraft, TaskIntake } from "../intake";

const session = (id: string, order?: number): ReplyTarget => ({
  id,
  spec: { kind: "linear_session" },
  ...(order === undefined ? {} : { order }),
});

const PR = "https://github.com/o/r/pull/7";
const ghComment = (id: string): InboxMessageDraft => ({
  source: "github",
  kind: "comment",
  external_id: id,
  payload: { target_id: id, body: "@bot fix", pr: { repo: "r", pr_url: PR }, created_at: "" },
});
const ghTarget = (id: string): ReplyTarget => ({
  id,
  spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 7, commentId: Number(id) },
});
const ciResult = (run: number): InboxMessageDraft => ({
  source: "github",
  kind: "ci_result",
  external_id: `workflow_run:${run}:1:7`,
  payload: {
    target_id: String(run),
    workflow_name: "CI",
    workflow_path: ".github/workflows/ci.yml",
    conclusion: "failure",
    run_url: "u",
    head_sha: "abc",
    head_branch: "b",
    pr: { repo: "r", pr_url: PR },
  },
});

async function insertTask(o: {
  source?: string;
  externalId?: string;
  key: string;
  prs?: string[];
}) {
  const prUrls = (o.prs ?? []).map((url) => ({ repo: "r", url, branch: "b", commit_sha: "c" }));
  const [row] = await db.execute<{ id: string; key: string }>(sql`
    INSERT INTO tasks (source, external_id, key, title, external_url, pr_urls)
         VALUES (${o.source ?? "api"}, ${o.externalId ?? crypto.randomUUID()}, ${o.key}, 't', 'u',
                 ${JSON.stringify(prUrls)}::text::jsonb)
    RETURNING id, key;`);
  return row as { id: string; key: string };
}

describe("Intake", () => {
  let killSandbox: ReturnType<typeof mock>;
  let detach: ReturnType<typeof mock>;
  let intake: TaskIntake;

  // A Linear `created`: issue-1 / ISS-1, delegated through `target`.
  const assignLinear = (
    target: ReplyTarget,
    o: Partial<Parameters<TaskIntake["assign"]>[0]> = {},
  ) =>
    intake.assign({
      source: "linear",
      externalId: "issue-1",
      key: { hint: "ISS-1" },
      title: "Fix auth",
      description: "desc",
      flags: [],
      url: () => "https://linear.app/x/issue/ISS-1",
      target: () => target,
      ...o,
    });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
    killSandbox = mock(() => Promise.resolve());
    detach = mock(() => {});
    intake = new Intake(
      new TaskRepository(),
      new InboxRepository(),
      { killSandbox },
      { detach },
      { apiKeyPrefix: "DBX-API-", ciResultMaxPerTask: 20 },
    );
  });

  describe("assign", () => {
    it("creates the task and its assignment round; the platform id is the round's external id", async () => {
      const requester = { id: "u-1", displayName: "Ann", codeHost: "unlinked" as const };
      const res = await assignLinear(session("sess-1"), { flags: ["FOO"], requester });
      expect(res).toEqual({ taskId: expect.any(String), key: "ISS-1", result: "created" });

      const [task] = await db.execute(
        sql`SELECT source, external_id, key, title, external_url, metadata FROM tasks`,
      );
      expect(task).toEqual({
        source: "linear",
        external_id: "issue-1",
        key: "ISS-1",
        title: "Fix auth",
        external_url: "https://linear.app/x/issue/ISS-1",
        metadata: { experimentalFlags: ["FOO"], requester },
      });
      const rounds = await db.execute(
        sql`SELECT source, kind, external_id, payload, reply_targets FROM inbox`,
      );
      expect([...rounds]).toEqual([
        {
          source: "linear",
          kind: "assignment",
          external_id: "issue-1",
          payload: {
            title: "Fix auth",
            description: "desc",
            external_url: "https://linear.app/x/issue/ISS-1",
            target_id: "sess-1",
            task_id: res.taskId,
            task_key: "ISS-1",
          },
          reply_targets: [session("sess-1")],
        },
      ]);
      // task_events is API-only.
      expect(await db.execute(sql`SELECT 1 FROM task_events`)).toHaveLength(0);
    });

    it("a hint another task holds, in any case, gets the source prefix", async () => {
      await insertTask({ key: "iss-1" });
      expect((await assignLinear(session("sess-1"))).key).toBe("LINEAR-ISS-1");
    });

    it("makes the hint branch-safe", async () => {
      expect((await assignLinear(session("sess-1"), { key: { hint: "ISS 1/x" } })).key).toBe(
        "ISS-1-x",
      );
    });

    it("retries once when a concurrent insert takes the key", async () => {
      // Another transaction holds an uncommitted task with the key: the check
      // doesn't see it, the insert waits on the index, then fails with 23505
      // once it commits, and the retry picks the prefixed key.
      const other = new SQL(TEST_DATABASE_URL);
      try {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        let inserted!: () => void;
        const ready = new Promise<void>((r) => {
          inserted = r;
        });
        const holder = other.begin(async (tx) => {
          await tx`INSERT INTO tasks (source, external_id, key, title, external_url)
                   VALUES ('api', 'other', 'ISS-1', 't', 'u')`;
          inserted();
          await gate;
        });
        await ready;
        const pending = assignLinear(session("sess-1"));
        await new Promise((r) => setTimeout(r, 150));
        release();
        await holder;
        expect((await pending).key).toBe("LINEAR-ISS-1");
      } finally {
        await other.close();
      }
    });

    it("compares delegation order when both targets carry one", async () => {
      await assignLinear(session("d:5", 5));
      expect((await assignLinear(session("d:3", 3))).result).toBe("duplicate");
      expect((await assignLinear(session("d:5", 5))).result).toBe("duplicate");
      expect((await assignLinear(session("d:7", 7))).result).toBe("restarted");
      const [round] = await db.execute<{ reply_targets: ReplyTarget[] }>(
        sql`SELECT reply_targets FROM inbox`,
      );
      expect(round?.reply_targets).toEqual([session("d:7", 7)]);
    });

    it("rejects an order that isn't a non-negative integer; a valid order still dedupes", async () => {
      await assignLinear(session("d:5", 5));
      for (const bad of [Number.NaN, -1, 1.5]) {
        await expect(assignLinear(session("d:5", bad))).rejects.toThrow(
          "target.order must be a non-negative integer",
        );
      }
      expect((await assignLinear(session("d:5", 5))).result).toBe("duplicate");
      const [round] = await db.execute<{ reply_targets: ReplyTarget[] }>(
        sql`SELECT reply_targets FROM inbox`,
      );
      expect(round?.reply_targets).toEqual([session("d:5", 5)]);
    });

    it("a duplicate kills nothing", async () => {
      const { taskId } = await assignLinear(session("sess-1"));
      await db.execute(sql`UPDATE tasks SET sandbox_id = 'sb-1' WHERE id = ${taskId}`);
      expect((await assignLinear(session("sess-1"))).result).toBe("duplicate");
      expect(killSandbox).not.toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
    });

    // Moved from agentSession.service.test ("kills the preempted sandbox when a
    // re-delegation restarts a live run"): intake now does the kill.
    it("kills the preempted sandbox when a re-delegation restarts a live run", async () => {
      const ann = { id: "u-1", displayName: "Ann", codeHost: "unlinked" as const };
      const { taskId } = await assignLinear(session("sess-1"), { flags: ["OLD"], requester: ann });
      await db.execute(
        sql`UPDATE tasks SET sandbox_id = 'sb-old', pvc_name = 'pvc-old' WHERE id = ${taskId}`,
      );

      const res = await assignLinear(session("sess-2"), {
        title: "Fix auth v2",
        url: () => "https://linear.app/x/issue/ISS-1/v2",
        flags: ["NEW"],
      });

      expect(res).toEqual({
        taskId,
        key: "ISS-1",
        result: "restarted",
        previousTargetId: "sess-1",
      });
      expect(killSandbox).toHaveBeenCalledTimes(1);
      expect(killSandbox).toHaveBeenCalledWith("sb-old");
      // In the tracked detached set, so shutdown drains it.
      expect(detach).toHaveBeenCalledWith(taskId, "killSandbox", expect.any(Promise));
      const [task] = await db.execute(
        sql`SELECT title, external_url, metadata, sandbox_id, pvc_name FROM tasks`,
      );
      // The old workspace volume is only unlinked, not deleted (§15 bug 6).
      expect(task).toEqual({
        title: "Fix auth v2",
        external_url: "https://linear.app/x/issue/ISS-1/v2",
        metadata: { experimentalFlags: ["NEW"] },
        sandbox_id: null,
        pvc_name: null,
      });
    });

    it("concurrent deliveries of one re-delegation restart the task once", async () => {
      // The task row lock serializes them: the first restarts, the rest read
      // the new target after it commits. Another transaction holds the
      // assignment row, so the first restart waits while the rest pile up.
      const { taskId } = await assignLinear(session("S0"));
      await db.execute(sql`UPDATE tasks SET sandbox_id = 'sb-old' WHERE id = ${taskId}`);
      const other = new SQL(TEST_DATABASE_URL);
      try {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        let locked!: () => void;
        const ready = new Promise<void>((r) => {
          locked = r;
        });
        const holder = other.begin(async (tx) => {
          await tx`SELECT 1 FROM inbox WHERE task_id = ${taskId} FOR UPDATE`;
          locked();
          await gate;
        });
        await ready;
        const pending = Promise.all(Array.from({ length: 6 }, () => assignLinear(session("S1"))));
        await new Promise((r) => setTimeout(r, 150));
        release();
        await holder;
        const results = (await pending).map((r) => r.result).sort();
        expect(results).toEqual([...Array(5).fill("duplicate"), "restarted"]);
      } finally {
        await other.close();
      }
      expect(killSandbox).toHaveBeenCalledTimes(1);
      expect(killSandbox).toHaveBeenCalledWith("sb-old");
    });

    it("rejects a target of another integration, and a hint without an external id", async () => {
      await expect(assignLinear({ id: "t", spec: { kind: "api_session" } })).rejects.toThrow(
        "a linear round can't carry a api_session reply target",
      );
      await expect(assignLinear(session("sess-1"), { externalId: undefined })).rejects.toThrow(
        "a hint key needs externalId",
      );
      expect(await db.execute(sql`SELECT 1 FROM tasks`)).toHaveLength(0);
    });
  });

  describe("followUp", () => {
    it("inserts the round with the task's identity; a redelivery is a duplicate", async () => {
      const task = await insertTask({ key: "DBX-API-1", prs: [PR] });
      const first = await intake.followUp({
        task,
        message: ghComment("555"),
        targets: [ghTarget("555")],
        prUrl: PR,
      });
      const [row] = await db.execute<{ id: string; payload: unknown }>(
        sql`SELECT id, payload FROM inbox`,
      );
      expect(first).toEqual({ roundId: (row as { id: string }).id });
      expect(row?.payload).toEqual({
        ...ghComment("555").payload,
        task_id: task.id,
        task_key: "DBX-API-1",
      });
      expect(
        await intake.followUp({ task, message: ghComment("555"), targets: [ghTarget("555")] }),
      ).toEqual({ dropped: "duplicate" });
      // A GitHub round on an API task writes nothing to the log.
      expect(await db.execute(sql`SELECT 1 FROM task_events`)).toHaveLength(0);
    });

    it("a review whose id equals a stored comment id is a duplicate while the old index exists", async () => {
      // characterization: changes in phase 3 (spec I9: the old (source, external_id) index goes)
      const task = await insertTask({ key: "DBX-API-1" });
      await intake.followUp({ task, message: ghComment("555"), targets: [ghTarget("555")] });
      const review = await intake.followUp({
        task,
        message: {
          source: "github",
          kind: "review",
          external_id: "555",
          payload: {
            review_body: { target_id: "555", body: "@bot" },
            inline_comments: [],
            pr: { repo: "r", pr_url: PR },
            created_at: "",
          },
        },
        targets: [
          {
            id: "555",
            spec: { kind: "review_body", owner: "o", repo: "r", prNumber: 7, reviewId: 555 },
          },
        ],
      });
      expect(review).toEqual({ dropped: "duplicate" });
    });

    it("drops a round whose PR is no longer on the task", async () => {
      const task = await insertTask({ key: "DBX-API-1" });
      expect(
        await intake.followUp({
          task,
          message: ghComment("555"),
          targets: [ghTarget("555")],
          prUrl: PR,
        }),
      ).toEqual({ dropped: "stale" });
      expect(await db.execute(sql`SELECT 1 FROM inbox`)).toHaveLength(0);
    });

    it("writes message_queued for an inserted API message only", async () => {
      const task = await insertTask({ key: "DBX-API-1" });
      const message: InboxMessageDraft = {
        source: "api",
        kind: "comment",
        external_id: "m-1",
        payload: { target_id: task.id, body: "more", pr: null, created_at: "" },
      };
      const targets: ReplyTarget[] = [{ id: task.id, spec: { kind: "api_session" } }];
      const first = await intake.followUp({ task, message, targets });
      expect(await intake.followUp({ task, message, targets })).toEqual({ dropped: "duplicate" });
      const events = await db.execute(sql`SELECT type, inbox_id, data FROM task_events`);
      expect([...events]).toEqual([
        {
          type: "message_queued",
          inbox_id: (first as { roundId: string }).roundId,
          data: { body: "more" },
        },
      ]);
    });

    // Moved from inbox.service.test ("enqueues when under the loop-breaker
    // threshold" / "drops the CI failure once the loop-breaker threshold is
    // reached"): the count now runs in the follow-up transaction.
    it("enqueues when under the loop-breaker threshold", async () => {
      const task = await insertTask({ key: "DBX-API-1" });
      for (let run = 1; run <= 19; run++) {
        await intake.followUp({ task, message: ciResult(run), targets: [ghTarget(String(run))] });
      }
      const res = await intake.followUp({ task, message: ciResult(20), targets: [ghTarget("20")] });
      expect(res).toEqual({ roundId: expect.any(String) });
    });

    it("drops the CI failure once the loop-breaker threshold is reached", async () => {
      const task = await insertTask({ key: "DBX-API-1" });
      for (let run = 1; run <= 20; run++) {
        await intake.followUp({ task, message: ciResult(run), targets: [ghTarget(String(run))] });
      }
      const res = await intake.followUp({ task, message: ciResult(21), targets: [ghTarget("21")] });
      expect(res).toEqual({ dropped: "ci_limit" });
      const [n] = await db.execute(sql`SELECT count(*)::int AS n FROM inbox`);
      expect(n).toEqual({ n: 20 });
    });

    it("checks payload.target_id against targets[0] (reviews exempt) and target kinds", async () => {
      const task = await insertTask({ key: "DBX-API-1" });
      await expect(
        intake.followUp({ task, message: ghComment("555"), targets: [ghTarget("556")] }),
      ).rejects.toThrow("payload.target_id must equal targets[0].id");
      await expect(
        intake.followUp({ task, message: ghComment("555"), targets: [session("555")] }),
      ).rejects.toThrow("a github round can't carry a linear_session reply target");
      // A review's targets[0] is its first inline comment; it has no target_id.
      const review = await intake.followUp({
        task,
        message: {
          source: "github",
          kind: "review",
          external_id: "88",
          payload: {
            review_body: { target_id: "88", body: "@bot" },
            inline_comments: [{ target_id: "11", path: "a.ts", line: 3, body: "nit" }],
            pr: { repo: "r", pr_url: PR },
            created_at: "",
          },
        },
        targets: [ghTarget("11")],
      });
      expect(review).toEqual({ roundId: expect.any(String) });
    });
  });

  it("restart is API-only", async () => {
    const task = await insertTask({ source: "linear", externalId: "issue-1", key: "ISS-1" });
    const def = { title: "T2", description: null, flags: [] };
    await expect(intake.restart(task.id, def)).rejects.toThrow("is not an API task");
    const [row] = await db.execute(sql`SELECT title FROM tasks`);
    expect(row).toEqual({ title: "t" });
  });

  it("findTask matches on source and external id", async () => {
    const t = await insertTask({ source: "linear", externalId: "issue-9", key: "ISS-9" });
    expect((await intake.findTask("linear", "issue-9"))?.id).toBe(t.id);
    expect(await intake.findTask("api", "issue-9")).toBeNull();
  });
});
