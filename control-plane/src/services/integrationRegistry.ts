import type { Context } from "hono";
import type { Task } from "../db/schema";
import { SEND_TIMEOUT_MS, TimeoutError, withTimeout } from "../integrations/http";
import { type Outbound, RetryableError } from "../integrations/outbound";
import type {
  Env,
  HookCtx,
  Integration,
  IntegrationDefinition,
  Outcome,
  Person,
  PrRef,
  ReplyTarget,
  Round,
  TaskService,
} from "../integrations/types";
import { logger } from "../logger";
import type { BackgroundWork } from "./backgroundWork";
import type { ReplyHolds } from "./replyHolds";
import { BoundTaskService } from "./task.service";

// Upper bound on one call into an integration.
export const TIMEOUT_MS = {
  deliver: SEND_TIMEOUT_MS,
  onTaskStarted: 20_000,
  onPrOpened: 30_000,
  onRoundFinished: 120_000,
  assignee: 15_000,
};
type HookName = Exclude<keyof typeof TIMEOUT_MS, "deliver">;

// Every integration's settings by name; undefined means off. index.ts calls
// this before running migrations, so a bad setting fails boot before the
// database is touched.
export function parseIntegrationConfigs(
  definitions: readonly IntegrationDefinition[],
  env: Env,
): Map<string, unknown> {
  return new Map(definitions.map((d) => [d.name, d.parseConfig(env)]));
}

// What every TaskService shares; the registry binds each to its integration.
type TaskServiceDeps = Omit<ConstructorParameters<typeof BoundTaskService>[1], "createsTasks">;

type DeliverResult = "ok" | "dropped" | "timed_out";

// An integration as core calls it. Each call runs under its timeout with an
// abort signal. A failure is logged and the caller goes on, except a
// RetryableError (nothing was sent) from deliver or onPrOpened, which escapes
// so the caller can hold the event. runId is the assignment id of the run the
// call belongs to, or null when there is none; the hook's isCurrent() compares
// it with the task's assignment id when the hook asks. deliver and
// onRoundFinished go to the round's own integration (round.source), whichever
// name they were looked up by, so a round can't reach another integration.
export type WrappedIntegration = {
  // One message for one of the round's targets: "timed_out" when it ran out
  // of time, "dropped" when it failed for good (both logged). An unknown or
  // disabled integration's send is skipped (logged) and counts as sent.
  deliver(
    round: Round,
    target: ReplyTarget,
    message: Outbound,
    meta: Record<string, unknown>,
  ): Promise<DeliverResult>;
  // A fresh provision, on every attempt, before the sandbox is created.
  onTaskStarted(task: Task, assignment: Round): Promise<void>;
  // pr_opened, after appendPrUrl; the dispatcher holds a RetryableError.
  onPrOpened(task: Task, runId: string | null, pr: PrRef, firstTime: boolean): Promise<void>;
  // In BackgroundWork, so it never blocks the caller.
  onRoundFinished(
    task: Task,
    round: Round,
    runId: string | null,
    outcome: Outcome | null,
    firstTransition: boolean,
    archive?: () => Promise<Uint8Array | null>,
  ): void;
  // undefined when the integration has no assignee, is off, or the lookup
  // failed (logged with `meta`).
  assignee(task: Task, meta: Record<string, unknown>): Promise<Person | null | undefined>;
};

// The only record of which integrations exist. It builds one TaskService per
// integration, bound to its name and its createsTasks. Each enabled
// integration is created once with its own; a disabled one has no instance,
// answers its status with disabledStatus(), and core's calls to it are
// skipped.
export class IntegrationRegistry {
  // The sources whose tasks are claimed and reconciled: every integration that
  // creates tasks, on or off, so a disabled integration's open tasks keep
  // running.
  readonly taskSources: string[];
  // The enabled integrations by name. Core reaches them only through for(),
  // webhooks(), status() and prMentionLogin().
  private readonly live: Readonly<Record<string, Integration>>;
  private readonly definitions = new Map<string, IntegrationDefinition>();
  private readonly taskServices = new Map<string, TaskService>();
  private readonly holds: Pick<ReplyHolds, "of">;
  private readonly background: Pick<BackgroundWork, "track">;
  private readonly inboxRepo: TaskServiceDeps["inboxRepo"];
  private readonly timeoutsMs: typeof TIMEOUT_MS;

  constructor(
    definitions: readonly IntegrationDefinition[],
    configs: ReadonlyMap<string, unknown>,
    deps: TaskServiceDeps & { holds: Pick<ReplyHolds, "of"> },
    // Tests shorten them.
    timeoutsMs: Partial<typeof TIMEOUT_MS> = {},
  ) {
    this.timeoutsMs = { ...TIMEOUT_MS, ...timeoutsMs };
    const { holds, ...shared } = deps;
    this.holds = holds;
    this.background = shared.background;
    this.inboxRepo = shared.inboxRepo;
    for (const def of definitions) {
      if (this.definitions.has(def.name)) {
        throw new Error(`integration ${def.name} is registered twice`);
      }
      this.definitions.set(def.name, def);
      this.taskServices.set(
        def.name,
        new BoundTaskService(def.name, { ...shared, createsTasks: def.createsTasks }),
      );
    }
    this.taskSources = definitions.filter((d) => d.createsTasks).map((d) => d.name);
    const live: Record<string, Integration> = {};
    for (const def of definitions) {
      const cfg = configs.get(def.name);
      if (cfg === undefined) continue;
      live[def.name] = def.create({ tasks: this.tasks(def.name), log: logger }, cfg);
    }
    this.live = live;
  }

  // The TaskService bound to `name`: the one its integration was given.
  tasks(name: string): TaskService {
    const tasks = this.taskServices.get(name);
    if (!tasks) throw new Error(`no integration is named ${name}`);
    return tasks;
  }

  // The integration named `name` (a task's or a round's source), wrapped.
  for(name: string): WrappedIntegration {
    return {
      deliver: (round, target, message, meta) => this.deliver(round, target, message, meta),
      onTaskStarted: async (task, assignment) => {
        const target = assignment.reply_targets[0];
        if (!target) return;
        await this.hook(name, "onTaskStarted", task, assignment.id, (ctx, i) =>
          i.onTaskStarted?.(ctx, task, target),
        );
      },
      onPrOpened: async (task, runId, pr, firstTime) => {
        await this.hook(name, "onPrOpened", task, runId, (ctx, i) =>
          i.onPrOpened?.({ ...ctx, firstTime }, task, pr),
        );
      },
      onRoundFinished: (task, round, runId, outcome, firstTransition, archive = async () => null) =>
        this.background.track(
          task.id,
          "onRoundFinished",
          this.hook(round.source, "onRoundFinished", task, runId, (ctx, i) =>
            i.onRoundFinished?.({ ...ctx, firstTransition, archive }, task, round, outcome),
          ),
        ),
      assignee: (task, meta) =>
        this.hook(name, "assignee", task, null, (ctx, i) => i.assignee?.(ctx, task), meta),
    };
  }

  // The login @-mentions on devbox's PRs go to, while an enabled integration
  // takes them.
  prMentionLogin(): string | undefined {
    return Object.values(this.live).find((i) => i.prMentionLogin)?.prMentionLogin;
  }

  // The enabled integrations that take webhooks.
  webhooks(): { name: string; webhook(c: Context): Promise<Response> }[] {
    return Object.entries(this.live).flatMap(([name, i]) =>
      i.webhook ? [{ name, webhook: i.webhook.bind(i) }] : [],
    );
  }

  // An integration's status body plus its held sends; undefined for a name no
  // integration has.
  status(name: string): Promise<object> | undefined {
    const def = this.definitions.get(name);
    if (!def) return undefined;
    const live = this.live[name];
    return (async () => ({
      ...(live ? await live.status() : def.disabledStatus()),
      holds: this.holds.of(name),
    }))();
  }

  private async deliver(
    round: Round,
    target: ReplyTarget,
    message: Outbound,
    meta: Record<string, unknown>,
  ): Promise<DeliverResult> {
    const log = { ...meta, inboxId: round.id, source: round.source, targetId: target.id };
    // A source this build doesn't know (rows written by a newer build before
    // a rollback) or a disabled integration has no instance.
    const live: Integration | undefined = this.live[round.source];
    if (!live) {
      logger.info(`${message.type} skipped: integration unknown or disabled`, log);
      return "ok";
    }
    try {
      await withTimeout(this.timeoutsMs.deliver, (signal) =>
        live.deliver({ signal, log: logger }, target, message),
      );
      return "ok";
    } catch (err) {
      if (err instanceof RetryableError) throw err;
      logErr(`deliver ${message.type} failed`, err, log);
      return err instanceof TimeoutError ? "timed_out" : "dropped";
    }
  }

  // Runs one of `name`'s hooks. A disabled integration, like one without
  // that hook, is skipped without a log line: core can't tell which hooks a
  // disabled one has.
  private async hook<T>(
    name: string,
    hook: HookName,
    task: Task,
    runId: string | null,
    run: (ctx: HookCtx, live: Integration) => Promise<T> | undefined,
    logMeta: Record<string, unknown> = {},
  ): Promise<T | undefined> {
    const live: Integration | undefined = this.live[name];
    if (!live?.[hook]) return undefined;
    const meta = { ...logMeta, taskId: task.id, integration: name };
    // false once a restart re-pended the assignment under a new id, and when
    // the task's assignment id can't be read.
    const isCurrent = async () => {
      if (!runId) return false;
      try {
        return (await this.inboxRepo.getAssignment(task.id))?.id === runId;
      } catch (err) {
        logErr(`${hook}: assignment lookup failed; isCurrent() is false`, err, meta);
        return false;
      }
    };
    try {
      return await withTimeout(this.timeoutsMs[hook], async (signal) =>
        run({ signal, log: logger, isCurrent }, live),
      );
    } catch (err) {
      if (hook === "onPrOpened" && err instanceof RetryableError) throw err;
      logErr(`${hook} hook failed`, err, meta);
      return undefined;
    }
  }
}

function logErr(msg: string, err: unknown, meta: Record<string, unknown>): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(msg, { ...meta, message: e.message, stack: e.stack });
}
