import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JiraIntegration } from "../lib/integrations";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import { CredentialRejected, type Fetch } from "../up/preflight";
import type { JiraDeployment } from "./deployment";
import { type SetupDeps, SetupError, type SetupOptions, setup } from "./setup";

const dir = mkdtempSync(join(tmpdir(), "devbox-jira-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PUBLIC = "https://hooks.example.com";
const SITE = "https://example.atlassian.net";
const CLOUD = "00000000-0000-0000-0000-000000000000";
const BOT_ID = "712020:00000000-0000-0000-0000-000000000000";
const EMAIL = "devbox@example.com";
const API = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3`;
const COMPOSE: Deployment = { kind: "compose" };
const K8S: Deployment = { kind: "k8s", context: "kind-devbox", namespace: "devbox" };
const GENERATED = "ab".repeat(32);
const ALL_PERMISSIONS = [
  "BROWSE_PROJECTS",
  "ADD_COMMENTS",
  "TRANSITION_ISSUES",
  "LINK_ISSUES",
  "ASSIGNABLE_USER",
];

const URL_Q =
  "Public HTTPS URL that forwards to port 3000 on this machine (a tunnel or reverse proxy): ";
const SITE_Q = "Jira site URL (e.g. https://example.atlassian.net): ";
const EMAIL_Q = "The service account's email (shown on its page in Atlassian Administration): ";
const TOKEN_Q =
  "Jira API token with read:jira-work, write:jira-work and read:jira-user (input hidden): ";
const KEEP_TOKEN_Q =
  "Jira API token with read:jira-work, write:jira-work and read:jira-user (input hidden; press Enter to keep the saved one): ";
const WEBHOOK_Q =
  "Jira webhook secret (input hidden; paste the webhook's current one, or press Enter to generate one to paste into its Secret field): ";
const SAVE_TOKEN_Q = "Save JIRA_API_TOKEN to the system keychain for compose? [Y/n] ";
const SAVE_BOTH_Q =
  "Save JIRA_API_TOKEN and JIRA_WEBHOOK_SECRET to the system keychain for compose? [Y/n] ";
const SHOW_Q = "Press Enter to show the webhook secret, to paste into the webhook's Secret field ";

const ADMIN = "https://admin.atlassian.com/";
const TOKEN_HINT = [
  "The service account, in Atlassian Administration (Directory → Service accounts):",
  "  1. Create it, if it doesn't exist.",
  "  2. Give it access to Jira with the User role (not an admin role).",
  "  3. Create an API token for it with exactly Jira's classic scopes read:jira-work, write:jira-work and read:jira-user.",
  `  ${ADMIN}`,
];
const WEBHOOKS = `${SITE}/plugins/servlet/webhooks`;
const ACT_AS = `devbox will act as devbox (account ${BOT_ID}) on ${SITE}`;
const rejected = (email = EMAIL) =>
  `Jira rejected JIRA_API_TOKEN, or the email ${email} doesn't match it (401): use the service account's API token, with scopes read:jira-work, write:jira-work and read:jira-user, and the service account's email`;
const LONG_SECRET = "my-webhook-secret-".repeat(2);
const PERMISSIONS = `${API}/mypermissions?permissions=${ALL_PERMISSIONS.join("%2C")}`;
// The Secret line names where the secret comes from; none when it is asked for.
const webhookBlock = (secret?: string) => [
  "",
  "The webhook in Jira (a Jira admin creates it once: Settings → System → WebHooks):",
  `  ${WEBHOOKS}`,
  "Click Create there, or edit the webhook you have, and paste these values:",
  `  URL     ${PUBLIC}/webhook/jira`,
  ...(secret ? [`  Secret  ${secret}`] : []),
  "  Events  Issue: created, updated; Comment: created",
  '  JQL     optional: leave it empty for every project, or limit devbox to some, e.g. project in ("ENG")',
];
const NEXT_COMPOSE = [
  "Next: bun run up (setup applies nothing)",
  "Then check Jira with: bun run jira:status",
];

// A configured block, as a first run writes it.
const JIRA: JiraIntegration = {
  enabled: true,
  siteUrl: SITE,
  cloudId: CLOUD,
  botEmail: EMAIL,
  botAccountId: BOT_ID,
  botName: "devbox",
  statuses: { started: "In Progress" },
};

let n = 0;
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

type World = {
  log: string[];
  // Every question asked, in order: line prompts, hidden prompts, confirms.
  asked: string[];
  shown: string[];
  fetched: string[];
  // Pages opened in the browser.
  opened: string[];
  keychain: MemoryKeychain;
};

function harness(o: {
  deployment?: Deployment;
  jira?: JiraIntegration;
  publicUrl?: string;
  byoIntegrationsSecret?: string;
  env?: Record<string, string>;
  saved?: Record<string, string>;
  noKeychain?: boolean;
  lines?: string[];
  hidden?: string[];
  save?: boolean;
  validTokens?: string[];
  // The permissions the bot holds in at least one project.
  held?: string[];
  isTTY?: boolean;
}): { d: JiraDeployment; deps: SetupDeps; w: World } {
  const deployment = o.deployment ?? COMPOSE;
  const w: World = {
    log: [],
    asked: [],
    shown: [],
    fetched: [],
    opened: [],
    keychain: new MemoryKeychain(o.saved),
  };
  const lines = [...(o.lines ?? [])];
  const hidden = [...(o.hidden ?? [])];
  const valid = new Set(o.validTokens ?? ["jira-token"]);
  const fetch: Fetch = async (url, init) => {
    w.fetched.push(url);
    if (url === `${SITE}/_edge/tenant_info`) return Response.json({ cloudId: CLOUD });
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const [email, token] = Buffer.from(auth.replace(/^Basic /, ""), "base64")
      .toString()
      .split(":");
    if (email !== EMAIL || !valid.has(token ?? "")) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (url === `${API}/myself`) {
      return Response.json({ accountId: BOT_ID, accountType: "app", displayName: "devbox" });
    }
    if (url === PERMISSIONS) {
      const held = o.held ?? ALL_PERMISSIONS;
      return Response.json({
        permissions: Object.fromEntries(held.map((k) => [k, { havePermission: true }])),
      });
    }
    return new Response("", { status: 599 });
  };
  const savedUrl = o.publicUrl ?? (o.jira ? PUBLIC : undefined);
  const configPath = join(dir, `c${n++}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      port: 1,
      ...(o.jira ? { integrations: { jira: o.jira } } : {}),
      ...(savedUrl !== undefined ? { publicUrl: savedUrl } : {}),
    }),
  );
  const resolver: ResolverDeps = {
    env: o.env ?? {},
    keychain: o.noKeychain ? undefined : w.keychain,
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
  const d: JiraDeployment = {
    deployment,
    configPath,
    jira: o.jira,
    linear: false,
    ...(savedUrl !== undefined ? { publicUrl: savedUrl } : {}),
    ...(o.byoIntegrationsSecret !== undefined
      ? { byoIntegrationsSecret: o.byoIntegrationsSecret }
      : {}),
    flag,
    applyCommand: deployment.kind === "k8s" ? `bun run k8s:install${flag}` : "bun run up",
    api: async () => {
      throw new Error("setup calls no API");
    },
  };
  const deps: SetupDeps = {
    resolver,
    promptLine: async (q) => {
      w.asked.push(q);
      return lines.shift() ?? "";
    },
    fetch,
    random: () => GENERATED,
    show: (secret) => w.shown.push(secret),
    openUrl: (url) => w.opened.push(url),
    log: (line) => w.log.push(line),
  };
  return { d, deps, w };
}

// Every setting by flag, for runs without a terminal.
const FLAGS: SetupOptions = {
  publicUrl: PUBLIC,
  site: SITE,
  email: EMAIL,
};

describe("jira setup", () => {
  it("first run on Compose: every question in order, the webhook before its secret, save, write, next step", async () => {
    const { d, deps, w } = harness({
      // URL, site, email, show.
      lines: [PUBLIC, SITE, EMAIL, ""],
      hidden: ["jira-token", ""],
    });
    // What was logged and opened before the email was asked for.
    let atEmail = { log: -1, opened: -1 };
    const ask = deps.promptLine;
    deps.promptLine = (q) => {
      if (q === EMAIL_Q) atEmail = { log: w.log.length, opened: w.opened.length };
      return ask(q);
    };
    await setup(d, {}, deps);
    expect(w.log.slice(0, atEmail.log)).toEqual([`Public URL: ${PUBLIC}`, "", ...TOKEN_HINT]);
    expect(atEmail.opened).toBe(1);
    expect(w.asked).toEqual([URL_Q, SITE_Q, EMAIL_Q, TOKEN_Q, WEBHOOK_Q, SHOW_Q, SAVE_BOTH_Q]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      "",
      ...TOKEN_HINT,
      ACT_AS,
      ...webhookBlock(),
      "",
      `Wrote integrations.jira to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(w.shown).toEqual([GENERATED]);
    // A new token and a new webhook: their pages open.
    expect(w.opened).toEqual([ADMIN, WEBHOOKS]);
    expect(readJson(d.configPath)).toEqual({
      port: 1,
      integrations: { jira: JIRA },
      publicUrl: PUBLIC,
    });
    expect(w.keychain.entries()).toEqual({
      "compose/JIRA_API_TOKEN": "jira-token",
      "compose/JIRA_WEBHOOK_SECRET": GENERATED,
    });
    // The secrets reach neither the log nor the config.
    const text = [...w.log, readFileSync(d.configPath, "utf8")].join("\n");
    expect(text).not.toContain("jira-token");
    expect(text).not.toContain(GENERATED);
  });

  it("without a terminal: flags and env, no question, nothing saved", async () => {
    const { d, deps, w } = harness({
      isTTY: false,
      env: { JIRA_API_TOKEN: "jira-token", JIRA_WEBHOOK_SECRET: "whsec" },
    });
    await setup(d, FLAGS, deps);
    expect(w.asked).toEqual([]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      "",
      "JIRA_API_TOKEN: from your environment",
      ACT_AS,
      "JIRA_WEBHOOK_SECRET: from your environment",
      ...webhookBlock("JIRA_WEBHOOK_SECRET from your environment"),
      "",
      `Wrote integrations.jira to ${d.configPath}`,
      "bun run up will use JIRA_API_TOKEN from your environment",
      "bun run up will use JIRA_WEBHOOK_SECRET from your environment",
      ...NEXT_COMPOSE,
    ]);
    expect((readJson(d.configPath).integrations as { jira: unknown }).jira).toEqual(JIRA);
    expect(w.keychain.entries()).toEqual({});
    expect(w.opened).toEqual([]);
  });

  it("no token without a terminal: refuses, writes nothing", async () => {
    const { d, deps, w } = harness({ isTTY: false, env: { JIRA_WEBHOOK_SECRET: "whsec" } });
    const before = readFileSync(d.configPath, "utf8");
    await expect(setup(d, FLAGS, deps)).rejects.toThrow(
      new SetupError(
        "no JIRA_API_TOKEN: run `bun run jira:setup` in a terminal, or set JIRA_API_TOKEN",
      ),
    );
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
    expect(w.fetched).toEqual([`${SITE}/_edge/tenant_info`]);
  });

  it("no token typed: nothing written", async () => {
    const { d, deps } = harness({ hidden: [""] });
    const before = readFileSync(d.configPath, "utf8");
    await expect(setup(d, FLAGS, deps)).rejects.toThrow(
      "No Jira API token entered: nothing was written. Run `bun run jira:setup` again when you have it.",
    );
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
  });

  it("a 401 from env stops; a typed one is asked for again until accepted", async () => {
    const env = harness({
      isTTY: false,
      env: { JIRA_API_TOKEN: "expired", JIRA_WEBHOOK_SECRET: "whsec" },
    });
    await expect(setup(env.d, FLAGS, env.deps)).rejects.toBeInstanceOf(CredentialRejected);

    const typed = harness({ hidden: ["expired", "jira-token", LONG_SECRET] });
    await setup(typed.d, FLAGS, typed.deps);
    expect(typed.w.asked.slice(0, 2)).toEqual([TOKEN_Q, TOKEN_Q]);
    expect(typed.w.log).toContain(rejected());
    expect(typed.w.log).toContain(ACT_AS);
  });

  it("a rejected saved token is kept and asked for again; the accepted one replaces it", async () => {
    const { d, deps, w } = harness({
      jira: JIRA,
      saved: { "compose/JIRA_API_TOKEN": "expired", "compose/JIRA_WEBHOOK_SECRET": "whsec" },
      hidden: ["", "jira-token"],
    });
    await setup(d, {}, deps);
    expect(w.asked).toEqual([KEEP_TOKEN_Q, TOKEN_Q, SAVE_TOKEN_Q]);
    expect(w.log).toContain("The saved JIRA_API_TOKEN for compose was rejected; keeping it");
    expect(w.keychain.entries()["compose/JIRA_API_TOKEN"]).toBe("jira-token");
  });

  it("a wrong email with a good saved token: the token stays saved", async () => {
    const saved = {
      "compose/JIRA_API_TOKEN": "jira-token",
      "compose/JIRA_WEBHOOK_SECRET": "whsec",
    };
    const { d, deps, w } = harness({ saved, hidden: ["", ""] });
    const before = readFileSync(d.configPath, "utf8");
    await expect(setup(d, { ...FLAGS, email: "typo@example.com" }, deps)).rejects.toThrow(
      "No Jira API token entered: nothing was written. Run `bun run jira:setup` again when you have it.",
    );
    expect(w.asked).toEqual([KEEP_TOKEN_Q, TOKEN_Q]);
    expect(w.log).toContain("The saved JIRA_API_TOKEN for compose was rejected; keeping it");
    expect(w.log).toContain(rejected("typo@example.com"));
    expect(w.keychain.entries()).toEqual(saved);
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
  });

  it("warns about a permission the bot holds in no project, and opens no page for it", async () => {
    const { d, deps, w } = harness({
      jira: JIRA,
      saved: { "compose/JIRA_API_TOKEN": "jira-token", "compose/JIRA_WEBHOOK_SECRET": "whsec" },
      hidden: [""],
      held: ["BROWSE_PROJECTS", "ADD_COMMENTS"],
    });
    await setup(d, {}, deps);
    expect(w.fetched).toContain(PERMISSIONS);
    expect(w.log).toContain(
      "warning: the bot lacks TRANSITION_ISSUES, LINK_ISSUES, ASSIGNABLE_USER (needed to assign issues to the bot) in every project: give the service account a role that has them in each project devbox works in",
    );
    expect(w.opened).toEqual([]);
  });

  it("statuses: a first run moves issues to In Progress when devbox starts, and nowhere when it finishes", async () => {
    const { d, deps } = harness({
      // URL, site, email, show.
      lines: [PUBLIC, SITE, EMAIL, ""],
      hidden: ["jira-token", ""],
    });
    await setup(d, {}, deps);
    expect(
      (readJson(d.configPath).integrations as { jira: JiraIntegration }).jira.statuses,
    ).toEqual({ started: "In Progress" });
  });

  it("re-run with the saved token: nothing asked, the settings kept", async () => {
    const saved = {
      "compose/JIRA_API_TOKEN": "jira-token",
      "compose/JIRA_WEBHOOK_SECRET": "whsec",
    };
    const { d, deps, w } = harness({
      jira: { ...JIRA, statuses: { started: "In Progress", done: "Done", failed: "Blocked" } },
      saved,
      hidden: [""],
    });
    await setup(d, {}, deps);
    expect(w.asked).toEqual([KEEP_TOKEN_Q]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      "",
      "JIRA_API_TOKEN: from the system keychain (compose)",
      ACT_AS,
      "JIRA_WEBHOOK_SECRET: from the system keychain (compose)",
      ...webhookBlock(
        "the JIRA_WEBHOOK_SECRET saved in the system keychain for compose (not shown; to replace it, run bun run secrets rm JIRA_WEBHOOK_SECRET, then bun run jira:setup)",
      ),
      "",
      `Wrote integrations.jira to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect((readJson(d.configPath).integrations as { jira: JiraIntegration }).jira).toEqual({
      ...JIRA,
      statuses: { started: "In Progress", done: "Done", failed: "Blocked" },
    });
    expect(w.keychain.entries()).toEqual(saved);
    expect(w.shown).toEqual([]);
    // Nothing new: the links are printed, no page opens.
    expect(w.opened).toEqual([]);
  });

  it("a saved token: the prompt to keep or replace it names the scopes", async () => {
    const { d, deps, w } = harness({
      jira: JIRA,
      saved: { "compose/JIRA_API_TOKEN": "old-token", "compose/JIRA_WEBHOOK_SECRET": "whsec" },
      validTokens: ["old-token", "jira-token"],
      hidden: ["jira-token"],
    });
    await setup(d, {}, deps);
    expect(w.asked[0]).toBe(KEEP_TOKEN_Q);
    expect(KEEP_TOKEN_Q).toContain("read:jira-work, write:jira-work and read:jira-user");
    // A saved token needs no Atlassian Administration hint.
    expect(w.log).not.toContain(TOKEN_HINT[0]);
  });

  it("rotation: a new token replaces the saved one, the other settings kept", async () => {
    const { d, deps, w } = harness({
      jira: { ...JIRA, allowRestrictedIssues: true },
      saved: { "compose/JIRA_API_TOKEN": "old-token", "compose/JIRA_WEBHOOK_SECRET": "whsec" },
      validTokens: ["old-token", "jira-token"],
      hidden: ["jira-token"],
    });
    await setup(d, {}, deps);
    expect(w.asked).toEqual([KEEP_TOKEN_Q, SAVE_TOKEN_Q]);
    expect((readJson(d.configPath).integrations as { jira: JiraIntegration }).jira).toEqual({
      ...JIRA,
      allowRestrictedIssues: true,
    });
    expect(w.keychain.entries()["compose/JIRA_API_TOKEN"]).toBe("jira-token");
  });

  it("rotation with the save declined: the old saved token is removed, so up asks", async () => {
    const { d, deps, w } = harness({
      jira: JIRA,
      saved: { "compose/JIRA_API_TOKEN": "old-token", "compose/JIRA_WEBHOOK_SECRET": "whsec" },
      validTokens: ["old-token", "jira-token"],
      hidden: ["jira-token"],
      save: false,
    });
    await setup(d, {}, deps);
    expect(w.asked).toEqual([KEEP_TOKEN_Q, SAVE_TOKEN_Q]);
    expect(w.keychain.entries()).toEqual({ "compose/JIRA_WEBHOOK_SECRET": "whsec" });
    expect(w.log).toContain(
      "Removed the old JIRA_API_TOKEN saved in the system keychain for compose, so that bun run up doesn't use it instead of the new one",
    );
    expect(w.log).toContain(
      "Set JIRA_API_TOKEN in your environment before bun run up; otherwise it asks for it in a terminal",
    );
    expect((readJson(d.configPath).integrations as { jira: JiraIntegration }).jira).toEqual(JIRA);
  });

  it("pasting the saved token again keeps it, as Enter does", async () => {
    const saved = {
      "compose/JIRA_API_TOKEN": "jira-token",
      "compose/JIRA_WEBHOOK_SECRET": "whsec",
    };
    const { d, deps, w } = harness({ jira: JIRA, saved, hidden: ["jira-token"], save: false });
    await setup(d, {}, deps);
    expect(w.asked).toEqual([KEEP_TOKEN_Q]);
    expect(w.keychain.entries()).toEqual(saved);
  });

  it("a typed webhook secret is used as it is; declining the save names env", async () => {
    const { d, deps, w } = harness({ hidden: ["jira-token", LONG_SECRET], save: false });
    await setup(d, FLAGS, deps);
    expect(w.log).toEqual(expect.arrayContaining(webhookBlock()));
    expect(w.log).toContain(
      "Set JIRA_API_TOKEN in your environment before bun run up; otherwise it asks for it in a terminal",
    );
    expect(w.log).toContain(
      "Set JIRA_WEBHOOK_SECRET in your environment before bun run up; otherwise it asks for it in a terminal",
    );
    // Nothing was saved before, so nothing is removed.
    expect(w.log.some((l) => l.startsWith("Removed"))).toBe(false);
    expect(w.shown).toEqual([]);
    expect(w.keychain.entries()).toEqual({});
  });

  it("refuses a typed webhook secret shorter than 20 characters, writing nothing", async () => {
    const { d, deps, w } = harness({ hidden: ["jira-token", "a".repeat(19)] });
    const before = readFileSync(d.configPath, "utf8");
    await expect(setup(d, FLAGS, deps)).rejects.toThrow(
      new SetupError(
        "the webhook secret you entered has 19 characters; it needs at least 20, as it is the only proof a delivery comes from Jira. Nothing was written: run `bun run jira:setup` again and press Enter to generate one, then set it in Jira",
      ),
    );
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
    expect(w.keychain.entries()).toEqual({});
    const ok = harness({ hidden: ["jira-token", "a".repeat(20)], save: false });
    await setup(ok.d, FLAGS, ok.deps);
    expect(ok.w.log).toEqual(expect.arrayContaining(webhookBlock()));
  });

  it("a re-run with a new public URL opens the webhooks page", async () => {
    const { d, deps, w } = harness({
      jira: JIRA,
      publicUrl: "https://old.example.com",
      saved: { "compose/JIRA_API_TOKEN": "jira-token", "compose/JIRA_WEBHOOK_SECRET": "whsec" },
      hidden: [""],
    });
    await setup(d, { publicUrl: PUBLIC }, deps);
    expect(w.opened).toEqual([WEBHOOKS]);
    expect(w.log).toContain(`  URL     ${PUBLIC}/webhook/jira`);
  });

  it("a re-run that generates a new webhook secret opens the webhooks page", async () => {
    const { d, deps, w } = harness({
      jira: JIRA,
      saved: { "compose/JIRA_API_TOKEN": "jira-token" },
      hidden: ["", ""],
      save: false,
    });
    await setup(d, {}, deps);
    expect(w.opened).toEqual([WEBHOOKS]);
    expect(w.shown).toEqual([GENERATED]);
  });

  it("no webhook secret without a terminal: shows the webhook, then refuses, writing nothing", async () => {
    const { d, deps, w } = harness({ isTTY: false, env: { JIRA_API_TOKEN: "jira-token" } });
    const before = readFileSync(d.configPath, "utf8");
    await expect(setup(d, FLAGS, deps)).rejects.toThrow(
      "no JIRA_WEBHOOK_SECRET: run `bun run jira:setup` in a terminal to generate one, or set JIRA_WEBHOOK_SECRET to the secret of the webhook in Jira",
    );
    expect(w.log).toEqual(expect.arrayContaining(webhookBlock()));
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
  });

  it("each missing setting without a terminal names its flag", async () => {
    const env = { JIRA_API_TOKEN: "jira-token", JIRA_WEBHOOK_SECRET: "whsec" };
    const cases: Array<[keyof SetupOptions, string]> = [
      [
        "site",
        "no Jira site URL: pass --site <https://…>, or run `bun run jira:setup` in a terminal",
      ],
      [
        "email",
        "no service account email: pass --email <address>, or run `bun run jira:setup` in a terminal",
      ],
    ];
    for (const [flag, message] of cases) {
      const { d, deps } = harness({ isTTY: false, env });
      const { [flag]: _, ...rest } = FLAGS;
      await expect(setup(d, rest, deps)).rejects.toThrow(new SetupError(message));
    }
  });

  it("refuses bad values", async () => {
    const env = { JIRA_API_TOKEN: "jira-token", JIRA_WEBHOOK_SECRET: "whsec" };
    const cases: Array<[Partial<SetupOptions>, string]> = [
      [
        { site: "https://example.atlassian.net/jira" },
        "the Jira site URL must be an https origin such as https://example.atlassian.net",
      ],
      [{ email: "devbox" }, "the service account's email must be an email address"],
    ];
    for (const [opts, message] of cases) {
      const { d, deps } = harness({ isTTY: false, env });
      await expect(setup(d, { ...FLAGS, ...opts }, deps)).rejects.toThrow(new SetupError(message));
    }
  });

  it("k8s with the user's own integrations Secret: no save, names the Secret", async () => {
    const { d, deps, w } = harness({
      deployment: K8S,
      byoIntegrationsSecret: "my-integrations",
      saved: { "k8s:kind-devbox/devbox/JIRA_API_TOKEN": "jira-token" },
      hidden: [""],
    });
    await setup(d, FLAGS, deps);
    const flag = ` --target ${d.configPath}`;
    // No webhook secret asked for and no save offered: the Secret holds them.
    expect(w.asked).toEqual([KEEP_TOKEN_Q]);
    expect(w.log.slice(-14)).toEqual([
      ...webhookBlock('JIRA_WEBHOOK_SECRET from Secret "my-integrations"'),
      "",
      `Wrote integrations.jira to ${d.configPath}`,
      'Put JIRA_API_TOKEN and JIRA_WEBHOOK_SECRET in Secret "my-integrations" in namespace devbox.',
      `Next: bun run k8s:install${flag} (setup applies nothing)`,
      `With GitOps, set the chart values integrations.jira.* to the integrations.jira block in ${d.configPath} instead, with enabled: true`,
      `Then check Jira with: bun run jira:status${flag}`,
    ]);
  });

  it("k8s with the user's own integrations Secret: a pasted token is not offered for saving", async () => {
    const { d, deps, w } = harness({
      deployment: K8S,
      byoIntegrationsSecret: "my-integrations",
      hidden: ["jira-token"],
    });
    await setup(d, FLAGS, deps);
    expect(w.asked).toEqual([TOKEN_Q]);
    expect(w.keychain.entries()).toEqual({});
  });

  it("a changed public URL names what else to update", async () => {
    const { d, deps, w } = harness({
      jira: JIRA,
      publicUrl: "https://old.example.com",
      env: { JIRA_API_TOKEN: "jira-token", JIRA_WEBHOOK_SECRET: "whsec" },
      isTTY: false,
    });
    await setup({ ...d, linear: true }, { publicUrl: PUBLIC }, deps);
    expect(w.log).toContain(`Update the webhook URL in the Linear app to ${PUBLIC}/webhook/linear`);
    expect(readJson(d.configPath).publicUrl).toBe(PUBLIC);
  });
});
