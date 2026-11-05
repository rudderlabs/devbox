// Jira's rounds as the harness reads them: webhooks run through Jira into a
// real TaskService and database, and the sweep writes the inbox files to a
// fake sandbox. A Jira comment must have the shape of the comment rounds the
// harness contract pins (Linear's and the API's, which reply outside a PR),
// and an assignment the shape of theirs.
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
const { createJira } = await import("../index");
const { assignmentEvent, CFG, commentEvent, fakeClient, NOW, sign } = await import("./fixtures");

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

describe("Jira rounds", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
  });

  it("reach the harness in the shape of the pinned rounds, and comment ids never meet issue ids", async () => {
    const writes: { path: string; body: string }[] = [];
    const sandboxManager = {
      writeHarnessFile: async (_sandboxId: string, path: string, body: string) => {
        writes.push({ path, body });
      },
      killSandbox: async () => {},
    } as unknown as SandboxManager;
    const taskRepo = new TaskRepository();
    const inboxRepo = new InboxRepository();
    const tasks = new BoundTaskService("jira", {
      createsTasks: true,
      taskRepo,
      inboxRepo,
      sandboxManager,
      background: { track: () => {} },
    });
    const jira = createJira({ tasks, log: logger }, CFG, {
      client: fakeClient([], []),
      now: () => NOW,
    });
    const app = createWebhookRoutes([{ name: "jira", webhook: (c) => jira.webhook(c) }]);
    const signed = async (payload: unknown) => {
      const body = JSON.stringify(payload);
      const res = await app.request("/webhook/jira", {
        method: "POST",
        body,
        headers: { "x-hub-signature": sign(body) },
      });
      return { status: res.status, body: await res.json() };
    };
    const ok = { status: 200, body: { status: "ok" } };

    // Issue 10042 is assigned; then a comment on it whose id is also 10042,
    // and one whose id is 10050, the id of an issue assigned after it.
    expect(await signed(assignmentEvent())).toEqual(ok);
    expect(await signed(commentEvent("@devbox also the footer", { commentId: "10042" }))).toEqual(
      ok,
    );
    expect(await signed(commentEvent("@devbox and the header", { commentId: "10050" }))).toEqual(
      ok,
    );
    expect(await signed(assignmentEvent({ issueId: "10050", issueKey: "DEMO-8" }))).toEqual(ok);
    // A redelivered comment is a duplicate.
    expect(await signed(commentEvent("@devbox also the footer", { commentId: "10042" }))).toEqual(
      ok,
    );

    await db.execute(sql`UPDATE tasks SET sandbox_id = 'sandbox-' || key, owner_id = 'pod-test'`);
    const inbox = new InboxService(inboxRepo, sandboxManager, {} as never);
    const rows = await db.execute<{ id: string }>(sql`SELECT id FROM tasks ORDER BY key`);
    for (const { id } of rows) await inbox.sweepUndelivered((await taskRepo.getById(id)) as Task);

    const files = writes.map((w) => JSON.parse(w.body) as File & Record<string, unknown>);
    expect(files.map((f) => [f.kind, f.external_id])).toEqual([
      ["assignment", "10042"],
      ["comment", "comment:10042"],
      ["comment", "comment:10050"],
      ["assignment", "10050"],
    ]);
    const [assignment, comment] = files;
    if (!assignment || !comment) throw new Error("no files");

    for (const pinnedComment of [pinned("linear", "comment"), pinned("api", "comment")]) {
      expect(shape(comment)).toEqual(shape(pinnedComment));
    }
    expect(shape(assignment)).toEqual(shape(pinned("linear", "assignment")));
    const [task] = await db.execute<{ id: string }>(sql`SELECT id FROM tasks WHERE key = 'DEMO-7'`);
    expect(comment).toEqual({
      id: expect.any(String),
      source: "jira",
      kind: "comment",
      external_id: "comment:10042",
      payload: {
        target_id: "10042",
        // A typed mention stays, as on GitHub; a picked one is dropped.
        body: "@devbox also the footer",
        pr: null,
        created_at: "",
        task_id: task?.id,
        task_key: "DEMO-7",
      },
    });
    expect(assignment).toEqual({
      id: expect.any(String),
      source: "jira",
      kind: "assignment",
      external_id: "10042",
      payload: {
        title: "Fix the login page",
        description: "the button is **broken** ",
        external_url: "https://example.atlassian.net/browse/DEMO-7",
        target_id: "10042:10101",
        task_id: task?.id,
        task_key: "DEMO-7",
      },
    });
  });
});
