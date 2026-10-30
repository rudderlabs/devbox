import { describe, expect, it, mock, spyOn } from "bun:test";
import type { Task } from "../../db/schema";
import { fakeIntegrations } from "../../integrations/__tests__/fakeIntegrations";
import type { HookCtx, Integration } from "../../integrations/types";
import type { InboxRepository, InboxRow } from "../../repositories/inbox.repository";

const { IntegrationHooks } = await import("../integrationHooks");
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
const noop: Integration = { name: "api", enabled: true, async deliver() {}, async status() {} };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hooksWith(
  linear: Partial<Integration>,
  github: Partial<Integration> = {},
  timeoutMs?: number,
) {
  const inboxRepo = { getAssignment: mock(() => Promise.resolve(row("a-1"))) };
  const integrations = fakeIntegrations({
    linear: { ...noop, name: "linear" as const, ...linear },
    github: { ...noop, name: "github" as const, ...github },
  });
  const t = timeoutMs;
  const timeouts =
    t === undefined
      ? undefined
      : { onTaskStarted: t, onPrOpened: t, onRoundFinished: t, assignee: t };
  return {
    hooks: new IntegrationHooks(integrations, inboxRepo as unknown as InboxRepository, timeouts),
    inboxRepo,
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

  it("skips a disabled integration's hooks: logged, never called, never held", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const assignee = mock(() => Promise.resolve(null));
      const onPrOpened = mock(() => Promise.reject(new RetryableError("429")));
      const { hooks } = hooksWith({ enabled: false, assignee, onPrOpened });
      const pr = { url: "u", repo: "r", branch: "b" };
      expect(await hooks.assignee(task, row("a-1"), {})).toBeUndefined();
      expect(await hooks.prOpened(task, row("a-1"), pr, true)).toBeUndefined();
      expect(assignee).not.toHaveBeenCalled();
      expect(onPrOpened).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        "assignee skipped: integration disabled",
        expect.objectContaining({ taskId: "task-1", integration: "linear" }),
      );
    } finally {
      info.mockRestore();
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

  it("onTaskStarted runs at most once per assignment id", async () => {
    const onTaskStarted = mock(() => Promise.resolve());
    const { hooks, inboxRepo } = hooksWith({ onTaskStarted });
    await hooks.taskStarted(task);
    await hooks.taskStarted(task);
    expect(onTaskStarted).toHaveBeenCalledTimes(1);
    // A restart re-pends the assignment under a new id: a new run starts.
    inboxRepo.getAssignment.mockResolvedValue(row("a-2"));
    await hooks.taskStarted(task);
    expect(onTaskStarted).toHaveBeenCalledTimes(2);
  });

  it("drain also waits for work detached while it drains", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const { hooks } = hooksWith({});
      let finished = false;
      hooks.detach(
        "task-1",
        "onRoundFinished",
        sleep(10).then(() =>
          // A webhook still being served restarts a task meanwhile.
          hooks.detach(
            "task-2",
            "killSandbox",
            sleep(20).then(() => {
              finished = true;
            }),
          ),
        ),
      );
      await hooks.drain(sleep(500));

      expect(finished).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("onRoundFinished routes by round.source; drain logs hook_abandoned for what is still running", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const finished: string[] = [];
      const record = async (_ctx: unknown, _task: Task, round: InboxRow) => {
        finished.push(round.id);
      };
      const { hooks } = hooksWith(
        // Outlives the drain deadline below.
        { onRoundFinished: (ctx, t, round) => sleep(200).then(() => record(ctx, t, round)) },
        { onRoundFinished: record },
      );
      hooks.roundFinished(task, row("gh-1", "review", "github"), null, true);
      hooks.roundFinished(task, row("a-1"), "failed", true);
      await hooks.drain(sleep(50));

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
