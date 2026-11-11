import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { logger } from "../../../logger";
import { HttpError } from "../../http";
import type { TaskService } from "../../types";
import { isJiraSpec } from "../webhook";
import {
  assignmentEvent,
  BOT,
  commentEvent,
  EMAIL,
  HUMAN,
  NAME,
  NOW,
  REPORTER,
  STRANGER,
  setup,
  sign,
  TASK,
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
const ignoredLog = () => logged(info).find(([msg]) => msg === "jira_webhook.ignored")?.[1];

describe("Jira webhook: signature contract", () => {
  const body = JSON.stringify(assignmentEvent());

  it.each([
    ["no signature", () => ({})],
    ["a signature under another secret", () => ({ "x-hub-signature": sign(body, "other") })],
    ["a malformed signature", () => ({ "x-hub-signature": "sha256=zz" })],
  ])("rejects %s with 401 before anything is read", async (_, headers) => {
    const { send, taskCalls, jiraCalls, jira } = setup();
    const res = await send(body, headers());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(taskCalls).toEqual([]);
    expect(jiraCalls).toEqual([]);
    expect(await jira.status()).toMatchObject({ lastWebhookAt: null });
  });

  it("rejects a valid signature over a tampered body", async () => {
    const { send, taskCalls, jiraCalls } = setup();
    const tampered = body.replace(HUMAN, STRANGER);
    const res = await send(tampered, { "x-hub-signature": sign(body) });
    expect(res.status).toBe(401);
    expect(taskCalls).toEqual([]);
    expect(jiraCalls).toEqual([]);
  });

  it("says why in the log, and nothing from the request", async () => {
    const { send } = setup();
    await send(body, { "x-hub-signature": sign(body, "other") });
    await send(body, { "x-atlassian-webhook-identifier": "1" });
    await send(body);
    expect(logged(warn).map(([msg]) => msg)).toEqual([
      "Jira webhook rejected: signature mismatch (check the webhook secret matches JIRA_WEBHOOK_SECRET)",
      "Jira webhook rejected: unsigned (set a secret on the webhook in Jira)",
    ]);
    expect(JSON.stringify(logged(warn))).not.toContain(HUMAN);
  });

  it("records a signed delivery and ignores the triggeredByUser query", async () => {
    const { signed, jira, taskCalls } = setup();
    const res = await signed(assignmentEvent());
    expect(res.status).toBe(200);
    expect(taskCalls.map((c) => c.method)).toEqual(["assign"]);
    expect(await jira.status()).toMatchObject({ lastWebhookAt: new Date(NOW).toISOString() });
  });

  it("answers 400 to a signed body that isn't JSON, and 200 to an event that isn't for the bot", async () => {
    const { send, signed, taskCalls } = setup();
    expect((await send("not json", { "x-hub-signature": sign("not json") })).status).toBe(400);
    const unassign = assignmentEvent();
    const res = await signed({
      ...unassign,
      changelog: { id: "10102", items: [{ field: "assignee", from: BOT, to: HUMAN }] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(taskCalls).toEqual([]);
  });
});

describe("Jira webhook: assignment", () => {
  it("assigns a task from the signed body, with config-built URLs", async () => {
    const { signed, taskCalls, jiraCalls } = setup();
    const res = await signed(assignmentEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    const [call] = taskCalls;
    const p = call?.args[0] as Parameters<TaskService["assign"]>[0];
    expect(p).toMatchObject({
      externalId: "10042",
      key: { hint: "DEMO-7" },
      title: "Fix the login page",
      description: "the button is **broken** ",
      flags: ["FAST_MODE"],
    });
    const ref = { id: "task-1", key: "DEMO-7" };
    expect(p.url(ref)).toBe("https://example.atlassian.net/browse/DEMO-7");
    // The delegation id is issueId:changelogId, ordered by the changelog id.
    const target = p.target(ref);
    expect(target).toEqual({
      id: "10042:10101",
      order: 10101,
      spec: { kind: "jira_issue", issueId: "10042" },
    });
    expect(isJiraSpec(target.spec)).toBe(true);
    // Nothing was looked up; the start comment went out.
    expect(jiraCalls).toEqual(["addComment 10042"]);
  });

  it.each(["restarted", "duplicate"] as const)("answers 200 to a %s assignment", async (result) => {
    const { signed } = setup({ result });
    expect((await signed(assignmentEvent())).status).toBe(200);
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
        JSON.stringify(p.doc).includes("Working on this. I'll reply here when I'm done."),
      ),
    ).toEqual(Array(times).fill(true));
  });

  it("answers 200 and logs it when the start comment fails", async () => {
    const { signed } = setup({
      client: {
        addComment: async () => {
          throw new HttpError("Jira POST /issue/10042/comment failed: HTTP 500", 500);
        },
      },
    });
    expect((await signed(assignmentEvent())).status).toBe(200);
    await Bun.sleep(0);
    expect(logged(warn)).toContainEqual([
      "jira start comment failed",
      { issueId: "10042", error: "http_500" },
    ]);
  });

  it.each([
    ["the bot's own event", { actor: user(BOT, "atlassian") }, "own_event", BOT],
    ["an app account", { actor: user(HUMAN, "app") }, "non_human", HUMAN],
    ["a customer account", { actor: user(HUMAN, "customer") }, "non_human", HUMAN],
  ] as const)("ignores %s with 200 and an id-only log", async (_, opts, reason, accountId) => {
    const { signed, taskCalls, jiraCalls } = setup();
    const res = await signed(assignmentEvent(opts));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason });
    expect(ignoredLog()).toEqual({ reason, issueId: "10042", accountId });
    expect(taskCalls).toEqual([]);
    expect(jiraCalls).toEqual([]);
  });

  // Only a person's account is trusted: never an app, a customer, one of
  // unknown type or the bot, and an issue with neither reporter nor creator
  // has no author to trust.
  it.each([
    ["assigner", { actor: user(STRANGER, "unknown") }, STRANGER],
    ["reporter", { reporter: user(REPORTER, "app") }, REPORTER],
    ["reporter", { reporter: user(REPORTER, "customer") }, REPORTER],
    ["reporter", { reporter: user(BOT) }, BOT],
    ["reporter", { reporter: null, creator: user(REPORTER, "app") }, REPORTER],
    ["reporter", { reporter: null, creator: null }, null],
  ] as const)("ignores an untrusted %s silently", async (side, opts, accountId) => {
    const { signed, taskCalls, jiraCalls } = setup();
    const res = await signed(assignmentEvent(opts));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "untrusted" });
    expect(ignoredLog()).toEqual({ reason: "untrusted", issueId: "10042", side, accountId });
    expect(taskCalls).toEqual([]);
    expect(jiraCalls).toEqual([]);
  });

  it("falls back to a person who created the issue when it has no reporter", async () => {
    const { signed, taskCalls } = setup();
    await signed(assignmentEvent({ reporter: null, creator: user(STRANGER) }));
    expect(taskCalls.map((c) => c.method)).toEqual(["assign"]);
  });

  it("ignores an issue with a security level unless restricted issues are allowed", async () => {
    const level = { id: "10001", name: "Staff only" };
    const off = setup();
    const res = await off.signed(assignmentEvent({ security: level }));
    expect(await res.json()).toEqual({ status: "ignored", reason: "restricted_issue" });
    expect(off.taskCalls).toEqual([]);

    const on = setup({ cfg: { allowRestrictedIssues: true } });
    await on.signed(assignmentEvent({ security: level }));
    expect(on.taskCalls.map((c) => c.method)).toEqual(["assign"]);
  });

  it("reads the security level when the payload leaves it out", async () => {
    const open = setup();
    await open.signed(assignmentEvent({ security: "absent" }));
    expect(open.jiraCalls).toContain("getIssue 10042 security");
    expect(open.taskCalls.map((c) => c.method)).toEqual(["assign"]);

    for (const fields of [{ security: { id: "10001" } }, {}]) {
      const closed = setup({
        client: { getIssue: async (id: string) => ({ id, key: "DEMO-7", fields }) },
      });
      const res = await closed.signed(assignmentEvent({ security: "absent" }));
      expect(await res.json()).toEqual({ status: "ignored", reason: "restricted_issue" });
      expect(closed.taskCalls).toEqual([]);
    }
  });

  it("answers 503 when the security level can't be read", async () => {
    const { signed, taskCalls } = setup({
      client: {
        getIssue: async () => {
          throw new HttpError("Jira GET failed: HTTP 500", 500);
        },
      },
    });
    const res = await signed(assignmentEvent({ security: "absent" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "security_unresolved" });
    expect(taskCalls).toEqual([]);
  });
});

describe("Jira webhook: comment", () => {
  it("queues a comment round for a person's mention, replying to the comment", async () => {
    const { signed, taskCalls } = setup();
    const res = await signed(commentEvent(`[~accountid:${BOT}] please *also* fix the footer`));
    expect(res.status).toBe(200);
    // Comment 20001 on issue 10042: each id must land in its own place.
    expect(taskCalls.map((c) => [c.method, ...c.args])).toEqual([
      ["findTask", "10042"],
      [
        "enqueueRound",
        {
          task: TASK,
          kind: "comment",
          externalId: "comment:20001",
          payload: {
            target_id: "20001",
            body: "please **also** fix the footer",
            pr: null,
            created_at: "",
          },
          targets: [{ id: "20001", spec: { kind: "jira_issue", issueId: "10042" } }],
        },
      ],
    ]);
    expect(logged(info)).toContainEqual([
      "jira follow-up",
      {
        issueId: "10042",
        commentId: "20001",
        accountId: HUMAN,
        taskId: "task-1",
        roundId: "round-1",
      },
    ]);
  });

  it("accepts a typed @name as the mention", async () => {
    const { signed, taskCalls } = setup();
    await signed(commentEvent("@devbox try again"));
    expect(taskCalls.map((c) => c.method)).toEqual(["findTask", "enqueueRound"]);
  });

  it("ignores a comment without a mention, without a lookup or a log line", async () => {
    const { signed, taskCalls, jiraCalls } = setup();
    const res = await signed(commentEvent("looks good to me"));
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(taskCalls).toEqual([]);
    expect(jiraCalls).toEqual([]);
    expect(logged(info)).toEqual([]);
  });

  it.each([
    [
      "a restricted comment",
      { visibility: { type: "role", value: "Admins" } },
      "restricted_comment",
    ],
    ["a customer's comment", { author: user(HUMAN, "customer") }, "non_human"],
    ["an app's comment", { author: user(HUMAN, "app") }, "non_human"],
  ] as const)("ignores %s", async (_, opts, reason) => {
    const { signed, taskCalls } = setup();
    const res = await signed(commentEvent("@devbox do it", opts));
    expect(await res.json()).toEqual({ status: "ignored", reason });
    expect(taskCalls).toEqual([]);
  });

  it("drops an app's comment that doesn't mention the bot without a log line", async () => {
    const { signed, taskCalls } = setup();
    const res = await signed(commentEvent("build passed", { author: user(HUMAN, "app") }));
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(taskCalls).toEqual([]);
    expect(logged(info)).toEqual([]);
  });

  it("drops the bot's own comment without a log line, even one that names it", async () => {
    const { signed, taskCalls, jiraCalls } = setup();
    const res = await signed(commentEvent("@devbox here is the PR", { author: user(BOT, "app") }));
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(taskCalls).toEqual([]);
    expect(jiraCalls).toEqual([]);
    expect(logged(info)).toEqual([]);
  });

  it("ignores a follow-up on an issue that has since been restricted", async () => {
    const restricted = {
      getIssue: async (id: string) => ({ id, key: "DEMO-7", fields: { security: { id: "1" } } }),
    };
    const closed = setup({ client: restricted });
    const res = await closed.signed(commentEvent("@devbox do it"));
    expect(await res.json()).toEqual({ status: "ignored", reason: "restricted_issue" });
    expect(closed.taskCalls.map((c) => c.method)).toEqual(["findTask"]);
    expect(ignoredLog()).toMatchObject({ reason: "restricted_issue", issueId: "10042" });

    const open = setup();
    await open.signed(commentEvent("@devbox do it"));
    expect(open.jiraCalls).toContain("getIssue 10042 security");
    expect(open.taskCalls.map((c) => c.method)).toEqual(["findTask", "enqueueRound"]);

    const allowed = setup({ cfg: { allowRestrictedIssues: true }, client: restricted });
    await allowed.signed(commentEvent("@devbox do it"));
    expect(allowed.taskCalls.map((c) => c.method)).toEqual(["findTask", "enqueueRound"]);
  });

  it("answers 503 when the issue's security level can't be read for a follow-up", async () => {
    const { signed, taskCalls } = setup({
      client: {
        getIssue: async () => {
          throw new HttpError("Jira GET failed: HTTP 500", 500);
        },
      },
    });
    const res = await signed(commentEvent("@devbox do it"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "security_unresolved" });
    expect(taskCalls.map((c) => c.method)).toEqual(["findTask"]);
  });

  it("ignores a commenter of unknown account type silently", async () => {
    const { signed, taskCalls, jiraCalls } = setup();
    const res = await signed(commentEvent("@devbox do it", { author: user(STRANGER, "unknown") }));
    expect(await res.json()).toEqual({ status: "ignored", reason: "untrusted" });
    expect(ignoredLog()).toEqual({
      reason: "untrusted",
      issueId: "10042",
      commentId: "20001",
      accountId: STRANGER,
      side: "commenter",
    });
    expect(taskCalls).toEqual([]);
    expect(jiraCalls).toEqual([]);
  });

  it("answers 503 for the bot's issue with no task yet, so Jira retries", async () => {
    const { signed, taskCalls } = setup({ task: null });
    const res = await signed(commentEvent("@devbox do it"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "task_not_found" });
    expect(taskCalls.map((c) => c.method)).toEqual(["findTask"]);
    expect(logged(warn)).toEqual([
      ["jira_webhook.task_not_found", { issueId: "10042", commentId: "20001", accountId: HUMAN }],
    ]);
  });

  it.each([
    ["someone else's", HUMAN],
    ["an unassigned", null],
  ] as const)(
    "ignores a mention on %s issue with no task, without a warning",
    async (_, assignee) => {
      const { signed, taskCalls } = setup({ task: null });
      const res = await signed(commentEvent("@devbox do it", { assignee }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ignored", reason: "no_task" });
      expect(taskCalls.map((c) => c.method)).toEqual(["findTask"]);
      expect(ignoredLog()).toEqual({
        reason: "no_task",
        issueId: "10042",
        commentId: "20001",
        accountId: HUMAN,
      });
      expect(logged(warn)).toEqual([]);
    },
  );
});

describe("Jira webhook: logs", () => {
  it("never carry a name or an email", async () => {
    const { signed } = setup();
    await signed(assignmentEvent());
    await signed(assignmentEvent({ actor: user(STRANGER, "unknown") }));
    await signed(assignmentEvent({ actor: user(BOT) }));
    await signed(commentEvent("@devbox x", { visibility: { type: "group", value: "staff" } }));
    await signed(commentEvent("@devbox x"));
    const all = JSON.stringify([...logged(info), ...logged(warn)]);
    expect(all).toContain(STRANGER);
    expect(all).not.toContain(NAME);
    expect(all).not.toContain(EMAIL);
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
      for (const event of [assignmentEvent(), commentEvent("@devbox please fix the footer")]) {
        const res = await signed(event);
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "internal" });
      }
      expect(logged(error)).toEqual([
        ["jira webhook failed", { error: "Error", code: "22P05" }],
        ["jira webhook failed", { error: "Error", code: "22P05" }],
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it("strips NUL, which Postgres can't store, from what it queues", async () => {
    const { signed, taskCalls } = setup();
    const event = assignmentEvent();
    event.issue.fields.summary = "Fix\0 the login page";
    event.issue.fields.description = "the button\0 is broken";
    await signed(event);
    await signed(commentEvent("@devbox also\0 the footer"));
    const queued = JSON.stringify(taskCalls);
    expect(queued).not.toContain("\\u0000");
    expect(queued).toContain("Fix the login page");
    expect(queued).toContain("the button is broken");
    expect(queued).toContain("also the footer");
  });
});
