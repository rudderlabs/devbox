import type { Context } from "hono";
import type { Task, taskSource } from "../db/schema";
import type { logger } from "../logger";
import type { InboxRow, ReplyTarget } from "../repositories/inbox.repository";
import type { ApiTaskSource } from "../types/api";
import type { InboxSource } from "../types/inboxMessage";
import type { TaskIntake } from "./intake";
import type { Outbound, SendCtx } from "./outbound";

type Logger = typeof logger;

// The sources a task can have (the task_source enum).
export type TaskSource = (typeof taskSource.enumValues)[number];
// One per task/round source (InboxSource).
export type IntegrationName = "linear" | "api" | "github";

// Compile-time checks: the literal unions kept where db/schema can't be
// imported (types/api.ts is bundled into the CLI) match what they mirror, so a
// new source fails the build until each is updated.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type SourceChecks = [
  Assert<Equal<InboxSource, IntegrationName>>,
  Assert<Equal<ApiTaskSource, TaskSource>>,
];

export interface Integration<S = unknown> {
  name: IntegrationName;
  // Core never calls webhook, deliver, hooks or assignee of a disabled module:
  // it logs and skips (a skipped send counts as sent, never held).
  enabled: boolean;

  // Incoming. Core mounts POST /webhook/<name> only when enabled (404
  // otherwise), behind the shared body limit and raw-body read.
  webhook?(c: Context, intake: TaskIntake): Promise<Response>;

  // Outgoing. Core labels each message; the integration decides where (or
  // whether) it shows up. Throws RetryableError only before anything was sent.
  deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void>;

  // Lifecycle hooks. Core runs each through IntegrationHooks (catch, log,
  // timeout, abort signal); see services/integrationHooks.ts for where and how.
  onTaskStarted?(ctx: HookCtx, task: Task, target: ReplyTarget): Promise<void>;
  onPrOpened?(ctx: HookCtx & { firstTime: boolean }, task: Task, pr: PrRef): Promise<void>;
  onRoundFinished?(
    ctx: HookCtx & { firstTransition: boolean; archive(): Promise<Uint8Array | null> },
    task: Task,
    round: InboxRow,
    outcome: Outcome | null,
  ): Promise<void>;
  assignee?(ctx: HookCtx, task: Task): Promise<Person | null>; // throws when the lookup itself fails

  // Health. Core serves GET /api/integrations/<name> (behind API auth, only
  // when the API is enabled) with this body plus the integration's held sends.
  status(): Promise<S>;
}

// isCurrent() is false once a restart rotated the task's assignment id.
export type HookCtx = { signal: AbortSignal; log: Logger; isCurrent(): Promise<boolean> };
export type Person = {
  id: string; // the platform account id: logs carry it, never the name or email
  displayName: string;
  email?: string;
  codeHost: { githubLogin: string } | "unlinked" | "unsupported";
};
export type PrRef = { url: string; repo: string; branch: string };
export type Outcome = "completed" | "partial_failure" | "no_action" | "failed";
