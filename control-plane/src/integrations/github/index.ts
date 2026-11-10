import type { Context } from "hono";
import {
  addIssueCommentReaction,
  addReviewCommentReaction,
  githubTokenState,
  parsePrUrl,
  postIssueComment,
  postReviewCommentReply,
  requestReviewers,
} from "../../clients/github";
import type { Task } from "../../db/schema";
import { retryable, SEND_TIMEOUT_MS, withTimeout } from "../http";
import type { Outbound, SendCtx } from "../outbound";
import type {
  HookCtx,
  Integration,
  IntegrationDefinition,
  PrOpenedCtx,
  PrRef,
  ReplyTarget,
  Round,
} from "../types";
import { assignToTaskPerson } from "./assignee";
import { type GithubConfig, parseGithubConfig } from "./config";
import { type GithubSpec, isGithubSpec } from "./rounds";
import { type GithubStatus, GithubStatusService } from "./status";
import { GitHubWebhookController } from "./webhook";

// GitHub creates no tasks: its rounds come only from its webhooks, so it is
// enabled exactly when they are, and disabling them skips open rounds' replies.
// Its status always reports the control plane's own token.
export const github: IntegrationDefinition<GithubConfig> = {
  name: "github",
  createsTasks: false,
  parseConfig: parseGithubConfig,
  create(core, cfg) {
    const controller = new GitHubWebhookController(core.tasks, cfg, core.log);
    const status = new GithubStatusService(githubTokenState, {
      enabled: true,
      ciResults: cfg.ciResultEnabled,
      lastWebhookAt: () => controller.lastWebhookAt(),
    });
    return new GithubIntegration(cfg, status, controller);
  },
  disabledStatus: () =>
    new GithubStatusService(githubTokenState, {
      enabled: false,
      ciResults: false,
      lastWebhookAt: () => null,
    }).status(),
};

// GitHub rounds (comments, reviews, CI results) post on the PR. A PR shows no
// live progress, and it is public: a failure's raw detail never goes there.
export class GithubIntegration implements Integration {
  // Its webhooks turn @-mentions of the bot into rounds.
  private readonly botLogin: string;

  constructor(
    cfg: Pick<GithubConfig, "botLogin">,
    private statusService: Pick<GithubStatusService, "status">,
    private controller: Pick<GitHubWebhookController, "handleWebhook">,
    // Bounds the onboarding comment.
    private readonly sendTimeoutMs = SEND_TIMEOUT_MS,
  ) {
    this.botLogin = cfg.botLogin;
  }

  // Today's responses: 403 for untrusted actors, 503 when the trusted set
  // can't be fetched. The controller holds its TaskService.
  webhook(c: Context): Promise<Response> {
    return this.controller.handleWebhook(c);
  }

  async status(): Promise<GithubStatus> {
    return this.statusService.status();
  }

  async deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void> {
    // Anything else isn't a GitHub target (a malformed or foreign row): the
    // error is logged and the send dropped.
    const spec = target.spec;
    if (!isGithubSpec(spec)) throw new Error("not a GitHub PR thread target");
    switch (message.type) {
      case "reply":
        await post(ctx, spec, message.body);
        return;
      case "progress":
        return;
      case "failure":
        await deliverFailure(ctx, spec, message, this.botLogin);
        return;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  // github.com pull requests are GitHub's: core hands it each new one.
  hostsPr(url: string): boolean {
    return parsePrUrl(url) !== null;
  }

  // The agent opened a pull request on github.com (core calls this as the
  // PR's code host's integration, once per PR). Two things, each on its own:
  // a failed comment doesn't cost the PR its assignee.
  // - The onboarding comment, awaited: comment interactivity is invisible
  //   unless users know it exists.
  // - The assignee: the task's person, through their linked GitHub account.
  //   In the background, since its round trips (the task's integration, then
  //   GitHub) must not stall the tick and nothing reads its result.
  // Both happen only while GitHub is on, that is while its webhooks are: a
  // deployment on a personal token, with no webhooks, gets neither.
  async onPrOpened(ctx: PrOpenedCtx, task: Task, pr: PrRef): Promise<void> {
    if (!ctx.firstTime) return;
    const gh = parsePrUrl(pr.url);
    if (!gh) return;
    // Under its own timeout, not only the hook's: a post that never settles,
    // whatever its abort signal, would leave this hook suspended, and the
    // assignee below would never start. The PR is recorded either way, and a
    // replay skips this hook.
    await withTimeout(this.sendTimeoutMs, (signal) =>
      postIssueComment(
        gh.owner,
        gh.repo,
        gh.prNumber,
        onboardingCommentBody(this.botLogin, task.key),
        signal,
      ),
    ).catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.log.error("onboarding comment post failed", {
        taskId: task.id,
        prUrl: pr.url,
        message: e.message,
        stack: e.stack,
      });
    });
    ctx.background(assignToTaskPerson(ctx, task, { url: pr.url, ...gh }));
  }

  // A finished review re-requests review from its reviewer, once (a replayed
  // `completed` doesn't). Best-effort: a failure is logged, nothing waits on it.
  async onRoundFinished(
    ctx: HookCtx & { firstTransition: boolean },
    task: Task,
    round: Round,
  ): Promise<void> {
    if (ctx.firstTransition && round.kind === "review") {
      await requestReviewFromOriginalReviewer(ctx, round, task);
    }
  }
}

// Built per-call from the login @-mentions go to, so the displayed name and
// the `@mention` example always match the actual GitHub App identity
// (GITHUB_BOT_LOGIN).
function onboardingCommentBody(botLogin: string, taskKey: string): string {
  return [
    `👋 I'm **${botLogin}**. I opened this PR from task \`${taskKey}\`.`,
    "",
    `Mention \`@${botLogin}\` and I'll act on it — on a top-level PR comment,`,
    "in a review summary, or on an inline comment on the diff. Without a mention I won't see it.",
  ].join("\n");
}

async function requestReviewFromOriginalReviewer(
  ctx: HookCtx,
  inboxRow: Round,
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
  inboxRow: Round,
): { owner: string; repo: string; prNumber: number } | null {
  const pr = (inboxRow.payload as { pr?: Record<string, unknown> } | null)?.pr;
  const owner = typeof pr?.owner === "string" ? pr.owner : "";
  const repo = typeof pr?.repo === "string" ? pr.repo : "";
  const prNumber = typeof pr?.prNumber === "number" ? pr.prNumber : Number.NaN;
  if (owner && repo && Number.isFinite(prNumber)) {
    return { owner, repo, prNumber };
  }

  const spec = inboxRow.reply_targets
    .map((t) => t.spec)
    .find((s) => isGithubSpec(s) && (s.kind === "review_body" || s.kind === "review_comment"));
  if (isGithubSpec(spec)) return { owner: spec.owner, repo: spec.repo, prNumber: spec.prNumber };

  const prUrl = typeof pr?.pr_url === "string" ? pr.pr_url : "";
  return prUrl ? parsePrUrl(prUrl) : null;
}

async function deliverFailure(
  ctx: SendCtx,
  spec: GithubSpec,
  message: Extract<Outbound, { type: "failure" }>,
  botLogin: string,
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
      // The retry hint is an @-mention, which the webhooks turn into a round.
      await post(
        ctx,
        spec,
        `⚠️ Something went wrong while working on this. Mention @${botLogin} in a new comment to retry.`,
      );
      return;
    }
    case "workspace_missing":
      if (message.summary) await workspaceMissing(ctx, spec, round, message.summary);
      return;
  }
}

// One notice per round. A comment gets a reply plus 😕. A review gets only a
// top-level PR comment for its summary, whatever target core passed (the
// review body has no reply / reactions API). A CI result is informational and
// dead-lettered silently.
async function workspaceMissing(
  ctx: SendCtx,
  spec: GithubSpec,
  round: Round,
  text: string,
): Promise<void> {
  if (round.kind === "review") {
    const body = round.reply_targets
      .map((t) => t.spec)
      .find((s) => isGithubSpec(s) && s.kind === "review_body");
    if (isGithubSpec(body)) await post(ctx, body, text);
    return;
  }
  if (round.kind !== "comment") return;
  try {
    await post(ctx, spec, text);
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
