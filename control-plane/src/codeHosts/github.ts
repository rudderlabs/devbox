import { addPrAssignees, getUserById, parsePrUrl, postIssueComment } from "../clients/github";
import { withTimeout } from "../integrations/http";
import type { Person } from "../integrations/types";
import { logger } from "../logger";
import type { AssignCtx, CodeHostAdapter } from "./types";

// github.com pull requests.
export const githubHost: CodeHostAdapter = {
  name: "github",

  owns: (url) => parsePrUrl(url) !== null,

  // Comment interactivity is invisible unless users know it exists. Built
  // per-call from the login @-mentions go to, so the displayed name and the
  // `@mention` example always match the actual GitHub App identity
  // (GITHUB_BOT_LOGIN).
  onboardingBody: (botLogin, taskKey) =>
    [
      `👋 I'm **${botLogin}**. I opened this PR from task \`${taskKey}\`.`,
      "",
      `Mention \`@${botLogin}\` and I'll act on it — on a top-level PR comment,`,
      "in a review summary, or on an inline comment on the diff. Without a mention I won't see it.",
    ].join("\n"),

  async comment(url, body, signal) {
    const pr = parsePrUrl(url);
    if (!pr) throw new Error("not a github.com pull request URL");
    await postIssueComment(pr.owner, pr.repo, pr.prNumber, body, signal);
  },

  // Through the GitHub account the person's platform links to them. Assignee
  // is the right primitive here: harness PRs open as DRAFTS and GitHub rejects
  // requested_reviewers on drafts.
  async assign(url: string, person: Person, ctx: AssignCtx): Promise<void> {
    const pr = parsePrUrl(url);
    if (!pr) return;
    const { taskId } = ctx;
    const account = person.githubAccount;
    if (account === undefined || account === null) {
      // null: the person can link an account on their platform but hasn't
      // (Linear: Settings → Connected accounts). Log the platform's account
      // id, not the name or email.
      logger.info("PR assignee mirror skipped", {
        event: "pr_assignee.result",
        status: "skipped",
        reason: account === null ? "no_github_mapping" : "unsupported",
        taskId,
        prUrl: url,
        personId: person.id,
      });
      return;
    }
    try {
      // Digits are an account id (ids survive renames): resolve the current
      // login. Anything else is already a login.
      const login = /^\d+$/.test(account)
        ? (await withTimeout(ctx.timeoutMs, (signal) => getUserById(account, signal))).login
        : account;
      if (!login) {
        // getUserById normalizes a malformed 2xx body to login: "" — don't
        // POST an empty assignee and misreport it as no_push_access.
        logger.warn("PR assignee mirror skipped", {
          event: "pr_assignee.result",
          status: "skipped",
          reason: "unresolved_login",
          taskId,
          prUrl: url,
          personId: person.id,
        });
        return;
      }
      const { assigned } = await addPrAssignees(pr.owner, pr.repo, pr.prNumber, [login]);
      // GitHub logins are case-insensitive but the response echoes canonical
      // casing — compare case-folded so a cased mapping isn't a false drop.
      if (!assigned.some((a) => a.toLowerCase() === login.toLowerCase())) {
        // GitHub silently drops logins without push access (201 regardless).
        logger.warn("PR assignee silently dropped by GitHub", {
          event: "pr_assignee.result",
          status: "silently_dropped",
          reason: "no_push_access",
          taskId,
          prUrl: url,
          requested: login,
          assigned,
        });
        return;
      }
      logger.info("PR assignee mirrored", {
        event: "pr_assignee.result",
        status: "assigned",
        taskId,
        prUrl: url,
        requested: login,
        assigned,
      });
    } catch (err) {
      // Untrusted values (the sandbox-written pr_url) go in the metadata,
      // never in the message.
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error("PR assignee mirror failed", {
        taskId,
        prUrl: url,
        message: e.message,
        stack: e.stack,
      });
    }
  },
};
