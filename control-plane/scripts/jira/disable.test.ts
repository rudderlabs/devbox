import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestructiveRefused } from "../lib/destructive";
import type { JiraIntegration } from "../lib/integrations";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import type { JiraDeployment } from "./deployment";
import { disable } from "./disable";

const dir = mkdtempSync(join(tmpdir(), "devbox-jira-disable-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const COMPOSE: Deployment = { kind: "compose" };
const JIRA: JiraIntegration = {
  enabled: true,
  siteUrl: "https://example.atlassian.net",
  cloudId: "00000000-0000-0000-0000-000000000000",
  botEmail: "devbox@example.com",
  botAccountId: "712020:00000000-0000-0000-0000-000000000000",
  botName: "devbox",
  projectKeys: ["ENG"],
  statuses: { started: "In Progress", done: "Done" },
  tokenExpiresAt: "2027-06-30",
};
const OFF = { ...JIRA, enabled: false };
// The other integrations, which disable never touches.
const OTHERS = {
  linear: { enabled: true, clientId: "linear-client-id" },
  githubApp: { enabled: false, tokenScope: "repos", ciResults: true },
};
const ALL_ENTRIES = {
  "compose/GITHUB_TOKEN": "c",
  "compose/JIRA_API_TOKEN": "a",
  "compose/JIRA_WEBHOOK_SECRET": "b",
};
const KEEP_RUNNING =
  "2 open Jira task(s) (bun run devbox ls --source jira): these keep running; their results will not reach Jira.";
const TURN_OFF_HOOK = "Disable the webhook in Jira (Settings → System → WebHooks).";
const DELETE_HOOK =
  "Delete the webhook in Jira (Settings → System → WebHooks); the service account and its API token are yours to remove.";
let n = 0;

async function run(o: {
  jira?: JiraIntegration;
  // Other integrations in the config file.
  others?: boolean;
  forget?: boolean;
  yes?: boolean;
  isTTY?: boolean;
  answer?: boolean;
  noKeychain?: boolean;
  // The API's answer for each task list; down when it throws.
  tasks?: (state: string) => Response;
  down?: boolean;
}) {
  const path = join(dir, `c${n++}.json`);
  const integrations = { ...(o.others ? OTHERS : {}), ...(o.jira ? { jira: o.jira } : {}) };
  const original = JSON.stringify({
    port: 1,
    ...(Object.keys(integrations).length > 0 ? { integrations } : {}),
  });
  writeFileSync(path, original);
  const keychain = new MemoryKeychain(ALL_ENTRIES);
  const log: string[] = [];
  const asked: string[] = [];
  const called: string[] = [];
  const d: JiraDeployment = {
    deployment: COMPOSE,
    configPath: path,
    jira: o.jira,
    linear: false,
    flag: "",
    applyCommand: "bun run up",
    api: async (p) => {
      called.push(p);
      if (o.down) throw new Error("down");
      const state = new URL(p, "http://x").searchParams.get("state") ?? "";
      return o.tasks
        ? o.tasks(state)
        : Response.json({ tasks: state === "idle" ? [] : [{ key: "JIRA-1" }], next_before: null });
    },
  };
  const resolver = {
    env: {},
    keychain: o.noKeychain ? undefined : keychain,
    deployment: COMPOSE,
    isTTY: o.isTTY ?? true,
    confirm: async (q: string) => {
      asked.push(q);
      return o.answer ?? false;
    },
  } as unknown as ResolverDeps;
  let error: unknown;
  try {
    await disable(
      d,
      { forget: o.forget === true, yes: o.yes === true },
      { resolver, log: (l) => log.push(l) },
    );
  } catch (err) {
    error = err;
  }
  return {
    log,
    asked,
    called,
    error,
    path,
    keychain,
    original: JSON.parse(original),
    file: JSON.parse(readFileSync(path, "utf8")),
  };
}

describe("jira disable", () => {
  it("switches off, keeps the settings and the keychain, counts the open tasks", async () => {
    const r = await run({ jira: JIRA });
    expect(r.file).toEqual({ port: 1, integrations: { jira: OFF } });
    expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
    expect(r.asked).toEqual([]);
    expect(r.called).toEqual([
      "/api/tasks?source=jira&state=queued&limit=100",
      "/api/tasks?source=jira&state=running&limit=100",
      "/api/tasks?source=jira&state=idle&limit=100",
    ]);
    expect(r.log).toEqual([
      `Disabled Jira in ${r.path}.`,
      KEEP_RUNNING,
      TURN_OFF_HOOK,
      "Next: bun run up",
    ]);
  });

  it("without the count: names the command that lists them; more than a page", async () => {
    const down = await run({ jira: JIRA, down: true });
    expect(down.log[1]).toBe(
      "Open Jira tasks (bun run devbox ls --source jira) keep running; their results will not reach Jira.",
    );
    const many = await run({
      jira: JIRA,
      tasks: () => Response.json({ tasks: [{}, {}], next_before: "2026-11-01T00:00:00Z" }),
    });
    expect(many.log[1]).toBe(
      "6+ open Jira task(s) (bun run devbox ls --source jira): these keep running; their results will not reach Jira.",
    );
    const refused = await run({ jira: JIRA, tasks: () => new Response("", { status: 401 }) });
    expect(refused.log[1]).toBe(down.log[1]);
  });

  it("already disabled, not configured", async () => {
    const off = await run({ jira: OFF });
    expect(off.file).toEqual(off.original);
    expect(off.log).toEqual(["Jira is already disabled for compose."]);
    for (const forget of [false, true]) {
      const r = await run({ forget });
      expect(r.file).toEqual({ port: 1 });
      expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
      expect(r.log).toEqual(["Jira is not configured for compose. Nothing to disable."]);
    }
  });

  it("--forget lists and removes on yes, keeping the other integrations", async () => {
    const r = await run({ jira: OFF, others: true, forget: true, answer: true });
    expect(r.asked).toEqual(["Remove these? [y/N] "]);
    expect(r.file).toEqual({ port: 1, integrations: OTHERS });
    expect(r.keychain.entries()).toEqual({ "compose/GITHUB_TOKEN": "c" });
    expect(r.log).toEqual([
      "This deletes:",
      `  - integrations.jira in ${r.path}`,
      "  - JIRA_API_TOKEN for compose in the system keychain",
      "  - JIRA_WEBHOOK_SECRET for compose in the system keychain",
      KEEP_RUNNING,
      DELETE_HOOK,
      "Next: bun run up",
    ]);
  });

  it("--forget on no removes nothing", async () => {
    const r = await run({ jira: JIRA, forget: true, answer: false });
    expect(r.file).toEqual(r.original);
    expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
    expect(r.log.at(-1)).toBe("Nothing was removed.");
  });

  it("--forget without a terminal refuses; --forget --yes removes", async () => {
    const refused = await run({ jira: JIRA, forget: true, isTTY: false });
    expect(refused.error).toBeInstanceOf(DestructiveRefused);
    expect((refused.error as Error).message).toBe(
      "jira:disable --forget deletes data: pass --yes to confirm without a terminal",
    );
    expect(refused.file).toEqual(refused.original);

    const yes = await run({ jira: JIRA, forget: true, yes: true, isTTY: false });
    expect(yes.error).toBeUndefined();
    expect(yes.asked).toEqual([]);
    expect(yes.file).toEqual({ port: 1 });
    expect(yes.keychain.entries()).toEqual({ "compose/GITHUB_TOKEN": "c" });
  });

  it("--forget with --no-keychain removes only the block", async () => {
    const r = await run({ jira: JIRA, forget: true, answer: true, noKeychain: true });
    expect(r.log.slice(0, 2)).toEqual(["This deletes:", `  - integrations.jira in ${r.path}`]);
    expect(r.file).toEqual({ port: 1 });
    expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
  });
});
