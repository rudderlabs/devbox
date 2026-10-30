import type { Task } from "../db/schema";
import type { logger } from "../logger";
import type { InboxRow, ReplyTarget } from "../repositories/inbox.repository";
import type { Outbound, SendCtx } from "./outbound";

type Logger = typeof logger;

// One per task/round source (today's InboxSource).
export type IntegrationName = "linear" | "api" | "github";

export interface Integration {
  name: IntegrationName;

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
