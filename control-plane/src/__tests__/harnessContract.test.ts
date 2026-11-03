// The files the harness reads from `inbox/`, pinned. Every way the control
// plane creates a round today runs through its production path, then the sweep
// writes the pending rounds to a fake sandbox, and the written files must equal
// the committed fixture. Only generated UUIDs are replaced (by first appearance,
// so which ids are equal still shows); every other value is fixed here.
//
// The fixture is the contract with the harness: a change that makes this test
// fail changes what the harness reads. Fix the code, not the fixture.
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { sql } from "drizzle-orm";
import fixture from "./harnessContract.fixture.json";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
mock.module("../config", () => ({
  config: { databaseUrl: TEST_DATABASE_URL, podId: "pod-test" },
}));

const { db } = await import("../db");
const { TaskRepository } = await import("../repositories/task.repository");
const { InboxRepository } = await import("../repositories/inbox.repository");
const { ApiTaskRepository } = await import("../repositories/apiTask.repository");
const { TaskEventRepository } = await import("../repositories/taskEvent.repository");
const { Intake } = await import("../integrations/intake");
const { InboxService } = await import("../services/inbox.service");
const { AgentSessionService } = await import("../services/agentSession.service");
const { ApiTaskService } = await import("../services/apiTask.service");
const { migrate } = await import("drizzle-orm/bun-sql/migrator");

import type { Task } from "../db/schema";
import type { SandboxManager } from "../services/sandboxManager.service";

const PR = { owner: "example", repo: "app", prNumber: 7 };
const PR_URL = "https://github.com/example/app/pull/7";

// Replaces each distinct UUID with `<uuid-N>`, numbered by first appearance.
function tokenizer(): (s: string) => string {
  const seen = new Map<string, string>();
  return (s) =>
    s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
      let token = seen.get(id);
      if (!token) {
        token = `<uuid-${seen.size + 1}>`;
        seen.set(id, token);
      }
      return token;
    });
}

describe("harness contract", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
    await db.execute(sql`ALTER SEQUENCE api_task_key_seq RESTART`);
  });

  it("the inbox files written to the sandbox match the fixture", async () => {
    const writes: { sandboxId: string; path: string; body: string }[] = [];
    const sandboxManager = {
      writeHarnessFile: async (sandboxId: string, path: string, body: string) => {
        writes.push({ sandboxId, path, body });
      },
      killSandbox: async () => {},
    } as unknown as SandboxManager;

    const taskRepo = new TaskRepository();
    const inboxRepo = new InboxRepository();
    const intake = new Intake(
      taskRepo,
      inboxRepo,
      sandboxManager,
      { detach: () => {} },
      { apiKeyPrefix: "DBX-API-", ciResultMaxPerTask: 20 },
    );
    // The sweep never reaches the integrations or hooks.
    const inbox = new InboxService(inboxRepo, sandboxManager, {} as never, {} as never, intake);
    // The webhook acks are fire-and-forget; a client that never arrives keeps
    // them from running.
    const linear = new AgentSessionService(
      intake,
      { getAuthorizedLinearClient: () => new Promise(() => {}) },
      inbox,
    );
    const api = new ApiTaskService(new ApiTaskRepository(), intake, new TaskEventRepository(), {
      publicBaseUrl: "https://devbox.example",
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    // Delivers every task's pending rounds, as reconcile does once the task
    // has a live sandbox.
    const sweepAll = async () => {
      await db.execute(sql`UPDATE tasks SET sandbox_id = 'sandbox-' || key, owner_id = 'pod-test'`);
      const tasks = await db.execute<{ id: string }>(sql`SELECT id FROM tasks ORDER BY created_at`);
      for (const { id } of tasks) {
        await inbox.sweepUndelivered((await taskRepo.getById(id)) as Task);
      }
    };

    // Linear: an assignment (its flag stripped from the description) and a
    // comment on a new agent session.
    await linear.handleEvent({
      action: "created",
      agentSessionId: "session-1",
      issue: {
        id: "issue-1",
        title: "Fix the login form",
        description: "The submit button does nothing.\n\n#devbox:exp:FAST_MODE",
        url: "https://linear.app/example/issue/ENG-42/fix-the-login-form",
      },
    });
    await linear.handleEvent({
      action: "prompted",
      agentSessionId: "session-2",
      activityId: "activity-1",
      activityBody: "Also check the signup form",
      issue: { id: "issue-1" },
    });

    // GitHub: a comment, a review with two inline comments and a CI failure,
    // on the PR the Linear task opened.
    await db.execute(sql`
      UPDATE tasks
         SET pr_urls = ${JSON.stringify([
           { repo: "app", url: PR_URL, branch: "devbox/eng-42", commit_sha: "abc123" },
         ])}::text::jsonb
       WHERE source = 'linear'`);
    const [linearTask] = await db.execute<{ id: string; key: string }>(
      sql`SELECT id, key FROM tasks WHERE source = 'linear'`,
    );
    const task = linearTask as { id: string; key: string };
    await inbox.enqueueComment({
      task,
      commentId: 101,
      body: "@devbox rename the helper",
      spec: { kind: "issue_comment", ...PR, commentId: 101 },
      createdAt: "2026-01-02T04:00:00Z",
    });
    await inbox.enqueueReview({
      task,
      reviewId: 201,
      reviewBody: "A few things to fix",
      inlineComments: [
        { id: 301, path: "src/a.ts", line: 12, body: "typo" },
        { id: 302, path: "src/b.ts", line: 30, startLine: 25, body: "extract this" },
      ],
      ...PR,
      reviewerLogin: "reviewer",
      createdAt: "2026-01-02T05:00:00Z",
    });
    await inbox.enqueueCiResult({
      task,
      runId: 401,
      runAttempt: 2,
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      conclusion: "failure",
      runUrl: "https://github.com/example/app/actions/runs/401",
      headSha: "abc123",
      headBranch: "devbox/eng-42",
      ...PR,
    });

    // API: an assignment and a message.
    const created = await api.create(null, {
      title: "Add a health check",
      description: "Expose /healthz",
      experimentalFlags: ["FAST_MODE"],
    });
    await api.sendMessage(created.key, "Also log the uptime");

    await sweepAll();

    // Restarts re-pend the assignment: a Linear re-delegation and an API
    // restart (without a description).
    await linear.handleEvent({
      action: "created",
      agentSessionId: "session-3",
      issue: {
        id: "issue-1",
        title: "Fix the login form, again",
        description: "Still broken.",
        url: "https://linear.app/example/issue/ENG-42/fix-the-login-form",
      },
    });
    await api.restart(created.key, {
      title: "Add a health check endpoint",
      description: null,
      experimentalFlags: [],
    });

    await sweepAll();

    const tokens = tokenizer();
    const files = writes.map((w) => ({
      sandboxId: w.sandboxId,
      path: tokens(w.path),
      body: JSON.parse(tokens(w.body)),
    }));
    expect(files).toStrictEqual(fixture);
  });
});
