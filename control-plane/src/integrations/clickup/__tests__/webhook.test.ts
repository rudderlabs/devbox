import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { logger } from "../../../logger";
import { HttpError } from "../../http";
import type { TaskService } from "../../types";
import { isClickUpSpec } from "../webhook";
import {
  assignmentEvent,
  BOT,
  CLICKBOT,
  COMMENT_ID,
  clickUpTask,
  commentEvent,
  DATE,
  EMAIL,
  GUEST,
  HUMAN,
  ITEM_ID,
  MEMBERS,
  NAME,
  NOW,
  STRANGER,
  setup,
  sign,
  TASK,
  TASK_ID,
  TEAM,
  tag,
  text,
  user,
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
const ignoredLog = () => logged(info).find(([msg]) => msg === "clickup_webhook.ignored")?.[1];
const HOUR = 60 * 60 * 1000;

describe("ClickUp webhook: signature contract", () => {
  const body = JSON.stringify(assignmentEvent());

  it.each([
    ["no signature", () => ({})],
    ["a signature under another secret", () => ({ "x-signature": sign(body, "other") })],
    ["a malformed signature", () => ({ "x-signature": "zz" })],
    ["a prefixed signature", () => ({ "x-signature": `sha256=${sign(body)}` })],
  ])("rejects %s with 403 before anything is read", async (_, headers) => {
    const { send, taskCalls, calls, clickup } = setup();
    const res = await send(body, headers());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(taskCalls).toEqual([]);
    expect(calls).toEqual([]);
    expect(await clickup.status()).toMatchObject({ lastWebhookAt: null });
  });

  it("rejects a valid signature over a tampered body", async () => {
    const { send, taskCalls, calls } = setup();
    const tampered = body.replace(String(HUMAN), String(STRANGER));
    const res = await send(tampered, { "x-signature": sign(body) });
    expect(res.status).toBe(403);
    expect(taskCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("logs a signed mismatch, and nothing for an unsigned probe or from the request", async () => {
    const { send } = setup();
    await send(body, { "x-signature": sign(body, "other") });
    await send(body);
    expect(logged(warn)).toEqual([
      ["ClickUp webhook rejected: signature mismatch (check CLICKUP_WEBHOOK_SECRET)"],
    ]);
  });

  it("records a signed delivery", async () => {
    const { signed, clickup } = setup();
    expect((await signed({ event: "taskUpdated" })).status).toBe(200);
    expect(await clickup.status()).toMatchObject({ lastWebhookAt: new Date(NOW).toISOString() });
  });

  it("answers 400 to a signed body that isn't JSON, and 200 to events that aren't for the bot", async () => {
    const { send, signed, taskCalls, calls } = setup();
    expect((await send("not json", { "x-signature": sign("not json") })).status).toBe(400);
    for (const event of [
      assignmentEvent({ field: "assignee_rem" }),
      assignmentEvent({ assignee: HUMAN }),
      { event: "taskCreated", task_id: TASK_ID, history_items: [] },
      { ...commentEvent([text("@devbox x")]), event: "taskUpdated" },
    ]) {
      const res = await signed(event);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ignored" });
    }
    expect(taskCalls).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("ClickUp webhook: assignment", () => {
  it("assigns a task from the task read again, with a URL built from its id", async () => {
    const { signed, taskCalls, calls } = setup();
    const res = await signed(assignmentEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(calls).toEqual([`task ${TASK_ID}`, `members ${TEAM}`, `addComment ${TASK_ID}`]);
    const [call] = taskCalls;
    const p = call?.args[0] as Parameters<TaskService["assign"]>[0];
    expect(p).toMatchObject({
      externalId: TASK_ID,
      key: { hint: `CU-${TASK_ID}` },
      title: "Fix the login page",
      description: "The button is **broken** ",
      flags: ["FAST_MODE"],
    });
    const ref = { id: "task-1", key: "CU-abc0001" };
    expect(p.url(ref)).toBe(`https://app.clickup.com/t/${TASK_ID}`);
    // The delegation id is taskId:historyItemId, ordered by the item's date.
    const target = p.target(ref);
    expect(target).toEqual({
      id: `${TASK_ID}:${ITEM_ID}`,
      order: Number(DATE),
      spec: { kind: "clickup_task", taskId: TASK_ID },
    });
    expect(isClickUpSpec(target.spec)).toBe(true);
    expect(logged(info)).toContainEqual([
      "clickup assignment",
      { clickupTaskId: TASK_ID, taskId: "task-1", result: "created", userId: HUMAN },
    ]);
  });

  it("orders a later assignment of the same task after an earlier one", async () => {
    const { signed, taskCalls } = setup();
    await signed(assignmentEvent());
    await signed(assignmentEvent({ itemId: "1000000000000000007", date: "1767229200000" }));
    const targets = taskCalls.map((c) =>
      (c.args[0] as Parameters<TaskService["assign"]>[0]).target({ id: "t", key: "k" }),
    );
    expect(targets.map((t) => t.id)).toEqual([
      `${TASK_ID}:${ITEM_ID}`,
      `${TASK_ID}:1000000000000000007`,
    ]);
    expect((targets[1]?.order ?? 0) > (targets[0]?.order ?? 0)).toBe(true);
  });

  it.each(["restarted", "duplicate"] as const)("answers 200 to a %s assignment", async (result) => {
    const { signed } = setup({ result });
    const res = await signed(assignmentEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(logged(info)).toContainEqual([
      "clickup assignment",
      { clickupTaskId: TASK_ID, taskId: "task-1", result, userId: HUMAN },
    ]);
  });

  it.each([
    ["created", 1],
    ["restarted", 1],
    ["duplicate", 0],
  ] as const)("comments that it started on a %s assignment %d time(s)", async (result, times) => {
    const { signed, posted } = setup({ result });
    await signed(assignmentEvent());
    expect(
      posted.map((p) =>
        JSON.stringify(p.parts).includes("Working on this. I'll reply here when I'm done."),
      ),
    ).toEqual(Array(times).fill(true));
  });

  it("answers 200 and logs it when the start comment fails", async () => {
    const { signed } = setup({
      client: {
        addComment: async () => {
          throw new HttpError(`ClickUp POST /task/${TASK_ID}/comment failed: HTTP 500`, 500);
        },
      },
    });
    expect((await signed(assignmentEvent())).status).toBe(200);
    await Bun.sleep(0);
    expect(logged(warn)).toContainEqual([
      "clickup start comment failed",
      { clickupTaskId: TASK_ID, error: "http_500" },
    ]);
  });

  it("ignores the bot assigning itself", async () => {
    const { signed, taskCalls, calls } = setup();
    const res = await signed(assignmentEvent({ actor: user(BOT, 1) }));
    expect(await res.json()).toEqual({ status: "ignored", reason: "own_event" });
    expect(ignoredLog()).toEqual({ reason: "own_event", clickupTaskId: TASK_ID, userId: BOT });
    expect(taskCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  // Only an owner, admin or member: never a guest, ClickBot (automations) or
  // an actor without a role.
  it.each([
    ["a guest", user(GUEST, 4), GUEST, 4],
    ["ClickBot", CLICKBOT, -1, null],
    ["an actor without a role", user(HUMAN, null), HUMAN, null],
  ] as const)("ignores %s as the assigner, reading nothing", async (_, actor, userId, role) => {
    const { signed, taskCalls, calls } = setup();
    const res = await signed(assignmentEvent({ actor }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "untrusted" });
    expect(ignoredLog()).toEqual({
      reason: "untrusted",
      clickupTaskId: TASK_ID,
      side: "assigner",
      userId,
      role,
    });
    expect(taskCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([1, 2, 3])("accepts an assigner of role %d", async (role) => {
    const { signed, taskCalls } = setup();
    await signed(assignmentEvent({ actor: user(HUMAN, role) }));
    expect(taskCalls.map((c) => c.method)).toEqual(["assign"]);
  });

  it.each([
    ["a guest", GUEST, 4],
    ["the bot", BOT, 3],
    ["not a member", STRANGER, null],
    ["unknown", null, null],
  ] as const)("ignores a task whose creator is %s", async (_, creatorId, role) => {
    const { signed, taskCalls } = setup({
      client: { task: async (id: string) => clickUpTask({ id, creatorId }) },
    });
    const res = await signed(assignmentEvent());
    expect(await res.json()).toEqual({ status: "ignored", reason: "untrusted" });
    expect(ignoredLog()).toEqual({
      reason: "untrusted",
      clickupTaskId: TASK_ID,
      side: "creator",
      userId: creatorId,
      role,
    });
    expect(taskCalls).toEqual([]);
  });

  it("ignores a task from another workspace", async () => {
    const { signed, taskCalls } = setup({
      client: { task: async (id: string) => clickUpTask({ id, teamId: "7654321" }) },
    });
    const res = await signed(assignmentEvent());
    expect(await res.json()).toEqual({ status: "ignored", reason: "wrong_team" });
    expect(ignoredLog()).toEqual({ reason: "wrong_team", clickupTaskId: TASK_ID });
    expect(taskCalls).toEqual([]);
  });

  it("answers 503 when the task can't be read", async () => {
    const { signed, taskCalls } = setup({
      client: {
        task: async () => {
          throw new HttpError("ClickUp GET failed: HTTP 500", 500);
        },
      },
    });
    const res = await signed(assignmentEvent());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "task_unresolved" });
    expect(logged(warn)).toContainEqual([
      "clickup_webhook.task_unresolved",
      { clickupTaskId: TASK_ID, error: "http_500" },
    ]);
    expect(taskCalls).toEqual([]);
  });

  it("answers 503 and logs trust_unresolved without a member list", async () => {
    const { signed, taskCalls } = setup({
      client: {
        members: async () => {
          throw new HttpError("ClickUp GET /team failed: HTTP 502", 502);
        },
      },
    });
    const res = await signed(assignmentEvent());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "trust_unresolved" });
    expect(logged(warn)).toEqual([
      ["clickup member list read failed", { error: "http_502" }],
      ["clickup_webhook.trust_unresolved", { clickupTaskId: TASK_ID }],
    ]);
    expect(taskCalls).toEqual([]);
  });

  it("keeps the member list for six hours, then reads it again", async () => {
    const { signed, clock, calls, taskCalls } = setup();
    await signed(assignmentEvent());
    clock.t += 6 * HOUR - 1;
    await signed(assignmentEvent());
    expect(calls.filter((c) => c.startsWith("members"))).toHaveLength(1);
    clock.t += 1;
    await signed(assignmentEvent());
    expect(calls.filter((c) => c.startsWith("members"))).toHaveLength(2);
    expect(taskCalls.map((c) => c.method)).toEqual(["assign", "assign", "assign"]);
  });

  it("keeps the last good list one more TTL when a read fails, then answers 503", async () => {
    let failing = false;
    const { signed, clock, taskCalls } = setup({
      client: {
        members: async () => {
          if (failing) throw new Error("down");
          return MEMBERS;
        },
      },
    });
    await signed(assignmentEvent());
    failing = true;
    clock.t += 12 * HOUR - 1;
    expect((await signed(assignmentEvent())).status).toBe(200);
    clock.t += 1;
    expect((await signed(assignmentEvent())).status).toBe(503);
    expect(taskCalls.map((c) => c.method)).toEqual(["assign", "assign"]);
    failing = false;
    expect((await signed(assignmentEvent())).status).toBe(200);
  });

  it("reads the list again for a creator missing from it, at most once a minute", async () => {
    let members = MEMBERS;
    const reads: number[] = [];
    const { signed, clock, taskCalls } = setup({
      client: {
        task: async (id: string) => clickUpTask({ id, creatorId: STRANGER }),
        members: async () => {
          reads.push(clock.t);
          return members;
        },
      },
    });
    await signed(assignmentEvent());
    clock.t += 30_000;
    await signed(assignmentEvent());
    expect(reads).toHaveLength(1);
    expect(taskCalls).toEqual([]);

    // A new member: the next read finds them.
    members = [...MEMBERS, { id: STRANGER, role: 3 }];
    clock.t += 30_000;
    await signed(assignmentEvent());
    expect(reads).toHaveLength(2);
    expect(taskCalls.map((c) => c.method)).toEqual(["assign"]);
  });

  it("reads the list once for concurrent deliveries", async () => {
    let reads = 0;
    const { signed } = setup({
      client: {
        members: async () => {
          reads++;
          await new Promise((r) => setTimeout(r, 10));
          return MEMBERS;
        },
      },
    });
    const all = await Promise.all([signed(assignmentEvent()), signed(assignmentEvent())]);
    expect(all.map((r) => r.status)).toEqual([200, 200]);
    expect(reads).toBe(1);
  });
});

describe("ClickUp webhook: comment", () => {
  it("queues a comment round for a mention, replying on the task", async () => {
    const { signed, taskCalls, calls } = setup();
    const res = await signed(
      commentEvent([tag(BOT), text(" please "), text("also", { bold: true }), text(" fix it\n")]),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(taskCalls.map((c) => [c.method, ...c.args])).toEqual([
      ["findTask", TASK_ID],
      [
        "enqueueRound",
        {
          task: TASK,
          kind: "comment",
          externalId: `comment:${COMMENT_ID}`,
          payload: {
            target_id: COMMENT_ID,
            body: " please **also** fix it",
            pr: null,
            created_at: "",
          },
          targets: [{ id: COMMENT_ID, spec: { kind: "clickup_task", taskId: TASK_ID } }],
        },
      ],
    ]);
    expect(logged(info)).toContainEqual([
      "clickup follow-up",
      {
        clickupTaskId: TASK_ID,
        commentId: COMMENT_ID,
        userId: HUMAN,
        taskId: "task-1",
        roundId: "round-1",
      },
    ]);
  });

  it("accepts a typed @name as the mention, in any case", async () => {
    const { signed, taskCalls } = setup();
    await signed(commentEvent([text("@DevBox try again\n")]));
    expect(taskCalls.map((c) => c.method)).toEqual(["findTask", "enqueueRound"]);
  });

  it("ignores a comment without a mention, without a lookup or a log line", async () => {
    const { signed, taskCalls } = setup();
    const res = await signed(commentEvent([text("looks good to me\n"), tag(HUMAN)]));
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(taskCalls).toEqual([]);
    expect(logged(info)).toEqual([]);
  });

  it("drops the bot's own comment without a log line, even one that names it", async () => {
    const { signed, taskCalls } = setup();
    const res = await signed(commentEvent([text("@devbox here is the PR")], { author: user(BOT) }));
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(taskCalls).toEqual([]);
    expect(logged(info)).toEqual([]);
  });

  it("ignores a private comment, with a log line", async () => {
    const { signed, taskCalls } = setup();
    const res = await signed(commentEvent([tag(BOT), text(" do it")], { isPrivate: true }));
    expect(await res.json()).toEqual({ status: "ignored", reason: "private_comment" });
    expect(ignoredLog()).toEqual({
      reason: "private_comment",
      clickupTaskId: TASK_ID,
      commentId: COMMENT_ID,
      userId: HUMAN,
    });
    expect(taskCalls).toEqual([]);
  });

  it.each([
    ["a guest", user(GUEST, 4), GUEST, 4],
    ["ClickBot", CLICKBOT, -1, null],
    ["an author without a role", user(HUMAN, null), HUMAN, null],
  ] as const)("ignores %s's mention", async (_, author, userId, role) => {
    const { signed, taskCalls } = setup();
    const res = await signed(commentEvent([tag(BOT), text(" do it")], { author }));
    expect(await res.json()).toEqual({ status: "ignored", reason: "untrusted" });
    expect(ignoredLog()).toEqual({
      reason: "untrusted",
      clickupTaskId: TASK_ID,
      commentId: COMMENT_ID,
      userId,
      side: "commenter",
      role,
    });
    expect(taskCalls).toEqual([]);
  });

  it("ignores a mention on a task it has no task for, with 200", async () => {
    const { signed, taskCalls } = setup({ task: null });
    const res = await signed(commentEvent([tag(BOT), text(" do it")]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "no_task" });
    expect(taskCalls.map((c) => c.method)).toEqual(["findTask"]);
    expect(logged(warn)).toEqual([]);
  });

  it("answers 200 to a duplicate comment", async () => {
    const { signed } = setup({
      tasks: { enqueueRound: async () => ({ dropped: "duplicate" as const }) },
    });
    const res = await signed(commentEvent([tag(BOT), text(" do it")]));
    expect(res.status).toBe(200);
    expect(logged(info)).toContainEqual([
      "clickup follow-up",
      {
        clickupTaskId: TASK_ID,
        commentId: COMMENT_ID,
        userId: HUMAN,
        taskId: "task-1",
        dropped: "duplicate",
      },
    ]);
  });
});

describe("ClickUp webhook: logs", () => {
  it("never carry a name or an email", async () => {
    const { signed } = setup();
    await signed(assignmentEvent());
    await signed(assignmentEvent({ actor: user(GUEST, 4) }));
    await signed(assignmentEvent({ actor: CLICKBOT }));
    await signed(commentEvent([tag(BOT), text(" x")], { isPrivate: true }));
    await signed(commentEvent([tag(BOT), text(" x")], { author: user(GUEST, 4) }));
    await signed(commentEvent([tag(BOT), tag(HUMAN), text(" x")]));
    const all = JSON.stringify([...logged(info), ...logged(warn)]);
    expect(all).toContain(String(GUEST));
    expect(all).not.toContain(NAME);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain("ClickBot");
  });

  it("answers 500 to an internal failure and logs only its class and SQLSTATE", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      // A database error's message carries the query's parameters. Bun's
      // PostgresError carries the SQLSTATE in `errno` and a constant in `code`.
      const fail = async () => {
        const cause = Object.assign(new Error("unsupported Unicode escape sequence"), {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "22P05",
        });
        throw new DrizzleQueryError("insert into inbox ...", ["please fix the footer"], cause);
      };
      const { signed } = setup({ tasks: { assign: fail, enqueueRound: fail } });
      for (const event of [assignmentEvent(), commentEvent([text("@devbox fix the footer")])]) {
        const res = await signed(event);
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "internal" });
      }
      expect(logged(error)).toEqual([
        ["clickup webhook failed", { error: "Error", code: "22P05" }],
        ["clickup webhook failed", { error: "Error", code: "22P05" }],
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it("strips NUL, which Postgres can't store, from what it queues", async () => {
    const { signed, taskCalls } = setup({
      client: {
        task: async (id: string) =>
          clickUpTask({ id, name: "Fix\0 the login page", markdownDescription: "the button\0 is" }),
      },
    });
    await signed(assignmentEvent());
    await signed(commentEvent([text("@devbox also\0 the footer")]));
    const queued = JSON.stringify(taskCalls);
    expect(queued).not.toContain("\\u0000");
    expect(queued).toContain("Fix the login page");
    expect(queued).toContain("the button is");
    expect(queued).toContain("also the footer");
  });
});

describe("isClickUpSpec", () => {
  it("accepts only a ClickUp task target with a well-formed id", () => {
    expect(isClickUpSpec({ kind: "clickup_task", taskId: TASK_ID })).toBe(true);
    for (const spec of [
      { kind: "clickup_task" },
      { kind: "clickup_task", taskId: 1 },
      { kind: "clickup_task", taskId: "../x" },
      { kind: "jira_issue", issueId: "10042" },
      null,
      "clickup_task",
    ]) {
      expect(isClickUpSpec(spec)).toBe(false);
    }
  });
});
