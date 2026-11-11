import { createHmac, timingSafeEqual } from "node:crypto";
import { mentionsBot, userId } from "./quill";

// Pure readers for ClickUp webhook deliveries ({event, task_id, webhook_id,
// history_items}). Every id is format-checked before anyone builds a URL, a
// dedupe key or an order from it, and a malformed payload reads as null,
// never as a throw.

// Task ids are lowercase letters and digits. History item and comment ids are
// digits with no leading zero (so each has one spelling), often longer than a
// safe integer, so they stay strings.
export const TASK_ID = /^[0-9a-z]{1,32}$/;
const ITEM_ID = /^[1-9]\d{0,31}$/;
const EPOCH_MS = /^\d{1,15}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

// Workspace roles that may drive devbox: owner, admin and member. Guests (4)
// never may, nor ClickBot (automations), whose role is null.
const TRUSTED_ROLES = new Set([1, 2, 3]);

// Who did something: the user id and workspace role (null when absent).
// Never the name or email.
export type ClickUpActor = { id: number; role: number | null };

export type ClickUpAssignment = {
  taskId: string;
  historyItemId: string;
  date: number; // ms since the epoch
  actor: ClickUpActor; // who assigned the bot
};

export type ClickUpComment = {
  taskId: string;
  commentId: string;
  author: ClickUpActor;
  parts: unknown[]; // the comment's rich-text parts, read by ./quill
  mentionsBot: boolean;
  private: boolean; // visible only to some people: never repeated anywhere public
};

// X-Signature: the hex HMAC-SHA256 of the raw body under the webhook secret,
// compared in constant time. An empty secret verifies nothing.
export function verifySignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || !header || !HEX_SHA256.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(header, "hex"));
}

// The bot being assigned: a taskAssigneeUpdated whose history adds the bot as
// an assignee. Creating a task already assigned to the bot sends one too.
// Removing the bot (assignee_rem) is null: the run carries on.
export function parseAssignment(payload: unknown, botUserId: number): ClickUpAssignment | null {
  const p = record(payload);
  if (p?.event !== "taskAssigneeUpdated") return null;
  const item = list(p.history_items)
    .map(record)
    .filter((i) => i?.field === "assignee_add" && userId(record(i.after)?.id) === botUserId)
    .at(-1);
  const taskId = matching(p.task_id, TASK_ID);
  const historyItemId = matching(item?.id, ITEM_ID);
  const date = matching(item?.date, EPOCH_MS);
  const actor = readActor(item?.user);
  if (!taskId || !historyItemId || !date || !actor) return null;
  return { taskId, historyItemId, date: Number(date), actor };
}

// A new comment; see ./quill's mentionsBot for what counts as mentioning the
// bot. A comment without rich-text parts is read from its plain text.
export function parseComment(
  payload: unknown,
  botUserId: number,
  botName: string,
): ClickUpComment | null {
  const p = record(payload);
  if (p?.event !== "taskCommentPosted") return null;
  const item = list(p.history_items)
    .map(record)
    .find((i) => record(i?.comment));
  const comment = record(item?.comment);
  const taskId = matching(p.task_id, TASK_ID);
  const commentId = matching(comment?.id, ITEM_ID);
  const author = readActor(item?.user);
  if (!taskId || !commentId || !author || !comment) return null;
  const parts = Array.isArray(comment.comment)
    ? comment.comment
    : [{ text: typeof comment.text_content === "string" ? comment.text_content : "" }];
  return {
    taskId,
    commentId,
    author,
    parts,
    mentionsBot: mentionsBot(parts, botUserId, botName),
    private: comment.is_private === true,
  };
}

// The assignment round's delegation id and order. Assigning the bot again
// gives a new history item, dated later, so a later assignment wins.
export function delegation(a: Pick<ClickUpAssignment, "taskId" | "historyItemId" | "date">): {
  id: string;
  order: number;
} {
  return { id: `${a.taskId}:${a.historyItemId}`, order: a.date };
}

// Whether a workspace role may drive devbox. As in a Linear workspace, every
// member may: only the workspace's people act there, and the webhook is
// signed. Never the bot.
export function isTrusted(actor: ClickUpActor, botUserId: number): boolean {
  return actor.id !== botUserId && actor.role !== null && TRUSTED_ROLES.has(actor.role);
}

export function readActor(v: unknown): ClickUpActor | null {
  const r = record(v);
  const id = userId(r?.id);
  if (id === null) return null;
  return { id, role: typeof r?.role === "number" ? r.role : null };
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function matching(v: unknown, re: RegExp): string | undefined {
  return typeof v === "string" && re.test(v) ? v : undefined;
}
