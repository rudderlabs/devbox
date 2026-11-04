import { type LinearClient, LinearError, RatelimitedLinearError } from "@linear/sdk";
import type { Context } from "hono";
import { getUserById } from "../../clients/github";
import {
  attachUrlToIssue,
  emitAction,
  emitError,
  emitResponse,
  emitThought,
  getIssueHumanAssignee,
  setIssueStarted,
  uploadIssueAttachment,
} from "../../clients/linear";
import { LinearTokenError } from "../../clients/linearOauth";
import type { Task } from "../../db/schema";
import { rateLimitWaitMs, retryable } from "../http";
import {
  type Outbound,
  RetryableError,
  type SendCtx,
  WORKSPACE_MISSING_MESSAGE,
} from "../outbound";
import type {
  HookCtx,
  Integration,
  IntegrationDefinition,
  Person,
  PrRef,
  ReplyTarget,
  Round,
} from "../types";
import { AgentSessionService } from "./agentSession";
import { type LinearConfig, parseLinearConfig } from "./config";
import { type LinearStatus, LinearStatusService } from "./status";
import { LinearTokenProvider } from "./tokenProvider";
import { LinearWebhookController } from "./webhook";

export const linear: IntegrationDefinition<LinearConfig> = {
  name: "linear",
  createsTasks: true,
  parseConfig: parseLinearConfig,
  create(core, cfg) {
    const tokenProvider = new LinearTokenProvider({
      creds: { clientId: cfg.clientId, clientSecret: cfg.clientSecret },
      log: core.log,
    });
    const status = new LinearStatusService(tokenProvider, core.log);
    const controller = new LinearWebhookController(
      new AgentSessionService(core.tasks, tokenProvider, core.log),
      cfg.webhookSecret,
      core.log,
      (at) => status.recordWebhook(at),
    );
    return new LinearIntegration(tokenProvider, status, controller);
  },
  disabledStatus: () => ({ configured: false }),
};

// Linear rounds post to the agent session. target.id IS the agent session id
// by construction (the enqueue paths stamp the live session id). The session
// is private to the workspace, so a failure shows its raw detail.
export class LinearIntegration implements Integration {
  constructor(
    private linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">,
    private statusService: Pick<LinearStatusService, "status">,
    private controller: Pick<LinearWebhookController, "handleWebhook">,
  ) {}

  // Today's responses, including 503 session_not_found when a prompt arrives
  // before its session (Linear retries). The controller holds its TaskService.
  webhook(c: Context): Promise<Response> {
    return this.controller.handleWebhook(c);
  }

  status(): Promise<LinearStatus> {
    return this.statusService.status();
  }

  async deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void> {
    if (target.spec.kind !== "linear_session") {
      throw new Error(`linear cannot deliver to a ${target.spec.kind} target`);
    }
    const client = await this.client(ctx.signal);
    // Each message is one activity (one request), so a retryable failure means
    // nothing was posted.
    try {
      switch (message.type) {
        case "reply":
          await emitResponse(client, target.id, message.body);
          return;
        case "progress":
          if (message.kind === "thought") await emitThought(client, target.id, message.body);
          // The daemon's body is the full action label (e.g. "Planning",
          // "Addressing comment"). Linear renders `<action> <parameter>`
          // concatenated, so a non-empty parameter appends a noisy suffix
          // ("Addressing comment task"). Pass empty parameter — the body
          // already carries everything the user should see.
          else if (message.kind === "action") await emitAction(client, target.id, message.body, "");
          else await emitError(client, target.id, message.body);
          return;
        case "failure": {
          // task_failed and a failed assignment carry the summary; a crashed
          // comment round carries only the detail.
          const text =
            message.cause === "workspace_missing"
              ? WORKSPACE_MISSING_MESSAGE
              : (message.summary ?? message.detail);
          if (text) await emitError(client, target.id, text);
          return;
        }
        default: {
          const _exhaustive: never = message;
          void _exhaustive;
        }
      }
    } catch (err) {
      throw linearRetryable(err) ?? err;
    }
  }

  // A fresh provision: moves the issue to its team's started state, then shows
  // "Provisioning" on the session. Each is best-effort; a team without a
  // started state still gets the action.
  async onTaskStarted(ctx: HookCtx, task: Task, target: ReplyTarget): Promise<void> {
    const client = await this.client(ctx.signal);
    await setIssueStarted(client, task.externalId).catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.log.error(`setIssueStarted failed for task ${task.id}`, {
        message: e.message,
        stack: e.stack,
      });
    });
    await emitAction(client, target.id, "Provisioning", "infra");
  }

  // Links the PR on the issue. Idempotent (Linear updates an existing link),
  // so it runs on every pr_opened dispatch; a RetryableError holds the event.
  async onPrOpened(ctx: HookCtx, task: Task, pr: PrRef): Promise<void> {
    const client = await this.client(ctx.signal);
    try {
      await attachUrlToIssue(client, task.externalId, pr.url, pr.repo);
    } catch (err) {
      throw linearRetryable(err) ?? err;
    }
  }

  // Uploads the run archive to the issue once, when this call finished the
  // assignment (a replayed `completed` doesn't upload again). The sandbox is
  // still alive here (it lives until the idle reaper). The archive is a
  // forensic nicety: core logs a failure and nothing else depends on it.
  async onRoundFinished(
    ctx: HookCtx & { firstTransition: boolean; archive(): Promise<Uint8Array | null> },
    task: Task,
    round: Round,
  ): Promise<void> {
    if (!ctx.firstTransition || round.kind !== "assignment") return;
    const bytes = await ctx.archive();
    if (!bytes || bytes.byteLength === 0) return;
    const client = await this.client(ctx.signal);
    await uploadIssueAttachment(client, {
      issueId: task.externalId,
      title: "Harness run archive",
      subtitle: `Task ${task.id}`,
      filename: `harness-run-${task.id}.tar.gz`,
      contentType: "application/gzip",
      bytes,
      metadata: { taskId: task.id },
      signal: ctx.signal,
    });
  }

  // The issue's human assignee. Identity comes from Linear's own user↔GitHub
  // mapping (User.gitHubUserId, set when a member connects GitHub under Linear
  // Settings → Connected accounts), never email matching.
  async assignee(ctx: HookCtx, task: Task): Promise<Person | null> {
    const client = await this.client(ctx.signal);
    const human = await getIssueHumanAssignee(client, task.externalId);
    if (!human) return null;
    const person = { id: human.id, displayName: human.displayName, email: human.email };
    if (!human.gitHubUserId) return { ...person, codeHost: "unlinked" };
    // Defensive about the field's format: numeric → GitHub account id
    // (resolve to the current login), anything else → already a login.
    const githubLogin = /^\d+$/.test(human.gitHubUserId)
      ? (await getUserById(human.gitHubUserId, ctx.signal)).login
      : human.gitHubUserId;
    return { ...person, codeHost: { githubLogin } };
  }

  // A per-call client: the signal bounds this send's requests only. Nothing
  // has been sent when the token request fails; see linearRetryable.
  private async client(signal: AbortSignal): Promise<LinearClient> {
    try {
      return await this.linearTokenProvider.getAuthorizedLinearClient(signal);
    } catch (err) {
      throw linearRetryable(err) ?? err;
    }
  }
}

// The SDK wraps every failure in a LinearError whose `raw` is what fetch (or
// the token renewal after a 401) threw. A rate limit is the SDK's
// RatelimitedLinearError: an HTTP 429 or a "ratelimited" GraphQL error, with
// Retry-After in seconds. Without it, the wait runs to the later of Linear's
// request and complexity reset times (epoch ms), and at least a minute.
// A failed token request is retried only when it is transient. A rejected
// client, secret or grant won't fix itself, so it is thrown as is: the caller
// logs it as an error and drops the send instead of holding every reply.
function linearRetryable(err: unknown): RetryableError | undefined {
  if (err instanceof RatelimitedLinearError) {
    const s = err.retryAfter;
    const wait =
      s !== undefined && s >= 0
        ? s * 1000
        : rateLimitWaitMs(Math.max(err.requestsResetAt ?? 0, err.complexityResetAt ?? 0));
    return new RetryableError(err.message, wait);
  }
  const cause = err instanceof LinearError ? err.raw : err;
  if (cause instanceof LinearTokenError) {
    return cause.transient
      ? new RetryableError(`Linear token fetch failed: ${cause.message}`)
      : undefined;
  }
  return retryable(cause);
}
