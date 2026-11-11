import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Task } from "../../../db/schema";
import { logger } from "../../../logger";
import { HttpError } from "../../http";
import { type Outbound, RetryableError } from "../../outbound";
import type { Outcome, PrRef, ReplyTarget, Round } from "../../types";
import type { AdfDoc } from "../adf";
import type { RemoteLink } from "../client";
import type { JiraConfig } from "../config";
import type { Client } from "../index";
import { assignmentEvent, BOT, CFG, HUMAN, NOW, setup, TASK, TRANSITIONS, user } from "./fixtures";

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

const target: ReplyTarget = { id: "10077", spec: { kind: "jira_issue", issueId: "10042" } };
const ctx = () => ({ signal: new AbortController().signal, log: logger });
const round = (kind: "assignment" | "comment") => ({ id: "r1", kind, source: "jira" }) as Round;
const text = (doc: AdfDoc | undefined) => JSON.stringify(doc);

describe("JiraIntegration deliver", () => {
  it("posts a reply as ADF comments on the target's issue", async () => {
    const { jira, posted } = setup();
    await jira.deliver(ctx(), target, { type: "reply", body: "Done: see **the PR**." });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.issueId).toBe("10042");
    expect(text(posted[0]?.doc)).toContain('"marks":[{"type":"strong"}]');
  });

  it("posts nothing for progress or a blank reply", async () => {
    const { jira, jiraCalls } = setup();
    for (const kind of ["thought", "action", "error"] as const) {
      await jira.deliver(ctx(), target, { type: "progress", kind, body: "working" });
    }
    await jira.deliver(ctx(), target, { type: "reply", body: "  " });
    expect(jiraCalls).toEqual([]);
  });

  it("refuses another integration's target and a malformed one", async () => {
    const { jira, jiraCalls } = setup();
    for (const spec of [
      { kind: "linear_session" },
      { kind: "issue_comment", owner: "o", repo: "r", prNumber: 1, commentId: 1 },
      { kind: "jira_issue" },
      { kind: "jira_issue", issueId: 10042 },
      { kind: "jira_issue", issueId: "../10042" },
      null,
      "jira_issue",
    ]) {
      await expect(
        jira.deliver(ctx(), { id: "x", spec }, { type: "reply", body: "x" }),
      ).rejects.toThrow("not a Jira issue target");
    }
    expect(jiraCalls).toEqual([]);
  });

  it("may retry only when the first part failed before it was sent", async () => {
    const { jira } = setup({
      client: {
        addComment: async () => {
          throw new HttpError("Jira POST failed: HTTP 429", 429, 30_000);
        },
      },
    });
    const err = await jira.deliver(ctx(), target, { type: "reply", body: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).retryAfterMs).toBe(30_000);
    expect(await jira.status()).toMatchObject({
      lastReplyFailure: { status: 429, at: new Date(NOW).toISOString() },
    });
  });

  it("never asks for a retry once a part is posted, so no part is posted twice", async () => {
    let sent = 0;
    const { jira } = setup({
      client: {
        addComment: async () => {
          if (++sent === 2) throw new HttpError("Jira POST failed: HTTP 429", 429);
          return { id: String(sent) };
        },
      },
    });
    const body = ["a".repeat(20_000), "b".repeat(20_000), "c".repeat(20_000)].join("\n\n");
    const err = await jira.deliver(ctx(), target, { type: "reply", body }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RetryableError);
    expect((err as Error).message).toContain("part 2 of 3");
    expect(sent).toBe(2);
    expect(await jira.status()).toMatchObject({
      lastReplyFailure: { status: 429, at: new Date(NOW).toISOString() },
    });
  });

  it("replaces a first part Jira refuses as too long with one short comment", async () => {
    const tooLong = new HttpError(
      'Jira POST /issue/10042/comment failed: HTTP 400 {"errors":{"comment":"You have exceeded the maximum length allowed"}}',
      400,
    );
    const docs: AdfDoc[] = [];
    const { jira } = setup({
      client: {
        addComment: async (_id: string, doc: AdfDoc) => {
          docs.push(doc);
          if (docs.length === 1) throw tooLong;
          return { id: "20002" };
        },
      },
    });
    const body = ["a".repeat(20_000), "b".repeat(20_000)].join("\n\n");
    await jira.deliver(ctx(), target, { type: "reply", body });
    expect(docs).toHaveLength(2);
    const short = text(docs[1]);
    expect(short.length).toBeLessThanOrEqual(10_000);
    expect(short).toContain("aaaa");
    expect(short).toEndWith('{"type":"text","text":"Full text in the pull request."}]}]}');
    expect(await jira.status()).toMatchObject({ lastReplyFailure: { status: 400 } });
  });

  it("keeps any other 400, and a later part's, as a failure", async () => {
    let sent = 0;
    const refuse = (when: number, message: string) =>
      setup({
        client: {
          addComment: async () => {
            if (++sent === when) throw new HttpError(message, 400);
            return { id: String(sent) };
          },
        },
      }).jira;
    const body = ["a".repeat(20_000), "b".repeat(20_000)].join("\n\n");
    const invalid = refuse(1, "Jira POST failed: HTTP 400 INVALID_INPUT");
    await expect(invalid.deliver(ctx(), target, { type: "reply", body })).rejects.toThrow(
      "INVALID_INPUT",
    );
    expect(sent).toBe(1);

    sent = 0;
    const later = refuse(2, "Jira POST failed: HTTP 400 maximum length exceeded");
    await expect(later.deliver(ctx(), target, { type: "reply", body })).rejects.toThrow(
      "part 2 of 2",
    );
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
      "devbox couldn't finish this task. To start over, assign the issue to someone else and then back to devbox; this opens a new pull request.",
    ],
    [
      failure("task_failed", "comment"),
      "devbox couldn't finish this. Comment with @devbox to retry.",
    ],
    [
      failure("workspace_missing", "comment"),
      "This task's workspace was cleaned up, so devbox can't continue it. Assign the issue to someone else and then back to devbox to start over.",
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
    const { jira, posted } = setup();
    await jira.deliver(ctx(), target, message);
    expect(posted).toHaveLength(1);
    expect(text(posted[0]?.doc)).toContain(JSON.stringify(expected).slice(1, -1));
  });

  it("never posts a failure's raw detail", async () => {
    const detail = "Traceback: KeyError at /workspace/secret_module.py";
    const { jira, posted } = setup();
    for (const cause of ["round_failed", "task_failed", "workspace_missing"] as const) {
      for (const kind of ["assignment", "comment"] as const) {
        await jira.deliver(ctx(), target, failure(cause, kind, { detail }));
        await jira.deliver(ctx(), target, failure(cause, kind, { summary: "Failed.", detail }));
      }
    }
    expect(posted.length).toBeGreaterThan(0);
    expect(JSON.stringify(posted)).not.toContain("Traceback");
  });
});

describe("JiraIntegration status", () => {
  it("reports auth, token, permissions and reply failures without secrets", async () => {
    const { jira, signed } = setup();
    await signed(assignmentEvent());
    const status = await jira.status();
    expect(status).toEqual({
      configured: true,
      lastWebhookAt: new Date(NOW).toISOString(),
      bot: { accountId: BOT, name: "devbox" },
      auth: "ok",
      // Held in no project.
      permissions: { missing: ["ASSIGNABLE_USER"] },
      lastReplyFailure: null,
    });
    const json = JSON.stringify(status);
    for (const secret of [CFG.apiToken, CFG.webhookSecret, CFG.botEmail]) {
      expect(json).not.toContain(secret);
    }
  });

  it("shows a rejected token and failures as a class, never upstream text", async () => {
    const upstream = "HTTP 401 <html>token abc123 is revoked</html>";
    const { jira } = setup({
      client: {
        myself: async () => {
          throw new HttpError(`Jira GET /myself failed: ${upstream}`, 401);
        },
        myPermissions: async () => {
          throw new HttpError(`Jira GET failed: ${upstream}`, 403);
        },
      },
    });
    const status = await jira.status();
    expect(status).toMatchObject({ auth: "rejected", permissions: { error: "http_403" } });
    expect(JSON.stringify(status)).not.toContain("abc123");
  });

  it("is unknown when Jira can't be reached", async () => {
    const { jira } = setup({
      client: {
        myself: async () => {
          throw new HttpError("HTTP 502", 502);
        },
      },
    });
    expect(await jira.status()).toMatchObject({ auth: "unknown" });
  });
});

const ISSUE_TASK = { ...TASK, externalId: "10042" } as Task;
const PR: PrRef = {
  url: "https://github.com/acme/widgets/pull/42",
  repo: "widgets",
  branch: "devbox/x",
};

// The issue as the hooks read it: its status and assignee (null: unassigned).
function issueAt(status: string, assignee: string | null = BOT) {
  return {
    getIssue: async (id: string, fields: string[]) => {
      expect(fields).toEqual(["status", "assignee"]);
      return {
        id,
        key: "DEMO-7",
        fields: {
          status: { id: "1", name: status },
          assignee:
            assignee === null ? null : user(assignee, assignee === BOT ? "app" : "atlassian"),
        } as Record<string, unknown>,
      };
    },
  };
}

// A hook context whose isCurrent() answer is recorded among the Jira calls,
// so tests see when it was asked.
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
    .filter(([msg]) => msg === "jira transition skipped")
    .map(([, meta]) => (meta as { reason: string }).reason);
const refused = (status: number) => async () => {
  throw new HttpError(`Jira POST /issue/10042/transitions failed: HTTP ${status}`, status);
};

describe("JiraIntegration onTaskStarted", () => {
  it("moves the bot's issue to the started status, matching names in any case", async () => {
    const { jira, jiraCalls } = setup({
      cfg: { statuses: { started: "IN PROGRESS" } },
      client: issueAt("To Do"),
    });
    await jira.onTaskStarted(hookCtx(jiraCalls), ISSUE_TASK);
    expect(jiraCalls).toEqual(["transitions 10042", "isCurrent", "transition 10042 11"]);
  });

  it.each([
    ["someone else is the assignee", issueAt("To Do", HUMAN), "not_assignee"],
    ["the issue is unassigned", issueAt("To Do", null), "not_assignee"],
    ["the issue is already started", issueAt("in progress"), "already_there"],
  ])("leaves the issue alone when %s", async (_, client, reason) => {
    const { jira, jiraCalls } = setup({ client });
    await jira.onTaskStarted(hookCtx(jiraCalls), ISSUE_TASK);
    expect(jiraCalls).toEqual([]);
    expect(skipped()).toEqual([reason]);
  });

  it("does nothing without a started status", async () => {
    // The default fake records getIssue calls too.
    const { jira, jiraCalls } = setup({ cfg: { statuses: { done: "Done" } } });
    await jira.onTaskStarted(hookCtx(jiraCalls), ISSUE_TASK);
    expect(jiraCalls).toEqual([]);
  });

  it("skips, with a warning, when the workflow has no move to the started status", async () => {
    const { jira, jiraCalls } = setup({
      cfg: { statuses: { started: "Doing" } },
      client: issueAt("To Do"),
    });
    await jira.onTaskStarted(hookCtx(jiraCalls), ISSUE_TASK);
    expect(jiraCalls).toEqual(["transitions 10042"]);
    expect(logged(warn)).toEqual([
      [
        "jira transition skipped: the workflow has no move to this status",
        { taskId: "task-1", issueId: "10042", to: "Doing" },
      ],
    ]);
  });

  it("skips when the task was restarted meanwhile", async () => {
    const { jira, jiraCalls } = setup({ client: issueAt("To Do") });
    await jira.onTaskStarted(hookCtx(jiraCalls, { current: false }), ISSUE_TASK);
    expect(jiraCalls).toEqual(["transitions 10042", "isCurrent"]);
    expect(skipped()).toEqual(["restarted"]);
  });

  it.each([400, 409, 422])("logs a %d refusal and carries on", async (status) => {
    const { jira, jiraCalls } = setup({
      client: { ...issueAt("To Do"), transition: refused(status) },
    });
    await jira.onTaskStarted(hookCtx(jiraCalls), ISSUE_TASK);
    expect(logged(warn)).toEqual([
      [
        "jira transition refused",
        { taskId: "task-1", issueId: "10042", to: "In Progress", status },
      ],
    ]);
  });

  it("leaves any other failure to the hook runner", async () => {
    const { jira, jiraCalls } = setup({
      client: { ...issueAt("To Do"), transition: refused(500) },
    });
    await expect(jira.onTaskStarted(hookCtx(jiraCalls), ISSUE_TASK)).rejects.toThrow("HTTP 500");
  });
});

describe("JiraIntegration onPrOpened", () => {
  const linked = (calls: string[]) =>
    calls.map((c) => JSON.parse(c.replace("upsertRemoteLink 10042 ", "")) as RemoteLink);

  it("links the pull request on the issue, keyed by its URL", async () => {
    const { jira, jiraCalls } = setup();
    await jira.onPrOpened(hookCtx([]), ISSUE_TASK, PR);
    expect(linked(jiraCalls)).toEqual([
      { globalId: PR.url, url: PR.url, title: "acme/widgets#42" },
    ]);
  });

  it("titles a link to a page of the pull request by the pull request", async () => {
    const { jira, jiraCalls } = setup();
    const url = "https://github.com/acme/widgets/pull/42/files";
    await jira.onPrOpened(hookCtx([]), ISSUE_TASK, { ...PR, url });
    expect(linked(jiraCalls)).toEqual([{ globalId: url, url, title: "acme/widgets#42" }]);
  });

  it.each([
    ["a lookalike host", "https://github.com.evil.example/acme/widgets/pull/42"],
    ["credentials", "https://user:secret@github.com/acme/widgets/pull/42"],
    ["another host", "https://git.example.com/acme/widgets/pull/42"],
    ["a script", "javascript:alert(1)"],
    ["http", "http://github.com/acme/widgets/pull/42"],
    ["a pull request number that isn't one", "https://github.com/acme/widgets/pull/42x"],
  ])("never links a URL with %s, and says so", async (_, url) => {
    const { jira, jiraCalls } = setup();
    await jira.onPrOpened(hookCtx([]), ISSUE_TASK, { ...PR, url });
    expect(jiraCalls).toEqual([]);
    expect(logged(warn)).toEqual([
      [
        "jira PR link skipped: not a GitHub pull request or GitLab merge request URL",
        { taskId: "task-1" },
      ],
    ]);
  });

  it("links a merge request under the GitLab instance, titled group/project!N", async () => {
    const { jira, jiraCalls } = setup({ cfg: { gitlabBaseUrl: "https://git.example.com/gl" } });
    for (const url of [
      "https://git.example.com/gl/acme/sub/widgets/-/merge_requests/12",
      "https://git.example.com/gl/acme/sub/widgets/-/merge_requests/12/diffs",
    ]) {
      await jira.onPrOpened(hookCtx([]), ISSUE_TASK, { ...PR, url });
    }
    expect(linked(jiraCalls).map((l) => l.title)).toEqual([
      "acme/sub/widgets!12",
      "acme/sub/widgets!12",
    ]);
  });

  it.each([
    [
      "no GitLab instance set",
      undefined,
      "https://git.example.com/acme/widgets/-/merge_requests/12",
    ],
    [
      "another host",
      "https://git.example.com",
      "https://gitlab.com/acme/widgets/-/merge_requests/12",
    ],
    [
      "a lookalike host",
      "https://git.example.com",
      "https://git.example.com.evil.example/acme/widgets/-/merge_requests/12",
    ],
    [
      "credentials",
      "https://git.example.com",
      "https://u:p@git.example.com/acme/widgets/-/merge_requests/12",
    ],
    [
      "a path outside the instance's prefix",
      "https://git.example.com/gl",
      "https://git.example.com/glx/acme/widgets/-/merge_requests/12",
    ],
    [
      "a dot segment",
      "https://git.example.com",
      "https://git.example.com/../widgets/-/merge_requests/12",
    ],
    [
      "not a merge request",
      "https://git.example.com",
      "https://git.example.com/acme/widgets/-/issues/12",
    ],
  ])("never links a GitLab URL with %s", async (_, gitlabBaseUrl, url) => {
    const { jira, jiraCalls } = setup({ cfg: { gitlabBaseUrl } });
    await jira.onPrOpened(hookCtx([]), ISSUE_TASK, { ...PR, url });
    expect(jiraCalls).toEqual([]);
  });

  it("lets a retryable failure escape so the event is held, and nothing else", async () => {
    const fail = (status: number) =>
      setup({
        client: {
          upsertRemoteLink: async () => {
            throw new HttpError(
              `Jira POST /issue/10042/remotelink failed: HTTP ${status}`,
              status,
              5_000,
            );
          },
        },
      }).jira.onPrOpened(hookCtx([]), ISSUE_TASK, PR);
    const held = await fail(429).catch((e) => e);
    expect(held).toBeInstanceOf(RetryableError);
    expect((held as RetryableError).retryAfterMs).toBe(5_000);
    const dropped = await fail(500).catch((e) => e);
    expect(dropped).toBeInstanceOf(HttpError);
    expect(dropped).not.toBeInstanceOf(RetryableError);
  });
});

describe("JiraIntegration onRoundFinished", () => {
  const statuses = { started: "In Progress", done: "done", failed: "Failed" };
  const finish = (
    o: {
      outcome?: Outcome | null;
      kind?: "assignment" | "comment";
      ctx?: { current?: boolean; firstTransition?: boolean };
      cfg?: Partial<JiraConfig>;
      client?: Partial<Client>;
    } = {},
  ) => {
    const s = setup({ cfg: o.cfg ?? { statuses }, client: o.client ?? issueAt("in progress") });
    const outcome = o.outcome === undefined ? "completed" : o.outcome;
    const ctx = hookCtx(s.jiraCalls, o.ctx);
    return s.jira
      .onRoundFinished(ctx, ISSUE_TASK, round(o.kind ?? "assignment"), outcome)
      .then(() => s.jiraCalls);
  };

  it.each([
    ["completed", "31"],
    ["no_action", "31"],
    ["partial_failure", "31"],
    ["failed", "41"],
  ] as const)("moves a %s task's issue from started (transition %s)", async (outcome, id) => {
    expect(await finish({ outcome })).toEqual([
      "transitions 10042",
      "isCurrent",
      `transition 10042 ${id}`,
    ]);
  });

  it.each([
    ["the round isn't the first to finish", { ctx: { firstTransition: false } }],
    ["the round is a comment", { kind: "comment" as const }],
    ["the outcome is unknown", { outcome: null }],
    [
      "no failed status is configured",
      { outcome: "failed" as const, cfg: { statuses: { started: "In Progress", done: "Done" } } },
    ],
    [
      "no done status is configured",
      { cfg: { statuses: { started: "In Progress", failed: "Failed" } } },
    ],
    ["no started status is configured", { cfg: { statuses: { done: "Done", failed: "Failed" } } }],
  ])("touches nothing when %s", async (_, o) => {
    // The default fake records getIssue calls too.
    expect(await finish({ ...o, client: {} })).toEqual([]);
  });

  it.each([
    ["was re-assigned", issueAt("In Progress", HUMAN), "not_assignee"],
    ["was un-assigned", issueAt("In Progress", null), "not_assignee"],
    ["was moved by hand", issueAt("Blocked"), "status_moved"],
    ["is already done", issueAt("Done"), "already_there"],
  ])("leaves an issue that %s alone", async (_, client, reason) => {
    expect(await finish({ client })).toEqual([]);
    expect(skipped()).toEqual([reason]);
  });

  it("asks whether the task is current right before the move, and skips if not", async () => {
    expect(await finish({ ctx: { current: false } })).toEqual(["transitions 10042", "isCurrent"]);
    expect(skipped()).toEqual(["restarted"]);
  });

  it("skips when the workflow has no move to the status", async () => {
    const transitions = async () => TRANSITIONS.filter((t) => t.id !== "31");
    const calls = await finish({ client: { ...issueAt("In Progress"), transitions } });
    expect(calls).toEqual([]);
    expect(logged(warn).map(([msg]) => msg)).toEqual([
      "jira transition skipped: the workflow has no move to this status",
    ]);
  });

  it("logs a 409 and carries on", async () => {
    await finish({ client: { ...issueAt("In Progress"), transition: refused(409) } });
    expect(logged(warn)).toEqual([
      ["jira transition refused", { taskId: "task-1", issueId: "10042", to: "done", status: 409 }],
    ]);
  });
});
