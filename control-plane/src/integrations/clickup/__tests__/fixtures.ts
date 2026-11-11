// Synthetic ids, names and payloads, shaped like ClickUp's webhook
// deliveries, and ClickUp behind the real webhook route with a fake ClickUp
// client and a TaskService that record what reaches them.
import { createHmac } from "node:crypto";
import type { Task } from "../../../db/schema";
import { logger } from "../../../logger";
import { createWebhookRoutes } from "../../../routes/webhook";
import type { TaskService } from "../../types";
import type { ClickUpMember, ClickUpTask } from "../client";
import type { ClickUpConfig } from "../config";
import { type Client, createClickUp } from "../index";
import type { ClickUpPart } from "../quill";

export const BOT = 1000001;
export const HUMAN = 1000002;
export const CREATOR = 1000003;
export const GUEST = 1000004;
export const STRANGER = 1000005; // in no workspace member list
export const TEAM = "1234567";
export const TASK_ID = "abc0001";
export const LIST_ID = "7000001";
export const ITEM_ID = "1000000000000000001";
export const COMMENT_ID = "9000000000000000001";
export const DATE = "1767225600000";
export const SECRET = "webhook-test-secret";
export const NAME = "Some Person";
export const EMAIL = "some.person@example.com";
export const NOW = new Date("2026-11-02T12:00:00Z").getTime();

export const CFG: ClickUpConfig = {
  teamId: TEAM,
  botUserId: BOT,
  botName: "devbox",
  statuses: { started: "in progress" },
  apiToken: "pk_test_token",
  webhookSecret: SECRET,
};

// A webhook actor: role 1 owner, 2 admin, 3 member, 4 guest.
export function user(id: number, role: number | null = 3) {
  return {
    id,
    username: NAME,
    email: EMAIL,
    color: "#7b68ee",
    initials: "SP",
    profilePicture: null,
    role,
    role_subtype: 0,
  };
}

// Automations act as ClickBot: a negative id and no role.
export const CLICKBOT = {
  id: -1,
  username: "ClickBot",
  email: "clickbot@example.com",
  color: "",
  initials: "C",
  profilePicture: null,
  role: null,
};

type AssignmentOpts = {
  actor?: unknown;
  taskId?: string;
  itemId?: string;
  date?: string;
  field?: string;
  assignee?: number;
};

export function assignmentEvent(o: AssignmentOpts = {}) {
  const field = o.field ?? "assignee_add";
  const assignee = user(o.assignee ?? BOT);
  return {
    event: "taskAssigneeUpdated",
    task_id: o.taskId ?? TASK_ID,
    webhook_id: "00000000-0000-4000-8000-000000000000",
    history_items: [
      {
        id: o.itemId ?? ITEM_ID,
        type: 1,
        date: o.date ?? DATE,
        field,
        parent_id: LIST_ID,
        data: {},
        source: null,
        user: o.actor ?? user(HUMAN),
        before: field === "assignee_rem" ? assignee : null,
        after: field === "assignee_rem" ? null : assignee,
      },
    ],
  };
}

export const text = (t: string, attributes: Record<string, unknown> = {}) => ({
  text: t,
  attributes,
});
export const tag = (id: number) => ({
  type: "tag",
  text: `@${NAME}`,
  user: { id, username: NAME, email: EMAIL, color: "#000", initials: "SP", profilePicture: null },
});

type CommentOpts = { author?: unknown; commentId?: string; taskId?: string; isPrivate?: boolean };

export function commentEvent(parts: unknown[], o: CommentOpts = {}) {
  const author = o.author ?? user(HUMAN);
  const commentId = o.commentId ?? COMMENT_ID;
  return {
    event: "taskCommentPosted",
    task_id: o.taskId ?? TASK_ID,
    webhook_id: "00000000-0000-4000-8000-000000000000",
    history_items: [
      {
        id: "1000000000000000002",
        type: 1,
        date: DATE,
        field: "comment",
        parent_id: LIST_ID,
        data: {},
        source: null,
        user: author,
        before: null,
        after: commentId,
        comment: {
          id: commentId,
          date: DATE,
          parent: o.taskId ?? TASK_ID,
          type: 1,
          comment: parts,
          text_content: parts.map((p) => (p as { text?: string }).text ?? "").join(""),
          x: null,
          y: null,
          image_y: null,
          image_x: null,
          page: null,
          comment_number: null,
          page_id: null,
          page_name: null,
          view_id: null,
          view_name: null,
          team: TEAM,
          user: author,
          new_thread_count: 0,
          new_mentioned_thread_count: 0,
          email_attachments: [],
          threaded_users: [],
          threaded_replies: 0,
          threaded_assignees: 0,
          threaded_assignees_unresolved: 0,
          is_private: o.isPrivate ?? false,
          reactions: [],
          emails: [],
          ai: false,
        },
      },
    ],
  };
}

export const TASK = { id: "task-1", key: "CU-abc0001" } as Task;

export function clickUpTask(o: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id: TASK_ID,
    name: "Fix the login page",
    markdownDescription: "The button is **broken** #devbox:exp:FAST_MODE",
    creatorId: CREATOR,
    assigneeIds: [BOT],
    status: "to do",
    listId: LIST_ID,
    teamId: TEAM,
    ...o,
  };
}

export const MEMBERS: ClickUpMember[] = [
  { id: HUMAN, role: 3 },
  { id: CREATOR, role: 1 },
  { id: GUEST, role: 4 },
  { id: BOT, role: 3 },
];

export const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

// A fake ClickUp that records its calls.
export function fakeClient(
  calls: string[],
  posted: Array<{ taskId: string; parts: ClickUpPart[] }>,
) {
  return {
    async user() {
      calls.push("user");
      return { id: BOT, username: "devbox" };
    },
    async members(teamId: string) {
      calls.push(`members ${teamId}`);
      return MEMBERS;
    },
    async task(id: string) {
      calls.push(`task ${id}`);
      return clickUpTask({ id });
    },
    async addComment(taskId: string, parts: ClickUpPart[]) {
      calls.push(`addComment ${taskId}`);
      posted.push({ taskId, parts });
      return { id: String(posted.length) };
    },
    async setStatus(id: string, status: string) {
      calls.push(`setStatus ${id} ${status}`);
    },
    async listStatuses(id: string) {
      calls.push(`listStatuses ${id}`);
      return ["to do", "In Progress", "Done", "Failed"];
    },
    async webhooks(teamId: string) {
      calls.push(`webhooks ${teamId}`);
      return [
        {
          id: "00000000-0000-4000-8000-000000000000",
          endpoint: "https://devbox.example.com/webhook/clickup",
          health: { status: "active", failCount: 0 },
        },
      ];
    },
  } satisfies Client;
}

export function setup(
  o: {
    cfg?: Partial<ClickUpConfig>;
    client?: Partial<Client>;
    task?: Task | null;
    result?: "created" | "restarted" | "duplicate";
    tasks?: Partial<TaskService>;
  } = {},
) {
  const clock = { t: NOW };
  const calls: string[] = [];
  const posted: Array<{ taskId: string; parts: ClickUpPart[] }> = [];
  const client: Client = { ...fakeClient(calls, posted), ...o.client };
  const taskCalls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <R>(method: string, value: R) =>
    async (...args: unknown[]) => {
      taskCalls.push({ method, args });
      return value;
    };
  const tasks = {
    source: "clickup",
    assign: record("assign", {
      taskId: "task-1",
      key: "CU-abc0001",
      result: o.result ?? "created",
    }),
    restart: record("restart", undefined),
    enqueueRound: record("enqueueRound", { roundId: "round-1" }),
    findTask: record("findTask", o.task === undefined ? TASK : o.task),
    findTaskByPrUrl: record("findTaskByPrUrl", null),
    ...o.tasks,
  } as TaskService;
  const clickup = createClickUp(
    { tasks, log: logger },
    { ...CFG, ...o.cfg },
    { client, now: () => clock.t },
  );
  const app = createWebhookRoutes([{ name: "clickup", webhook: (c) => clickup.webhook(c) }]);
  const send = (body: string, headers: Record<string, string> = {}) =>
    app.request("/webhook/clickup", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });
  const signed = (payload: unknown) => {
    const body = JSON.stringify(payload);
    return send(body, { "x-signature": sign(body) });
  };
  return { clickup, clock, calls, posted, taskCalls, send, signed };
}
