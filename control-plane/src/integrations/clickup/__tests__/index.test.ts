import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Task } from "../../../db/schema";
import { logger } from "../../../logger";
import { HttpError } from "../../http";
import { type Outbound, RetryableError } from "../../outbound";
import type { Outcome, ReplyTarget, Round } from "../../types";
import type { ClickUpConfig } from "../config";
import type { Client } from "../index";
import type { ClickUpPart } from "../quill";
import {
  assignmentEvent,
  BOT,
  CFG,
  clickUpTask,
  HUMAN,
  LIST_ID,
  NOW,
  setup,
  TASK,
  TASK_ID,
} from "./fixtures";

let info: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  info = spyOn(logger, "info").mockImplementation(() => logger);
  warn = spyOn(logger, "warn").mockImplementation(() => logger);
  info.mockClear();
  warn.mockClear();
});
afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
});

const logged = (spy: ReturnType<typeof spyOn>) => spy.mock.calls as Array<[string, unknown?]>;

const target: ReplyTarget = {
  id: "9000000000000000001",
  spec: { kind: "clickup_task", taskId: TASK_ID },
};
const ctx = () => ({ signal: new AbortController().signal, log: logger });
const round = (kind: "assignment" | "comment") => ({ id: "r1", kind, source: "clickup" }) as Round;
const shown = (parts: ClickUpPart[] | undefined) => (parts ?? []).map((p) => p.text).join("");

describe("ClickUpIntegration deliver", () => {
  it("posts a reply as rich-text comment parts on the target's task", async () => {
    const { clickup, posted } = setup();
    await clickup.deliver(ctx(), target, { type: "reply", body: "Done: see **the PR**." });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.taskId).toBe(TASK_ID);
    expect(posted[0]?.parts).toContainEqual({ text: "the PR", attributes: { bold: true } });
  });

  it("posts nothing for progress or a blank reply", async () => {
    const { clickup, calls } = setup();
    for (const kind of ["thought", "action", "error"] as const) {
      await clickup.deliver(ctx(), target, { type: "progress", kind, body: "working" });
    }
    await clickup.deliver(ctx(), target, { type: "reply", body: "  " });
    expect(calls).toEqual([]);
  });

  it("refuses another integration's target and a malformed one", async () => {
    const { clickup, calls } = setup();
    for (const spec of [
      { kind: "jira_issue", issueId: "10042" },
      { kind: "linear_session" },
      { kind: "clickup_task" },
      { kind: "clickup_task", taskId: 1 },
      { kind: "clickup_task", taskId: "../abc" },
      null,
      "clickup_task",
    ]) {
      await expect(
        clickup.deliver(ctx(), { id: "x", spec }, { type: "reply", body: "x" }),
      ).rejects.toThrow("not a ClickUp task target");
    }
    expect(calls).toEqual([]);
  });

  it("may retry only when the first part failed before it was sent", async () => {
    const { clickup } = setup({
      client: {
        addComment: async () => {
          throw new HttpError("ClickUp POST failed: HTTP 429", 429, 30_000);
        },
      },
    });
    const err = await clickup.deliver(ctx(), target, { type: "reply", body: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).retryAfterMs).toBe(30_000);
    expect(await clickup.status()).toMatchObject({
      lastReplyFailure: { at: new Date(NOW).toISOString(), error: "http_429" },
    });
  });

  it("drops a first part that failed any other way", async () => {
    const { clickup } = setup({
      client: {
        addComment: async () => {
          throw new HttpError("ClickUp POST failed: HTTP 400", 400);
        },
      },
    });
    const err = await clickup.deliver(ctx(), target, { type: "reply", body: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(RetryableError);
  });

  it("never asks for a retry once a part is posted, so no part is posted twice", async () => {
    let sent = 0;
    const { clickup } = setup({
      client: {
        addComment: async () => {
          if (++sent === 2) throw new HttpError("ClickUp POST failed: HTTP 429", 429);
          return { id: String(sent) };
        },
      },
    });
    const body = ["a".repeat(4_000), "b".repeat(4_000), "c".repeat(4_000)].join("\n\n");
    const err = await clickup.deliver(ctx(), target, { type: "reply", body }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RetryableError);
    expect((err as Error).message).toContain("part 2 of 3");
    expect(sent).toBe(2);
  });

  const failure = (
    cause: "round_failed" | "task_failed" | "workspace_missing",
    kind: "assignment" | "comment",
    extra: { summary?: string; detail?: string } = {},
  ): Outbound => ({ type: "failure", cause, round: round(kind), ...extra });

  it.each([
    [
      failure("task_failed", "assignment", { summary: "Task failed: x" }),
      "devbox couldn't finish this task. To start over, remove devbox from the assignees and assign it again; this opens a new pull request.",
    ],
    [
      failure("task_failed", "comment"),
      "devbox couldn't finish this. Comment with @devbox to retry.",
    ],
    [
      failure("workspace_missing", "comment"),
      "This task's workspace was cleaned up, so devbox can't continue it. Remove devbox from the assignees and assign it again to start over.",
    ],
    [
      failure("round_failed", "assignment", { summary: "Could not push the branch." }),
      "Could not push the branch.",
    ],
    [
      failure("round_failed", "comment"),
      "⚠️ Something went wrong while working on this. Comment with @devbox to retry.",
    ],
  ])("words a failure by cause and round kind (%#)", async (message, expected) => {
    const { clickup, posted } = setup();
    await clickup.deliver(ctx(), target, message);
    expect(posted).toHaveLength(1);
    expect(shown(posted[0]?.parts)).toContain(expected);
  });

  it("never posts a failure's raw detail", async () => {
    const detail = "Traceback: KeyError at /workspace/secret_module.py";
    const { clickup, posted } = setup();
    for (const cause of ["round_failed", "task_failed", "workspace_missing"] as const) {
      for (const kind of ["assignment", "comment"] as const) {
        await clickup.deliver(ctx(), target, failure(cause, kind, { detail }));
        await clickup.deliver(ctx(), target, failure(cause, kind, { summary: "Failed.", detail }));
      }
    }
    expect(posted.length).toBeGreaterThan(0);
    expect(JSON.stringify(posted)).not.toContain("Traceback");
  });
});

describe("ClickUpIntegration status", () => {
  it("reports the bot, team, token, webhook and reply failures without secrets", async () => {
    const { clickup, signed, calls } = setup();
    await signed(assignmentEvent());
    const status = await clickup.status();
    expect(status).toEqual({
      configured: true,
      bot: { id: BOT, name: "devbox" },
      team: CFG.teamId,
      auth: "ok",
      lastWebhookAt: new Date(NOW).toISOString(),
      webhook: { health: "active", failCount: 0 },
      lastReplyFailure: null,
    });
    expect(calls).toContain(`webhooks ${CFG.teamId}`);
    const json = JSON.stringify(status);
    for (const secret of [CFG.apiToken, CFG.webhookSecret]) expect(json).not.toContain(secret);
  });

  it("shows a rejected token as such and failures as a class, never upstream text", async () => {
    const upstream = 'HTTP 401 {"err":"Token invalid pk_abc123","ECODE":"OAUTH_025"}';
    const { clickup } = setup({
      client: {
        user: async () => {
          throw new HttpError(`ClickUp GET /user failed: ${upstream}`, 401);
        },
        addComment: async () => {
          throw new HttpError(`ClickUp POST failed: ${upstream}`, 401);
        },
      },
    });
    await clickup.deliver(ctx(), target, { type: "reply", body: "x" }).catch(() => {});
    const status = await clickup.status();
    expect(status).toMatchObject({ auth: "rejected", lastReplyFailure: { error: "http_401" } });
    expect(JSON.stringify(status)).not.toContain("abc123");
  });

  it("is unknown when ClickUp can't be reached", async () => {
    const { clickup } = setup({
      client: {
        user: async () => {
          throw new HttpError("HTTP 502", 502);
        },
      },
    });
    expect(await clickup.status()).toMatchObject({ auth: "unknown" });
  });

  it("finds the webhook by its endpoint's path, null without one, absent when unreadable", async () => {
    const hook = (endpoint: string, status = "failing", failCount = 7) => ({
      id: "w",
      endpoint,
      health: { status, failCount },
    });
    const withHooks = (hooks: ReturnType<typeof hook>[]) =>
      setup({ client: { webhooks: async () => hooks } }).clickup.status();
    expect(
      await withHooks([
        hook("https://other.example.com/hooks"),
        hook("https://devbox.example.com/webhook/clickup"),
      ]),
    ).toMatchObject({ webhook: { health: "failing", failCount: 7 } });
    expect(await withHooks([hook("https://other.example.com/hooks")])).toMatchObject({
      webhook: null,
    });

    const unreadable = await setup({
      client: {
        webhooks: async () => {
          throw new HttpError("HTTP 500", 500);
        },
      },
    }).clickup.status();
    expect(unreadable).not.toHaveProperty("webhook");
    expect(unreadable).toMatchObject({ auth: "ok" });
  });
});

const CU_TASK = { ...TASK, externalId: TASK_ID } as Task;

// The task as the hooks read it: its status and assignees.
function taskAt(status: string, assigneeIds = [BOT]): Partial<Client> {
  return { task: async (id: string) => clickUpTask({ id, status, assigneeIds }) };
}

// A hook context whose isCurrent() answer is recorded among the ClickUp
// calls, so tests see when it was asked.
function hookCtx(calls: string[], o: { current?: boolean; firstTransition?: boolean } = {}) {
  return {
    signal: new AbortController().signal,
    log: logger,
    isCurrent: async () => {
      calls.push("isCurrent");
      return o.current ?? true;
    },
    firstTransition: o.firstTransition ?? true,
    archive: async () => null,
  };
}

const skipped = () =>
  logged(info)
    .filter(([msg]) => msg === "clickup status move skipped")
    .map(([, meta]) => (meta as { reason: string }).reason);
const refused = (status: number) => async () => {
  throw new HttpError(`ClickUp PUT /task/${TASK_ID} failed: HTTP ${status}`, status);
};

describe("ClickUpIntegration onTaskStarted", () => {
  it("moves the bot's task to the started status in the list's spelling", async () => {
    const { clickup, calls } = setup({ client: taskAt("to do") });
    await clickup.onTaskStarted(hookCtx(calls), CU_TASK);
    expect(calls).toEqual([
      `listStatuses ${LIST_ID}`,
      "isCurrent",
      `setStatus ${TASK_ID} In Progress`,
    ]);
  });

  it.each([
    ["the bot is no longer an assignee", taskAt("to do", [HUMAN]), "not_assignee"],
    ["the task is unassigned", taskAt("to do", []), "not_assignee"],
    ["the task is already started", taskAt("IN PROGRESS"), "already_there"],
  ])("leaves the task alone when %s", async (_, client, reason) => {
    const { clickup, calls } = setup({ client });
    await clickup.onTaskStarted(hookCtx(calls), CU_TASK);
    expect(calls).toEqual([]);
    expect(skipped()).toEqual([reason]);
  });

  it("does nothing without a started status", async () => {
    const { clickup, calls } = setup({ cfg: { statuses: { done: "done" } } });
    await clickup.onTaskStarted(hookCtx(calls), CU_TASK);
    expect(calls).toEqual([]);
  });

  it("skips, with a warning, when the task's list has no such status", async () => {
    const { clickup, calls } = setup({
      cfg: { statuses: { started: "doing" } },
      client: taskAt("to do"),
    });
    await clickup.onTaskStarted(hookCtx(calls), CU_TASK);
    expect(calls).toEqual([`listStatuses ${LIST_ID}`]);
    expect(logged(warn)).toEqual([
      [
        "clickup status move skipped: the task's list has no such status",
        { taskId: "task-1", clickupTaskId: TASK_ID, to: "doing" },
      ],
    ]);
  });

  it("skips when the task was restarted meanwhile", async () => {
    const { clickup, calls } = setup({ client: taskAt("to do") });
    await clickup.onTaskStarted(hookCtx(calls, { current: false }), CU_TASK);
    expect(calls).toEqual([`listStatuses ${LIST_ID}`, "isCurrent"]);
    expect(skipped()).toEqual(["restarted"]);
  });

  it("logs a 400 refusal and carries on", async () => {
    const { clickup, calls } = setup({ client: { ...taskAt("to do"), setStatus: refused(400) } });
    await clickup.onTaskStarted(hookCtx(calls), CU_TASK);
    expect(logged(warn)).toEqual([
      [
        "clickup status move refused",
        { taskId: "task-1", clickupTaskId: TASK_ID, to: "in progress", status: 400 },
      ],
    ]);
  });

  it("leaves any other failure to the hook runner", async () => {
    const { clickup, calls } = setup({ client: { ...taskAt("to do"), setStatus: refused(500) } });
    await expect(clickup.onTaskStarted(hookCtx(calls), CU_TASK)).rejects.toThrow("HTTP 500");
  });
});

describe("ClickUpIntegration onRoundFinished", () => {
  const statuses = { started: "in progress", done: "done", failed: "FAILED" };
  const finish = (
    o: {
      outcome?: Outcome | null;
      kind?: "assignment" | "comment";
      ctx?: { current?: boolean; firstTransition?: boolean };
      cfg?: Partial<ClickUpConfig>;
      client?: Partial<Client>;
    } = {},
  ) => {
    const s = setup({ cfg: o.cfg ?? { statuses }, client: o.client ?? taskAt("In Progress") });
    const outcome = o.outcome === undefined ? "completed" : o.outcome;
    const ctx = hookCtx(s.calls, o.ctx);
    return s.clickup
      .onRoundFinished(ctx, CU_TASK, round(o.kind ?? "assignment"), outcome)
      .then(() => s.calls);
  };

  it.each([
    ["completed", "Done"],
    ["no_action", "Done"],
    ["partial_failure", "Done"],
    ["failed", "Failed"],
  ] as const)("moves a %s task from started to %s", async (outcome, to) => {
    expect(await finish({ outcome })).toEqual([
      `listStatuses ${LIST_ID}`,
      "isCurrent",
      `setStatus ${TASK_ID} ${to}`,
    ]);
  });

  it.each([
    ["the round isn't the first to finish", { ctx: { firstTransition: false } }],
    ["the round is a comment", { kind: "comment" as const }],
    ["the outcome is unknown", { outcome: null }],
    [
      "no failed status is configured",
      { outcome: "failed" as const, cfg: { statuses: { started: "in progress", done: "done" } } },
    ],
    [
      "no done status is configured",
      { cfg: { statuses: { started: "in progress", failed: "failed" } } },
    ],
    ["no started status is configured", { cfg: { statuses: { done: "done", failed: "failed" } } }],
  ])("touches nothing when %s", async (_, o) => {
    // The default fake records task reads too.
    expect(await finish({ ...o, client: {} })).toEqual([]);
  });

  it.each([
    ["was re-assigned", taskAt("in progress", [HUMAN]), "not_assignee"],
    ["was moved by hand", taskAt("blocked"), "status_moved"],
    ["is already done", taskAt("DONE"), "already_there"],
  ])("leaves a task that %s alone", async (_, client, reason) => {
    expect(await finish({ client })).toEqual([]);
    expect(skipped()).toEqual([reason]);
  });

  it("asks whether the task is current right before the move, and skips if not", async () => {
    expect(await finish({ ctx: { current: false } })).toEqual([
      `listStatuses ${LIST_ID}`,
      "isCurrent",
    ]);
    expect(skipped()).toEqual(["restarted"]);
  });

  it("logs a 400 and carries on", async () => {
    await finish({ client: { ...taskAt("in progress"), setStatus: refused(400) } });
    expect(logged(warn)).toEqual([
      [
        "clickup status move refused",
        { taskId: "task-1", clickupTaskId: TASK_ID, to: "done", status: 400 },
      ],
    ]);
  });
});

describe("ClickUpIntegration", () => {
  it("has no PR link hook: replies carry the pull request's URL", () => {
    const { clickup } = setup();
    expect("onPrOpened" in clickup).toBe(false);
    expect("hostsPr" in clickup).toBe(false);
  });
});
