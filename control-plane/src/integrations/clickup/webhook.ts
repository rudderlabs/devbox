import type { Context } from "hono";
import { parseExperimentalFlags } from "../../services/experimentalFlags";
import { errorClass, withTimeout } from "../http";
import type { Logger, ReplyTarget, TaskService } from "../types";
import type { ClickUpClient, ClickUpTask } from "./client";
import type { ClickUpConfig } from "./config";
import {
  type ClickUpAssignment,
  type ClickUpComment,
  delegation,
  isTrusted,
  parseAssignment,
  parseComment,
  TASK_ID,
  verifySignature,
} from "./events";
import { commentToMarkdown } from "./quill";

// ClickUp gives a delivery 7 s. The reads on the request are kept short; the
// task and the member list are read side by side.
const TASK_READ_TIMEOUT_MS = 3_000;
const MEMBERS_READ_TIMEOUT_MS = 2_500;
// How long the workspace's member list (for creators' roles) is used before
// it is read again; on a failed read the last good one serves one TTL more.
const MEMBERS_TTL_MS = 6 * 60 * 60 * 1000;
// Someone missing from a list at least this old (a new member) has it read again.
const MEMBERS_MISS_REFRESH_MS = 60_000;

// A ClickUp reply target's spec: replies are comments on the task. The
// target's id is the delegation id (`taskId:historyItemId`) for an
// assignment, the comment id for a follow-up. The JSON is stored with the round.
export type ClickUpSpec = { kind: "clickup_task"; taskId: string };

export function isClickUpSpec(spec: unknown): spec is ClickUpSpec {
  const s = spec as { kind?: unknown; taskId?: unknown } | null;
  return s?.kind === "clickup_task" && typeof s.taskId === "string" && TASK_ID.test(s.taskId);
}

function taskTarget(id: string, taskId: string, order?: number): ReplyTarget {
  const spec: ClickUpSpec = { kind: "clickup_task", taskId };
  return order === undefined ? { id, spec } : { id, order, spec };
}

// A comment round's external id, prefixed as Jira's are, so a comment id can
// never meet an assignment's external id (the task id).
export function commentExternalId(commentId: string): string {
  return `comment:${commentId}`;
}

// The workspace's members and their roles, read lazily: warm() reads the
// list again once it is a TTL old. A failed read keeps the last good list
// until it is two TTLs old; with none, a lookup can't be resolved. A webhook
// makes at most one read: warm() before the lookup, or the lookup itself for
// someone missing from a list (a new member).
export class MemberRoles {
  private roles: Map<number, number | null> | null = null;
  private fetchedAt = 0;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | null = null;

  constructor(
    private readonly client: Pick<ClickUpClient, "members">,
    private readonly teamId: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  // Reads the list again if it is due.
  warm(): Promise<void> {
    const due = this.roles === null || this.now() - this.fetchedAt >= MEMBERS_TTL_MS;
    return due ? this.read() : Promise.resolve();
  }

  // The user's workspace role (null: none), undefined for someone who isn't
  // a member, or "unresolved" without a usable list.
  async role(userId: number): Promise<number | null | undefined | "unresolved"> {
    if (this.roles && !this.roles.has(userId)) {
      if (this.now() - this.attemptedAt >= MEMBERS_MISS_REFRESH_MS) await this.read();
    }
    if (!this.roles || this.now() - this.fetchedAt >= 2 * MEMBERS_TTL_MS) return "unresolved";
    return this.roles.has(userId) ? (this.roles.get(userId) ?? null) : undefined;
  }

  // One read at a time; it never throws.
  private read(): Promise<void> {
    if (this.reading) return this.reading;
    this.attemptedAt = this.now();
    this.reading = withTimeout(MEMBERS_READ_TIMEOUT_MS, (signal) =>
      this.client.members(this.teamId, signal),
    )
      .then((members) => {
        this.roles = new Map(members.map((m) => [m.id, m.role]));
        this.fetchedAt = this.now();
      })
      .catch((err) => {
        this.log.warn("clickup member list read failed", { error: errorClass(err) });
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }
}

// POST /webhook/clickup. Answers within ClickUp's 7 s: an assignment reads
// the task and, when due, the member list; a comment reads nothing. A 503
// asks ClickUp to deliver again. A bad signature is 403, never 401 or 410,
// on which ClickUp suspends the webhook.
// Untrusted actors are answered 200 and ignored, with a log line by user id
// and nothing posted. Automations act as ClickBot, whose role is null, so
// they never start or steer work.
export class ClickUpWebhookController {
  constructor(
    private readonly tasks: Pick<TaskService, "assign" | "findTask" | "enqueueRound">,
    private readonly cfg: ClickUpConfig,
    private readonly client: Pick<ClickUpClient, "task">,
    private readonly members: Pick<MemberRoles, "warm" | "role">,
    private readonly log: Logger,
    private readonly onSignedWebhook: () => void,
  ) {}

  async handleWebhook(c: Context): Promise<Response> {
    const raw = await c.req.text();
    const signature = c.req.header("x-signature");
    if (!verifySignature(raw, signature, this.cfg.webhookSecret)) {
      // A signed request that fails is most likely ClickUp with another
      // secret. Unsigned requests (probes) are expected and not logged.
      // Nothing from the request is logged.
      if (signature) {
        this.log.warn(
          "ClickUp webhook rejected: signature mismatch (check CLICKUP_WEBHOOK_SECRET)",
        );
      }
      return c.json({ error: "invalid signature" }, 403);
    }
    this.onSignedWebhook();

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    try {
      const { botUserId, botName } = this.cfg;
      const assignment = parseAssignment(payload, botUserId);
      if (assignment) return await this.onAssignment(c, assignment);
      const comment = parseComment(payload, botUserId, botName);
      if (comment) return await this.onComment(c, comment);
      return c.json({ status: "ignored" }, 200);
    } catch (err) {
      // The class and the Postgres SQLSTATE only: a database error's message
      // carries the query's parameters (the task's text, the comment body).
      // drizzle wraps the driver's error in `cause`; Bun's driver puts the
      // SQLSTATE in `errno` (`code` is its own constant).
      const pg = ((err as { cause?: unknown } | null)?.cause ?? err) as { errno?: unknown } | null;
      const code = pg?.errno;
      this.log.error("clickup webhook failed", {
        error: errorClass(err),
        ...(typeof code === "string" ? { code } : {}),
      });
      return c.json({ error: "internal" }, 500);
    }
  }

  // A new task, or a restart when the bot is assigned again. Both the
  // assigner and the task's creator must be trusted, since the creator wrote
  // the description the agent acts on. The task is read again, so its
  // workspace, creator and text come from ClickUp, not the payload.
  private async onAssignment(c: Context, a: ClickUpAssignment): Promise<Response> {
    const { cfg } = this;
    const meta = { clickupTaskId: a.taskId };
    if (a.actor.id === cfg.botUserId) {
      return this.ignored(c, "own_event", { ...meta, userId: a.actor.id });
    }
    if (!isTrusted(a.actor, cfg.botUserId)) {
      return this.ignored(c, "untrusted", {
        ...meta,
        side: "assigner",
        userId: a.actor.id,
        role: a.actor.role,
      });
    }

    let task: ClickUpTask;
    try {
      [task] = await Promise.all([
        withTimeout(TASK_READ_TIMEOUT_MS, (signal) => this.client.task(a.taskId, signal)),
        this.members.warm(),
      ]);
    } catch (err) {
      return this.unavailable(c, "task_unresolved", { ...meta, error: errorClass(err) });
    }
    if (task.teamId !== cfg.teamId) return this.ignored(c, "wrong_team", meta);

    const creator = task.creatorId;
    const role = creator === null ? undefined : await this.members.role(creator);
    if (role === "unresolved") return this.unavailable(c, "trust_unresolved", meta);
    if (
      creator === null ||
      role === undefined ||
      !isTrusted({ id: creator, role }, cfg.botUserId)
    ) {
      return this.ignored(c, "untrusted", {
        ...meta,
        side: "creator",
        userId: creator,
        role: role ?? null,
      });
    }

    // Without NUL, which Postgres can't store.
    const { flags, strippedDescription } = parseExperimentalFlags(
      task.markdownDescription.replaceAll("\0", ""),
    );
    // Assigning the bot again gives a new history item, dated later, so a
    // later assignment restarts the task and a redelivery is a duplicate.
    const { id, order } = delegation(a);
    const { taskId } = a;
    const result = await this.tasks.assign({
      externalId: taskId,
      key: { hint: `CU-${taskId}` },
      title: task.name.replaceAll("\0", ""),
      description: strippedDescription,
      flags,
      // From the format-checked id, never a URL from the payload.
      url: () => `https://app.clickup.com/t/${taskId}`,
      target: () => taskTarget(id, taskId, order),
    });
    this.log.info("clickup assignment", {
      ...meta,
      taskId: result.taskId,
      result: result.result,
      userId: a.actor.id,
    });
    return c.json({ status: "ok" }, 200);
  }

  // A follow-up on the devbox task. Only a comment that mentions the bot and
  // that everyone can read counts: the agent's answer is public.
  private async onComment(c: Context, comment: ClickUpComment): Promise<Response> {
    const { cfg } = this;
    const { taskId, commentId, author } = comment;
    const meta = { clickupTaskId: taskId, commentId, userId: author.id };
    // The bot's own replies (which may name it) and the many comments that
    // don't mention it are not worth a log line. Its own go first: a reply
    // that names the bot must never count as a mention.
    if (author.id === cfg.botUserId) return c.json({ status: "ignored" }, 200);
    if (!comment.mentionsBot) return c.json({ status: "ignored" }, 200);
    if (comment.private) return this.ignored(c, "private_comment", meta);
    if (!isTrusted(author, cfg.botUserId)) {
      return this.ignored(c, "untrusted", { ...meta, side: "commenter", role: author.role });
    }

    const task = await this.tasks.findTask(taskId);
    if (!task) return this.ignored(c, "no_task", meta);
    const result = await this.tasks.enqueueRound({
      task,
      kind: "comment",
      externalId: commentExternalId(commentId),
      payload: {
        // Replies go to the task; matches targets[0].id.
        target_id: commentId,
        body: commentToMarkdown(comment.parts, cfg.botUserId),
        // Not PR-scoped: the conversation is on the task.
        pr: null,
        // Only GitHub rounds get the PR discussion, which this scopes.
        created_at: "",
      },
      targets: [taskTarget(commentId, taskId)],
    });
    this.log.info("clickup follow-up", { ...meta, taskId: task.id, ...result });
    return c.json({ status: "ok" }, 200);
  }

  // 200, so ClickUp doesn't deliver again, with one log line carrying ids
  // only (never a name, email or body).
  private ignored(c: Context, reason: string, meta: Record<string, unknown>): Response {
    this.log.info("clickup_webhook.ignored", { reason, ...meta });
    return c.json({ status: "ignored", reason }, 200);
  }

  // 503, so ClickUp delivers the event again later.
  private unavailable(c: Context, reason: string, meta: Record<string, unknown>): Response {
    this.log.warn(`clickup_webhook.${reason}`, meta);
    return c.json({ error: reason }, 503);
  }
}
