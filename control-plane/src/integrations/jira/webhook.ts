import type { Context } from "hono";
import { parseExperimentalFlags } from "../../services/experimentalFlags";
import { errorClass, withTimeout } from "../http";
import type { Logger, ReplyTarget, TaskService } from "../types";
import type { JiraClient } from "./client";
import type { JiraConfig } from "./config";
import {
  delegation,
  isNonHuman,
  issueContext,
  isTrusted,
  type JiraActor,
  type JiraAssignment,
  type JiraComment,
  parseAssignment,
  parseComment,
  verifySignature,
} from "./events";
import { wikiToMarkdown } from "./wiki";

// The issue read on the webhook request is kept short.
const ISSUE_READ_TIMEOUT_MS = 3_000;
const ISSUE_ID = /^[1-9]\d{0,14}$/;

// A Jira reply target's spec: replies are comments on the issue. The
// target's id is the delegation id (`issueId:changelogId`) for an assignment,
// the comment id for a follow-up. The JSON is stored with the round.
export type JiraSpec = { kind: "jira_issue"; issueId: string };

export function isJiraSpec(spec: unknown): spec is JiraSpec {
  const s = spec as { kind?: unknown; issueId?: unknown } | null;
  return s?.kind === "jira_issue" && typeof s.issueId === "string" && ISSUE_ID.test(s.issueId);
}

function issueTarget(id: string, issueId: string, order?: number): ReplyTarget {
  const spec: JiraSpec = { kind: "jira_issue", issueId };
  return order === undefined ? { id, spec } : { id, order, spec };
}

// A comment round's external id. The database keeps an older
// (source, external_id) index for one more release, and Jira's comment ids
// and issue ids are separate sequences that meet, so the bare comment id could
// collide with an issue's assignment round: the comment would be dropped as a
// duplicate, or that issue's assignment refused. The prefix keeps them apart.
export function commentExternalId(commentId: string): string {
  return `comment:${commentId}`;
}

// POST /webhook/jira. Answers fast: the only call out is, when the payload
// leaves it out, a read of the issue's security level. Jira retries a 5xx,
// which is how a comment that beats its task's creation gets another try.
// Jira appends ?triggeredByUser= to the URL; it is ignored, the signed body is
// what counts.
// Untrusted actors are answered 200 and ignored, with a log line by account
// id and nothing posted, as on GitHub.
export class JiraWebhookController {
  constructor(
    private readonly tasks: Pick<TaskService, "assign" | "findTask" | "enqueueRound">,
    private readonly cfg: JiraConfig,
    private readonly client: Pick<JiraClient, "getIssue">,
    private readonly log: Logger,
    private readonly onSignedWebhook: () => void,
  ) {}

  async handleWebhook(c: Context): Promise<Response> {
    const raw = await c.req.text();
    const signature = c.req.header("x-hub-signature");
    if (!verifySignature(raw, signature, this.cfg.webhookSecret)) {
      // A signed request that fails is most likely Jira with another secret; an
      // unsigned one with Jira's headers is a webhook saved without a secret.
      // Other unsigned requests (probes) are expected and not logged. Nothing
      // from the request is logged.
      if (signature) {
        this.log.warn(
          "Jira webhook rejected: signature mismatch (check the webhook secret matches JIRA_WEBHOOK_SECRET)",
        );
      } else if (c.req.header("x-atlassian-webhook-identifier")) {
        this.log.warn("Jira webhook rejected: unsigned (set a secret on the webhook in Jira)");
      }
      return c.json({ error: "invalid signature" }, 401);
    }
    this.onSignedWebhook();

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    try {
      const { botAccountId, botName } = this.cfg;
      const assignment = parseAssignment(payload, botAccountId);
      if (assignment) return await this.onAssignment(c, payload, assignment);
      const comment = parseComment(payload, botAccountId, botName);
      if (comment) return await this.onComment(c, payload, comment);
      return c.json({ status: "ignored" }, 200);
    } catch (err) {
      // The class and the Postgres code only: a database error's message
      // carries the query's parameters (the issue's text, the comment body).
      const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
      this.log.error("jira webhook failed", {
        error: errorClass(err),
        ...(typeof code === "string" ? { code } : {}),
      });
      return c.json({ error: "internal" }, 500);
    }
  }

  // A new task, or a restart when the bot is assigned again. Both the assigner
  // and the reporter must be trusted, since the reporter wrote the description
  // the agent acts on; an issue without a reporter falls back to its creator.
  private async onAssignment(c: Context, payload: unknown, a: JiraAssignment): Promise<Response> {
    const { cfg } = this;
    const meta = { issueId: a.issueId };
    const skip = this.skipReason(payload, a.actor);
    if (skip) return this.ignored(c, skip, { ...meta, accountId: a.actor.accountId });

    if (!isTrusted(a.actor, cfg.botAccountId)) {
      return this.ignored(c, "untrusted", {
        ...meta,
        side: "assigner",
        accountId: a.actor.accountId,
      });
    }
    const reporter = a.reporter ?? issueContext(payload).creator;
    if (!reporter || !isTrusted(reporter, cfg.botAccountId)) {
      const accountId = reporter?.accountId ?? null;
      return this.ignored(c, "untrusted", { ...meta, side: "reporter", accountId });
    }

    const restricted = await this.restricted(a.issueId, a.securityLevel);
    if (restricted === "unresolved") return this.unavailable(c, "security_unresolved", meta);
    if (restricted) return this.ignored(c, "restricted_issue", meta);

    const { flags, strippedDescription } = parseExperimentalFlags(
      wikiToMarkdown(a.descriptionWiki, cfg.botAccountId),
    );
    // Re-assigning the bot gives a new changelog id, higher than the last, so
    // a later assignment restarts the task and a redelivery is a duplicate.
    const { id, order } = delegation(a);
    const { issueId, issueKey } = a;
    const { taskId, result } = await this.tasks.assign({
      externalId: issueId,
      key: { hint: issueKey },
      title: a.title,
      description: strippedDescription,
      flags,
      // From config and the format-checked key, never a URL from the payload.
      url: () => `${cfg.siteUrl}/browse/${encodeURIComponent(issueKey)}`,
      target: () => issueTarget(id, issueId, order),
    });
    this.log.info("jira assignment", { ...meta, taskId, result, accountId: a.actor.accountId });
    return c.json({ status: "ok" }, 200);
  }

  // A follow-up on the issue's task. Only a comment that mentions the bot and
  // that everyone can read, on an issue everyone can read, counts: the agent's
  // answer is public. A security level can be set after the task started, so
  // the issue is read again for each follow-up.
  private async onComment(c: Context, payload: unknown, comment: JiraComment): Promise<Response> {
    const { cfg } = this;
    const { issueId, commentId } = comment;
    const meta = { issueId, commentId, accountId: comment.author.accountId };
    // The bot's own replies (which may name it) and the many comments that
    // don't mention it are not worth a log line. Its own go first: a reply
    // that names the bot must never count as a mention.
    if (comment.author.accountId === cfg.botAccountId) return c.json({ status: "ignored" }, 200);
    const skip = this.skipReason(payload, comment.author);
    if (skip) return this.ignored(c, skip, meta);
    if (!comment.mentionsBot) return c.json({ status: "ignored" }, 200);
    if (comment.restricted) return this.ignored(c, "restricted_comment", meta);

    if (!isTrusted(comment.author, cfg.botAccountId)) {
      return this.ignored(c, "untrusted", { ...meta, side: "commenter" });
    }

    const task = await this.tasks.findTask(issueId);
    if (!task) {
      // With the bot as the assignee, the assignment may still be on its way,
      // and Jira retries a 5xx. Otherwise the bot was mentioned on an issue it
      // has no task for, and retrying would only repeat this answer.
      return comment.assignedToBot
        ? this.unavailable(c, "task_not_found", meta)
        : this.ignored(c, "no_task", meta);
    }
    const restricted = await this.restricted(issueId, "unknown");
    if (restricted === "unresolved") return this.unavailable(c, "security_unresolved", meta);
    if (restricted) return this.ignored(c, "restricted_issue", meta);
    const result = await this.tasks.enqueueRound({
      task,
      kind: "comment",
      externalId: commentExternalId(commentId),
      payload: {
        // Replies go to the issue; matches targets[0].id.
        target_id: commentId,
        body: wikiToMarkdown(comment.bodyWiki, cfg.botAccountId),
        // Not PR-scoped: the conversation is on the issue.
        pr: null,
        // Only GitHub rounds get the PR discussion, which this scopes.
        created_at: "",
      },
      targets: [issueTarget(commentId, issueId)],
    });
    this.log.info("jira follow-up", { ...meta, taskId: task.id, ...result });
    return c.json({ status: "ok" }, 200);
  }

  // Why an event by `actor` is not for devbox, if it isn't: the bot's own
  // (its replies may name it), from an app or customer account, or outside the
  // configured projects.
  private skipReason(payload: unknown, actor: JiraActor): string | undefined {
    if (actor.accountId === this.cfg.botAccountId) return "own_event";
    if (isNonHuman(actor)) return "non_human";
    const { projectKey } = issueContext(payload);
    if (!projectKey || !this.cfg.projectKeys.includes(projectKey)) return "foreign_project";
    return undefined;
  }

  // Whether the issue is restricted to a security level, so devbox must not
  // act on it (unless allowed). When the payload doesn't say (`level`
  // "unknown"), the issue is read; if that answer leaves it out too, the issue
  // counts as restricted, since its visibility can't be confirmed.
  private async restricted(
    issueId: string,
    level: JiraAssignment["securityLevel"],
  ): Promise<boolean | "unresolved"> {
    if (this.cfg.allowRestrictedIssues) return false;
    if (level !== "unknown") return level === "set";
    try {
      const issue = await withTimeout(ISSUE_READ_TIMEOUT_MS, (signal) =>
        this.client.getIssue(issueId, ["security"], signal),
      );
      return issue.fields.security !== null;
    } catch (err) {
      this.log.warn("jira issue security read failed", { issueId, error: errorClass(err) });
      return "unresolved";
    }
  }

  // 200, so Jira doesn't retry, with one log line carrying ids only (never a
  // name, email or body).
  private ignored(c: Context, reason: string, meta: Record<string, unknown>): Response {
    this.log.info("jira_webhook.ignored", { reason, ...meta });
    return c.json({ status: "ignored", reason }, 200);
  }

  // 503, so Jira delivers the event again later.
  private unavailable(c: Context, reason: string, meta: Record<string, unknown>): Response {
    this.log.warn(`jira_webhook.${reason}`, meta);
    return c.json({ error: reason }, 503);
  }
}
