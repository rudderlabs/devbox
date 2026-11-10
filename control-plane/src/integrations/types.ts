import type { Context } from "hono";
import type { Task } from "../db/schema";
import type { logger } from "../logger";
import type { InboxRow, ReplyTarget } from "../repositories/inbox.repository";
import type { TaskService } from "../services/task.service";
import type { Outbound, SendCtx } from "./outbound";

// What an integration module may use from core, besides ./outbound, ./http
// and ./env. Its TaskService is bound to its own name.
export type { InboxRow as Round, ReplyTarget } from "../repositories/inbox.repository";
export type { TaskService } from "../services/task.service";
export type Env = Record<string, string | undefined>;
export type Logger = typeof logger;

// One per integration module; integrations/index.ts lists them all.
export interface IntegrationDefinition<C = unknown> {
  // The source of its tasks and rounds, POST /webhook/<name> and
  // GET /api/integrations/<name>. Stored in tasks.source and inbox.source, so
  // never renamed.
  name: string;
  // Whether it creates tasks. Only then may it assign and restart tasks
  // through its TaskService, and its tasks are claimed and reconciled, even
  // while it is off.
  createsTasks: boolean;
  // Its settings, or undefined when it is off. Throws on a bad value, which
  // fails boot before migrations run.
  parseConfig(env: Env): C | undefined;
  // Called once at startup, only when it is on.
  create(core: Core, cfg: C): Integration;
  // GET /api/integrations/<name> while it is off.
  disabledStatus(): object;
}

// What core hands an integration: its own TaskService and the logger.
export type Core = { tasks: TaskService; log: Logger };

// An enabled integration. A disabled one has no instance: core skips its
// webhook, sends and hooks (a skipped send counts as sent, never held).
export interface Integration {
  // Incoming. Core mounts POST /webhook/<name> (404 for any other name),
  // behind the shared body limit and raw-body read.
  webhook?(c: Context): Promise<Response>;

  // Outgoing. Core labels each message; the integration decides where (or
  // whether) it shows up. Throws RetryableError only before anything was sent.
  deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void>;

  // Lifecycle hooks. Core calls each through the registry, which applies its
  // timeout and abort signal and logs a failure (services/integrationRegistry.ts).
  // Before each fresh-provision attempt: a deferred provision calls it again,
  // so it must be safe to repeat.
  onTaskStarted?(ctx: HookCtx, task: Task, target: ReplyTarget): Promise<void>;
  // The agent opened a pull request. Two integrations hear of it, each in its
  // own role:
  // - the task's own, after the PR is recorded on the task and on every
  //   dispatch of the event (firstTime is false on a replay): Linear links the
  //   PR on its issue. Its RetryableError holds the event.
  // - the one whose code host the PR is on (its hostsPr says so), once, before
  //   the PR is recorded, with firstTime true: there it does what the host
  //   wants on a new PR. GitHub posts its onboarding comment and, in the
  //   background, assigns the PR to the task's person; GitLab posts its
  //   note. Best-effort: a failure is logged and nothing is held. A crash
  //   before the record repeats it.
  onPrOpened?(ctx: PrOpenedCtx, task: Task, pr: PrRef): Promise<void>;
  // Whether `url` is a pull request on this integration's code host. Only a
  // code host's integration has it; core then calls its onPrOpened for each
  // new one. An integration that is off has no instance, so its host's pull
  // requests get nothing.
  hostsPr?(url: string): boolean;
  onRoundFinished?(
    ctx: HookCtx & { firstTransition: boolean; archive(): Promise<Uint8Array | null> },
    task: Task,
    round: InboxRow,
    outcome: Outcome | null,
  ): Promise<void>;
  assignee?(ctx: HookCtx, task: Task): Promise<Person | null>; // throws when the lookup itself fails

  // Health. Core serves GET /api/integrations/<name> (behind API auth, only
  // when the API is enabled) with this body plus the integration's held sends.
  status(): Promise<object>;
}

// isCurrent() is false once a restart rotated the task's assignment id, when
// that id can't be read, and in assignee(), which belongs to no run. It reads
// the id on each call.
export type HookCtx = { signal: AbortSignal; log: Logger; isCurrent(): Promise<boolean> };
export type PrOpenedCtx = HookCtx & {
  firstTime: boolean;
  // The task's person, asked of the task's own integration (its assignee()),
  // which an integration can't call itself. undefined: that integration has
  // no assignee() (API tasks), or the lookup failed (logged). null: no human
  // is assigned.
  person(): Promise<Person | null | undefined>;
  // Work that must not hold up the tick: core keeps track of it instead of
  // waiting, and shutdown waits for it until its deadline. Nothing reads its
  // result; a rejection is logged. The hook's signal is no use to it (it
  // never fires once the hook has returned), so the work bounds itself.
  background(work: Promise<unknown>): void;
};
export type Person = {
  id: string; // the platform account id: logs carry it, never the name or email
  displayName: string;
  email?: string;
  // The GitHub account the platform links to this person: a numeric account
  // id or a login. null: the platform links accounts but this person hasn't.
  // Absent: the platform can't link accounts. The GitHub integration resolves it.
  githubAccount?: string | null;
};
export type PrRef = { url: string; repo: string; branch: string };
export type Outcome = "completed" | "partial_failure" | "no_action" | "failed";
