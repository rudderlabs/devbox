import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import type {
  Integration,
  IntegrationDefinition,
  ReplyTarget,
  TaskService,
} from "../../integrations/types";
import type { InboxRepository } from "../../repositories/inbox.repository";
import type { TaskRepository } from "../../repositories/task.repository";

// The real definitions reach the GitHub client, which reads config at import.
mock.module("../../config", () => ({ config: {} }));

const { IntegrationRegistry, parseIntegrationConfigs } = await import("../integrationRegistry");
const { ReplyHolds } = await import("../replyHolds");
const { RetryableError } = await import("../../integrations/outbound");
const { definitions } = await import("../../integrations");

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
    hooks: { detach: () => {} },
    holds,
  });

describe("IntegrationRegistry", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("creates only enabled integrations", () => {
    const a = definition("a");
    const b = definition("b");
    const r = registry([a, b], { b: "on" });
    expect(Object.keys(r.live)).toEqual(["b"]);
    expect(a.created).toHaveLength(0);
    expect(b.created).toHaveLength(1);
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

  it("are on from their own settings", () => {
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
    const r = registry([...definitions], env);
    expect(Object.keys(r.live)).toEqual(["linear", "github", "api"]);
    expect(r.webhooks().map((w) => w.name)).toEqual(["linear", "github"]);
    expect(Object.keys(registry([...definitions], { API_ENABLED: "true" }).live)).toEqual(["api"]);
  });
});
