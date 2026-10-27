import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import {
  addIssueCommentReaction,
  addReviewCommentReaction,
  fetchOrgMembers,
  getReviewComments,
  getUserIdByLogin,
} from "../clients/github";
import { config } from "../config";
import type { GithubWebhooksConfig } from "../integrationsConfig";
import { logger } from "../logger";
import type { ReplyTargetSpec } from "../repositories/inbox.repository";
import type { TaskRepository } from "../repositories/task.repository";
import type { InboxService } from "../services/inbox.service";

// ──── Parsed event surface ────
//
// parseGithubEvent reduces the raw GH event types to this discriminated union
// and applies these trigger rules:
//  - issue_comment / standalone pull_request_review_comment → require @<bot>
//  - in-review per-comment events → dropped as dedup (the submitted-review
//    handler batches them via getReviewComments)
//  - pull_request_review (submitted) → accepted unconditionally here; the
//    mention gate for reviews runs later in the controller, after fetching
//    inline comments (see handleWebhook)
//  - workflow_run (completed, conclusion=failure) → ci_result enqueue
//  - pull_request (closed) is intentionally NOT handled here yet.
export type ParsedGitHubEvent =
  | {
      kind: "comment";
      userLogin: string;
      prUrl: string;
      commentId: number;
      body: string;
      // ISO-8601 `created_at` of the comment; "" when absent.
      createdAt: string;
      spec: Extract<ReplyTargetSpec, { kind: "issue_comment" | "review_comment" }>;
      owner: string;
      repo: string;
      prNumber: number;
    }
  | {
      kind: "review";
      userLogin: string;
      prUrl: string;
      reviewId: number;
      reviewBody: string;
      // ISO-8601 `submitted_at` of the review; "" when absent.
      createdAt: string;
      owner: string;
      repo: string;
      prNumber: number;
    }
  | { kind: "inline_review_comment_dropped_as_dedup"; userLogin: string }
  | {
      kind: "workflow_run";
      runId: number;
      runAttempt: number;
      workflowName: string;
      workflowPath: string;
      conclusion: string;
      runUrl: string;
      headSha: string;
      headBranch: string;
      pullRequests: Array<{ number: number }>;
      owner: string;
      repo: string;
    };

// Mention trigger, built from the configured bot login: `@<botLogin>`.
export function mentionRegex(botLogin: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])@${escapeRegExp(botLogin)}(?![A-Za-z0-9_-])`, "i");
}
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

// How long the resolved trusted set is served before it is fetched again. Same
// as the org member TTL in harness/src/harness/discussion_context.py, so a
// removed member stops being trusted within the same horizon in both places.
export const TRUSTED_SET_TTL_MS = 6 * 60 * 60 * 1000;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pull the login of the actor for the four trigger event types — used for
// logging only (login is mutable: GitHub releases a renamed handle after 90
// days, so a stranger could later own it). Returns "" for any unknown shape.
export function extractUserLogin(eventHeader: string | undefined, payload: unknown): string {
  const p = rec(payload);
  switch (eventHeader) {
    case "issue_comment":
    case "pull_request_review_comment":
      return str(rec(rec(p.comment).user).login);
    case "pull_request_review":
      return str(rec(rec(p.review).user).login);
    case "pull_request":
      // Actor is `sender` (closer / labeler / etc.), NOT `pull_request.user`
      // (the PR opener). Use sender so pr-action events check the actual actor.
      return str(rec(p.sender).login);
    case "workflow_run":
      return str(rec(p.sender).login);
    default:
      return "";
  }
}

// Pull the numeric user id of the actor — the value the trust gate checks
// against the trusted-org member set. Ids are immutable + never re-issued by
// GitHub, so a rename can't grant a stranger trust. Returns 0 for any unknown
// shape so the gate fails closed.
export function extractUserId(eventHeader: string | undefined, payload: unknown): number {
  const p = rec(payload);
  let raw: unknown;
  switch (eventHeader) {
    case "issue_comment":
    case "pull_request_review_comment":
      raw = rec(rec(p.comment).user).id;
      break;
    case "pull_request_review":
      raw = rec(rec(p.review).user).id;
      break;
    case "pull_request":
      raw = rec(p.sender).id;
      break;
    case "workflow_run":
      raw = rec(p.sender).id;
      break;
    default:
      return 0;
  }
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

// Pull the login of the PR opener (the author of the underlying PR, NOT the
// actor of this specific event). Used to short-circuit events on PRs that
// harness itself opened — those PRs aren't tracked in our tasks table, so
// processing them is wasted work and risks loops if the bot ends up
// referencing itself.
export function extractPrOpenerLogin(eventHeader: string | undefined, payload: unknown): string {
  const p = rec(payload);
  switch (eventHeader) {
    case "issue_comment":
      // GitHub models PRs as issues for the comments API — `issue.user` is
      // the PR opener.
      return str(rec(rec(p.issue).user).login);
    case "pull_request_review":
    case "pull_request_review_comment":
    case "pull_request":
      return str(rec(rec(p.pull_request).user).login);
    default:
      return "";
  }
}

// Canonical PR URL — built deterministically so it is byte-identical to the
// html_url the harness stores via pr_opened (findByPrUrl does an exact jsonb
// containment match). Never trust the payload's html_url formatting.
function prUrlOf(owner: string, repo: string, prNumber: number): string {
  return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}

// Discriminated parser over the four GH event types. Returns null for anything
// outside the trigger rules (the controller maps null → 200 ignored).
export function parseGithubEvent(
  eventHeader: string | undefined,
  payload: unknown,
  mention: RegExp,
): ParsedGitHubEvent | null {
  const p = rec(payload);
  const action = str(p.action);
  const repository = rec(p.repository);
  const owner = str(rec(repository.owner).login);
  const repo = str(repository.name);

  if (eventHeader === "issue_comment") {
    if (action !== "created") return null;
    // GitHub historically modeled PRs on top of Issues, so a top-level PR
    // comment (the Conversation-tab kind, NOT inline-on-diff) is delivered
    // under the `issue_comment` event header — there is no separate
    // `pull_request_comment` event. The two cases share one payload shape and
    // are distinguished by `issue.pull_request`: present on PRs, absent on
    // plain issues. We only care about the PR case; drop the rest.
    const issue = rec(p.issue);
    if (Object.keys(rec(issue.pull_request)).length === 0) return null;
    const comment = rec(p.comment);
    const body = str(comment.body);
    const userLogin = str(rec(comment.user).login);
    const commentId = num(comment.id);
    const prNumber = num(issue.number);
    if (!owner || !repo || !Number.isFinite(commentId) || !Number.isFinite(prNumber)) return null;
    if (!mention.test(body)) return null;
    return {
      kind: "comment",
      userLogin,
      prUrl: prUrlOf(owner, repo, prNumber),
      commentId,
      body,
      createdAt: str(comment.created_at),
      spec: { kind: "issue_comment", owner, repo, prNumber, commentId },
      owner,
      repo,
      prNumber,
    };
  }

  if (eventHeader === "pull_request_review_comment") {
    if (action !== "created") return null;
    const comment = rec(p.comment);
    const userLogin = str(rec(comment.user).login);
    // An inline comment that belongs to a submitted review carries
    // pull_request_review_id — drop it; the submitted-review handler batches it.
    if (comment.pull_request_review_id != null) {
      return { kind: "inline_review_comment_dropped_as_dedup", userLogin };
    }
    const body = str(comment.body);
    const pr = rec(p.pull_request);
    const prNumber = num(pr.number);
    const commentId = num(comment.id);
    if (!owner || !repo || !Number.isFinite(commentId) || !Number.isFinite(prNumber)) return null;
    if (!mention.test(body)) return null;
    const line = typeof comment.line === "number" ? comment.line : num(comment.original_line);
    return {
      kind: "comment",
      userLogin,
      prUrl: prUrlOf(owner, repo, prNumber),
      commentId,
      body,
      createdAt: str(comment.created_at),
      spec: {
        kind: "review_comment",
        owner,
        repo,
        prNumber,
        commentId,
        // Standalone inline → the agent's reply threads under this comment.
        inReplyTo: commentId,
        path: str(comment.path),
        line: Number.isFinite(line) ? line : 0,
      },
      owner,
      repo,
      prNumber,
    };
  }

  if (eventHeader === "pull_request_review") {
    // A submitted review — body + inline comments batched. Parsed
    // unconditionally; the mention gate runs in handleWebhook after fetching
    // inline comments (reviewBodyMentionsBot / mentioningInlineComments).
    if (action !== "submitted") return null;
    const review = rec(p.review);
    const pr = rec(p.pull_request);
    const reviewId = num(review.id);
    const prNumber = num(pr.number);
    const userLogin = str(rec(review.user).login);
    if (!owner || !repo || !Number.isFinite(reviewId) || !Number.isFinite(prNumber)) return null;
    return {
      kind: "review",
      userLogin,
      prUrl: prUrlOf(owner, repo, prNumber),
      reviewId,
      reviewBody: str(review.body),
      createdAt: str(review.submitted_at),
      owner,
      repo,
      prNumber,
    };
  }

  if (eventHeader === "workflow_run") {
    if (action !== "completed") return null;
    const workflowRun = rec(p.workflow_run);
    const workflow = rec(p.workflow);
    const runId = num(workflowRun.id);
    const runAttemptRaw = num(workflowRun.run_attempt);
    const runAttempt = runAttemptRaw > 0 ? runAttemptRaw : 1;
    const conclusion = str(workflowRun.conclusion);
    if (!owner || !repo || !conclusion || runId <= 0) return null;
    // Only failed runs need agent attention — success/cancelled/skipped are noise.
    if (conclusion !== "failure") return null;
    const rawPrs = Array.isArray(workflowRun.pull_requests) ? workflowRun.pull_requests : [];
    const pullRequests = (rawPrs as unknown[])
      .map((pr) => ({ number: num(rec(pr).number) }))
      .filter((pr) => Number.isFinite(pr.number) && pr.number > 0);
    return {
      kind: "workflow_run",
      runId,
      runAttempt,
      workflowName: str(workflowRun.name),
      workflowPath: str(workflow.path),
      conclusion,
      runUrl: str(workflowRun.html_url),
      headSha: str(workflowRun.head_sha),
      headBranch: str(workflowRun.head_branch),
      pullRequests,
      owner,
      repo,
    };
  }

  return null;
}

// HMAC verify for x-hub-signature-256 (format: "sha256=<hex>").
function verifyGithubSignature(body: string, signatureHeader: string, secret: string): boolean {
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);
  if (!HEX_SHA256.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const providedBuf = Buffer.from(provided, "hex");
  if (providedBuf.length !== expected.length) return false;
  return timingSafeEqual(expected, providedBuf);
}

export class GitHubWebhookController {
  // Cached in-flight or resolved promise for the trusted set (numeric user ids:
  // every member of each trusted org, plus each trusted user resolved from their
  // login). Promise-as-singleton: concurrent webhooks during the first fetch all
  // await the same value (no duplicate API calls). A rejection clears the slot
  // so the next webhook re-triggers the fetch rather than serving a permanently
  // broken gate. A resolved value is dropped after TRUSTED_SET_TTL_MS.
  private trustedPromise: Promise<ReadonlySet<number>> | null = null;
  private trustedFetchedAt = 0;

  private readonly mention: RegExp;
  // Login as it appears in webhook payloads. GitHub Apps surface as
  // `<app-name>[bot]` in user.login fields. Used to short-circuit events the bot
  // emitted itself (own comments, own inline replies) before we hit the trust
  // gate or DB.
  private readonly botPayloadLogin: string;

  // The last validly signed delivery this replica saw (kept in memory).
  private lastSignedAt: number | null = null;

  constructor(
    private inboxService: InboxService,
    private taskRepo: TaskRepository,
    private readonly settings: GithubWebhooksConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.mention = mentionRegex(settings.botLogin);
    this.botPayloadLogin = `${settings.botLogin}[bot]`;
  }

  lastWebhookAt(): string | null {
    return this.lastSignedAt === null ? null : new Date(this.lastSignedAt).toISOString();
  }

  // One info line per rejected delivery. No payload content and no
  // secret: event name, GitHub's delivery id, and why.
  private reject(c: Context, reason: string): void {
    logger.info("github_webhook.rejected", {
      event: c.req.header("x-github-event"),
      deliveryId: c.req.header("x-github-delivery"),
      reason,
    });
  }

  private getTrusted(): Promise<ReadonlySet<number>> {
    if (this.trustedPromise && this.now() - this.trustedFetchedAt >= TRUSTED_SET_TTL_MS) {
      this.trustedPromise = null;
    }
    if (!this.trustedPromise) {
      this.trustedFetchedAt = this.now();
      this.trustedPromise = (async () => {
        const trusted = new Set<number>();
        for (const org of this.settings.trustedOrgs) {
          const members = await fetchOrgMembers(org);
          if (members.size === 0) {
            // Empty set is a real failure mode (scope-deficient token, wrong
            // org). Throw so the next webhook retries instead of caching a gate
            // that rejects everyone.
            throw new Error(`trusted org member list is empty: ${org}`);
          }
          for (const id of members) trusted.add(id);
        }
        for (const login of this.settings.trustedUsers) {
          const id = await getUserIdByLogin(login);
          if (id === null) {
            // Unknown login: leave it untrusted, keep the rest of the set.
            logger.warn("trusted user login did not resolve; ignoring it", { login });
            continue;
          }
          trusted.add(id);
        }
        if (trusted.size === 0) throw new Error("trusted set is empty");
        return trusted;
      })().catch((err) => {
        this.trustedPromise = null;
        throw err;
      });
    }
    return this.trustedPromise;
  }

  async handleWebhook(c: Context): Promise<Response> {
    const body = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");

    if (!signature || !verifyGithubSignature(body, signature, this.settings.secret)) {
      this.reject(c, "signature");
      return c.json({ error: "invalid signature" }, 401);
    }
    this.lastSignedAt = this.now();

    // GitHub webhooks send the body in one of two content types, chosen at
    // webhook-config time: `application/json` (raw JSON) or
    // `application/x-www-form-urlencoded` (form-encoded with a `payload`
    // field holding URL-encoded JSON). HMAC is over the raw body either way,
    // so signature verify above already happened on `body`. Decode here.
    let payload: unknown;
    try {
      const contentType = c.req.header("content-type") ?? "";
      const jsonBody = contentType.includes("application/x-www-form-urlencoded")
        ? (new URLSearchParams(body).get("payload") ?? "")
        : body;
      payload = JSON.parse(jsonBody);
    } catch {
      logger.warn("github webhook rejected: invalid json", {
        contentType: c.req.header("content-type"),
        bodyPreview: body.slice(0, 200),
      });
      return c.json({ error: "invalid json" }, 400);
    }
    const eventHeader = c.req.header("x-github-event");
    const userLogin = extractUserLogin(eventHeader, payload);
    const userId = extractUserId(eventHeader, payload);
    const prOpenerLogin = extractPrOpenerLogin(eventHeader, payload);

    // Bot-self loop suppression — events the bot emitted itself would loop
    // back through here (e.g. an `@<bot>` mention in a bot-authored reply).
    // GitHub Apps surface user.login as `<app-name>[bot]` in webhook payloads,
    // hence the suffix match.
    // EXCEPTION: workflow_run on a bot-opened PR is triggered by the bot's own
    // push, so its sender IS the bot. That's the case we WANT to handle (CI
    // failed on the bot's PR), not suppress — validWebhookRequest allows it via
    // botUserId. Exempt it here so the self-loop guard doesn't drop CI results.
    if (eventHeader !== "workflow_run" && userLogin === this.botPayloadLogin) {
      this.reject(c, "self_event");
      return c.json({ status: "ignored", reason: "bot self-event" }, 200);
    }

    // Scope filter: harness only acts on PRs it opened itself (one task →
    // one bot-opened PR, tracked in `tasks`). Comments/reviews on PRs opened
    // by anyone else are unrelated to harness's work — drop them BEFORE the
    // trust gate and DB lookup so unrelated org activity doesn't fan out
    // into API calls.
    // workflow_run events have no single PR opener field. The task-lookup
    // (findByPrUrl) already scopes to bot-opened PRs, so the pre-filter is
    // redundant for this event type.
    if (eventHeader !== "workflow_run" && prOpenerLogin !== this.botPayloadLogin) {
      this.reject(c, "not_bot_pr");
      return c.json({ status: "ignored", reason: "PR not opened by bot" }, 200);
    }

    // Actor-trust gate — runs BEFORE any parsing / routing / DB lookup.
    // Without this, anyone with a GitHub account can `@<bot>` on a
    // public/open-source PR or submit a review and drive a sandbox run on
    // the bot's behalf. HMAC above proves the event came from GitHub; this
    // check proves the *actor* is a member of a trusted org or a trusted
    // user. Compared by immutable numeric user id, not login, so a renamed
    // handle re-claimed by a stranger can't slip past a stale cache. The
    // trusted set is loaded lazily (`/orgs/{org}/members` per org, one lookup
    // per user) on the first webhook and cached for TRUSTED_SET_TTL_MS (6 h);
    // concurrent webhooks share one in-flight fetch.
    let trusted: ReadonlySet<number>;
    try {
      trusted = await this.getTrusted();
    } catch (err) {
      // GitHub unreachable / token scope problem. Return 503 so GitHub retries
      // per its delivery policy rather than dropping the event as a hard 403.
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error("github webhook 503: trusted set fetch failed", {
        eventHeader,
        message: e.message,
      });
      return c.json({ error: "service unavailable" }, 503);
    }

    if (!validWebhookRequest(eventHeader, userId, trusted, this.settings.botUserId)) {
      this.reject(c, "not_trusted");
      return c.json({ error: "forbidden" }, 403);
    }

    const parsed = parseGithubEvent(eventHeader, payload, this.mention);

    // logger.debug("github webhook accepted: ", { userId, userLogin, prOpenerLogin });
    // logger.debug("parsed payload: ", { parsed });

    if (!parsed) return c.json({ status: "ignored" }, 200);

    if (parsed.kind === "inline_review_comment_dropped_as_dedup") {
      return c.json({ status: "ignored", reason: "in-review dedup" }, 200);
    }

    if (parsed.kind === "workflow_run") {
      if (!config.github.ciResultEnabled) {
        return c.json({ status: "ignored", reason: "ci_result disabled" }, 200);
      }
      try {
        // One workflow_run can list multiple PRs; enqueue per matching task.
        // The loop breaker (service-side) drops failures past the per-task cap
        // and logs each trip — nothing to surface in the response here.
        for (const pr of parsed.pullRequests) {
          const prUrl = prUrlOf(parsed.owner, parsed.repo, pr.number);
          const task = await this.taskRepo.findByPrUrl(prUrl);
          if (!task) continue;
          logger.debug("workflow_run matched a bot-opened task; enqueueing ci_result", {
            taskId: task.id,
            taskExternalUrl: task.externalUrl,
            runId: parsed.runId,
            prNumber: pr.number,
          });

          await this.inboxService.enqueueCiResult({
            task,
            runId: parsed.runId,
            runAttempt: parsed.runAttempt,
            workflowName: parsed.workflowName,
            workflowPath: parsed.workflowPath,
            conclusion: parsed.conclusion,
            runUrl: parsed.runUrl,
            headSha: parsed.headSha,
            headBranch: parsed.headBranch,
            owner: parsed.owner,
            repo: parsed.repo,
            prNumber: pr.number,
          });
        }
        return c.json({ status: "ok" }, 200);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        logger.error("handleGithubWebhook failed", {
          eventKind: parsed.kind,
          message: e.message,
          stack: e.stack,
        });
        return c.json({ error: "internal" }, 500);
      }
    }

    try {
      // comment / review — task has no status; every comment enqueues an inbox
      // row. The sweep recreates the sandbox from PVC if needed and surfaces a
      // PVC-missing error if the workspace has already been pruned.
      const task = await this.taskRepo.findByPrUrl(parsed.prUrl);
      if (!task) return c.json({ status: "ignored" }, 200);

      if (parsed.kind === "comment") {
        await this.inboxService.enqueueComment({
          task,
          commentId: parsed.commentId,
          body: parsed.body,
          spec: parsed.spec,
          createdAt: parsed.createdAt,
        });
        // Fire-and-forget 👀 — no DB marker, no retry. GH dedups reactions by
        // (user, content) so a duplicate webhook delivery is a no-op API call.
        const react =
          parsed.spec.kind === "issue_comment" ? addIssueCommentReaction : addReviewCommentReaction;
        void react(parsed.owner, parsed.repo, parsed.commentId, "eyes").catch(logFireAndForget);
      } else {
        // Drop any inline comment authored by the bot itself — defensive: a
        // batch must never enqueue harness's own replies as items to address.
        const fetchedInlineComments = (
          await getReviewComments(parsed.owner, parsed.repo, parsed.prNumber, parsed.reviewId)
        ).filter((comment) => comment.user.login !== this.botPayloadLogin);
        const reviewBodyMentionsBot = this.mention.test(parsed.reviewBody);
        const mentioningInlineComments = fetchedInlineComments.filter((comment) =>
          this.mention.test(comment.body),
        );
        if (!reviewBodyMentionsBot && mentioningInlineComments.length === 0) {
          return c.json({ status: "ignored", reason: "no mention" }, 200);
        }
        const inlineComments = reviewBodyMentionsBot
          ? fetchedInlineComments
          : mentioningInlineComments;
        await this.inboxService.enqueueReview({
          task,
          reviewId: parsed.reviewId,
          reviewBody: reviewBodyMentionsBot ? parsed.reviewBody : "",
          inlineComments,
          owner: parsed.owner,
          repo: parsed.repo,
          prNumber: parsed.prNumber,
          reviewerLogin: parsed.userLogin,
          createdAt: parsed.createdAt,
        });
        // Fire-and-forget 👀 on each processed inline; review_body has no reactions API.
        for (const ic of inlineComments) {
          void addReviewCommentReaction(parsed.owner, parsed.repo, ic.id, "eyes").catch(
            logFireAndForget,
          );
        }
      }

      return c.json({ status: "ok" }, 200);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error("handleGithubWebhook failed", {
        eventKind: parsed.kind,
        message: e.message,
        stack: e.stack,
      });
      return c.json({ error: "internal" }, 500);
    }
  }
}

function validWebhookRequest(
  eventHeader: string | undefined,
  userId: number,
  trusted: ReadonlySet<number>,
  botUserId: number,
): boolean {
  if (eventHeader === "workflow_run" && userId === botUserId) {
    // we allow handling webhook requests for workflow_run
    // on the PR's which are opened by the bot.
    return true;
  }

  if (userId && trusted.has(userId)) {
    // For all the other events, the userId must be in the trusted set (a member
    // of a trusted org, or a trusted user).
    return true;
  }

  return false;
}

function logFireAndForget(err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.warn("github reaction fire-and-forget failed", {
    message: e.message,
    stack: e.stack,
  });
}
