import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { PeekDeps } from "../lib/secrets";
import { type LinearDeployment, loadDeployment } from "./deployment";
import { status } from "./status";

const COMPOSE: Deployment = { kind: "compose" };
const LINEAR = { enabled: true, clientId: "lin-client-id" };
const PUBLIC = "https://hooks.example.com";
const BODY = {
  configured: true,
  workspace: { id: "o1", name: "Example", urlKey: "example" },
  appUser: { id: "u1", name: "devbox" },
  lastWebhookAt: "2026-10-16T07:55:25.031Z",
  lastTokenError: null,
};
const PROBE_URL = "https://hooks.example.com/webhook/linear";
const unsigned = () => Response.json({ error: "invalid signature" }, { status: 401 });

async function run(o: {
  linear?: Partial<typeof LINEAR> & { enabled: boolean };
  // The top-level publicUrl; PUBLIC unless null.
  publicUrl?: string | null;
  api?: () => Promise<Response>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  byo?: string;
  fromApiIngress?: boolean;
}): Promise<{ log: string[]; probed: string[] }> {
  const log: string[] = [];
  const probed: string[] = [];
  const d: LinearDeployment = {
    deployment: COMPOSE,
    configPath: "devbox.config.json",
    linear: o.linear,
    ...(o.publicUrl === null ? {} : { publicUrl: o.publicUrl ?? PUBLIC }),
    applyCommand: "bun run up",
    statusCommand: "bun run linear:status",
    ...(o.byo ? { byoIntegrationsSecret: o.byo } : {}),
    ...(o.fromApiIngress ? { fromApiIngress: true } : {}),
    api: o.api ?? (async () => Response.json(BODY)),
  };
  const resolver = {
    env: { LINEAR_WEBHOOK_SECRET: "whsec" },
    keychain: new MemoryKeychain({ "compose/LINEAR_CLIENT_SECRET": "csecret" }),
    deployment: COMPOSE,
    run: async () => ({ code: 1, stdout: "" }),
  } as unknown as PeekDeps;
  await status(d, {
    resolver,
    fetch: async (url, init) => {
      probed.push(url);
      return (o.fetch ?? unsigned)(url, init);
    },
    log: (l) => log.push(l),
  });
  return { log, probed };
}

const HEAD = [
  "Linear (compose)",
  "  clientId   lin-client-id",
  "  publicUrl  https://hooks.example.com",
  "  LINEAR_CLIENT_SECRET   keychain",
  "  LINEAR_WEBHOOK_SECRET  env",
];
const OK_LINE = `Webhook URL ${PROBE_URL}: reaches devbox with Linear on`;
const CP_LINE =
  "Control plane: workspace Example (example), app user devbox, last webhook from Linear 2026-10-16T07:55:25.031Z";

describe("linear status", () => {
  it("not configured", async () => {
    const r = await run({});
    expect(r.log).toEqual(["Linear is not configured for compose. Run: bun run linear:setup"]);
    expect(r.probed).toEqual([]);
  });

  it("disabled", async () => {
    const r = await run({ linear: { ...LINEAR, enabled: false } });
    expect(r.log).toEqual([
      "Linear is disabled for compose (enabled: false in devbox.config.json). Turn it on again: bun run linear:setup, or set enabled to true, then bun run up.",
    ]);
    expect(r.probed).toEqual([]);
  });

  it("configured: block, sources, control plane, probe ok", async () => {
    const r = await run({ linear: LINEAR });
    expect(r.log).toEqual([...HEAD, CP_LINE, OK_LINE]);
    expect(r.probed).toEqual([PROBE_URL]);
  });

  it("the user's Secret: sources say from Secret (not read)", async () => {
    const r = await run({ linear: LINEAR, byo: "my-integrations" });
    expect(r.log).toEqual([
      "Linear (compose)",
      "  clientId   lin-client-id",
      "  publicUrl  https://hooks.example.com",
      '  LINEAR_CLIENT_SECRET   from Secret "my-integrations" (not read)',
      '  LINEAR_WEBHOOK_SECRET  from Secret "my-integrations" (not read)',
      CP_LINE,
      OK_LINE,
    ]);
  });

  it("control plane unreachable: the probe still runs", async () => {
    const r = await run({
      linear: LINEAR,
      api: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(r.log).toEqual([
      ...HEAD,
      "Control plane: not reachable (connect ECONNREFUSED)",
      OK_LINE,
    ]);
  });

  it("configured false: the apply-command hint", async () => {
    const r = await run({
      linear: LINEAR,
      api: async () => Response.json({ configured: false }),
    });
    expect(r.log).toEqual([
      ...HEAD,
      "Control plane: Linear is not on there yet. Run: bun run up",
      OK_LINE,
    ]);
  });

  it("last webhook from Linear: none yet", async () => {
    const r = await run({
      linear: LINEAR,
      api: async () => Response.json({ ...BODY, lastWebhookAt: null }),
    });
    expect(r.log).toEqual([
      ...HEAD,
      "Control plane: workspace Example (example), app user devbox, last webhook from Linear none yet",
      OK_LINE,
    ]);
  });

  it("probe 404 / no answer / VPN hint", async () => {
    const notFound = await run({
      linear: LINEAR,
      fetch: async () => new Response("nope", { status: 404 }),
    });
    expect(notFound.log).toEqual([
      ...HEAD,
      CP_LINE,
      `the webhook URL ${PROBE_URL} got 404: something answered, but not devbox with Linear on. Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that integrations.linear.enabled is true and applied, or restart the control plane`,
    ]);

    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    const noAnswer = await run({ linear: LINEAR, fetch: down });
    expect(noAnswer.log).toEqual([
      ...HEAD,
      CP_LINE,
      `the webhook URL ${PROBE_URL} got no answer (ECONNREFUSED): the public URL does not reach devbox. Is the tunnel down, or the Ingress or DNS not ready yet?`,
    ]);

    const vpn = await run({ linear: LINEAR, fetch: down, fromApiIngress: true });
    expect(vpn.log).toEqual([
      ...HEAD,
      CP_LINE,
      `the webhook URL ${PROBE_URL} got no answer (ECONNREFUSED): the public URL does not reach devbox. Is the tunnel down, or the Ingress or DNS not ready yet? The URL comes from ingress.api, which may be reachable only over a VPN: enable a public ingress.webhooks in the target file`,
    ]);
  });

  it("no publicUrl: no probe", async () => {
    const r = await run({ linear: LINEAR, publicUrl: null });
    expect(r.log).toEqual([
      "Linear (compose)",
      "  clientId   lin-client-id",
      "  publicUrl  not set",
      "  LINEAR_CLIENT_SECRET   keychain",
      "  LINEAR_WEBHOOK_SECRET  env",
      CP_LINE,
    ]);
    expect(r.probed).toEqual([]);
  });

  it("lastTokenError", async () => {
    const r = await run({
      linear: LINEAR,
      api: async () => Response.json({ ...BODY, lastTokenError: "invalid_client" }),
    });
    expect(r.log).toEqual([...HEAD, CP_LINE, "Last Linear token error: invalid_client", OK_LINE]);
  });
});

describe("linear status on kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "devbox-linear-status-"));
  let savedXdg: string | undefined;
  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    // No CLI profiles.
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(dir, "config-"));
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const KIND: Deployment = { kind: "k8s", context: "kind-devbox", namespace: "devbox" };
  let n = 0;

  async function onKind(
    linear: typeof LINEAR,
    api?: () => Promise<Response>,
  ): Promise<{ path: string; log: string[] }> {
    const path = join(dir, `t${n++}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        context: "kind-devbox",
        profile: "k8s-kind-devbox",
        publicUrl: PUBLIC,
        integrations: { linear },
      }),
    );
    const loaded = loadDeployment({ target: path, noKeychain: true });
    const d = api ? { ...loaded, api } : loaded;
    const log: string[] = [];
    const resolver = {
      env: { LINEAR_WEBHOOK_SECRET: "whsec" },
      keychain: new MemoryKeychain({ "k8s:kind-devbox/devbox/LINEAR_CLIENT_SECRET": "csecret" }),
      deployment: KIND,
      run: async () => ({ code: 1, stdout: "" }),
    } as unknown as PeekDeps;
    await status(d, { resolver, fetch: async () => unsigned(), log: (l) => log.push(l) });
    return { path, log };
  }

  const KIND_HEAD = [
    "Linear (k8s:kind-devbox/devbox)",
    "  clientId   lin-client-id",
    "  publicUrl  https://hooks.example.com",
    "  LINEAR_CLIENT_SECRET   keychain",
    "  LINEAR_WEBHOOK_SECRET  env",
  ];

  it("the apply and profile hints name k8s:kind", async () => {
    expect((await onKind(LINEAR)).log).toEqual([
      ...KIND_HEAD,
      'Control plane: not reachable (no CLI profile "k8s-kind-devbox": run `bun run k8s:kind` first)',
      OK_LINE,
    ]);
    const off = await onKind(LINEAR, async () => Response.json({ configured: false }));
    expect(off.log).toEqual([
      ...KIND_HEAD,
      "Control plane: Linear is not on there yet. Run: bun run k8s:kind",
      OK_LINE,
    ]);
    const disabled = await onKind({ ...LINEAR, enabled: false });
    expect(disabled.log).toEqual([
      `Linear is disabled for k8s:kind-devbox/devbox (enabled: false in ${disabled.path}). Turn it on again: bun run linear:setup, or set enabled to true, then bun run k8s:kind.`,
    ]);
  });
});
