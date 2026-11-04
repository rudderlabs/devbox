import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import type { Integration, IntegrationDefinition, TaskService } from "../../integrations/types";
import type { InboxRepository } from "../../repositories/inbox.repository";
import type { TaskRepository } from "../../repositories/task.repository";

// The real definitions reach the GitHub client, which reads config at import.
mock.module("../../config", () => ({ config: {} }));

const { IntegrationRegistry, parseIntegrationConfigs } = await import("../integrationRegistry");
const { BoundTaskService } = await import("../task.service");
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
const bound = (def: IntegrationDefinition) =>
  new BoundTaskService(def.name, {} as TaskRepository, {} as InboxRepository, {} as never, {
    detach: () => {},
  });
const registry = (
  defs: IntegrationDefinition[],
  env: Record<string, string> = {},
  deps: {
    tasks?: (d: IntegrationDefinition) => TaskService;
    holds?: InstanceType<typeof ReplyHolds>;
  } = {},
) =>
  new IntegrationRegistry(defs, parseIntegrationConfigs(defs, env), {
    tasks: deps.tasks ?? bound,
    holds: deps.holds ?? new ReplyHolds(),
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

  it("hands each integration a TaskService bound to its own name", () => {
    const defs = [definition("a"), definition("b"), definition("c")];
    registry(defs, { a: "on", b: "on", c: "on" });
    expect(defs.map((d) => d.created.map((core) => core.tasks.source))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  it("refuses to hand an integration another integration's TaskService", () => {
    const a = definition("a");
    const b = definition("b");
    expect(() => registry([a, b], { a: "on", b: "on" }, { tasks: () => bound(a) })).toThrow(
      "integration b was given the a TaskService",
    );
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

    const r = registry([definition("linear"), definition("github")], { github: "on" }, { holds });
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

  it("are on from their own settings, each with its own TaskService", () => {
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
    const sources: string[] = [];
    const r = registry([...definitions], env, {
      tasks: (d) => {
        sources.push(d.name);
        return bound(d);
      },
    });
    expect(Object.keys(r.live)).toEqual(["linear", "github", "api"]);
    expect(sources).toEqual(["linear", "github", "api"]);
    expect(r.webhooks().map((w) => w.name)).toEqual(["linear", "github"]);
    expect(Object.keys(registry([...definitions], { API_ENABLED: "true" }).live)).toEqual(["api"]);
  });
});
