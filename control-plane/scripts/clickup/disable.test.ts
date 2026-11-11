import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestructiveRefused } from "../lib/destructive";
import type { ClickupIntegration } from "../lib/integrations";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import type { ClickupDeployment } from "./deployment";
import { disable } from "./disable";

const dir = mkdtempSync(join(tmpdir(), "devbox-clickup-disable-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const COMPOSE: Deployment = { kind: "compose" };
const API = "https://api.clickup.com/api/v2";
const TEAM = "9000000000";
const CLICKUP: ClickupIntegration = {
  enabled: true,
  teamId: TEAM,
  botUserId: 100000001,
  botName: "devbox",
  statuses: { started: "in progress" },
};
const OFF = { ...CLICKUP, enabled: false };
// The other integrations, which disable never touches.
const OTHERS = { linear: { enabled: true, clientId: "linear-client-id" } };
const ALL_ENTRIES = {
  "compose/GITHUB_TOKEN": "c",
  "compose/CLICKUP_API_TOKEN": "pk_bot",
  "compose/CLICKUP_WEBHOOK_SECRET": "b",
};
const HOOKS = [
  { id: "hook-1", endpoint: "https://hooks.example.com/webhook/clickup" },
  { id: "not-ours", endpoint: "https://elsewhere.example.com/hook" },
];
const KEEP_RUNNING =
  "2 open ClickUp task(s) (bun run devbox ls --source clickup): these keep running; their results will not reach ClickUp.";
let n = 0;

async function run(o: {
  clickup?: ClickupIntegration;
  others?: boolean;
  forget?: boolean;
  yes?: boolean;
  isTTY?: boolean;
  answer?: boolean;
  noKeychain?: boolean;
  env?: Record<string, string>;
  entries?: Record<string, string>;
  // ClickUp's answer to listing the webhooks.
  listing?: () => Response;
}) {
  const path = join(dir, `c${n++}.json`);
  const integrations = {
    ...(o.others ? OTHERS : {}),
    ...(o.clickup ? { clickup: o.clickup } : {}),
  };
  const original = JSON.stringify({
    port: 1,
    ...(Object.keys(integrations).length > 0 ? { integrations } : {}),
  });
  writeFileSync(path, original);
  const keychain = new MemoryKeychain(o.entries ?? ALL_ENTRIES);
  const log: string[] = [];
  const asked: string[] = [];
  const called: string[] = [];
  const d: ClickupDeployment = {
    deployment: COMPOSE,
    configPath: path,
    clickup: o.clickup,
    integrations: {},
    flag: "",
    applyCommand: "bun run up",
    api: async (p) => {
      const state = new URL(p, "http://x").searchParams.get("state") ?? "";
      return Response.json({ tasks: state === "idle" ? [] : [{}], next_before: null });
    },
  };
  const resolver = {
    env: o.env ?? {},
    keychain: o.noKeychain ? undefined : keychain,
    deployment: COMPOSE,
    isTTY: o.isTTY ?? true,
    confirm: async (q: string) => {
      asked.push(q);
      return o.answer ?? false;
    },
  } as unknown as ResolverDeps;
  const fetch = async (url: string, init?: RequestInit) => {
    called.push(
      `${init?.method ?? "GET"} ${url} ${new Headers(init?.headers).get("authorization")}`,
    );
    if (url === `${API}/team/${TEAM}/webhook`) {
      return o.listing ? o.listing() : Response.json({ webhooks: HOOKS });
    }
    return new Response("{}");
  };
  let error: unknown;
  try {
    await disable(
      d,
      { forget: o.forget === true, yes: o.yes === true },
      { resolver, fetch, log: (l) => log.push(l) },
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

describe("clickup disable", () => {
  it("switches off, keeps the settings, the keychain and the webhook", async () => {
    const r = await run({ clickup: CLICKUP });
    expect(r.file).toEqual({ port: 1, integrations: { clickup: OFF } });
    expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
    expect(r.called).toEqual([]);
    expect(r.log).toEqual([
      `Disabled ClickUp in ${r.path}.`,
      KEEP_RUNNING,
      "The webhook in ClickUp stays: with ClickUp off its deliveries fail, and ClickUp suspends it after 100 failures; bun run clickup:setup reactivates it.",
      "Next: bun run up",
    ]);
  });

  it("already disabled, not configured", async () => {
    const off = await run({ clickup: OFF });
    expect(off.file).toEqual(off.original);
    expect(off.log).toEqual(["ClickUp is already disabled for compose."]);
    for (const forget of [false, true]) {
      const r = await run({ forget });
      expect(r.file).toEqual({ port: 1 });
      expect(r.log).toEqual(["ClickUp is not configured for compose. Nothing to disable."]);
    }
  });

  it("--forget lists and, on yes, deletes the devbox webhook with the saved token, then the rest", async () => {
    const r = await run({ clickup: OFF, others: true, forget: true, answer: true });
    expect(r.asked).toEqual(["Remove these? [y/N] "]);
    expect(r.called).toEqual([
      `GET ${API}/team/${TEAM}/webhook pk_bot`,
      `DELETE ${API}/webhook/hook-1 pk_bot`,
    ]);
    expect(r.file).toEqual({ port: 1, integrations: OTHERS });
    expect(r.keychain.entries()).toEqual({ "compose/GITHUB_TOKEN": "c" });
    expect(r.log).toEqual([
      "This deletes:",
      `  - webhook hook-1 in ClickUp workspace ${TEAM} (https://hooks.example.com/webhook/clickup)`,
      `  - integrations.clickup in ${r.path}`,
      "  - CLICKUP_API_TOKEN for compose in the system keychain",
      "  - CLICKUP_WEBHOOK_SECRET for compose in the system keychain",
      "Deleted webhook hook-1 in ClickUp.",
      KEEP_RUNNING,
      "The bot's ClickUp account and its API token are yours to remove.",
      "Next: bun run up",
    ]);
  });

  it("--forget on no removes nothing, in ClickUp neither", async () => {
    const r = await run({ clickup: CLICKUP, forget: true, answer: false });
    expect(r.file).toEqual(r.original);
    expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
    expect(r.called.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(r.log.at(-1)).toBe("Nothing was removed.");
  });

  it("--forget without a token: says the webhook stays; the env's token wins over the keychain's", async () => {
    const none = await run({ clickup: CLICKUP, forget: true, answer: true, noKeychain: true });
    expect(none.called).toEqual([]);
    expect(none.log[0]).toBe(
      "No CLICKUP_API_TOKEN in your environment or the system keychain, so the webhook in ClickUp stays: to delete it too, run this with CLICKUP_API_TOKEN set to the bot's token. Removing the bot from the workspace also stops it.",
    );
    expect(none.file).toEqual({ port: 1 });

    const env = await run({
      clickup: CLICKUP,
      forget: true,
      answer: true,
      env: { CLICKUP_API_TOKEN: "pk_env" },
    });
    expect(env.called).toEqual([
      `GET ${API}/team/${TEAM}/webhook pk_env`,
      `DELETE ${API}/webhook/hook-1 pk_env`,
    ]);
  });

  it("--forget when ClickUp can't list the webhooks: says so, removes the rest", async () => {
    const r = await run({
      clickup: CLICKUP,
      forget: true,
      answer: true,
      listing: () => new Response("", { status: 401 }),
    });
    expect(r.log[0]).toStartWith(
      "Can't list the webhooks in ClickUp (ClickUp rejected CLICKUP_API_TOKEN (401)",
    );
    expect(r.called.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(r.file).toEqual({ port: 1 });
  });

  it("--forget without a terminal refuses; --forget --yes removes", async () => {
    const refused = await run({ clickup: CLICKUP, forget: true, isTTY: false });
    expect(refused.error).toBeInstanceOf(DestructiveRefused);
    expect((refused.error as Error).message).toBe(
      "clickup:disable --forget deletes data: pass --yes to confirm without a terminal",
    );
    expect(refused.file).toEqual(refused.original);
    expect(refused.called.some((c) => c.startsWith("DELETE"))).toBe(false);

    const yes = await run({ clickup: CLICKUP, forget: true, yes: true, isTTY: false });
    expect(yes.error).toBeUndefined();
    expect(yes.asked).toEqual([]);
    expect(yes.file).toEqual({ port: 1 });
    expect(yes.called.at(-1)).toBe(`DELETE ${API}/webhook/hook-1 pk_bot`);
  });
});
