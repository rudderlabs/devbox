import { describe, expect, it, mock, spyOn } from "bun:test";
import type { Task } from "../../db/schema";
import { fakeIntegrations } from "../../integrations/__tests__/fakeIntegrations";
import type { HookCtx, Integration } from "../../integrations/types";
import type { InboxRepository, InboxRow } from "../../repositories/inbox.repository";

const { IntegrationHooks } = await import("../integrationHooks");
const { BackgroundWork } = await import("../backgroundWork");
const { RetryableError } = await import("../../integrations/outbound");
const { logger } = await import("../../logger");

const task = { id: "task-1", source: "linear" } as Task;
const row = (id: string, kind = "assignment", source = "linear") =>
  ({
    id,
    kind,
    source,
    reply_targets: [{ id: "sess-1", spec: { kind: "linear_session" } }],
  }) as unknown as InboxRow;
const noop: Integration = {
  async deliver() {},
  async status() {
    return {};
  },
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Hooks over enabled linear and github integrations, or with linear disabled
// (no instance) when `linear` is null.
function hooksWith(
  linear: Partial<Integration> | null,
  github: Partial<Integration> = {},
  timeoutMs?: number,
) {
  const inboxRepo = { getAssignment: mock(() => Promise.resolve(row("a-1"))) };
  const integrations: Record<string, Integration> = fakeIntegrations({
    linear: { ...noop, ...linear },
    github: { ...noop, ...github },
  });
  if (linear === null) delete integrations.linear;
  const t = timeoutMs;
  const timeouts =
    t === undefined
      ? undefined
      : { onTaskStarted: t, onPrOpened: t, onRoundFinished: t, assignee: t };
  const background = new BackgroundWork();
  return {
    hooks: new IntegrationHooks(
      integrations,
      inboxRepo as unknown as InboxRepository,
      background,
      timeouts,
    ),
    inboxRepo,
    background,
  };
}

describe("IntegrationHooks", () => {
  it("never throws: a failing hook is logged and yields undefined", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      const { hooks } = hooksWith({
        assignee: () => Promise.reject(new RetryableError("token fetch failed")),
      });
      expect(await hooks.assignee(task, row("a-1"), { prUrl: "u" })).toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        "assignee hook failed",
        expect.objectContaining({ taskId: "task-1", integration: "linear" }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("skips a disabled integration's hooks as it does a missing hook: no lookup, no log, never held", async () => {
    const logs = (["info", "warn", "error"] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => logger),
    );
    try {
      const { hooks, inboxRepo, background } = hooksWith(null);
      const pr = { url: "u", repo: "r", branch: "b" };
      expect(await hooks.assignee(task, row("a-1"), {})).toBeUndefined();
      expect(await hooks.prOpened(task, row("a-1"), pr, true)).toBeUndefined();
      await hooks.taskStarted(task, row("a-1"));
      hooks.roundFinished(task, row("a-1"), "completed", true);
      await background.drain(Promise.resolve());
      expect(inboxRepo.getAssignment).not.toHaveBeenCalled();
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  it("onPrOpened alone lets a RetryableError escape, so pr_opened holds", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      const pr = { url: "u", repo: "r", branch: "b" };
      const retry = hooksWith({ onPrOpened: () => Promise.reject(new RetryableError("429")) });
      await expect(retry.hooks.prOpened(task, row("a-1"), pr, true)).rejects.toThrow("429");
      const other = hooksWith({ onPrOpened: () => Promise.reject(new Error("HTTP 500")) });
      expect(await other.hooks.prOpened(task, row("a-1"), pr, true)).toBeUndefined();
    } finally {
      error.mockRestore();
    }
  });

  it("cuts a hung hook at its timeout: the call resolves and the hook's signal aborts", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      let signal: AbortSignal | undefined;
      const { hooks } = hooksWith(
        {
          assignee: (ctx) => {
            signal = ctx.signal;
            return new Promise<never>(() => {});
          },
        },
        {},
        20,
      );
      expect(await hooks.assignee(task, row("a-1"), {})).toBeUndefined();
      expect(signal?.aborted).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("a failed assignment lookup still runs the hook, with isCurrent() false", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      let ctx: HookCtx | undefined;
      const { hooks, inboxRepo } = hooksWith({
        async assignee(c) {
          ctx = c;
          return null;
        },
      });
      inboxRepo.getAssignment.mockRejectedValue(new Error("connection reset"));
      expect(await hooks.assignee(task, row("c-1", "comment"), {})).toBeNull();
      expect(await ctx?.isCurrent()).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it("isCurrent() turns false once a restart rotated the assignment id", async () => {
    let ctx: HookCtx | undefined;
    const { hooks, inboxRepo } = hooksWith({
      async assignee(c) {
        ctx = c;
        return null;
      },
    });
    // A comment round: the baseline is the task's assignment id at hook start.
    await hooks.assignee(task, row("c-1", "comment"), {});
    expect(await ctx?.isCurrent()).toBe(true);
    inboxRepo.getAssignment.mockResolvedValue(row("a-2"));
    expect(await ctx?.isCurrent()).toBe(false);
  });

  it("onTaskStarted runs on each fresh-provision attempt, with the assignment's first target", async () => {
    const onTaskStarted = mock((_ctx: HookCtx, _task: Task, _target: unknown) => Promise.resolve());
    const { hooks, inboxRepo } = hooksWith({ onTaskStarted });
    // A deferred provision retries the same assignment.
    await hooks.taskStarted(task, row("a-1"));
    await hooks.taskStarted(task, row("a-1"));
    expect(onTaskStarted).toHaveBeenCalledTimes(2);
    expect(onTaskStarted.mock.calls.map((c) => c[2])).toEqual([
      { id: "sess-1", spec: { kind: "linear_session" } },
      { id: "sess-1", spec: { kind: "linear_session" } },
    ]);
    // The caller hands in the assignment row: no lookup of its own.
    expect(inboxRepo.getAssignment).not.toHaveBeenCalled();
  });

  it("onRoundFinished routes by round.source; drain logs hook_abandoned for what is still running", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const finished: string[] = [];
      const record = async (_ctx: unknown, _task: Task, round: InboxRow) => {
        finished.push(round.id);
      };
      const { hooks, background } = hooksWith(
        // Outlives the drain deadline below.
        { onRoundFinished: (ctx, t, round) => sleep(200).then(() => record(ctx, t, round)) },
        { onRoundFinished: record },
      );
      hooks.roundFinished(task, row("gh-1", "review", "github"), null, true);
      hooks.roundFinished(task, row("a-1"), "failed", true);
      await background.drain(sleep(50));

      expect(finished).toEqual(["gh-1"]);
      expect(warn.mock.calls).toEqual([
        [
          "hook abandoned at shutdown",
          { event: "hook_abandoned", taskId: "task-1", hook: "onRoundFinished" },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
