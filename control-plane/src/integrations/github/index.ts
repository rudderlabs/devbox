import type { Context } from "hono";
import {
  addIssueCommentReaction,
  addReviewCommentReaction,
  parsePrUrl,
  postIssueComment,
  postReviewCommentReply,
  requestReviewers,
} from "../../clients/github";
import { config } from "../../config";
import type { GitHubWebhookController } from "../../controllers/githubWebhook.controller";
import type { Task } from "../../db/schema";
import type { InboxRow, ReplyTarget, ReplyTargetSpec } from "../../repositories/inbox.repository";
import type { GithubStatus, GithubStatusService } from "../../services/githubStatus.service";
import { WORKSPACE_MISSING_MESSAGE } from "../../services/inbox.service";
import { retryable } from "../http";
import type { Outbound, SendCtx } from "../outbound";
import type { HookCtx, Integration } from "../types";

type GithubSpec = Extract<
  ReplyTargetSpec,
  { kind: "issue_comment" | "review_comment" | "review_body" }
>;

// GitHub rounds (comments, reviews, CI results) post on the PR. A PR shows no
// live progress, and it is public: a failure's raw detail never goes there.
// GitHub creates no tasks: its rounds come only from its webhooks, so it is
// enabled exactly when they are, and disabling them skips open rounds' replies.
export class GithubIntegration implements Integration<GithubStatus> {
  readonly name = "github";
  // Today's webhook controller. It enqueues through InboxService, which needs
  // this registry, so app.ts attaches it afterwards (only when enabled).
  controller?: GitHubWebhookController;

  constructor(
    // GITHUB_WEBHOOKS_ENABLED.
    readonly enabled: boolean,
    private statusService: Pick<GithubStatusService, "status">,
  ) {}

  // Today's responses: 403 for untrusted actors, 503 when the trusted set
  // can't be fetched. The controller already holds the intake.
  async webhook(c: Context): Promise<Response> {
    if (!this.controller) return c.notFound();
    return this.controller.handleWebhook(c);
  }

  async status(): Promise<GithubStatus> {
    return this.statusService.status();
  }

  async deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void> {
    const spec = target.spec;
    if (spec.kind === "linear_session" || spec.kind === "api_session") {
      throw new Error(`github cannot deliver to a ${spec.kind} target`);
    }
    switch (message.type) {
      case "reply":
        await post(ctx, spec, message.body);
        return;
      case "progress":
        return;
      case "failure":
        await deliverFailure(ctx, spec, message);
        return;
    }
  }

  // A finished review re-requests review from its reviewer, once (a replayed
  // `completed` doesn't). Best-effort: a failure is logged, nothing waits on it.
  async onRoundFinished(
    ctx: HookCtx & { firstTransition: boolean },
    task: Task,
    round: InboxRow,
  ): Promise<void> {
    if (ctx.firstTransition && round.kind === "review") {
      await requestReviewFromOriginalReviewer(ctx, round, task);
    }
  }
}

async function requestReviewFromOriginalReviewer(
  ctx: HookCtx,
  inboxRow: Extract<InboxRow, { kind: "review" }>,
  task: Task,
): Promise<void> {
  const payload = inboxRow.payload as Record<string, unknown> | null | undefined;
  const reviewerLoginRaw = payload?.reviewer_login;
  const reviewerLogin = typeof reviewerLoginRaw === "string" ? reviewerLoginRaw.trim() : "";
  if (!reviewerLogin) {
    ctx.log.info("review re-request skipped", {
      event: "review_rerequest.result",
      status: "skipped",
      reason: "missing_reviewer_login",
      taskId: task.id,
      inboxId: inboxRow.id,
    });
    return;
  }

  const pr = reviewPrCoordinates(inboxRow);
  if (!pr) {
    ctx.log.warn("review re-request skipped", {
      event: "review_rerequest.result",
      status: "skipped",
      reason: "missing_pr_coordinates",
      taskId: task.id,
      inboxId: inboxRow.id,
      reviewerLogin,
    });
    return;
  }

  try {
    await requestReviewers(pr.owner, pr.repo, pr.prNumber, [reviewerLogin], ctx.signal);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    ctx.log.error("request reviewers failed", {
      taskId: task.id,
      inboxId: inboxRow.id,
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.prNumber,
      reviewerLogin,
      message: e.message,
      stack: e.stack,
    });
  }
}

function reviewPrCoordinates(
  inboxRow: Extract<InboxRow, { kind: "review" }>,
): { owner: string; repo: string; prNumber: number } | null {
  const pr = inboxRow.payload.pr as Record<string, unknown> | undefined;
  const owner = typeof pr?.owner === "string" ? pr.owner : "";
  const repo = typeof pr?.repo === "string" ? pr.repo : "";
  const prNumber = typeof pr?.prNumber === "number" ? pr.prNumber : Number.NaN;
  if (owner && repo && Number.isFinite(prNumber)) {
    return { owner, repo, prNumber };
  }

  const target = inboxRow.reply_targets.find(
    (t) => t.spec.kind === "review_body" || t.spec.kind === "review_comment",
  );
  if (target && "owner" in target.spec) {
    return { owner: target.spec.owner, repo: target.spec.repo, prNumber: target.spec.prNumber };
  }

  const prUrl = typeof pr?.pr_url === "string" ? pr.pr_url : "";
  return prUrl ? parsePrUrl(prUrl) : null;
}

async function deliverFailure(
  ctx: SendCtx,
  spec: GithubSpec,
  message: Extract<Outbound, { type: "failure" }>,
): Promise<void> {
  const { round } = message;
  switch (message.cause) {
    case "task_failed":
      // failTask's message is control-plane-generated and scrubbed: public-safe.
      if (message.summary) await post(ctx, spec, message.summary);
      return;
    case "round_failed": {
      // A failed CI-fix round stays silent.
      if (round.kind === "ci_result") return;
      // The retry hint is an @-mention, which only works with webhooks on.
      const botLogin = config.github.webhooks?.botLogin;
      if (!botLogin) return;
      await post(
        ctx,
        spec,
        `⚠️ Something went wrong while working on this. Mention @${botLogin} in a new comment to retry.`,
      );
      return;
    }
    case "workspace_missing":
      await workspaceMissing(ctx, spec, round);
      return;
  }
}

// One notice per round. A comment gets a reply plus 😕. A review gets only a
// top-level PR comment for its summary, whatever target core passed (the
// review body has no reply / reactions API). A CI result is informational and
// dead-lettered silently.
async function workspaceMissing(ctx: SendCtx, spec: GithubSpec, round: InboxRow): Promise<void> {
  if (round.kind === "review") {
    const body = round.reply_targets.find((t) => t.spec.kind === "review_body");
    if (body?.spec.kind === "review_body") await post(ctx, body.spec, WORKSPACE_MISSING_MESSAGE);
    return;
  }
  if (round.kind !== "comment") return;
  try {
    await post(ctx, spec, WORKSPACE_MISSING_MESSAGE);
  } finally {
    // The reaction is independent of the reply: try it even if the reply failed.
    await confusedReaction(ctx, spec).catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.log.error("workspace_missing reaction failed", { message: e.message, stack: e.stack });
    });
  }
}

async function confusedReaction(ctx: SendCtx, spec: GithubSpec): Promise<void> {
  if (spec.kind === "issue_comment") {
    await addIssueCommentReaction(spec.owner, spec.repo, spec.commentId, "confused", ctx.signal);
  } else if (spec.kind === "review_comment") {
    await addReviewCommentReaction(spec.owner, spec.repo, spec.commentId, "confused", ctx.signal);
  }
}

// Posts `body` verbatim to one PR thread, by target kind. CP never formats it.
// It is the first request of every GitHub send (the 😕 reaction comes after and
// never fails the send), so a retryable failure here means nothing was posted.
async function post(ctx: SendCtx, spec: GithubSpec, body: string): Promise<void> {
  const { signal } = ctx;
  try {
    switch (spec.kind) {
      case "issue_comment":
        await postIssueComment(spec.owner, spec.repo, spec.prNumber, body, signal);
        return;
      case "review_comment":
        await postReviewCommentReply(
          spec.owner,
          spec.repo,
          spec.prNumber,
          spec.inReplyTo,
          body,
          signal,
        );
        return;
      case "review_body":
        // Top-level PR comment — GH has no reply-to-review-body API.
        await postIssueComment(spec.owner, spec.repo, spec.prNumber, body, signal);
        return;
      default: {
        const _exhaustive: never = spec;
        void _exhaustive;
      }
    }
  } catch (err) {
    throw retryable(err) ?? err;
  }
}
