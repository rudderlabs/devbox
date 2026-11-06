import { createHmac, timingSafeEqual } from "node:crypto";
import { mentionsBot } from "./wiki";

// Pure readers for Jira admin-webhook payloads. Every id is format-checked
// before anyone builds a URL, a dedupe key or an order from it, and a
// malformed payload reads as null, never as a throw.

// Digits with no leading zero, short enough to stay a safe integer, so each
// id has one spelling and Number() of it is exact.
const NUMERIC = /^[1-9]\d{0,14}$/;
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

// Who did something: the account id and Jira's account type ("atlassian",
// "app" or "customer"). Never the name or email.
export type JiraActor = { accountId: string; accountType?: string };

export type JiraAssignment = {
  issueId: string;
  issueKey: string;
  changelogId: string;
  actor: JiraActor; // who assigned the bot
  reporter: JiraActor | null;
  // Whether the issue is restricted to a security level; "unknown" when the
  // payload leaves the field out, so the caller can read the issue to find out.
  securityLevel: "set" | "unset" | "unknown";
  title: string;
  descriptionWiki: string;
};

export type JiraComment = {
  issueId: string;
  commentId: string; // a different sequence from issue ids: the two can be equal
  author: JiraActor;
  bodyWiki: string;
  mentionsBot: boolean;
  // Whether the issue's assignee is the bot. Jira's comment events carry the
  // issue's assignee; one that leaves it out reads as false.
  assignedToBot: boolean;
  // Visible only to some people (a role or group, or internal on a service
  // desk), so it must not be repeated anywhere public.
  restricted: boolean;
};

// The admin webhook's X-Hub-Signature: "sha256=" and the hex HMAC-SHA256 of
// the raw body under the webhook secret, compared in constant time. An empty
// secret verifies nothing.
export function verifySignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
): boolean {
  const prefix = "sha256=";
  if (!secret || !header?.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  if (!HEX_SHA256.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(provided, "hex"));
}

// The bot being assigned: an issue_created or issue_updated whose changelog
// assigns the issue to `botAccountId`. Creating an issue already assigned to
// the bot sends only issue_created, with the assignee in its changelog, so one
// rule covers both. An un-assign (to someone else, or nobody) is null. The
// item is matched by its name, not fieldId alone, and a custom field that
// happens to be called "assignee" doesn't count.
export function parseAssignment(payload: unknown, botAccountId: string): JiraAssignment | null {
  const p = record(payload);
  if (p?.webhookEvent !== "jira:issue_created" && p?.webhookEvent !== "jira:issue_updated") {
    return null;
  }
  const changelog = record(p.changelog);
  const items = Array.isArray(changelog?.items) ? changelog.items : [];
  const change = items
    .map(record)
    .filter((i) => i?.field === "assignee" && i.fieldtype !== "custom")
    .at(-1);
  if (!botAccountId || change?.to !== botAccountId) return null;

  const issue = record(p.issue);
  const fields = record(issue?.fields);
  const issueId = numeric(issue?.id);
  const changelogId = numeric(changelog?.id);
  const issueKey = typeof issue?.key === "string" && ISSUE_KEY.test(issue.key) ? issue.key : null;
  const actor = readActor(p.user);
  if (!issueId || !changelogId || !issueKey || !actor || !fields) return null;
  return {
    issueId,
    issueKey,
    changelogId,
    actor,
    reporter: readActor(fields.reporter),
    securityLevel:
      fields.security === undefined ? "unknown" : fields.security === null ? "unset" : "set",
    // Without NUL, which Postgres can't store.
    title: typeof fields.summary === "string" ? fields.summary.replaceAll("\0", "") : "",
    descriptionWiki: typeof fields.description === "string" ? fields.description : "",
  };
}

// A new comment; see mentionsBot for what counts as mentioning the bot.
export function parseComment(
  payload: unknown,
  botAccountId: string,
  botName: string,
): JiraComment | null {
  const p = record(payload);
  if (p?.webhookEvent !== "comment_created") return null;
  const comment = record(p.comment);
  const issue = record(p.issue);
  const issueId = numeric(issue?.id);
  const commentId = numeric(comment?.id);
  const author = readActor(comment?.author);
  const body = comment?.body;
  if (!issueId || !commentId || !author || typeof body !== "string") return null;
  return {
    issueId,
    commentId,
    author,
    bodyWiki: body,
    mentionsBot: mentionsBot(body, botAccountId, botName),
    assignedToBot: readActor(record(issue?.fields)?.assignee)?.accountId === botAccountId,
    restricted: comment?.visibility != null || comment?.jsdPublic === false,
  };
}

// The assignment round's delegation id and order. Re-assigning the bot gives
// a new changelog id, higher than the last, so a later assignment wins.
export function delegation(a: Pick<JiraAssignment, "issueId" | "changelogId">): {
  id: string;
  order: number;
} {
  return { id: `${a.issueId}:${a.changelogId}`, order: Number(a.changelogId) };
}

// The issue's creator, who stands in for a missing reporter.
export function issueCreator(payload: unknown): JiraActor | null {
  return readActor(record(record(record(payload)?.issue)?.fields)?.creator);
}

// App accounts (integrations, service accounts) and customer accounts
// (service-desk portal users) are never treated as people.
export function isNonHuman(actor: JiraActor): boolean {
  return actor.accountType === "app" || actor.accountType === "customer";
}

// Whether an account may drive devbox. As in a Linear workspace, every person
// on the site may: only accounts with access to the site act there, and the
// webhook is signed. Only an account Jira marks as a person's ("atlassian")
// counts, so apps, customers and an account of unknown type never do, and
// neither does the bot.
export function isTrusted(actor: JiraActor, botAccountId: string): boolean {
  return actor.accountType === "atlassian" && actor.accountId !== botAccountId;
}

function readActor(v: unknown): JiraActor | null {
  const r = record(v);
  if (typeof r?.accountId !== "string" || !ACCOUNT_ID.test(r.accountId)) return null;
  return typeof r.accountType === "string"
    ? { accountId: r.accountId, accountType: r.accountType }
    : { accountId: r.accountId };
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function numeric(v: unknown): string | undefined {
  return typeof v === "string" && NUMERIC.test(v) ? v : undefined;
}
