import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { sql } from "drizzle-orm";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
mock.module("../../config", () => ({ config: { databaseUrl: TEST_DATABASE_URL } }));

const { db } = await import("../../db");
const { ApiTaskRepository } = await import("../../repositories/apiTask.repository");
const { InboxRepository } = await import("../../repositories/inbox.repository");
const { TaskRepository } = await import("../../repositories/task.repository");
const { Intake } = await import("../../integrations/intake");
const { TaskEventRepository } = await import("../../repositories/taskEvent.repository");
const { ApiTaskService } = await import("../apiTask.service");
const { ApiError } = await import("../../errors");

import type { ApiTask } from "../../types/api";

const { migrate } = await import("drizzle-orm/bun-sql/migrator");

const T0 = "2026-10-07T12:00:00.000Z";
const principal = { tokenId: "", name: "frodo" };

describe("ApiTaskService", () => {
  let killSandbox: ReturnType<typeof mock>;
  let service: InstanceType<typeof ApiTaskService>;

  const freeze = async () => {
    await db.execute(sql`UPDATE tasks SET created_at = ${T0}, updated_at = ${T0}`);
    await db.execute(sql`UPDATE inbox SET created_at = ${T0}, updated_at = ${T0}`);
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
    await db.execute(sql`ALTER SEQUENCE api_task_key_seq RESTART`);
    const [tok] = await db.execute<{ id: string }>(
      sql`INSERT INTO api_tokens (name, secret_hash) VALUES ('frodo', 'h') RETURNING id`,
    );
    principal.tokenId = (tok as { id: string }).id;
    killSandbox = mock(() => Promise.resolve());
    const intake = new Intake(
      new TaskRepository(),
      new InboxRepository(),
      { killSandbox },
      { detach: () => {} },
      { apiKeyPrefix: "DBX-API-", ciResultMaxPerTask: 20 },
    );
    service = new ApiTaskService(new ApiTaskRepository(), intake, new TaskEventRepository(), {
      publicBaseUrl: "https://api.example",
      now: () => new Date(T0),
    });
  });

  it("create returns the whole task resource", async () => {
    const created = await service.create(principal, {
      title: "T",
      description: "D",
      experimentalFlags: ["FOO"],
    });
    await freeze();
    expect(await service.get("DBX-API-1")).toEqual({
      id: created.id,
      key: "DBX-API-1",
      source: "api",
      title: "T",
      description: "D",
      external_url: "https://api.example/api/tasks/DBX-API-1",
      created_by: { id: principal.tokenId, name: "frodo" },
      experimental_flags: ["FOO"],
      state: "queued",
      sandbox_live: false,
      prs: [],
      rounds: [
        {
          id: expect.any(String),
          source: "api",
          kind: "assignment",
          status: "pending",
          outcome: null,
          failure_reason: null,
          created_at: T0,
        },
      ],
      created_at: T0,
      updated_at: T0,
    });
  });

  it("get resolves a lower-case key and the task id; unknown refs are 404 task_not_found", async () => {
    const created = await service.create(null, {
      title: "T",
      description: null,
      experimentalFlags: [],
    });
    expect((await service.get("dbx-api-1")).id).toBe(created.id);
    expect((await service.get(created.id)).key).toBe("DBX-API-1");
    await expect(service.get("NOPE-1")).rejects.toEqual(
      new ApiError(404, "task_not_found", "Task not found"),
    );
  });

  it("maps PRs", async () => {
    const { id } = await service.create(null, {
      title: "T",
      description: null,
      experimentalFlags: [],
    });
    await db.execute(sql`
      UPDATE tasks
         SET pr_urls = '[{"repo":"acme/x","url":"https://github.com/acme/x/pull/1","branch":"devbox/DBX-API-1-t","commit_sha":"abc"}]'::jsonb
       WHERE id = ${id}`);
    const t = await service.get(id);
    expect(t.prs).toEqual([
      {
        repo: "acme/x",
        url: "https://github.com/acme/x/pull/1",
        branch: "devbox/DBX-API-1-t",
      },
    ]);
  });

  it("sendMessage returns the round id; Linear tasks are 409 not_api_task", async () => {
    await service.create(null, { title: "T", description: null, experimentalFlags: [] });
    const { round_id } = await service.sendMessage("DBX-API-1", "more");
    expect((await service.get("DBX-API-1")).rounds[0]?.id).toBe(round_id);

    await db.execute(sql`INSERT INTO tasks (source, external_id, key, title, external_url)
                         VALUES ('linear', 'i', 'ABC-1', 'l', 'https://linear.app/x/issue/ABC-1')`);
    await expect(service.sendMessage("ABC-1", "x")).rejects.toEqual(
      new ApiError(409, "not_api_task", "Only API tasks can be changed through the API"),
    );
    await expect(
      service.restart("ABC-1", { title: "x", description: null, experimentalFlags: [] }),
    ).rejects.toEqual(
      new ApiError(409, "not_api_task", "Only API tasks can be changed through the API"),
    );
  });

  // The whole task after a restart: pending assignment round, no live sandbox.
  const restartedTask = (id: string, fields: Partial<ApiTask>): ApiTask => ({
    id,
    key: "DBX-API-1",
    source: "api",
    title: "T",
    description: null,
    external_url: "https://api.example/api/tasks/DBX-API-1",
    created_by: null,
    experimental_flags: [],
    state: "queued",
    sandbox_live: false,
    prs: [],
    rounds: [
      {
        id: expect.any(String),
        source: "api",
        kind: "assignment",
        status: "pending",
        outcome: null,
        failure_reason: null,
        created_at: T0,
      },
    ],
    created_at: T0,
    updated_at: T0,
    ...fields,
  });

  it("restart with null description and no flags replaces the definition", async () => {
    const { id } = await service.create(null, {
      title: "T",
      description: "D",
      experimentalFlags: ["FOO"],
    });
    await db.execute(sql`UPDATE tasks SET sandbox_id = 'sbx-old' WHERE id = ${id}`);
    await service.restart("DBX-API-1", { title: "T2", description: null, experimentalFlags: [] });
    await freeze();
    expect(await service.get("DBX-API-1")).toEqual(restartedTask(id, { title: "T2" }));
  });

  it("restart with every field set replaces them", async () => {
    const { id } = await service.create(null, {
      title: "T",
      description: null,
      experimentalFlags: ["FOO"],
    });
    await service.restart("DBX-API-1", {
      title: "T3",
      description: "D3",
      experimentalFlags: ["BAR"],
    });
    await freeze();
    expect(await service.get("DBX-API-1")).toEqual(
      restartedTask(id, { title: "T3", description: "D3", experimental_flags: ["BAR"] }),
    );
  });

  it("restart kills the previous sandbox", async () => {
    const { id } = await service.create(null, {
      title: "T",
      description: null,
      experimentalFlags: [],
    });
    await db.execute(sql`UPDATE tasks SET sandbox_id = 'sbx-old' WHERE id = ${id}`);
    await service.restart("DBX-API-1", { title: "T", description: null, experimentalFlags: [] });
    expect(killSandbox).toHaveBeenCalledWith("sbx-old");
  });

  it("restart resets the run, re-pends a failed assignment and only kills the old sandbox", async () => {
    const { id } = await service.create(principal, {
      title: "T",
      description: null,
      experimentalFlags: ["FOO"],
    });
    await db.execute(sql`
      UPDATE tasks
         SET owner_id = 'pod-a', heartbeat_at = now(), sandbox_id = 'sbx-old', pvc_name = 'pvc-old',
             last_observed_event_seq = 9, metadata = metadata || '{"retryCount":2}'::jsonb,
             pr_urls = '[{"repo":"r","url":"https://github.com/o/r/pull/1","branch":"b","commit_sha":"c"}]'::jsonb
       WHERE id = ${id}`);
    await db.execute(sql`
      UPDATE inbox SET status = 'failed', failure_reason = 'boom', outcome = 'failed'
       WHERE task_id = ${id}`);
    const [before] = await db.execute<{ id: string }>(sql`SELECT id FROM inbox`);

    await service.restart("DBX-API-1", { title: "T2", description: null, experimentalFlags: [] });

    const [task] = await db.execute(sql`
      SELECT key, external_url, created_by, owner_id, heartbeat_at, sandbox_id, pvc_name,
             last_observed_event_seq::int AS seq, pr_urls, metadata
        FROM tasks WHERE id = ${id}`);
    expect(task).toEqual({
      key: "DBX-API-1",
      external_url: "https://api.example/api/tasks/DBX-API-1",
      created_by: principal.tokenId,
      owner_id: null,
      heartbeat_at: null,
      sandbox_id: null,
      pvc_name: null,
      seq: 0,
      pr_urls: [],
      metadata: { experimentalFlags: [] },
    });
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id, status, failure_reason, outcome FROM inbox`,
    );
    expect([...rows]).toEqual([
      { id: expect.any(String), status: "pending", failure_reason: null, outcome: null },
    ]);
    expect(rows[0]?.id).not.toBe((before as { id: string }).id);
    // The old workspace volume is not deleted, only unlinked (spec §15 bug 6, out of scope).
    expect(killSandbox).toHaveBeenCalledTimes(1);
    expect(killSandbox).toHaveBeenCalledWith("sbx-old");
  });

  it("sendMessage is not idempotent: the same body twice queues two rounds", async () => {
    await service.create(null, { title: "T", description: null, experimentalFlags: [] });
    const a = await service.sendMessage("DBX-API-1", "again");
    const b = await service.sendMessage("DBX-API-1", "again");
    expect(a.round_id).not.toBe(b.round_id);
    const queued = await db.execute(
      sql`SELECT type FROM task_events WHERE type = 'message_queued'`,
    );
    expect(queued).toHaveLength(2);
  });

  it("restart with no previous sandbox kills nothing", async () => {
    await service.create(null, { title: "T", description: null, experimentalFlags: [] });
    await service.restart("DBX-API-1", { title: "T2", description: null, experimentalFlags: [] });
    expect(killSandbox).not.toHaveBeenCalled();
  });

  it("list: created_by=me uses the principal; with auth off it matches nothing; next_before pages", async () => {
    await service.create(principal, { title: "a", description: null, experimentalFlags: [] });
    await service.create(null, { title: "b", description: null, experimentalFlags: [] });
    await service.create(principal, { title: "c", description: null, experimentalFlags: [] });
    const mine = await service.list(principal, { createdBy: "me", limit: 1 });
    expect(mine.tasks.map((t) => t.title)).toEqual(["c"]);
    expect(mine.next_before).toBe(mine.tasks[0]?.id ?? null);
    const page2 = await service.list(principal, {
      createdBy: "me",
      limit: 1,
      before: mine.next_before ?? undefined,
    });
    expect({ titles: page2.tasks.map((t) => t.title), next: page2.next_before }).toEqual({
      titles: ["a"],
      next: null,
    });
    expect((await service.list(null, { createdBy: "me", limit: 20 })).tasks).toEqual([]);
  });

  it("events: envelopes after the cursor; Linear tasks report logging unavailable", async () => {
    const { id } = await service.create(null, {
      title: "T",
      description: null,
      experimentalFlags: [],
    });
    await db.execute(sql`UPDATE task_events SET created_at = ${T0}`);
    expect(await service.events("DBX-API-1", 0, 200)).toEqual({
      events: [
        {
          id: 1,
          task_id: id,
          origin: "control_plane",
          type: "task_created",
          round_id: expect.any(String),
          seq: null,
          created_at: T0,
          data: { title: "T", description: null, experimental_flags: [] },
        },
      ],
      next_after: 1,
      logging: "available",
    });
    expect(await service.events("DBX-API-1", 1, 200)).toEqual({
      events: [],
      next_after: 1,
      logging: "available",
    });
    await db.execute(sql`INSERT INTO tasks (source, external_id, key, title, external_url)
                         VALUES ('linear', 'i', 'ABC-1', 'l', 'https://linear.app/x/issue/ABC-1')`);
    expect(await service.events("ABC-1", 0, 200)).toEqual({
      events: [],
      next_after: 0,
      logging: "unavailable",
    });
  });
});
