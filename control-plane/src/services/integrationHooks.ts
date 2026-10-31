import type { Task } from "../db/schema";
import { withTimeout } from "../integrations/http";
import { RetryableError } from "../integrations/outbound";
import type {
  HookCtx,
  Integration,
  IntegrationName,
  Outcome,
  Person,
  PrRef,
} from "../integrations/types";
import { logger } from "../logger";
import type { InboxRepository, InboxRow } from "../repositories/inbox.repository";

// Upper bound on one hook call.
const HOOK_TIMEOUT_MS = {
  onTaskStarted: 20_000,
  onPrOpened: 30_000,
  onRoundFinished: 120_000,
  assignee: 15_000,
} as const;
type HookName = keyof typeof HOOK_TIMEOUT_MS;
// What a detached promise is doing, for the shutdown log.
type DetachedWork = HookName | "killSandbox" | "slack";

// Runs integrations' lifecycle hooks. onTaskStarted, onPrOpened and
// assignee go to the task's own integration; onRoundFinished goes to the
// round's. A disabled integration's hooks are skipped (logged). Each call runs
// under its hook's timeout with an abort signal and never throws: a failure is
// logged and the caller goes on. The one exception
// is a RetryableError from onPrOpened, which escapes so the dispatcher holds
// pr_opened as it holds a send (the hook must be idempotent). Detached work is
// tracked so TaskProcessor.stop() can drain it.
export class IntegrationHooks {
  private readonly detached = new Map<Promise<void>, { taskId: string; hook: DetachedWork }>();
  // Assignment ids whose onTaskStarted already ran on this pod: a provision
  // deferred by a transient error runs again for the same assignment.
  // ponytail: one id per started task for the pod's lifetime; prune if that ever matters.
  private readonly started = new Set<string>();

  constructor(
    private integrations: Record<IntegrationName, Integration>,
    private inboxRepo: Pick<InboxRepository, "getAssignment">,
    private timeoutsMs: Record<HookName, number> = HOOK_TIMEOUT_MS,
  ) {}

  // Fresh provision, before the sandbox is created. Awaited; no hold.
  async taskStarted(task: Task): Promise<void> {
    const owner = this.integrations[task.source];
    if (!owner.onTaskStarted) return;
    const round = await this.inboxRepo.getAssignment(task.id).catch((err) => {
      logErr("onTaskStarted skipped: assignment lookup failed", err, { taskId: task.id });
      return null;
    });
    const target = round?.reply_targets[0];
    if (!round || !target || this.started.has(round.id)) return;
    this.started.add(round.id);
    await this.callHook("onTaskStarted", owner, task, round, (ctx) =>
      owner.onTaskStarted?.(ctx, task, target),
    );
  }

  // pr_opened, after appendPrUrl, awaited before the cursor advances. Throws
  // RetryableError (nothing was sent), which the dispatcher turns into a hold.
  async prOpened(task: Task, round: InboxRow | null, pr: PrRef, firstTime: boolean): Promise<void> {
    const owner = this.integrations[task.source];
    await this.callHook("onPrOpened", owner, task, round, (ctx) =>
      owner.onPrOpened?.({ ...ctx, firstTime }, task, pr),
    );
  }

  // The task's assignee, for detached work. undefined when the integration
  // has no assignee, is disabled, or the lookup failed (logged here, with
  // `logMeta`).
  assignee(
    task: Task,
    round: InboxRow | null,
    logMeta: Record<string, unknown>,
  ): Promise<Person | null | undefined> {
    const owner = this.integrations[task.source];
    return this.callHook(
      "assignee",
      owner,
      task,
      round,
      (ctx) => owner.assignee?.(ctx, task),
      logMeta,
    );
  }

  // Detached. Called (a) on `completed`, with firstTransition = whether that
  // call marked the row responded, and (b) when a task failure or a missing
  // workspace dead-letters an assignment row: outcome failed, first
  // transition, no archive. Integrations gate their posts on firstTransition.
  roundFinished(
    task: Task,
    round: InboxRow,
    outcome: Outcome | null,
    firstTransition: boolean,
    archive: () => Promise<Uint8Array | null> = async () => null,
  ): void {
    // A source this build has no integration for (rows written by a newer
    // build before a rollback) has no hook.
    const owner: Integration | undefined = this.integrations[round.source];
    if (!owner?.onRoundFinished) return;
    this.detach(
      task.id,
      "onRoundFinished",
      this.callHook("onRoundFinished", owner, task, round, (ctx) =>
        owner.onRoundFinished?.({ ...ctx, firstTransition, archive }, task, round, outcome),
      ),
    );
  }

  // Tracks detached work (a hook, core work that calls one, or a restart's
  // sandbox kill) for drain().
  detach(taskId: string, hook: DetachedWork, work: Promise<unknown>): void {
    const p: Promise<void> = work
      .then(
        () => {},
        (err) => logErr(`detached ${hook} work failed`, err, { taskId }),
      )
      .finally(() => this.detached.delete(p));
    this.detached.set(p, { taskId, hook });
  }

  // Waits for detached work until `deadline` settles, then logs what is still
  // running; the process exits right after. Work detached meanwhile (say, a
  // restart's sandbox kill from a webhook still being served) is waited for too.
  async drain(deadline: Promise<void>): Promise<void> {
    let expired = false;
    void deadline.then(() => {
      expired = true;
    });
    while (this.detached.size > 0 && !expired) {
      await Promise.race([Promise.allSettled(this.detached.keys()), deadline]);
    }
    for (const { taskId, hook } of this.detached.values()) {
      logger.warn("hook abandoned at shutdown", { event: "hook_abandoned", taskId, hook });
    }
  }

  private async callHook<T>(
    hook: HookName,
    owner: Integration,
    task: Task,
    round: InboxRow | null,
    run: (ctx: HookCtx) => Promise<T> | undefined,
    logMeta: Record<string, unknown> = {},
  ): Promise<T | undefined> {
    if (!owner[hook]) return undefined;
    const meta = { ...logMeta, taskId: task.id, integration: owner.name };
    if (!owner.enabled) {
      logger.info(`${hook} skipped: integration disabled`, meta);
      return undefined;
    }
    try {
      return await withTimeout(this.timeoutsMs[hook], async (signal) => {
        // A failed lookup still runs the hook; isCurrent() then answers false.
        const startedOn = await this.assignmentId(task.id, round).catch((err) => {
          logErr(`${hook}: assignment lookup failed; isCurrent() is false`, err, meta);
          return undefined;
        });
        return run({
          signal,
          log: logger,
          isCurrent: async () =>
            startedOn !== undefined &&
            (await this.assignmentId(task.id).catch(() => undefined)) === startedOn,
        });
      });
    } catch (err) {
      if (hook === "onPrOpened" && err instanceof RetryableError) throw err;
      logErr(`${hook} hook failed`, err, meta);
      return undefined;
    }
  }

  // The task's assignment id: a restart re-pends the assignment row under a
  // new id. When the round in hand is the assignment, its id is that id.
  private async assignmentId(taskId: string, round?: InboxRow | null): Promise<string | null> {
    if (round?.kind === "assignment") return round.id;
    return (await this.inboxRepo.getAssignment(taskId))?.id ?? null;
  }
}

function logErr(msg: string, err: unknown, meta: Record<string, unknown>): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(msg, { ...meta, message: e.message, stack: e.stack });
}
