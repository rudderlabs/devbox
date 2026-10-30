import { describe, expect, it, mock, spyOn } from "bun:test";
import type { Task } from "../../db/schema";
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
const noop: Integration = { name: "api", async deliver() {} };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hooksWith(linear: Partial<Integration>, github: Partial<Integration> = {}) {
  const inboxRepo = { getAssignment: mock(() => Promise.resolve(row("a-1"))) };
  const integrations = {
    linear: { ...noop, name: "linear" as const, ...linear },
    api: noop,
    github: { ...noop, name: "github" as const, ...github },
  };
  return {
    hooks: new IntegrationHooks(integrations, inboxRepo as unknown as InboxRepository),
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
      expect(await hooks.assignee(task, row("a-1"))).toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        "assignee hook failed",
        expect.objectContaining({ taskId: "task-1", integration: "linear" }),
      );
    } finally {
      error.mockRestore();
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

  it("isCurrent() turns false once a restart rotated the assignment id", async () => {
    let ctx: HookCtx | undefined;
    const { hooks, inboxRepo } = hooksWith({
      async assignee(c) {
        ctx = c;
        return null;
      },
    });
    // A comment round: the baseline is the task's assignment id at hook start.
    await hooks.assignee(task, row("c-1", "comment"));
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
