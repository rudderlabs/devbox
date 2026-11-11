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
  ReplyTarget,
  Round,
} from "../types";
import { type ClickUpClient, clickUpClient } from "./client";
import { type ClickUpConfig, parseClickUpConfig } from "./config";
import { markdownToComments } from "./quill";
import { type ClickUpIntegrationStatus, ClickUpStatusService } from "./status";
import { ClickUpWebhookController, isClickUpSpec, MemberRoles } from "./webhook";

export const clickup: IntegrationDefinition<ClickUpConfig> = {
  name: "clickup",
  createsTasks: true,
  parseConfig: parseClickUpConfig,
  create: (core, cfg) => createClickUp(core, cfg),
  // clickup:status reads this to tell "off here" from "not reachable".
  disabledStatus: () => ({ configured: false }),
};

// The ClickUp calls devbox makes; tests pass a fake.
export type Client = Pick<
  ClickUpClient,
  "user" | "members" | "task" | "addComment" | "setStatus" | "listStatuses" | "webhooks"
>;

// ClickUp from its settings. `deps` replaces the client and the clock in tests.
export function createClickUp(
  core: Core,
  cfg: ClickUpConfig,
  deps: { client?: Client; now?: () => number } = {},
): ClickUpIntegration {
  const now = deps.now ?? Date.now;
  const client = deps.client ?? clickUpClient({ token: cfg.apiToken });
  const status = new ClickUpStatusService(cfg, client, now);
  const members = new MemberRoles(client, cfg.teamId, core.log, now);
  const controller = new ClickUpWebhookController(core.tasks, cfg, client, members, core.log, () =>
    status.recordWebhook(),
  );
  return new ClickUpIntegration(cfg, client, status, controller);
}

// ClickUp through a workspace webhook and a bot member account. Assigning the
// bot a task starts (or, assigned again, restarts) a devbox task; a comment
// that mentions the bot is a follow-up. Replies and failure notices are
// comments on the task, which everyone who can see the task reads: a
// failure's raw detail never goes there, and ClickUp shows no live progress.
// ClickUp has no remote links, so there is no onPrOpened: replies carry the
// pull request's URL.
export class ClickUpIntegration implements Integration {
  constructor(
    private readonly cfg: ClickUpConfig,
    private readonly client: Client,
    private readonly statusService: Pick<ClickUpStatusService, "status" | "recordReplyFailure">,
    private readonly controller: Pick<ClickUpWebhookController, "handleWebhook">,
  ) {}

  webhook(c: Context): Promise<Response> {
    return this.controller.handleWebhook(c);
  }

  status(): Promise<ClickUpIntegrationStatus> {
    return this.statusService.status();
  }

  async deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void> {
    // Anything else isn't a ClickUp target (a malformed or foreign row): the
    // error is logged and the send dropped.
    const spec = target.spec;
    if (!isClickUpSpec(spec)) throw new Error("not a ClickUp task target");
    switch (message.type) {
      case "reply":
        await this.post(ctx, spec.taskId, message.body);
        return;
      case "progress":
        return;
      case "failure": {
        const text = failureText(message, this.cfg.botName);
        if (text) await this.post(ctx, spec.taskId, text);
        return;
      }
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  // A fresh provision: moves the task to the started status, if one is
  // configured and the task is still the bot's. Safe to repeat: a task
  // already there is left alone.
  async onTaskStarted(ctx: HookCtx, task: Task): Promise<void> {
    const started = this.cfg.statuses.started;
    if (started) await this.moveTask(ctx, task, started);
  }

  // When this call finished the assignment, moves the task from started to
  // done, or to failed when it failed. A partial failure counts as done: at
  // least one pull request is open for review and the reply lists the
  // repositories that failed. Without a started status a task someone moved
  // by hand can't be told apart, so nothing moves.
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
    await this.moveTask(ctx, task, to, started);
  }

  // Compare-and-set: moves the ClickUp task to the status named `to` only
  // while the bot is one of its assignees, the task isn't there already and,
  // when `from` is given, is still in `from`, and the devbox task wasn't
  // restarted (checked last, right before the move). Status names are per
  // list and match in any case. A list without `to`, or ClickUp refusing the
  // move (400), is logged and skipped; any other error is the hook runner's
  // to log.
  private async moveTask(ctx: HookCtx, task: Task, to: string, from?: string): Promise<void> {
    const clickupTaskId = task.externalId;
    const meta = { taskId: task.id, clickupTaskId, to };
    const skip = (reason: string) =>
      ctx.log.info("clickup status move skipped", { ...meta, reason });
    const current = await this.client.task(clickupTaskId, ctx.signal);
    if (!current.assigneeIds.includes(this.cfg.botUserId)) return skip("not_assignee");
    if (sameName(current.status, to)) return skip("already_there");
    if (from !== undefined && !sameName(current.status, from)) return skip("status_moved");
    const statuses = await this.client.listStatuses(current.listId, ctx.signal);
    const name = statuses.find((s) => sameName(s, to));
    if (!name) {
      ctx.log.warn("clickup status move skipped: the task's list has no such status", meta);
      return;
    }
    if (!(await ctx.isCurrent())) return skip("restarted");
    try {
      await this.client.setStatus(clickupTaskId, name, ctx.signal);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 400)) throw err;
      ctx.log.warn("clickup status move refused", { ...meta, status: err.status });
    }
  }

  // Posts `markdown` as up to three comments. Only a failure of the first part
  // may be retried: once a part is on the task, a retry would post it again.
  private async post(ctx: SendCtx, taskId: string, markdown: string): Promise<void> {
    const comments = markdownToComments(markdown);
    for (const [i, comment] of comments.entries()) {
      try {
        await this.client.addComment(taskId, comment, ctx.signal);
      } catch (err) {
        this.statusService.recordReplyFailure(err);
        if (i === 0) throw retryable(err) ?? err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`ClickUp reply part ${i + 1} of ${comments.length} failed: ${msg}`);
      }
    }
  }
}

// The notice for a failed task or round, by cause and round kind, naming the
// bot so people know whom to assign again or mention. A crashed comment
// round's raw detail is never posted; a failed assignment shows the harness's
// user-safe summary.
function failureText(m: Extract<Outbound, { type: "failure" }>, bot: string): string | undefined {
  const assignment = m.round.kind === "assignment";
  switch (m.cause) {
    case "task_failed":
      return assignment
        ? `devbox couldn't finish this task. To start over, remove ${bot} from the assignees and assign it again; this opens a new pull request.`
        : `devbox couldn't finish this. Comment with @${bot} to retry.`;
    case "workspace_missing":
      return `This task's workspace was cleaned up, so devbox can't continue it. Remove ${bot} from the assignees and assign it again to start over.`;
    case "round_failed":
      return assignment
        ? m.summary
        : `⚠️ Something went wrong while working on this. Comment with @${bot} to retry.`;
  }
}

// ClickUp status names match in any case.
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
