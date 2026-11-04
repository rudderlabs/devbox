import { afterEach, describe, expect, it, mock, setSystemTime, spyOn } from "bun:test";
import type { Task } from "../../db/schema";
import { fakeDefinitions } from "../../integrations/__tests__/fakeIntegrations";
import type {
  HookCtx,
  Integration,
  IntegrationDefinition,
  ReplyTarget,
  Round,
  TaskService,
} from "../../integrations/types";
import type { InboxRepository } from "../../repositories/inbox.repository";
import type { TaskRepository } from "../../repositories/task.repository";

// The real definitions reach the GitHub client, which reads config at import.
mock.module("../../config", () => ({ config: {} }));

const { IntegrationRegistry, parseIntegrationConfigs, TIMEOUT_MS } = await import(
  "../integrationRegistry"
);
const { ReplyHolds } = await import("../replyHolds");
const { RetryableError } = await import("../../integrations/outbound");
const { definitions } = await import("../../integrations");
const { BackgroundWork } = await import("../backgroundWork");
const { logger } = await import("../../logger");

const none = { heldTasks: 0, oldestHoldAgeMs: 0 };
const integration = (status: object = {}): Integration => ({
  async deliver() {},
  async status() {
    return status;
  },
});
// A definition that records the core it was created with.
const definition = (
  name: string,
  over: Partial<IntegrationDefinition> = {},
): IntegrationDefinition & { created: { tasks: TaskService }[] } => {
  const created: { tasks: TaskService }[] = [];
  return {
    name,
    createsTasks: true,
    parseConfig: (env) => env[name],
    create(core) {
      created.push(core);
      return integration({ name });
    },
    disabledStatus: () => ({ off: name }),
    created,
    ...over,
  };
};
// Records each task the TaskServices assign, with its source.
const assigned: { source: string; key: unknown }[] = [];
const taskRepo = {
  assign: mock((p: { source: string; key: unknown }) => {
    assigned.push({ source: p.source, key: p.key });
    return Promise.resolve({ id: "task-1", key: "K-1", result: "created", prevSandboxId: null });
  }),
} as unknown as TaskRepository;
const registry = (
  defs: IntegrationDefinition[],
  env: Record<string, string> = {},
  holds = new ReplyHolds(),
) =>
  new IntegrationRegistry(defs, parseIntegrationConfigs(defs, env), {
    taskRepo,
    inboxRepo: {} as InboxRepository,
    sandboxManager: {} as never,
    background: { track: () => {} },
    holds,
  });

describe("IntegrationRegistry", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("creates only enabled integrations", async () => {
    const a = definition("a");
    const b = definition("b");
    const r = registry([a, b], { b: "on" });
    expect(await r.status("a")).toEqual({ off: "a", holds: none });
    expect(await r.status("b")).toEqual({ name: "b", holds: none });
    expect(a.created).toHaveLength(0);
    expect(b.created).toHaveLength(1);
  });

  it("bounds each call by default: deliver 20 s, onTaskStarted 20 s, onPrOpened 30 s, onRoundFinished 120 s, assignee 15 s", () => {
    expect(TIMEOUT_MS).toEqual({
      deliver: 20_000,
      onTaskStarted: 20_000,
      onPrOpened: 30_000,
      onRoundFinished: 120_000,
      assignee: 15_000,
    });
  });

  it("builds one TaskService per integration, bound to its name, and hands it to that integration", () => {
    const defs = [definition("a"), definition("b"), definition("c")];
    const r = registry(defs, { a: "on", c: "on" });
    expect(["a", "b", "c"].map((name) => r.tasks(name).source)).toEqual(["a", "b", "c"]);
    expect(defs.map((d) => d.created.map((core) => core.tasks))).toEqual([
      [r.tasks("a")],
      [],
      [r.tasks("c")],
    ]);
    expect(() => r.tasks("d")).toThrow("no integration is named d");
  });

  it("a duplicate name fails", () => {
    expect(() => registry([definition("a"), definition("b"), definition("a")])).toThrow(
      "integration a is registered twice",
    );
  });

  it("task sources are the integrations that create tasks, on or off", () => {
    const r = registry(
      [definition("a"), definition("b", { createsTasks: false }), definition("c")],
      {
        a: "on",
        b: "on",
      },
    );
    expect(r.taskSources).toEqual(["a", "c"]);
  });

  it("webhooks are the enabled integrations that take them", async () => {
    const withWebhook = (name: string) =>
      definition(name, {
        create: () => ({ ...integration(), webhook: async () => new Response(name) }),
      });
    const r = registry([withWebhook("a"), withWebhook("b"), definition("c")], { a: "on", c: "on" });
    const hooks = r.webhooks();
    expect(hooks.map((w) => w.name)).toEqual(["a"]);
    expect(await (await (hooks[0] as (typeof hooks)[0]).webhook({} as never)).text()).toBe("a");
  });

  it("prMentionLogin is the login of an enabled integration that takes @-mentions", () => {
    const mentions = definition("b", {
      create: () => ({ ...integration(), prMentionLogin: "bot" }),
    });
    expect(registry([definition("a"), mentions], { a: "on", b: "on" }).prMentionLogin()).toBe(
      "bot",
    );
    expect(registry([definition("a"), mentions], { a: "on" }).prMentionLogin()).toBeUndefined();
  });

  it("status adds held sends; disabled ones answer disabledStatus(); unknown names have none", async () => {
    const T0 = new Date("2026-10-30T12:00:00Z").getTime();
    const holds = new ReplyHolds();
    setSystemTime(new Date(T0));
    holds.hold("t1", { inbox_id: "i1", seq: 1 }, "github", new RetryableError("HTTP 429"));
    setSystemTime(new Date(T0 + 4_000));
    holds.hold("t2", { inbox_id: "i2", seq: 3 }, "github", new RetryableError("HTTP 429"));
    setSystemTime(new Date(T0 + 5_000));

    const r = registry([definition("linear"), definition("github")], { github: "on" }, holds);
    expect(await r.status("github")).toEqual({
      name: "github",
      holds: { heldTasks: 2, oldestHoldAgeMs: 5_000 },
    });
    expect(await r.status("linear")).toEqual({ off: "linear", holds: none });
    for (const name of ["jira", "constructor"]) expect(r.status(name)).toBeUndefined();
  });
});

describe("parseIntegrationConfigs", () => {
  it("parses each integration's settings and lets a bad one throw", () => {
    const defs = [definition("a"), definition("b")];
    expect(parseIntegrationConfigs(defs, { b: "x" })).toEqual(
      new Map([
        ["a", undefined],
        ["b", "x"],
      ]),
    );
    const bad = definition("c", {
      parseConfig: () => {
        throw new Error("C_ENABLED must be true or false");
      },
    });
    expect(() => parseIntegrationConfigs([...defs, bad], {})).toThrow(
      "C_ENABLED must be true or false",
    );
  });
});

describe("the integrations this build has", () => {
  it("are linear, github and api; linear and api create tasks", () => {
    const r = registry([...definitions]);
    expect(definitions.map((d) => d.name)).toEqual(["linear", "github", "api"]);
    expect(r.taskSources).toEqual(["linear", "api"]);
  });

  it("answer their status bodies while off", async () => {
    const r = registry([...definitions]);
    expect(await r.status("linear")).toEqual({ configured: false, holds: none });
    expect(await r.status("github")).toEqual({
      token: expect.objectContaining({ source: "env" }),
      webhooks: { enabled: false, lastWebhookAt: null, ciResults: false },
      holds: none,
    });
    expect(await r.status("api")).toEqual({ enabled: false, holds: none });
  });

  it("bind each TaskService to its integration; only linear and api may assign and restart", async () => {
    const r = registry([...definitions]);
    assigned.length = 0;
    const assign = (name: string, target: ReplyTarget) =>
      r.tasks(name).assign({
        externalId: "ext-1",
        key: { hint: "K-1" },
        title: "t",
        description: null,
        flags: [],
        url: () => "https://example.com/1",
        target: () => target,
      });
    await assign("linear", { id: "s", spec: { kind: "linear_session" } });
    await assign("api", { id: "s", spec: { kind: "api_session" } });
    expect(assigned.map((a) => a.source)).toEqual(["linear", "api"]);

    const pr = { kind: "issue_comment", owner: "o", repo: "r", prNumber: 1, commentId: 1 } as const;
    await expect(assign("github", { id: "1", spec: pr })).rejects.toThrow(
      "assign: github creates no tasks",
    );
    await expect(
      r.tasks("github").restart("task-1", {
        title: "t",
        description: null,
        flags: [],
        target: { id: "1", spec: pr },
      }),
    ).rejects.toThrow("restart: github creates no tasks");
    expect(assigned).toHaveLength(2);
  });

  it("are on from their own settings", async () => {
    const env = {
      LINEAR_ENABLED: "true",
      LINEAR_CLIENT_ID: "cid",
      LINEAR_CLIENT_SECRET: "csecret",
      LINEAR_WEBHOOK_SECRET: "wsecret",
      GITHUB_WEBHOOKS_ENABLED: "true",
      GITHUB_WEBHOOK_SECRET: "hook",
      GITHUB_BOT_LOGIN: "my-bot",
      GITHUB_BOT_USER_ID: "42",
      GITHUB_TRUSTED_USERS: "alice",
      API_ENABLED: "true",
    };
    // Linear and GitHub take webhooks only while on; the API has none, so its
    // status tells.
    const r = registry([...definitions], env);
    expect(r.webhooks().map((w) => w.name)).toEqual(["linear", "github"]);
    expect(await r.status("api")).toEqual({ enabled: true, holds: none });
    const apiOnly = registry([...definitions], { API_ENABLED: "true" });
    expect(apiOnly.webhooks()).toEqual([]);
    expect(await apiOnly.status("api")).toEqual({ enabled: true, holds: none });
  });
});

// The wrapped integrations core calls through for(), over enabled linear and
// github integrations built from these parts, or with linear off when
// `linear` is null.
const task = { id: "task-1", source: "linear" } as Task;
const row = (id: string, kind = "assignment", source = "linear") =>
  ({
    id,
    kind,
    source,
    reply_targets: [{ id: "sess-1", spec: { kind: "linear_session" } }],
  }) as unknown as Round;
const target: ReplyTarget = { id: "sess-1", spec: { kind: "linear_session" } };
const reply = { type: "reply", body: "hi" } as const;
const pr = { url: "u", repo: "r", branch: "b", github: null };
const noop: Integration = integration();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const HOOKS = ["onTaskStarted", "onPrOpened", "onRoundFinished", "assignee"] as const;

function wrapped(
  linear: Partial<Integration> | null,
  github: Partial<Integration> = {},
  timeoutMs?: number,
) {
  const inboxRepo = { getAssignment: mock(() => Promise.resolve(row("a-1"))) };
  const background = new BackgroundWork();
  const defs = fakeDefinitions({
    linear: linear && { ...noop, ...linear },
    github: { ...noop, ...github },
  });
  const t = timeoutMs;
  const r = new IntegrationRegistry(
    defs,
    parseIntegrationConfigs(defs, {}),
    {
      taskRepo,
      inboxRepo: inboxRepo as unknown as InboxRepository,
      sandboxManager: {} as never,
      background,
      holds: new ReplyHolds(),
    },
    t === undefined
      ? {}
      : { deliver: t, onTaskStarted: t, onPrOpened: t, onRoundFinished: t, assignee: t },
  );
  return { r, inboxRepo, background };
}

describe("IntegrationRegistry.for: deliver", () => {
  it("hands the message to the integration with an abort signal: ok", async () => {
    const deliver = mock((_ctx: unknown, _target: unknown, _message: unknown) => Promise.resolve());
    const { r } = wrapped({ deliver });
    expect(await r.for("linear").deliver(row("a-1"), target, reply, { taskId: "task-1" })).toBe(
      "ok",
    );
    expect(deliver).toHaveBeenCalledWith(
      { signal: expect.any(AbortSignal), log: logger },
      target,
      reply,
    );
  });

  it("an unknown or disabled integration's send is skipped, logged, and counts as sent", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const { r } = wrapped(null);
      const meta = { taskId: "task-1" };
      expect(await r.for("linear").deliver(row("a-1"), target, reply, meta)).toBe("ok");
      expect(await r.for("jira").deliver(row("j-1", "comment", "jira"), target, reply, meta)).toBe(
        "ok",
      );
      expect(info.mock.calls).toEqual([
        [
          "reply skipped: integration unknown or disabled",
          { taskId: "task-1", inboxId: "a-1", source: "linear", targetId: "sess-1" },
        ],
        [
          "reply skipped: integration unknown or disabled",
          { taskId: "task-1", inboxId: "j-1", source: "jira", targetId: "sess-1" },
        ],
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it("any other failure is logged and dropped; a RetryableError is rethrown", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      const meta = { taskId: "task-1", eventType: "agent_response" };
      const failing = wrapped({ deliver: () => Promise.reject(new Error("HTTP 500")) });
      expect(await failing.r.for("linear").deliver(row("a-1"), target, reply, meta)).toBe(
        "dropped",
      );
      expect(error.mock.calls).toEqual([
        [
          "deliver reply failed",
          {
            ...meta,
            inboxId: "a-1",
            source: "linear",
            targetId: "sess-1",
            message: "HTTP 500",
            stack: expect.any(String),
          },
        ],
      ]);

      const held = wrapped({ deliver: () => Promise.reject(new RetryableError("HTTP 429")) });
      await expect(held.r.for("linear").deliver(row("a-1"), target, reply, meta)).rejects.toThrow(
        "HTTP 429",
      );
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});

describe("IntegrationRegistry.for: hooks", () => {
  it("never throws: a failing hook is logged and yields undefined", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      const { r } = wrapped({
        assignee: () => Promise.reject(new RetryableError("token fetch failed")),
      });
      expect(await r.for("linear").assignee(task, { prUrl: "u" })).toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        "assignee hook failed",
        expect.objectContaining({ prUrl: "u", taskId: "task-1", integration: "linear" }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("skips a disabled or unknown integration's hooks as it does a missing hook: no lookup, no log, never held", async () => {
    const logs = (["info", "warn", "error"] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => logger),
    );
    try {
      const { r, inboxRepo, background } = wrapped(null);
      for (const name of ["linear", "jira"]) {
        const off = r.for(name);
        expect(await off.assignee(task, {})).toBeUndefined();
        expect(await off.onPrOpened(task, "a-1", pr, true)).toBeUndefined();
        expect(await off.onTaskStarted(task, row("a-1"))).toBeUndefined();
        off.onRoundFinished(task, row("a-1"), "a-1", "completed", true);
      }
      await background.drain(Promise.resolve());
      expect(inboxRepo.getAssignment).not.toHaveBeenCalled();
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  it("only deliver and onPrOpened let a RetryableError escape, so only they hold", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      const retry = () => Promise.reject(new RetryableError("429"));
      const { r, background } = wrapped({
        deliver: retry,
        onTaskStarted: retry,
        onPrOpened: retry,
        onRoundFinished: retry,
        assignee: retry,
      });
      const linear = r.for("linear");
      await expect(linear.deliver(row("a-1"), target, reply, {})).rejects.toThrow("429");
      await expect(linear.onPrOpened(task, "a-1", pr, true)).rejects.toThrow("429");
      expect(await linear.onTaskStarted(task, row("a-1"))).toBeUndefined();
      expect(await linear.assignee(task, {})).toBeUndefined();
      linear.onRoundFinished(task, row("a-1"), "a-1", null, true);
      await background.drain(sleep(500));
      expect(error.mock.calls.map(([msg]) => msg)).toEqual([
        "onTaskStarted hook failed",
        "assignee hook failed",
        "onRoundFinished hook failed",
      ]);

      // Any other onPrOpened failure is logged and the event goes on.
      const other = wrapped({ onPrOpened: () => Promise.reject(new Error("HTTP 500")) });
      expect(await other.r.for("linear").onPrOpened(task, "a-1", pr, true)).toBeUndefined();
    } finally {
      error.mockRestore();
    }
  });

  it("cuts a hung call at its timeout: the call resolves, the send times out and the signal aborts", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      const signals: Record<string, AbortSignal> = {};
      const hang = (name: string) => (ctx: { signal: AbortSignal }) => {
        signals[name] = ctx.signal;
        return new Promise<never>(() => {});
      };
      const { r, background } = wrapped(
        Object.fromEntries(["deliver", ...HOOKS].map((name) => [name, hang(name)])),
        {},
        20,
      );
      const linear = r.for("linear");
      expect(await linear.deliver(row("a-1"), target, reply, {})).toBe("timed_out");
      expect(await linear.onTaskStarted(task, row("a-1"))).toBeUndefined();
      expect(await linear.onPrOpened(task, "a-1", pr, true)).toBeUndefined();
      expect(await linear.assignee(task, {})).toBeUndefined();
      linear.onRoundFinished(task, row("a-1"), "a-1", null, true);
      await background.drain(sleep(500));

      expect(Object.keys(signals).sort()).toEqual(["deliver", ...HOOKS].sort());
      for (const signal of Object.values(signals)) expect(signal.aborted).toBe(true);
      expect(
        error.mock.calls.map(([msg, meta]) => [msg, (meta as { message: string }).message]),
      ).toEqual([
        ["deliver reply failed", "timed out after 20 ms"],
        ["onTaskStarted hook failed", "timed out after 20 ms"],
        ["onPrOpened hook failed", "timed out after 20 ms"],
        ["assignee hook failed", "timed out after 20 ms"],
        ["onRoundFinished hook failed", "timed out after 20 ms"],
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it("no inbox query unless isCurrent() is called", async () => {
    const { r, inboxRepo, background } = wrapped({
      onTaskStarted: async () => {},
      onPrOpened: async () => {},
      onRoundFinished: async () => {},
      assignee: async () => null,
    });
    const linear = r.for("linear");
    await linear.deliver(row("a-1"), target, reply, {});
    await linear.onTaskStarted(task, row("a-1"));
    await linear.onPrOpened(task, "a-1", pr, true);
    await linear.assignee(task, {});
    linear.onRoundFinished(task, row("c-1", "comment"), "a-1", null, true);
    await background.drain(sleep(500));
    expect(inboxRepo.getAssignment).not.toHaveBeenCalled();
  });

  it("isCurrent() is false when its lookup fails", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    try {
      let ctx: HookCtx | undefined;
      const { r, inboxRepo } = wrapped({
        async onPrOpened(c) {
          ctx = c;
        },
      });
      inboxRepo.getAssignment.mockRejectedValue(new Error("connection reset"));
      await r.for("linear").onPrOpened(task, "a-1", pr, true);
      expect(await ctx?.isCurrent()).toBe(false);
      expect(error).toHaveBeenCalledWith(
        "onPrOpened: assignment lookup failed; isCurrent() is false",
        expect.objectContaining({
          taskId: "task-1",
          integration: "linear",
          message: "connection reset",
        }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("isCurrent() is false without a run, and reads nothing", async () => {
    const ctxs: HookCtx[] = [];
    const { r, inboxRepo } = wrapped({
      async onPrOpened(c) {
        ctxs.push(c);
      },
      async assignee(c) {
        ctxs.push(c);
        return null;
      },
    });
    // An event without an inbox row, and assignee(), which belongs to no run.
    await r.for("linear").onPrOpened(task, null, pr, true);
    await r.for("linear").assignee(task, {});
    expect(await Promise.all(ctxs.map((c) => c.isCurrent()))).toEqual([false, false]);
    expect(inboxRepo.getAssignment).not.toHaveBeenCalled();
  });

  it("isCurrent() reads the task's assignment id on each call: false once a restart rotated it", async () => {
    let ctx: HookCtx | undefined;
    const { r, inboxRepo, background } = wrapped(
      {},
      {
        async onRoundFinished(c) {
          ctx = c;
        },
      },
    );
    // A GitHub review round of the run whose assignment is a-1.
    r.for("github").onRoundFinished(task, row("gh-1", "review", "github"), "a-1", null, true);
    await background.drain(sleep(500));
    expect(await ctx?.isCurrent()).toBe(true);
    inboxRepo.getAssignment.mockResolvedValue(row("a-2"));
    expect(await ctx?.isCurrent()).toBe(false);
    expect(inboxRepo.getAssignment).toHaveBeenCalledTimes(2);
  });

  it("onTaskStarted runs on each fresh-provision attempt, with the assignment's first target and run", async () => {
    const calls: [HookCtx, ReplyTarget][] = [];
    const { r, inboxRepo } = wrapped({
      async onTaskStarted(ctx, _task, t) {
        calls.push([ctx, t]);
      },
    });
    // A deferred provision retries the same assignment.
    await r.for("linear").onTaskStarted(task, row("a-1"));
    await r.for("linear").onTaskStarted(task, row("a-1"));
    expect(calls.map(([, t]) => t)).toEqual([target, target]);
    // The caller hands in the assignment row: no lookup of its own.
    expect(inboxRepo.getAssignment).not.toHaveBeenCalled();
    // Its run is that assignment.
    expect(await calls[0]?.[0].isCurrent()).toBe(true);
  });

  it("onRoundFinished runs in BackgroundWork; drain logs hook_abandoned for what is still running", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const finished: string[] = [];
      const record = async (_ctx: unknown, _task: Task, round: Round) => {
        finished.push(round.id);
      };
      const { r, background } = wrapped(
        // Outlives the drain deadline below.
        { onRoundFinished: (ctx, t, round) => sleep(200).then(() => record(ctx, t, round)) },
        { onRoundFinished: record },
      );
      r.for("github").onRoundFinished(task, row("gh-1", "review", "github"), "a-1", null, true);
      r.for("linear").onRoundFinished(task, row("a-1"), "a-1", "failed", true);
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

describe("IntegrationRegistry.for: routing", () => {
  it("a round goes to its own integration, whichever name it was looked up by", async () => {
    const sent: string[] = [];
    const finished: string[] = [];
    const parts = (name: string): Partial<Integration> => ({
      deliver: async () => {
        sent.push(name);
      },
      onRoundFinished: async () => {
        finished.push(name);
      },
    });
    const { r, background } = wrapped(parts("linear"), parts("github"));
    const githubRound = row("gh-1", "comment", "github");
    expect(await r.for("linear").deliver(githubRound, target, reply, {})).toBe("ok");
    r.for("linear").onRoundFinished(task, githubRound, "a-1", null, true);
    await background.drain(sleep(500));

    expect(sent).toEqual(["github"]);
    expect(finished).toEqual(["github"]);
  });
});
