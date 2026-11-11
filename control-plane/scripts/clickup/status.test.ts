import { describe, expect, it } from "bun:test";
import type { ClickupIntegration } from "../lib/integrations";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { PeekDeps } from "../lib/secrets";
import type { ClickupDeployment } from "./deployment";
import { status } from "./status";

const COMPOSE: Deployment = { kind: "compose" };
const PUBLIC = "https://hooks.example.com";
const CLICKUP: ClickupIntegration = {
  enabled: true,
  teamId: "9000000000",
  botUserId: 100000001,
  botName: "devbox",
  statuses: { started: "in progress" },
};
const BODY = {
  configured: true,
  bot: { id: 100000001, name: "devbox" },
  team: "9000000000",
  auth: "ok",
  lastWebhookAt: "2026-11-02T07:55:25.031Z",
  webhook: { health: "active", failCount: 0 },
  lastReplyFailure: null,
};
const PROBE_URL = `${PUBLIC}/webhook/clickup`;
const unsigned = () => Response.json({ error: "invalid signature" }, { status: 403 });

async function run(o: {
  clickup?: ClickupIntegration;
  publicUrl?: string | null;
  api?: () => Promise<Response>;
  fetch?: () => Response;
  byo?: string;
}): Promise<{ log: string[]; probed: string[] }> {
  const log: string[] = [];
  const probed: string[] = [];
  const d: ClickupDeployment = {
    deployment: COMPOSE,
    configPath: "devbox.config.json",
    clickup: o.clickup,
    integrations: {},
    ...(o.publicUrl === null ? {} : { publicUrl: o.publicUrl ?? PUBLIC }),
    flag: "",
    applyCommand: "bun run up",
    ...(o.byo ? { byoIntegrationsSecret: o.byo } : {}),
    api: o.api ?? (async () => Response.json(BODY)),
  };
  const resolver = {
    env: { CLICKUP_WEBHOOK_SECRET: "whsec" },
    keychain: new MemoryKeychain({ "compose/CLICKUP_API_TOKEN": "pk_bot" }),
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
  "ClickUp (compose)",
  "  workspace       9000000000",
  "  bot             devbox (user 100000001)",
  "  publicUrl       https://hooks.example.com",
  "  CLICKUP_API_TOKEN       keychain",
  "  CLICKUP_WEBHOOK_SECRET  env",
];
const CP = [
  "Control plane: bot devbox, auth ok, last webhook from ClickUp 2026-11-02T07:55:25.031Z",
  "Webhook in ClickUp: active",
];
const OK_LINE = `Webhook URL ${PROBE_URL}: reaches devbox with ClickUp on`;

describe("clickup status", () => {
  it("not configured, disabled", async () => {
    expect((await run({})).log).toEqual([
      "ClickUp is not configured for compose. Run: bun run clickup:setup",
    ]);
    const off = await run({ clickup: { ...CLICKUP, enabled: false } });
    expect(off.log).toEqual([
      "ClickUp is disabled for compose (enabled: false in devbox.config.json). Turn it on again: bun run clickup:setup, or set enabled to true, then bun run up.",
    ]);
    expect(off.probed).toEqual([]);
  });

  it("configured: block, sources, the control plane's summary, the 403 probe ok", async () => {
    const r = await run({ clickup: CLICKUP });
    expect(r.log).toEqual([...HEAD, ...CP, OK_LINE]);
    expect(r.probed).toEqual([PROBE_URL]);
  });

  it("a rejected token, a suspended webhook, a failed reply", async () => {
    const r = await run({
      clickup: CLICKUP,
      api: async () =>
        Response.json({
          ...BODY,
          lastWebhookAt: null,
          auth: "rejected",
          webhook: { health: "suspended", failCount: 100 },
          lastReplyFailure: { at: "2026-11-02T08:00:00.000Z", error: "HTTP 400" },
        }),
    });
    expect(r.log.slice(HEAD.length)).toEqual([
      "Control plane: bot devbox, auth rejected, last webhook from ClickUp none yet",
      "ClickUp rejects CLICKUP_API_TOKEN: generate a new personal token for the bot, run bun run clickup:setup, then bun run up",
      "Webhook in ClickUp: suspended, 100 failed deliveries",
      "ClickUp sends nothing to a suspended webhook: bun run clickup:setup reactivates it",
      "Last failed reply to ClickUp: HTTP 400 at 2026-11-02T08:00:00.000Z",
      OK_LINE,
    ]);
  });

  it("no webhook in ClickUp; its health unknown to the control plane", async () => {
    const none = await run({
      clickup: CLICKUP,
      api: async () => Response.json({ ...BODY, webhook: null }),
    });
    expect(none.log).toContain(
      "Webhook in ClickUp: none for this workspace. Run: bun run clickup:setup",
    );
    const { webhook: _, ...noField } = BODY;
    const unknown = await run({ clickup: CLICKUP, api: async () => Response.json(noField) });
    expect(unknown.log.some((l) => l.startsWith("Webhook in ClickUp"))).toBe(false);
  });

  it("the user's Secret, an unreachable control plane, ClickUp not on there yet", async () => {
    const byo = await run({ clickup: CLICKUP, byo: "my-integrations" });
    expect(byo.log.slice(HEAD.length - 2, HEAD.length)).toEqual([
      '  CLICKUP_API_TOKEN       from Secret "my-integrations" (not read)',
      '  CLICKUP_WEBHOOK_SECRET  from Secret "my-integrations" (not read)',
    ]);
    const down = await run({
      clickup: CLICKUP,
      api: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(down.log).toEqual([
      ...HEAD,
      "Control plane: not reachable (connect ECONNREFUSED)",
      OK_LINE,
    ]);
    const off = await run({
      clickup: CLICKUP,
      api: async () => Response.json({ configured: false }),
    });
    expect(off.log).toEqual([
      ...HEAD,
      "Control plane: ClickUp is not on there yet. Run: bun run up",
      OK_LINE,
    ]);
  });

  it("the probe's failure, and no probe without a public URL", async () => {
    const r = await run({
      clickup: CLICKUP,
      fetch: () => new Response("Not Found", { status: 404 }),
    });
    expect(r.log.at(-1)).toBe(
      `the webhook URL ${PROBE_URL} got 404: something answered, but not devbox with ClickUp on. Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that integrations.clickup.enabled is true and applied, or restart the control plane`,
    );
    const none = await run({ clickup: CLICKUP, publicUrl: null });
    expect(none.probed).toEqual([]);
    expect(none.log).toContain("  publicUrl       not set");
  });
});
