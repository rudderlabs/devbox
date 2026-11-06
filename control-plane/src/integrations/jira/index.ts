import type { Context } from "hono";
import type { Task } from "../../db/schema";
import { HttpError, retryable } from "../http";
import type { Outbound, SendCtx } from "../outbound";
import type {
  Core,
  HookCtx,
  Integration,
  IntegrationDefinition,
  Outcome,
  PrRef,
  ReplyTarget,
  Round,
} from "../types";
import { adfComments, adfShortComment } from "./adf";
import { type JiraClient, jiraClient } from "./client";
import { type JiraConfig, parseJiraConfig } from "./config";
import { type JiraIntegrationStatus, JiraStatusService } from "./status";
import { isJiraSpec, JiraWebhookController } from "./webhook";

// How Jira refuses a transition it won't make: a required field or a
// condition (400), a concurrent change (409), or an invalid request (422).
const TRANSITION_REFUSED = new Set([400, 409, 422]);

export const jira: IntegrationDefinition<JiraConfig> = {
  name: "jira",
  createsTasks: true,
  parseConfig: parseJiraConfig,
  create: (core, cfg) => createJira(core, cfg),
  // jira:status reads this to tell "off here" from "not reachable".
  disabledStatus: () => ({ configured: false }),
};

// The Jira calls devbox makes; tests pass a fake.
export type Client = Pick<
  JiraClient,
  | "myself"
  | "addComment"
  | "getIssue"
  | "myPermissions"
  | "projectStatuses"
  | "transitions"
  | "transition"
  | "upsertRemoteLink"
>;

// Jira from its settings. `deps` replaces the client and the clock in tests.
export function createJira(
  core: Core,
  cfg: JiraConfig,
  deps: { client?: Client; now?: () => number } = {},
): JiraIntegration {
  const now = deps.now ?? Date.now;
  const client =
    deps.client ?? jiraClient({ cloudId: cfg.cloudId, email: cfg.botEmail, token: cfg.apiToken });
  const status = new JiraStatusService(cfg, client, core.log, now);
  const controller = new JiraWebhookController(core.tasks, cfg, client, core.log, () =>
    status.recordWebhook(),
  );
  return new JiraIntegration(cfg, client, status, controller);
}

// Jira Cloud through an admin webhook and a bot account. Assigning the bot an
// issue starts (or, assigned again, restarts) a task; a comment that mentions
// the bot is a follow-up. Replies and failure notices are comments on the
// issue, which everyone who can see the issue reads: a failure's raw detail
// never goes there, and Jira shows no live progress.
export class JiraIntegration implements Integration {
  constructor(
    private readonly cfg: JiraConfig,
    private readonly client: Client,
    private readonly statusService: Pick<JiraStatusService, "status" | "recordReplyFailure">,
    private readonly controller: Pick<JiraWebhookController, "handleWebhook">,
  ) {}

  webhook(c: Context): Promise<Response> {
    return this.controller.handleWebhook(c);
  }

  status(): Promise<JiraIntegrationStatus> {
    return this.statusService.status();
  }

  async deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void> {
    // Anything else isn't a Jira target (a malformed or foreign row): the
    // error is logged and the send dropped.
    const spec = target.spec;
    if (!isJiraSpec(spec)) throw new Error("not a Jira issue target");
    switch (message.type) {
      case "reply":
        await this.post(ctx, spec.issueId, message.body);
        return;
      case "progress":
        return;
      case "failure": {
        const text = failureText(message, this.cfg.botName);
        if (text) await this.post(ctx, spec.issueId, text);
        return;
      }
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  // A fresh provision: moves the issue to the started status, if one is
  // configured and the issue is still the bot's. Safe to repeat: an issue
  // already there is left alone.
  async onTaskStarted(ctx: HookCtx, task: Task): Promise<void> {
    const started = this.cfg.statuses.started;
    if (started) await this.moveIssue(ctx, task, started);
  }

  // Links the pull request on the issue. Jira updates the link with the same
  // globalId in place, so this runs on every pr_opened dispatch; a
  // RetryableError holds the event. The URL comes from the sandbox and Jira
  // shows it as a link, so only an https github.com pull request is linked.
  async onPrOpened(ctx: HookCtx, task: Task, pr: PrRef): Promise<void> {
    const gh = pr.github;
    if (!gh || !pr.url.startsWith("https://")) {
      ctx.log.warn("jira PR link skipped: not a GitHub pull request URL", { taskId: task.id });
      return;
    }
    const title = `${gh.owner}/${gh.repo}#${gh.prNumber}`;
    try {
      await this.client.upsertRemoteLink(
        task.externalId,
        { globalId: pr.url, url: pr.url, title },
        ctx.signal,
      );
    } catch (err) {
      throw retryable(err) ?? err;
    }
  }

  // When this call finished the assignment, moves the issue from started to
  // done, or to failed when the task failed. A partial failure counts as done:
  // at least one pull request is open for review and the reply lists the
  // repositories that failed, so the issue belongs with its reviewers. Without
  // a started status an issue someone moved by hand can't be told apart, so
  // nothing moves.
  async onRoundFinished(
    ctx: HookCtx & { firstTransition: boolean },
    task: Task,
    round: Round,
    outcome: Outcome | null,
  ): Promise<void> {
    if (!ctx.firstTransition || round.kind !== "assignment" || !outcome) return;
    const { started, done, failed } = this.cfg.statuses;
    const to = outcome === "failed" ? failed : done;
    if (!started || !to) return;
    await this.moveIssue(ctx, task, to, started);
  }

  // Compare-and-set: moves the task's issue to the status named `to` only
  // while the bot is its assignee, the issue isn't there already and, when
  // `from` is given, is still in `from`, and the task wasn't restarted (checked
  // last, right before the move). Names match in any case. A workflow with no
  // move to `to`, or Jira refusing the move, is logged and skipped; any other
  // error is the hook runner's to log.
  private async moveIssue(ctx: HookCtx, task: Task, to: string, from?: string): Promise<void> {
    const issueId = task.externalId;
    const meta = { taskId: task.id, issueId, to };
    const skip = (reason: string) => ctx.log.info("jira transition skipped", { ...meta, reason });
    const { fields } = await this.client.getIssue(issueId, ["status", "assignee"], ctx.signal);
    if (prop(fields.assignee, "accountId") !== this.cfg.botAccountId) return skip("not_assignee");
    const status = prop(fields.status, "name") ?? "";
    if (sameName(status, to)) return skip("already_there");
    if (from !== undefined && !sameName(status, from)) return skip("status_moved");
    const transitions = await this.client.transitions(issueId, ctx.signal);
    const move = transitions.find((t) => sameName(t.to.name, to));
    if (!move) {
      ctx.log.warn("jira transition skipped: the workflow has no move to this status", meta);
      return;
    }
    if (!(await ctx.isCurrent())) return skip("restarted");
    try {
      await this.client.transition(issueId, move.id, ctx.signal);
    } catch (err) {
      if (!(err instanceof HttpError && TRANSITION_REFUSED.has(err.status))) throw err;
      ctx.log.warn("jira transition refused", { ...meta, status: err.status });
    }
  }

  // Posts `markdown` as up to three comments. Only a failure of the first part
  // may be retried: once a part is on the issue, a retry would post it again.
  // Jira counts length its own way, so a first part it refuses as too long is
  // replaced by one short comment.
  private async post(ctx: SendCtx, issueId: string, markdown: string): Promise<void> {
    const docs = adfComments(markdown);
    for (const [i, doc] of docs.entries()) {
      try {
        await this.client.addComment(issueId, doc, ctx.signal);
      } catch (err) {
        this.statusService.recordReplyFailure(err);
        if (i === 0 && tooLong(err)) {
          await this.client
            .addComment(issueId, adfShortComment(markdown), ctx.signal)
            .catch((e) => {
              throw retryable(e) ?? e;
            });
          return;
        }
        if (i === 0) throw retryable(err) ?? err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Jira reply part ${i + 1} of ${docs.length} failed: ${msg}`);
      }
    }
  }
}

// The notice for a failed task or round, by cause and round kind, naming the
// bot so people know whom to re-assign or mention. A crashed comment round's
// raw detail is never posted; a failed assignment shows the harness's
// user-safe summary.
function failureText(m: Extract<Outbound, { type: "failure" }>, bot: string): string | undefined {
  const assignment = m.round.kind === "assignment";
  switch (m.cause) {
    case "task_failed":
      return assignment
        ? `devbox couldn't finish this task. To start over, assign the issue to someone else and then back to ${bot}; this opens a new pull request.`
        : `devbox couldn't finish this. Comment with @${bot} to retry.`;
    case "workspace_missing":
      return `This task's workspace was cleaned up, so devbox can't continue it. Assign the issue to someone else and then back to ${bot} to start over.`;
    case "round_failed":
      return assignment
        ? m.summary
        : `⚠️ Something went wrong while working on this. Comment with @${bot} to retry.`;
  }
}

// Jira's 400 for a comment over its length limit.
function tooLong(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    err.status === 400 &&
    /exceed|too long|maximum length/i.test(err.message)
  );
}

// Jira status names match in any case.
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// A string property of an object field from an issue (assignee.accountId, status.name).
function prop(field: unknown, key: string): string | undefined {
  const v =
    typeof field === "object" && field !== null
      ? (field as Record<string, unknown>)[key]
      : undefined;
  return typeof v === "string" ? v : undefined;
}
