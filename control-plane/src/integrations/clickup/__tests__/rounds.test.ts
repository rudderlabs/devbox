// ClickUp's rounds as the harness reads them: webhooks run through ClickUp
// into a real TaskService and database, and the sweep writes the inbox files
// to a fake sandbox. A ClickUp comment must have the shape of the comment
// rounds the harness contract pins (Linear's and the API's, which reply
// outside a PR), and an assignment the shape of theirs.
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { sql } from "drizzle-orm";
import contract from "../../../__tests__/harnessContract.fixture.json";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
mock.module("../../../config", () => ({
  config: { databaseUrl: TEST_DATABASE_URL, podId: "pod-test" },
}));

const { db } = await import("../../../db");
const { TaskRepository } = await import("../../../repositories/task.repository");
const { InboxRepository } = await import("../../../repositories/inbox.repository");
const { BoundTaskService } = await import("../../../services/task.service");
const { InboxService } = await import("../../../services/inbox.service");
const { createWebhookRoutes } = await import("../../../routes/webhook");
const { logger } = await import("../../../logger");
const { migrate } = await import("drizzle-orm/bun-sql/migrator");
const { createClickUp } = await import("../index");
const { assignmentEvent, BOT, CFG, commentEvent, fakeClient, ITEM_ID, NOW, sign, tag, text } =
  await import("./fixtures");

import type { Task } from "../../../db/schema";
import type { SandboxManager } from "../../../services/sandboxManager.service";

type File = { source: string; kind: string; payload: Record<string, unknown> };
// A file's keys, and its payload's, sorted.
const shape = (f: File) => ({
  keys: Object.keys(f).sort(),
  payload: Object.keys(f.payload).sort(),
});
const pinned = (source: string, kind: string) => {
  const entry = (contract as { body: File }[]).find(
    (e) => e.body.source === source && e.body.kind === kind,
  );
  if (!entry) throw new Error(`the contract has no ${source} ${kind}`);
  return entry.body;
};

describe("ClickUp rounds", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
  });

  it("reach the harness in the shape of the pinned rounds, and restart on a later assignment", async () => {
    const writes: { path: string; body: string }[] = [];
    const sandboxManager = {
      writeHarnessFile: async (_sandboxId: string, path: string, body: string) => {
        writes.push({ path, body });
      },
      killSandbox: async () => {},
    } as unknown as SandboxManager;
    const taskRepo = new TaskRepository();
    const inboxRepo = new InboxRepository();
    const tasks = new BoundTaskService("clickup", {
      createsTasks: true,
      taskRepo,
      inboxRepo,
      sandboxManager,
      background: { track: () => {} },
    });
    const clickup = createClickUp({ tasks, log: logger }, CFG, {
      client: fakeClient([], []),
      now: () => NOW,
    });
    const app = createWebhookRoutes([{ name: "clickup", webhook: (c) => clickup.webhook(c) }]);
    const signed = async (payload: unknown) => {
      const body = JSON.stringify(payload);
      const res = await app.request("/webhook/clickup", {
        method: "POST",
        body,
        headers: { "x-signature": sign(body) },
      });
      return { status: res.status, body: await res.json() };
    };
    const ok = { status: 200, body: { status: "ok" } };
    const taskRow = async () =>
      (
        await db.execute<{ id: string; key: string; external_url: string }>(
          sql`SELECT id, key, external_url FROM tasks`,
        )
      )[0];

    // abc0001 is assigned, and a redelivery is a duplicate; a comment on it,
    // redelivered too.
    expect(await signed(assignmentEvent())).toEqual(ok);
    expect(await signed(assignmentEvent())).toEqual(ok);
    const comment = commentEvent([tag(BOT), text(" also the "), text("footer", { bold: true })]);
    expect(await signed(comment)).toEqual(ok);
    expect(await signed(comment)).toEqual(ok);
    const task = await taskRow();
    expect(task).toMatchObject({
      key: "CU-abc0001",
      external_url: "https://app.clickup.com/t/abc0001",
    });

    await db.execute(sql`UPDATE tasks SET sandbox_id = 'sandbox-1', owner_id = 'pod-test'`);
    const inbox = new InboxService(inboxRepo, sandboxManager, {} as never);
    await inbox.sweepUndelivered((await taskRepo.getById(task?.id ?? "")) as Task);

    const files = writes.map((w) => JSON.parse(w.body) as File & Record<string, unknown>);
    expect(files.map((f) => [f.kind, f.external_id])).toEqual([
      ["assignment", "abc0001"],
      ["comment", "comment:9000000000000000001"],
    ]);
    const [assignment, followUp] = files;
    if (!assignment || !followUp) throw new Error("no files");
    for (const pinnedComment of [pinned("linear", "comment"), pinned("api", "comment")]) {
      expect(shape(followUp)).toEqual(shape(pinnedComment));
    }
    expect(shape(assignment)).toEqual(shape(pinned("linear", "assignment")));
    expect(followUp).toEqual({
      id: expect.any(String),
      source: "clickup",
      kind: "comment",
      external_id: "comment:9000000000000000001",
      payload: {
        target_id: "9000000000000000001",
        body: " also the **footer**",
        pr: null,
        created_at: "",
        task_id: task?.id,
        task_key: "CU-abc0001",
      },
    });
    expect(assignment).toEqual({
      id: expect.any(String),
      source: "clickup",
      kind: "assignment",
      external_id: "abc0001",
      payload: {
        title: "Fix the login page",
        description: "The button is **broken** ",
        external_url: "https://app.clickup.com/t/abc0001",
        target_id: `abc0001:${ITEM_ID}`,
        task_id: task?.id,
        task_key: "CU-abc0001",
      },
    });

    // An earlier assignment arriving late is a duplicate; a later one restarts the task.
    expect(
      await signed(assignmentEvent({ itemId: "1000000000000000000", date: "1767225500000" })),
    ).toEqual(ok);
    const later = assignmentEvent({ itemId: "1000000000000000009", date: "1767229200000" });
    expect(await signed(later)).toEqual(ok);
    const targets = await db.execute<{ target_id: string }>(
      sql`SELECT payload->>'target_id' AS target_id FROM inbox WHERE kind = 'assignment'`,
    );
    expect(targets.map((t) => t.target_id)).toEqual(["abc0001:1000000000000000009"]);
  });
});
