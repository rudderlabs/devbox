// Synthetic ids, names and payloads, shaped like Jira Cloud's admin webhooks,
// and Jira behind the real webhook route with a fake Jira client and a
// TaskService that record what reaches them.
import { createHmac } from "node:crypto";
import type { Task } from "../../../db/schema";
import { logger } from "../../../logger";
import { createWebhookRoutes } from "../../../routes/webhook";
import type { TaskService } from "../../types";
import type { AdfDoc } from "../adf";
import type { JiraTransition, RemoteLink } from "../client";
import type { JiraConfig } from "../config";
import { type Client, createJira } from "../index";

export const BOT = "5e0f1a2b3c4d5e6f7a8b9c0d";
export const HUMAN = "5c3e2f1a9b8d7c6e5f4a3b21";
export const REPORTER = "5d4c3b2a1f0e9d8c7b6a5f43";
export const STRANGER = "5f6e5d4c3b2a1f0e9d8c7b6a";
export const SECRET = "webhook-test-secret";
export const NAME = "Some Person";
export const EMAIL = "some.person@example.com";
export const NOW = new Date("2026-11-02T12:00:00Z").getTime();

export const CFG: JiraConfig = {
  siteUrl: "https://example.atlassian.net",
  cloudId: "11111111-2222-4333-8444-555555555555",
  botEmail: "devbox-bot@example.com",
  botAccountId: BOT,
  botName: "devbox",
  statuses: { started: "In Progress", done: "Done" },
  allowRestrictedIssues: false,
  apiToken: "jira-test-token",
  webhookSecret: SECRET,
};

export function user(accountId: string, accountType = "atlassian") {
  return {
    self: `https://example.atlassian.net/rest/api/2/user?accountId=${accountId}`,
    accountId,
    displayName: NAME,
    emailAddress: EMAIL,
    active: true,
    accountType,
  };
}

type AssignmentOpts = {
  actor?: ReturnType<typeof user>;
  reporter?: ReturnType<typeof user> | null;
  creator?: ReturnType<typeof user> | null;
  security?: unknown; // "absent" leaves the field out
  changelogId?: string;
  issueId?: string;
  issueKey?: string;
};

export function assignmentEvent(o: AssignmentOpts = {}) {
  const fields: Record<string, unknown> = {
    summary: "Fix the login page",
    description: `[~accountid:${BOT}] the button is *broken* #devbox:exp:FAST_MODE`,
    project: { id: "10000", key: "DEMO", name: "Demo" },
    reporter: o.reporter === undefined ? user(REPORTER) : o.reporter,
    creator: o.creator === undefined ? user(REPORTER) : o.creator,
    assignee: user(BOT, "app"),
  };
  if (o.security !== "absent") fields.security = o.security ?? null;
  const issueId = o.issueId ?? "10042";
  return {
    timestamp: 1_700_000_000_000,
    webhookEvent: "jira:issue_updated",
    issue_event_type_name: "issue_assigned",
    user: o.actor ?? user(HUMAN),
    issue: {
      id: issueId,
      self: `https://evil.example.com/rest/api/2/issue/${issueId}`,
      key: o.issueKey ?? "DEMO-7",
      fields,
    },
    changelog: {
      id: o.changelogId ?? "10101",
      items: [{ field: "assignee", fieldtype: "jira", fieldId: "assignee", from: null, to: BOT }],
    },
  };
}

type CommentOpts = {
  author?: ReturnType<typeof user>;
  visibility?: unknown;
  commentId?: string;
  issueId?: string;
  assignee?: string | null; // the issue's; null: unassigned
};

export function commentEvent(body: string, o: CommentOpts = {}) {
  return {
    timestamp: 1_700_000_000_000,
    webhookEvent: "comment_created",
    comment: {
      id: o.commentId ?? "20001",
      author: o.author ?? user(HUMAN),
      body,
      created: "2026-11-01T00:00:00.000+0000",
      jsdPublic: true,
      ...(o.visibility === undefined ? {} : { visibility: o.visibility }),
    },
    issue: {
      id: o.issueId ?? "10042",
      key: "DEMO-7",
      fields: {
        summary: "Fix the login page",
        project: { key: "DEMO" },
        assignee: o.assignee === null ? null : user(o.assignee ?? BOT, "app"),
      },
    },
  };
}

export const TASK = { id: "task-1", key: "DEMO-7" } as Task;
// The moves the bot's workflow offers from any status.
export const TRANSITIONS: JiraTransition[] = [
  { id: "11", name: "Start", to: { id: "3", name: "In Progress" } },
  { id: "31", name: "Finish", to: { id: "10001", name: "Done" } },
  { id: "41", name: "Give up", to: { id: "10002", name: "Failed" } },
];
export const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

// A fake Jira that records its calls.
export function fakeClient(calls: string[], posted: Array<{ issueId: string; doc: AdfDoc }>) {
  return {
    async getIssue(id: string, fields: string[]) {
      calls.push(`getIssue ${id} ${fields.join(",")}`);
      return { id, key: "DEMO-7", fields: { security: null } as Record<string, unknown> };
    },
    async addComment(issueId: string, doc: AdfDoc) {
      calls.push(`addComment ${issueId}`);
      posted.push({ issueId, doc });
      return { id: "20001" };
    },
    async myself() {
      calls.push("myself");
      return { accountId: BOT, accountType: "app", displayName: "devbox" };
    },
    async myPermissions(perms: string[]) {
      return Object.fromEntries(perms.map((p) => [p, p !== "ASSIGNABLE_USER"]));
    },
    async transitions(id: string) {
      calls.push(`transitions ${id}`);
      return TRANSITIONS;
    },
    async transition(id: string, transitionId: string) {
      calls.push(`transition ${id} ${transitionId}`);
    },
    async upsertRemoteLink(id: string, link: RemoteLink) {
      calls.push(`upsertRemoteLink ${id} ${JSON.stringify(link)}`);
    },
  } satisfies Client;
}

export function setup(
  o: {
    cfg?: Partial<JiraConfig>;
    client?: Partial<Client>;
    task?: Task | null;
    result?: "created" | "restarted" | "duplicate";
    tasks?: Partial<TaskService>;
  } = {},
) {
  const clock = { t: NOW };
  const jiraCalls: string[] = [];
  const posted: Array<{ issueId: string; doc: AdfDoc }> = [];
  const client: Client = { ...fakeClient(jiraCalls, posted), ...o.client };
  const taskCalls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <R>(method: string, value: R) =>
    async (...args: unknown[]) => {
      taskCalls.push({ method, args });
      return value;
    };
  const tasks = {
    source: "jira",
    assign: record("assign", { taskId: "task-1", key: "DEMO-7", result: o.result ?? "created" }),
    restart: record("restart", undefined),
    enqueueRound: record("enqueueRound", { roundId: "round-1" }),
    findTask: record("findTask", o.task === undefined ? TASK : o.task),
    findTaskByPrUrl: record("findTaskByPrUrl", null),
    ...o.tasks,
  } as TaskService;
  const jira = createJira(
    { tasks, log: logger },
    { ...CFG, ...o.cfg },
    { client, now: () => clock.t },
  );
  const app = createWebhookRoutes([{ name: "jira", webhook: (c) => jira.webhook(c) }]);
  const send = (body: string, headers: Record<string, string> = {}) =>
    app.request(`/webhook/jira?triggeredByUser=${STRANGER}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });
  const signed = (payload: unknown) => {
    const body = JSON.stringify(payload);
    return send(body, { "x-hub-signature": sign(body) });
  };
  return { jira, clock, jiraCalls, posted, taskCalls, send, signed };
}
