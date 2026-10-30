import {
  addIssueCommentReaction,
  addReviewCommentReaction,
  postIssueComment,
  postReviewCommentReply,
} from "../../clients/github";
import { config } from "../../config";
import type { InboxRow, ReplyTargetSpec } from "../../repositories/inbox.repository";
import { WORKSPACE_MISSING_MESSAGE } from "../../services/inbox.service";
import { retryable } from "../http";
import type { Outbound, SendCtx } from "../outbound";
import type { Integration } from "../types";

type GithubSpec = Extract<
  ReplyTargetSpec,
  { kind: "issue_comment" | "review_comment" | "review_body" }
>;

// GitHub rounds (comments, reviews, CI results) post on the PR. A PR shows no
// live progress, and it is public: a failure's raw detail never goes there.
export const githubIntegration: Integration = {
  name: "github",
  async deliver(ctx, target, message) {
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
  },
};

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
