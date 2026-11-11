import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClickupIntegration, Integrations } from "../lib/integrations";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import { CredentialRejected, type Fetch } from "../up/preflight";
import type { ClickupTeam, ClickupWebhook } from "./check";
import type { ClickupDeployment } from "./deployment";
import { type SetupDeps, SetupError, setup } from "./setup";

const dir = mkdtempSync(join(tmpdir(), "devbox-clickup-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PUBLIC = "https://hooks.example.com";
const HOOK_URL = `${PUBLIC}/webhook/clickup`;
const API = "https://api.clickup.com/api/v2";
const TEAM = "9000000000";
const BOT_ID = 100000001;
const HOOK_ID = "00000000-0000-0000-0000-000000000001";
const NEW_SECRET = "clickup-made-secret";
const COMPOSE: Deployment = { kind: "compose" };
const K8S: Deployment = { kind: "k8s", context: "kind-devbox", namespace: "devbox" };
const EVENTS = ["taskAssigneeUpdated", "taskCommentPosted"];

const URL_Q =
  "Public HTTPS URL that forwards to port 3000 on this machine (a tunnel or reverse proxy): ";
const TOKEN_Q = "ClickUp API token of the bot (pk_…) (input hidden): ";
const KEEP_TOKEN_Q =
  "ClickUp API token of the bot (pk_…) (input hidden; press Enter to keep the saved one): ";
const SAVE_BOTH_Q =
  "Save CLICKUP_API_TOKEN and CLICKUP_WEBHOOK_SECRET to the system keychain for compose? [Y/n] ";
const SAVE_SECRET_Q = "Save CLICKUP_WEBHOOK_SECRET to the system keychain for compose? [Y/n] ";
const SAVE_TOKEN_Q = "Save CLICKUP_API_TOKEN to the system keychain for compose? [Y/n] ";
const SHOW_Q = "Press Enter to show the webhook secret, to set as CLICKUP_WEBHOOK_SECRET ";
const TOKEN_HINT = [
  "The bot, the ClickUp account devbox acts as:",
  "  1. Invite it to your workspace as a member (not a guest), if it isn't there.",
  "  2. Signed in as the bot, generate its personal API token under Settings → Apps:",
  "  https://app.clickup.com/settings/apps",
];
const ACT_AS = `devbox will act as devbox (user ${BOT_ID}), a member of workspace Example (${TEAM})`;
const CREATED = `Webhook ${HOOK_ID} in ClickUp: created for ${HOOK_URL} (taskAssigneeUpdated, taskCommentPosted)`;
const UPDATED = `Webhook ${HOOK_ID} in ClickUp: updated for ${HOOK_URL}`;
const NEXT_COMPOSE = [
  "Next: bun run up (setup applies nothing)",
  "Then check ClickUp with: bun run clickup:status",
];

// A configured block, as a first run writes it.
const CLICKUP: ClickupIntegration = {
  enabled: true,
  teamId: TEAM,
  botUserId: BOT_ID,
  botName: "devbox",
  statuses: { started: "in progress" },
};
const team = (role: number | null = 3, id = TEAM, name = "Example"): ClickupTeam => ({
  id,
  name,
  members: [{ user: { id: 1, role: 1 } }, { user: { id: BOT_ID, role } }],
});
const hook = (o: Partial<ClickupWebhook> = {}): ClickupWebhook => ({
  id: HOOK_ID,
  endpoint: HOOK_URL,
  secret: NEW_SECRET,
  health: { status: "active", fail_count: 0 },
  ...o,
});

let n = 0;
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const written = (path: string) =>
  (readJson(path).integrations as { clickup?: ClickupIntegration }).clickup;

type Call = { method: string; url: string; body?: unknown };
type World = {
  log: string[];
  // Every question asked, in order: line prompts, hidden prompts, confirms.
  asked: string[];
  shown: string[];
  calls: Call[];
  keychain: MemoryKeychain;
};

function harness(o: {
  deployment?: Deployment;
  clickup?: ClickupIntegration;
  integrations?: Integrations;
  publicUrl?: string;
  byoIntegrationsSecret?: string;
  env?: Record<string, string>;
  saved?: Record<string, string>;
  lines?: string[];
  hidden?: string[];
  save?: boolean;
  validTokens?: string[];
  teams?: ClickupTeam[];
  hooks?: ClickupWebhook[];
  // What a PUT answers with; by default the webhook, its secret included.
  putSecret?: string | null;
  isTTY?: boolean;
}): { d: ClickupDeployment; deps: SetupDeps; w: World } {
  const deployment = o.deployment ?? COMPOSE;
  const w: World = {
    log: [],
    asked: [],
    shown: [],
    calls: [],
    keychain: new MemoryKeychain(o.saved),
  };
  const lines = [...(o.lines ?? [])];
  const hidden = [...(o.hidden ?? [])];
  const valid = new Set(o.validTokens ?? ["pk_bot"]);
  const hooks = [...(o.hooks ?? [])];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    w.calls.push({ method, url, ...(body !== undefined ? { body } : {}) });
    if (!valid.has(new Headers(init?.headers).get("authorization") ?? "")) {
      return Response.json({ err: "Token invalid", ECODE: "OAUTH_025" }, { status: 401 });
    }
    if (url === `${API}/user`) {
      return Response.json({ user: { id: BOT_ID, username: "devbox", email: "bot@example.com" } });
    }
    if (url === `${API}/team`) return Response.json({ teams: o.teams ?? [team()] });
    if (url === `${API}/team/${TEAM}/webhook` && method === "GET") {
      return Response.json({ webhooks: hooks });
    }
    if (url === `${API}/team/${TEAM}/webhook` && method === "POST") {
      const made = hook({ endpoint: (body as { endpoint: string }).endpoint });
      return Response.json({ id: HOOK_ID, webhook: made });
    }
    if (url.startsWith(`${API}/webhook/`) && method === "PUT") {
      const id = url.slice(`${API}/webhook/`.length);
      const was = hooks.find((h) => h.id === id);
      const secret = o.putSecret === undefined ? was?.secret : o.putSecret;
      return Response.json({
        id,
        webhook: { ...was, ...(body as object), ...(secret ? { secret } : { secret: undefined }) },
      });
    }
    return new Response("", { status: 599 });
  };
  const savedUrl = o.publicUrl ?? (o.clickup ? PUBLIC : undefined);
  const integrations: Integrations = {
    ...(o.integrations ?? {}),
    ...(o.clickup ? { clickup: o.clickup } : {}),
  };
  const configPath = join(dir, `c${n++}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      port: 1,
      ...(Object.keys(integrations).length ? { integrations } : {}),
      ...(savedUrl !== undefined ? { publicUrl: savedUrl } : {}),
    }),
  );
  const resolver: ResolverDeps = {
    env: o.env ?? {},
    keychain: w.keychain,
    deployment,
    isTTY: o.isTTY ?? true,
    prompt: async (q) => {
      w.asked.push(q);
      return hidden.shift() ?? "";
    },
    confirm: async (q) => {
      w.asked.push(q);
      return o.save ?? true;
    },
    run: async () => {
      throw new Error("setup runs no command");
    },
    log: (line) => w.log.push(line),
  };
  const flag = deployment.kind === "k8s" ? ` --target ${configPath}` : "";
  const d: ClickupDeployment = {
    deployment,
    configPath,
    clickup: o.clickup,
    integrations,
    ...(savedUrl !== undefined ? { publicUrl: savedUrl } : {}),
    ...(o.byoIntegrationsSecret !== undefined
      ? { byoIntegrationsSecret: o.byoIntegrationsSecret }
      : {}),
    flag,
    applyCommand: deployment.kind === "k8s" ? `bun run k8s:install${flag}` : "bun run up",
    api: async () => {
      throw new Error("setup calls no devbox API");
    },
  };
  const deps: SetupDeps = {
    resolver,
    promptLine: async (q) => {
      w.asked.push(q);
      return lines.shift() ?? "";
    },
    fetch,
    show: (secret) => w.shown.push(secret),
    log: (line) => w.log.push(line),
  };
  return { d, deps, w };
}

const SAVED = {
  "compose/CLICKUP_API_TOKEN": "pk_bot",
  "compose/CLICKUP_WEBHOOK_SECRET": NEW_SECRET,
};
const writes = (w: World) => w.calls.filter((c) => c.method !== "GET");

describe("clickup setup", () => {
  it("first run on Compose: the token, the bot's workspace, a new webhook, save, write, next step", async () => {
    const { d, deps, w } = harness({ lines: [PUBLIC], hidden: ["pk_bot"] });
    await setup(d, {}, deps);
    expect(w.asked).toEqual([URL_Q, TOKEN_Q, SAVE_BOTH_Q]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      "",
      ...TOKEN_HINT,
      ACT_AS,
      "",
      CREATED,
      "",
      `Wrote integrations.clickup to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(w.calls).toEqual([
      { method: "GET", url: `${API}/user` },
      { method: "GET", url: `${API}/team` },
      { method: "GET", url: `${API}/team/${TEAM}/webhook` },
      {
        method: "POST",
        url: `${API}/team/${TEAM}/webhook`,
        body: { endpoint: HOOK_URL, events: EVENTS },
      },
    ]);
    expect(readJson(d.configPath)).toEqual({
      port: 1,
      integrations: { clickup: CLICKUP },
      publicUrl: PUBLIC,
    });
    expect(w.keychain.entries()).toEqual(SAVED);
    // Saved, so not shown; and the secrets reach neither the log nor the config.
    expect(w.shown).toEqual([]);
    const text = [...w.log, readFileSync(d.configPath, "utf8")].join("\n");
    expect(text).not.toContain("pk_bot");
    expect(text).not.toContain(NEW_SECRET);
  });

  it("without a terminal: flags and env; a new webhook's secret is neither saved nor shown", async () => {
    const { d, deps, w } = harness({ isTTY: false, env: { CLICKUP_API_TOKEN: "pk_bot" } });
    await setup(d, { publicUrl: PUBLIC }, deps);
    expect(w.asked).toEqual([]);
    expect(w.shown).toEqual([]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      "",
      "CLICKUP_API_TOKEN: from your environment",
      ACT_AS,
      "",
      CREATED,
      "",
      "The webhook secret is not shown without a terminal: run `bun run clickup:setup` in a terminal to save or see it",
      `Wrote integrations.clickup to ${d.configPath}`,
      "bun run up will use CLICKUP_API_TOKEN from your environment",
      "Set CLICKUP_WEBHOOK_SECRET in your environment before bun run up; otherwise it asks for it in a terminal",
      ...NEXT_COMPOSE,
    ]);
    expect(written(d.configPath)).toEqual(CLICKUP);
    expect(w.keychain.entries()).toEqual({});
  });

  it("no token without a terminal, or none typed: refuses, writes nothing", async () => {
    const headless = harness({ isTTY: false });
    const before = readFileSync(headless.d.configPath, "utf8");
    await expect(setup(headless.d, { publicUrl: PUBLIC }, headless.deps)).rejects.toThrow(
      new SetupError(
        "no CLICKUP_API_TOKEN: run `bun run clickup:setup` in a terminal, or set CLICKUP_API_TOKEN",
      ),
    );
    expect(readFileSync(headless.d.configPath, "utf8")).toBe(before);
    expect(headless.w.calls).toEqual([]);

    const empty = harness({ hidden: [""] });
    await expect(setup(empty.d, { publicUrl: PUBLIC }, empty.deps)).rejects.toThrow(
      "No ClickUp API token entered: nothing was written. Run `bun run clickup:setup` again when you have it.",
    );
  });

  it("a rejected token: from env it stops; a typed one is asked for again; a saved one is kept", async () => {
    const env = harness({ isTTY: false, env: { CLICKUP_API_TOKEN: "pk_old" } });
    await expect(setup(env.d, { publicUrl: PUBLIC }, env.deps)).rejects.toBeInstanceOf(
      CredentialRejected,
    );

    const typed = harness({ hidden: ["pk_old", "pk_bot"], save: false });
    await setup(typed.d, { publicUrl: PUBLIC }, typed.deps);
    expect(typed.w.asked.slice(0, 2)).toEqual([TOKEN_Q, TOKEN_Q]);
    expect(typed.w.log).toContain(
      "ClickUp rejected CLICKUP_API_TOKEN (401): use the bot's personal API token (pk_…), from ClickUp's Settings → Apps while signed in as the bot",
    );

    const saved = harness({
      clickup: CLICKUP,
      saved: { ...SAVED, "compose/CLICKUP_API_TOKEN": "pk_old" },
      hooks: [hook()],
      hidden: ["", ""],
    });
    await expect(setup(saved.d, {}, saved.deps)).rejects.toThrow(
      "No ClickUp API token entered: nothing was written.",
    );
    expect(saved.w.asked).toEqual([KEEP_TOKEN_Q, TOKEN_Q]);
    expect(saved.w.log).toContain(
      "The saved CLICKUP_API_TOKEN for compose was rejected; keeping it",
    );
    expect(saved.w.keychain.entries()["compose/CLICKUP_API_TOKEN"]).toBe("pk_old");
  });

  it("re-run: the webhook at this URL is updated in place, the settings kept, nothing saved", async () => {
    const statuses = { started: "doing", done: "review" };
    const { d, deps, w } = harness({
      clickup: { ...CLICKUP, statuses },
      saved: SAVED,
      hooks: [hook()],
    });
    await setup(d, {}, deps);
    expect(w.asked).toEqual([KEEP_TOKEN_Q]);
    expect(writes(w)).toEqual([
      {
        method: "PUT",
        url: `${API}/webhook/${HOOK_ID}`,
        body: { endpoint: HOOK_URL, events: EVENTS, status: "active" },
      },
    ]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      "",
      "CLICKUP_API_TOKEN: from the system keychain (compose)",
      ACT_AS,
      "",
      UPDATED,
      "CLICKUP_WEBHOOK_SECRET: from the system keychain (compose)",
      "",
      `Wrote integrations.clickup to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(written(d.configPath)).toEqual({ ...CLICKUP, statuses });
    expect(w.keychain.entries()).toEqual(SAVED);
  });

  it("re-run: statuses removed by hand stay removed", async () => {
    const { statuses: _, ...bare } = CLICKUP;
    const { d, deps } = harness({ clickup: bare, saved: SAVED, hooks: [hook()] });
    await setup(d, {}, deps);
    expect(written(d.configPath)).toEqual(bare);
  });

  it("a new public URL: the webhook at the old one is moved, not duplicated; a suspended one is reactivated", async () => {
    const old = "https://old.example.com";
    const { d, deps, w } = harness({
      clickup: CLICKUP,
      integrations: { linear: { enabled: true, clientId: "c" } },
      publicUrl: old,
      saved: SAVED,
      hooks: [
        { id: "other", endpoint: "https://elsewhere.example.com/hook", secret: "x" },
        hook({
          endpoint: `${old}/webhook/clickup`,
          health: { status: "suspended", fail_count: 100 },
        }),
      ],
    });
    await setup(d, { publicUrl: PUBLIC }, deps);
    expect(writes(w)).toEqual([
      {
        method: "PUT",
        url: `${API}/webhook/${HOOK_ID}`,
        body: { endpoint: HOOK_URL, events: EVENTS, status: "active" },
      },
    ]);
    expect(w.log).toContain(
      `${UPDATED} (it pointed at ${old}/webhook/clickup); reactivated (it was suspended)`,
    );
    expect(w.log).toContain(`Update the webhook URL in the Linear app to ${PUBLIC}/webhook/linear`);
    expect(readJson(d.configPath).publicUrl).toBe(PUBLIC);
  });

  it("a reused webhook without a saved secret: ClickUp's is used and offered for saving", async () => {
    const { d, deps, w } = harness({
      clickup: CLICKUP,
      saved: { "compose/CLICKUP_API_TOKEN": "pk_bot" },
      hooks: [hook()],
      putSecret: null,
    });
    await setup(d, {}, deps);
    expect(w.asked).toEqual([KEEP_TOKEN_Q, SAVE_SECRET_Q]);
    expect(w.keychain.entries()).toEqual(SAVED);
  });

  it("a reused webhook whose secret ClickUp doesn't return and none saved: refuses, writes nothing", async () => {
    const { d, deps } = harness({
      clickup: CLICKUP,
      saved: { "compose/CLICKUP_API_TOKEN": "pk_bot" },
      hooks: [hook({ secret: undefined })],
      putSecret: null,
    });
    const before = readFileSync(d.configPath, "utf8");
    await expect(setup(d, {}, deps)).rejects.toThrow(
      new SetupError(
        `ClickUp didn't return the secret of webhook ${HOOK_ID}, and none is in your environment or the keychain: set CLICKUP_WEBHOOK_SECRET to it and run \`bun run clickup:setup\` again. If it is lost, bun run clickup:disable --forget deletes the webhook (and the ClickUp settings); setup then creates a new one.`,
      ),
    );
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
    // ... and with one in the environment, that one is used.
    const env = harness({
      clickup: CLICKUP,
      saved: { "compose/CLICKUP_API_TOKEN": "pk_bot" },
      env: { CLICKUP_WEBHOOK_SECRET: "from-env" },
      hooks: [hook({ secret: undefined })],
      putSecret: null,
    });
    await setup(env.d, {}, env.deps);
    expect(env.w.log).toContain("bun run up will use CLICKUP_WEBHOOK_SECRET from your environment");
  });

  it("a saved or env secret that isn't the webhook's: the keychain's is replaced on yes, env's refused", async () => {
    const saved = harness({
      clickup: CLICKUP,
      saved: { ...SAVED, "compose/CLICKUP_WEBHOOK_SECRET": "stale" },
      hooks: [hook()],
    });
    await setup(saved.d, {}, saved.deps);
    expect(saved.w.log).toContain(
      `The CLICKUP_WEBHOOK_SECRET saved in the system keychain for compose is not webhook ${HOOK_ID}'s secret: using ClickUp's`,
    );
    expect(saved.w.asked).toEqual([KEEP_TOKEN_Q, SAVE_SECRET_Q]);
    expect(saved.w.keychain.entries()).toEqual(SAVED);

    const declined = harness({
      clickup: CLICKUP,
      saved: { ...SAVED, "compose/CLICKUP_WEBHOOK_SECRET": "stale" },
      hooks: [hook()],
      save: false,
    });
    await setup(declined.d, {}, declined.deps);
    // Never removed: the old one is named, with how to override or remove it.
    expect(declined.w.keychain.entries()["compose/CLICKUP_WEBHOOK_SECRET"]).toBe("stale");
    expect(declined.w.asked).toEqual([KEEP_TOKEN_Q, SAVE_SECRET_Q, SHOW_Q]);
    expect(declined.w.shown).toEqual([NEW_SECRET]);
    expect(declined.w.log).toContain(
      "The old CLICKUP_WEBHOOK_SECRET saved in the system keychain for compose stays, and bun run up would use it: set CLICKUP_WEBHOOK_SECRET in your environment, which wins, or remove the old one with bun run secrets rm CLICKUP_WEBHOOK_SECRET",
    );

    const env = harness({
      clickup: CLICKUP,
      saved: { "compose/CLICKUP_API_TOKEN": "pk_bot" },
      env: { CLICKUP_WEBHOOK_SECRET: "stale" },
      hooks: [hook()],
    });
    const before = readFileSync(env.d.configPath, "utf8");
    await expect(setup(env.d, {}, env.deps)).rejects.toThrow(
      `CLICKUP_WEBHOOK_SECRET in your environment is not the secret of webhook ${HOOK_ID}: unset it, or set it to the webhook's, and run \`bun run clickup:setup\` again. Nothing was written.`,
    );
    expect(readFileSync(env.d.configPath, "utf8")).toBe(before);
  });

  it("rotation with the save declined: the new token is used, the old saved one stays", async () => {
    const { d, deps, w } = harness({
      clickup: CLICKUP,
      saved: { ...SAVED, "compose/CLICKUP_API_TOKEN": "pk_old" },
      validTokens: ["pk_old", "pk_bot"],
      hidden: ["pk_bot"],
      hooks: [hook()],
      save: false,
    });
    await setup(d, {}, deps);
    expect(w.asked).toEqual([KEEP_TOKEN_Q, SAVE_TOKEN_Q]);
    expect(w.keychain.entries()["compose/CLICKUP_API_TOKEN"]).toBe("pk_old");
    expect(w.log).toContain(
      "The old CLICKUP_API_TOKEN saved in the system keychain for compose stays, and bun run up would use it: set CLICKUP_API_TOKEN in your environment, which wins, or remove the old one with bun run secrets rm CLICKUP_API_TOKEN",
    );
  });

  it("a guest bot: refused with why, before any webhook call", async () => {
    const { d, deps, w } = harness({ hidden: ["pk_bot"], teams: [team(4)] });
    await expect(setup(d, { publicUrl: PUBLIC }, deps)).rejects.toThrow(
      new SetupError(
        "devbox is a guest in workspace Example: a guest sees only what is shared with it and may not manage the workspace's webhooks, so devbox needs a member (or an admin or owner). Make it a member in ClickUp (Settings → People), then run `bun run clickup:setup` again.",
      ),
    );
    expect(w.calls.map((c) => c.url)).toEqual([`${API}/user`, `${API}/team`]);
    const unknown = harness({ hidden: ["pk_bot"], teams: [team(null)] });
    await expect(setup(unknown.d, { publicUrl: PUBLIC }, unknown.deps)).rejects.toThrow(
      "can't tell devbox's role in workspace Example: it must be a member, an admin or the owner there",
    );
  });

  it("the workspace: --team, the saved one, a choice in a terminal, refused without one", async () => {
    const teams = [team(3, "9000000001", "Other"), team()];
    const env = { CLICKUP_API_TOKEN: "pk_bot" };
    const headless = harness({ isTTY: false, env, teams });
    await expect(setup(headless.d, { publicUrl: PUBLIC }, headless.deps)).rejects.toThrow(
      `the bot is in 2 ClickUp workspaces: pass --team <id> with one of Other (9000000001), Example (${TEAM})`,
    );

    const flag = harness({ isTTY: false, env, teams });
    await setup(flag.d, { publicUrl: PUBLIC, team: TEAM }, flag.deps);
    expect(written(flag.d.configPath)?.teamId).toBe(TEAM);

    const chosen = harness({ env, teams, lines: ["2"] });
    await setup(chosen.d, { publicUrl: PUBLIC }, chosen.deps);
    expect(chosen.w.asked[0]).toBe("The workspace devbox works in (number or id): ");
    expect(chosen.w.log).toContain("  2. Example (9000000000)");
    expect(written(chosen.d.configPath)?.teamId).toBe(TEAM);

    const kept = harness({ env, teams, clickup: CLICKUP, saved: SAVED, hooks: [hook()] });
    await setup(kept.d, {}, kept.deps);
    expect(kept.w.asked).toEqual([]);

    const missing = harness({ isTTY: false, env, teams });
    await expect(
      setup(missing.d, { publicUrl: PUBLIC, team: "9000000009" }, missing.deps),
    ).rejects.toThrow(
      `the bot is not in ClickUp workspace 9000000009: invite it there as a member, or pass --team with one of its workspaces: Other (9000000001), Example (${TEAM})`,
    );
    await expect(
      setup(missing.d, { publicUrl: PUBLIC, team: "example" }, missing.deps),
    ).rejects.toThrow("--team must be a ClickUp workspace id, digits only");
  });

  it("k8s with the user's own integrations Secret: nothing saved; a new secret is shown for the Secret", async () => {
    const { d, deps, w } = harness({
      deployment: K8S,
      byoIntegrationsSecret: "my-integrations",
      hidden: ["pk_bot"],
    });
    await setup(d, { publicUrl: PUBLIC }, deps);
    const flag = ` --target ${d.configPath}`;
    expect(w.asked).toEqual([
      TOKEN_Q,
      'Press Enter to show the webhook secret, to set as CLICKUP_WEBHOOK_SECRET in Secret "my-integrations" ',
    ]);
    expect(w.shown).toEqual([NEW_SECRET]);
    expect(w.keychain.entries()).toEqual({});
    expect(w.log.slice(-5)).toEqual([
      `Wrote integrations.clickup to ${d.configPath}`,
      'Put CLICKUP_API_TOKEN and CLICKUP_WEBHOOK_SECRET in Secret "my-integrations" in namespace devbox.',
      `Next: bun run k8s:install${flag} (setup applies nothing)`,
      `With GitOps, set the chart values integrations.clickup.* to the integrations.clickup block in ${d.configPath} instead, with enabled: true`,
      `Then check ClickUp with: bun run clickup:status${flag}`,
    ]);
  });

  it("never deletes a webhook", async () => {
    const { d, deps, w } = harness({
      clickup: CLICKUP,
      saved: SAVED,
      hooks: [hook(), hook({ id: "second", endpoint: "https://old.example.com/webhook/clickup" })],
    });
    await setup(d, {}, deps);
    expect(w.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(writes(w).map((c) => c.url)).toEqual([`${API}/webhook/${HOOK_ID}`]);
  });
});
