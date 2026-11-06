import { addPrAssignees, getUserById } from "../../clients/github";
import type { Task } from "../../db/schema";
import { SEND_TIMEOUT_MS, withTimeout } from "../http";
import type { PrOpenedCtx } from "../types";

// Assigns a pull request the agent opened to the task's person, through the
// GitHub account their platform links to them. Assignee is the right primitive
// here: harness PRs open as DRAFTS and GitHub rejects requested_reviewers on
// drafts.
//
// Runs in the background (onPrOpened hands it to ctx.background), after the
// hook has returned, so it takes no signal from the hook: the person lookup is
// bounded by the registry and the login lookup here. Assigning has no limit of
// its own: shutdown drains background work until a deadline.
//
// Best-effort by contract: never rejects, and logs its outcome as
// pr_assignee.result. The untrusted, sandbox-written PR URL goes in the
// metadata, never in a message.
export async function assignToTaskPerson(
  ctx: Pick<PrOpenedCtx, "log" | "person">,
  task: Pick<Task, "id">,
  pr: { url: string; owner: string; repo: string; prNumber: number },
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<void> {
  const meta = { taskId: task.id, prUrl: pr.url };
  try {
    // undefined: the task's integration has no assignee() (API tasks), or the
    // lookup failed (logged by the registry).
    const person = await ctx.person();
    if (person === undefined) return;
    if (!person) {
      ctx.log.info("PR assignee mirror skipped", {
        event: "pr_assignee.result",
        status: "skipped",
        reason: "no_human_assignee",
        ...meta,
      });
      return;
    }
    const account = person.githubAccount;
    if (account === undefined || account === null) {
      // null: the person can link an account on their platform but hasn't
      // (Linear: Settings → Connected accounts). Log the platform's account
      // id, not the name or email.
      ctx.log.info("PR assignee mirror skipped", {
        event: "pr_assignee.result",
        status: "skipped",
        reason: account === null ? "no_github_mapping" : "unsupported",
        ...meta,
        personId: person.id,
      });
      return;
    }
    // Digits are an account id (ids survive renames): resolve the current
    // login. Anything else is already a login.
    const login = /^\d+$/.test(account)
      ? (await withTimeout(timeoutMs, (signal) => getUserById(account, signal))).login
      : account;
    if (!login) {
      // getUserById normalizes a malformed 2xx body to login: "" — don't
      // POST an empty assignee and misreport it as no_push_access.
      ctx.log.warn("PR assignee mirror skipped", {
        event: "pr_assignee.result",
        status: "skipped",
        reason: "unresolved_login",
        ...meta,
        personId: person.id,
      });
      return;
    }
    const { assigned } = await addPrAssignees(pr.owner, pr.repo, pr.prNumber, [login]);
    // GitHub logins are case-insensitive but the response echoes canonical
    // casing — compare case-folded so a cased mapping isn't a false drop.
    if (!assigned.some((a) => a.toLowerCase() === login.toLowerCase())) {
      // GitHub silently drops logins without push access (201 regardless).
      ctx.log.warn("PR assignee silently dropped by GitHub", {
        event: "pr_assignee.result",
        status: "silently_dropped",
        reason: "no_push_access",
        ...meta,
        requested: login,
        assigned,
      });
      return;
    }
    ctx.log.info("PR assignee mirrored", {
      event: "pr_assignee.result",
      status: "assigned",
      ...meta,
      requested: login,
      assigned,
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    ctx.log.error("PR assignee mirror failed", { ...meta, message: e.message, stack: e.stack });
  }
}
