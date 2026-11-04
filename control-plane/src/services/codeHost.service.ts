import { addPrAssignees, getUserById, parsePrUrl, postIssueComment } from "../clients/github";
import type { Task } from "../db/schema";
import { SEND_TIMEOUT_MS, withTimeout } from "../integrations/http";
import type { PrRef } from "../integrations/types";
import { logger } from "../logger";
import type { BackgroundWork } from "./backgroundWork";
import type { IntegrationRegistry } from "./integrationRegistry";

// One-time onboarding comment posted on every PR harness opens — comment
// interactivity is invisible unless users know it exists. Built per-call from
// the login @-mentions go to, so the displayed name and the `@mention` example
// always match the actual GitHub App identity (GITHUB_BOT_LOGIN).
function onboardingCommentBody(botLogin: string, taskKey: string): string {
  return [
    `👋 I'm **${botLogin}**. I opened this PR from task \`${taskKey}\`.`,
    "",
    `Mention \`@${botLogin}\` and I'll act on it — on a top-level PR comment,`,
    "in a review summary, or on an inline comment on the diff. Without a mention I won't see it.",
  ].join("\n");
}

// GitHub, the only code host. The harness opens pull requests with the
// sandbox's git token; the control plane then introduces itself on each new PR
// and assigns it to the task's person. The GitHub integration is separate: it
// only turns comments, reviews and CI results into rounds.
export class CodeHost {
  constructor(
    // assignee(): the task's own integration's person. prMentionLogin(): set
    // while an enabled integration turns @-mentions on PRs into rounds.
    private registry: Pick<IntegrationRegistry, "for" | "prMentionLogin">,
    private background: Pick<BackgroundWork, "track">,
    // Bounds each GitHub call it waits for: the onboarding comment, awaited
    // inside the tick like a send, and the account id lookup.
    private sendTimeoutMs = SEND_TIMEOUT_MS,
  ) {}

  // The PR a pr_opened event reports, with its GitHub coordinates (null for a
  // URL that isn't a github.com PR).
  prRef(e: { pr_url: string; repo: string; branch: string }): PrRef {
    return { url: e.pr_url, repo: e.repo, branch: e.branch, github: parsePrUrl(e.pr_url) };
  }

  // The first dispatch of a pr_opened: the onboarding comment (awaited and
  // bounded), then the assignee mirror in BackgroundWork, since its upstream
  // round trips must not stall the tick and nothing reads its result.
  // Best-effort: never throws.
  async prOpened(task: Task, pr: PrRef): Promise<void> {
    await this.postOnboardingComment(task, pr);
    this.background.track(task.id, "assignee", this.mirrorAssignee(task, pr));
  }

  private async postOnboardingComment(task: Task, pr: PrRef): Promise<void> {
    // The comment explains @-mentions, which only work while an enabled
    // integration takes them (GitHub's webhooks).
    const botLogin = this.registry.prMentionLogin();
    if (!botLogin) return;
    const gh = pr.github;
    if (!gh) return; // not a github.com PR URL — skip
    await withTimeout(this.sendTimeoutMs, (signal) =>
      postIssueComment(
        gh.owner,
        gh.repo,
        gh.prNumber,
        onboardingCommentBody(botLogin, task.key),
        signal,
      ),
    ).catch((err) => logErr("onboarding comment post failed", err));
  }

  // Assigns the PR to the task's person, through the GitHub account their
  // platform links to them. Assignee is the right primitive here: harness PRs
  // open as DRAFTS and GitHub rejects requested_reviewers on drafts.
  //
  // Best-effort by contract: never rejects, a failure must not block dispatch
  // or the cursor.
  private async mirrorAssignee(task: Task, pr: PrRef): Promise<void> {
    const gh = pr.github;
    if (!gh) return; // not a github.com PR URL — skip
    // undefined: no assignee() (API tasks), or the lookup failed (logged).
    const person = await this.registry.for(task.source).assignee(task, { prUrl: pr.url });
    if (person === undefined) return;
    if (!person) {
      logger.info("PR assignee mirror skipped", {
        event: "pr_assignee.result",
        status: "skipped",
        reason: "no_human_assignee",
        taskId: task.id,
        prUrl: pr.url,
      });
      return;
    }
    const account = person.githubAccount;
    if (account === undefined || account === null) {
      // null: the person can link an account on their platform but hasn't
      // (Linear: Settings → Connected accounts). Log the platform's account
      // id, not the name or email.
      logger.info("PR assignee mirror skipped", {
        event: "pr_assignee.result",
        status: "skipped",
        reason: account === null ? "no_github_mapping" : "unsupported",
        taskId: task.id,
        prUrl: pr.url,
        personId: person.id,
      });
      return;
    }
    try {
      // Digits are an account id (ids survive renames): resolve the current
      // login. Anything else is already a login.
      const login = /^\d+$/.test(account)
        ? (await withTimeout(this.sendTimeoutMs, (signal) => getUserById(account, signal))).login
        : account;
      if (!login) {
        // getUserById normalizes a malformed 2xx body to login: "" — don't
        // POST an empty assignee and misreport it as no_push_access.
        logger.warn("PR assignee mirror skipped", {
          event: "pr_assignee.result",
          status: "skipped",
          reason: "unresolved_login",
          taskId: task.id,
          prUrl: pr.url,
          personId: person.id,
        });
        return;
      }
      const { assigned } = await addPrAssignees(gh.owner, gh.repo, gh.prNumber, [login]);
      // GitHub logins are case-insensitive but the response echoes canonical
      // casing — compare case-folded so a cased mapping isn't a false drop.
      if (!assigned.some((a) => a.toLowerCase() === login.toLowerCase())) {
        // GitHub silently drops logins without push access (201 regardless).
        logger.warn("PR assignee silently dropped by GitHub", {
          event: "pr_assignee.result",
          status: "silently_dropped",
          reason: "no_push_access",
          taskId: task.id,
          prUrl: pr.url,
          requested: login,
          assigned,
        });
        return;
      }
      logger.info("PR assignee mirrored", {
        event: "pr_assignee.result",
        status: "assigned",
        taskId: task.id,
        prUrl: pr.url,
        requested: login,
        assigned,
      });
    } catch (err) {
      logErr("PR assignee mirror failed", err, { taskId: task.id, prUrl: pr.url });
    }
  }
}

// Untrusted values (e.g. sandbox-written pr_url) belong in `meta`, never in
// `msg`: metadata is JSON-stringified by the logger while the message is
// emitted raw, so a newline in an interpolated message would forge log lines.
function logErr(msg: string, err: unknown, meta: Record<string, unknown> = {}): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(msg, { ...meta, message: e.message, stack: e.stack });
}
