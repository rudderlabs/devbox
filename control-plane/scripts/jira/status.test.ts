import { describe, expect, it } from "bun:test";
import type { JiraIntegration } from "../lib/integrations";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { PeekDeps } from "../lib/secrets";
import type { JiraDeployment } from "./deployment";
import { status } from "./status";

const COMPOSE: Deployment = { kind: "compose" };
const PUBLIC = "https://hooks.example.com";
const BOT_ID = "712020:00000000-0000-0000-0000-000000000000";
const JIRA: JiraIntegration = {
  enabled: true,
  siteUrl: "https://example.atlassian.net",
  cloudId: "00000000-0000-0000-0000-000000000000",
  botEmail: "devbox@example.com",
  botAccountId: BOT_ID,
  botName: "devbox",
  projectKeys: ["ENG", "OPS"],
  trustedGroups: ["jira-software-users"],
  statuses: { started: "In Progress", done: "Done" },
  tokenExpiresAt: "2027-06-30",
};
const BODY = {
  configured: true,
  lastWebhookAt: "2026-11-02T07:55:25.031Z",
  bot: { accountId: BOT_ID, name: "devbox" },
  auth: "ok",
  tokenDaysLeft: 238,
  trust: { source: "groups", cachedAccounts: 3 },
  projects: {
    ENG: { missingPermissions: [], missingStatuses: [] },
    OPS: {
      missingPermissions: ["LINK_ISSUES", "ASSIGNABLE_USER"],
      missingStatuses: ["In Progress"],
    },
  },
  lastReplyFailure: null,
  holds: { heldTasks: 0, oldestHoldAgeMs: 0 },
};
const PROBE_URL = `${PUBLIC}/webhook/jira`;
const unsigned = () => Response.json({ error: "invalid signature" }, { status: 401 });

async function run(o: {
  jira?: JiraIntegration;
  publicUrl?: string | null;
  api?: () => Promise<Response>;
  fetch?: () => Response;
  byo?: string;
}): Promise<{ log: string[]; probed: string[] }> {
  const log: string[] = [];
  const probed: string[] = [];
  const d: JiraDeployment = {
    deployment: COMPOSE,
    configPath: "devbox.config.json",
    jira: o.jira,
    linear: false,
    ...(o.publicUrl === null ? {} : { publicUrl: o.publicUrl ?? PUBLIC }),
    flag: "",
    applyCommand: "bun run up",
    ...(o.byo ? { byoIntegrationsSecret: o.byo } : {}),
    api: o.api ?? (async () => Response.json(BODY)),
  };
  const resolver = {
    env: { JIRA_WEBHOOK_SECRET: "whsec" },
    keychain: new MemoryKeychain({ "compose/JIRA_API_TOKEN": "jira-token" }),
    deployment: COMPOSE,
    run: async () => ({ code: 1, stdout: "" }),
  } as unknown as PeekDeps;
  await status(d, {
    resolver,
    fetch: async (url) => {
      probed.push(url);
      return (o.fetch ?? unsigned)();
    },
    log: (l) => log.push(l),
  });
  return { log, probed };
}

const HEAD = [
  "Jira (compose)",
  "  site            https://example.atlassian.net",
  "  bot             devbox (devbox@example.com)",
  "  projectKeys     ENG, OPS",
  "  trust           groups jira-software-users",
  "  tokenExpiresAt  2027-06-30",
  "  publicUrl       https://hooks.example.com",
  "  JIRA_API_TOKEN       keychain",
  "  JIRA_WEBHOOK_SECRET  env",
];
const CP = [
  "Control plane: bot devbox, auth ok, last webhook from Jira 2026-11-02T07:55:25.031Z",
  "API token: expires in 238 days",
  "Trust: groups, 3 accounts cached",
  "Project ENG: ok",
  'Project OPS: missing LINK_ISSUES, ASSIGNABLE_USER (needed to assign issues to the bot); no status "In Progress"',
];
const OK_LINE = `Webhook URL ${PROBE_URL}: reaches devbox with Jira on`;

describe("jira status", () => {
  it("not configured, disabled", async () => {
    expect((await run({})).log).toEqual([
      "Jira is not configured for compose. Run: bun run jira:setup",
    ]);
    const off = await run({ jira: { ...JIRA, enabled: false } });
    expect(off.log).toEqual([
      "Jira is disabled for compose (enabled: false in devbox.config.json). Turn it on again: bun run jira:setup, or set enabled to true, then bun run up.",
    ]);
    expect(off.probed).toEqual([]);
  });

  it("configured: block, sources, the control plane's summary, probe ok", async () => {
    const r = await run({ jira: JIRA });
    expect(r.log).toEqual([...HEAD, ...CP, OK_LINE]);
    expect(r.probed).toEqual([PROBE_URL]);
  });

  it("a rejected token, a short expiry, a trust error, failed and held replies", async () => {
    const r = await run({
      jira: JIRA,
      api: async () =>
        Response.json({
          ...BODY,
          lastWebhookAt: null,
          auth: "rejected",
          tokenDaysLeft: 5,
          trust: { source: "groups+users", cachedAccounts: 0, lastError: "HttpError 503" },
          projects: { ENG: { error: "TimeoutError" } },
          lastReplyFailure: { status: 400, at: "2026-11-02T08:00:00.000Z" },
          holds: { heldTasks: 2, oldestHoldAgeMs: 300_000 },
        }),
    });
    expect(r.log.slice(HEAD.length)).toEqual([
      "Control plane: bot devbox, auth rejected, last webhook from Jira none yet",
      "Jira rejects JIRA_API_TOKEN: create a new token for the service account, run bun run jira:setup, then bun run up",
      "API token: expires in 5 days: rotate it soon (create a new one, then run bun run jira:setup)",
      "Trust: groups+users, 0 accounts cached, last lookup failed: HttpError 503",
      "Project ENG: can't check (TimeoutError)",
      "Last failed reply to Jira: HTTP 400 at 2026-11-02T08:00:00.000Z",
      "Replies held for 2 task(s), the oldest for 5 min: Jira is refusing or rate-limiting them",
      OK_LINE,
    ]);
  });

  it("trust by group without Browse users and groups", async () => {
    const r = await run({
      jira: JIRA,
      api: async () =>
        Response.json({
          ...BODY,
          trust: {
            source: "groups",
            cachedAccounts: 0,
            lastError: "http_403",
            missingPermissions: ["USER_PICKER"],
          },
        }),
    });
    expect(r.log).toContain(
      "Trust: groups, 0 accounts cached, last lookup failed: http_403, missing USER_PICKER (the global permission Browse users and groups, needed to trust groups): grant it to a group the service account is in (Jira Settings → System → Global permissions)",
    );
  });

  it("trust: everyone with access to the site without lists, else the groups and users", async () => {
    const { trustedGroups: _, ...noTrust } = JIRA;
    const site = await run({
      jira: noTrust,
      api: async () => Response.json({ ...BODY, trust: { source: "site", cachedAccounts: 0 } }),
    });
    expect(site.log).toEqual([
      ...HEAD.map((l) =>
        l.startsWith("  trust ") ? "  trust           everyone with access to the site" : l,
      ),
      ...CP.map((l) => (l.startsWith("Trust:") ? "Trust: everyone with access to the site" : l)),
      OK_LINE,
    ]);
    expect(site.log.some((l) => l.includes("USER_PICKER"))).toBe(false);

    const both = await run({
      jira: { ...JIRA, trustedGroups: ["a", "Site admins"], trustedUsers: [BOT_ID] },
    });
    expect(both.log).toContain(`  trust           groups a, Site admins; users ${BOT_ID}`);
  });

  it("an expired token and a reply with no answer", async () => {
    const r = await run({
      jira: JIRA,
      api: async () =>
        Response.json({
          ...BODY,
          tokenDaysLeft: -3,
          projects: {},
          lastReplyFailure: { status: null, at: "2026-11-02T08:00:00.000Z" },
        }),
    });
    expect(r.log).toContain("API token: expired 3 days ago");
    expect(r.log).toContain("Last failed reply to Jira: no answer at 2026-11-02T08:00:00.000Z");
  });

  it("the user's Secret, an unreachable control plane, Jira not on there yet", async () => {
    const byo = await run({ jira: JIRA, byo: "my-integrations" });
    expect(byo.log.slice(7, 9)).toEqual([
      '  JIRA_API_TOKEN       from Secret "my-integrations" (not read)',
      '  JIRA_WEBHOOK_SECRET  from Secret "my-integrations" (not read)',
    ]);
    const down = await run({
      jira: JIRA,
      api: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(down.log).toEqual([
      ...HEAD,
      "Control plane: not reachable (connect ECONNREFUSED)",
      OK_LINE,
    ]);
    const off = await run({ jira: JIRA, api: async () => Response.json({ configured: false }) });
    expect(off.log).toEqual([
      ...HEAD,
      "Control plane: Jira is not on there yet. Run: bun run up",
      OK_LINE,
    ]);
  });

  it("the probe's failure, and no probe without a public URL", async () => {
    const r = await run({ jira: JIRA, fetch: () => new Response("Not Found", { status: 404 }) });
    expect(r.log.at(-1)).toBe(
      `the webhook URL ${PROBE_URL} got 404: something answered, but not devbox with Jira on. Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that integrations.jira.enabled is true and applied, or restart the control plane`,
    );
    const none = await run({ jira: JIRA, publicUrl: null });
    expect(none.probed).toEqual([]);
    expect(none.log).toContain("  publicUrl       not set");
  });
});
