import { describe, expect, it } from "bun:test";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { PeekDeps } from "../lib/secrets";
import type { GithubDeployment } from "./deployment";
import { status } from "./status";

const COMPOSE: Deployment = { kind: "compose" };
const K8S: Deployment = { kind: "k8s", context: "kind-devbox", namespace: "devbox" };
const APP = {
  enabled: true,
  appId: 123,
  slug: "example-devbox",
  installationId: 7,
  botUserId: 1234567,
  tokens: "devbox" as const,
  tokenScope: "repos" as const,
  ciResults: true,
};
const PUBLIC = "https://hooks.example.com";
const PROBE_URL = `${PUBLIC}/webhook/github`;
const NOW = new Date("2026-10-19T12:00:00Z");
const BODY = {
  token: {
    source: "file",
    expiresAt: "2026-10-19T12:31:00Z",
    readAt: "2026-10-19T11:32:10Z",
    lastError: null,
  },
  webhooks: { enabled: true, lastWebhookAt: "2026-10-19T11:20:02Z", ciResults: true },
};
const unsigned = () => Response.json({ error: "invalid signature" }, { status: 401 });

async function run(o: {
  app?: Partial<Omit<typeof APP, "tokens">> & {
    tokens?: "devbox" | "external";
    tokenFile?: string;
    org?: string;
    pending?: { appId: number; slug: string; org?: string };
  };
  none?: boolean;
  deployment?: Deployment;
  publicUrl?: string | null;
  api?: () => Promise<Response>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  byoGithub?: string;
  byoKey?: string;
  byoIntegrations?: string;
  fromApiIngress?: boolean;
  env?: Record<string, string>;
  keychain?: Record<string, string>;
  tokenFileExists?: boolean;
}): Promise<{ log: string[]; probed: string[] }> {
  const log: string[] = [];
  const probed: string[] = [];
  const deployment = o.deployment ?? COMPOSE;
  const k8s = deployment.kind === "k8s";
  const d: GithubDeployment = {
    deployment,
    configPath: "devbox.config.json",
    githubApp: o.none ? undefined : { ...APP, ...o.app },
    linear: false,
    repos: [],
    trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
    ...(o.publicUrl === null ? {} : { publicUrl: o.publicUrl ?? PUBLIC }),
    applyCommand: k8s ? "bun run k8s:kind" : "bun run up",
    statusCommand: "bun run github:status",
    ...(o.byoGithub ? { byoGithubSecret: o.byoGithub } : {}),
    ...(o.byoKey ? { byoKeySecret: o.byoKey } : {}),
    ...(o.byoIntegrations ? { byoIntegrationsSecret: o.byoIntegrations } : {}),
    ...(o.fromApiIngress ? { fromApiIngress: true } : {}),
    api: o.api ?? (async () => Response.json(BODY)),
  };
  const scope = k8s ? "k8s:kind-devbox/devbox" : "compose";
  const resolver = {
    env: o.env ?? { GITHUB_WEBHOOK_SECRET: "whsec" },
    keychain: new MemoryKeychain(
      o.keychain ?? { [`${scope}/GITHUB_APP_PRIVATE_KEY`]: "-----BEGIN-----" },
    ),
    deployment,
    run: async () => ({ code: 1, stdout: "" }),
  } as unknown as PeekDeps;
  await status(d, {
    resolver,
    now: () => NOW,
    fileExists: () => o.tokenFileExists === true,
    fetch: async (url, init) => {
      probed.push(url);
      return (o.fetch ?? unsigned)(url, init);
    },
    log: (l) => log.push(l),
  });
  return { log, probed };
}

const SETTINGS_URL = "https://github.com/settings/apps/example-devbox";
const settings = (
  scope: string,
  o: { tokens?: string; settingsUrl?: string; publicUrl?: string } = {},
) => [
  `GitHub App (${scope})`,
  "  appId           123",
  "  slug            example-devbox",
  `  settings        ${o.settingsUrl ?? SETTINGS_URL}`,
  "  installationId  7",
  "  botUserId       1234567",
  `  tokens          ${o.tokens ?? "devbox"}`,
  "  tokenScope      repos",
  "  ciResults       true",
  "  trustedOrgs     example-org",
  "  trustedUsers    none",
  `  publicUrl       ${o.publicUrl ?? "https://hooks.example.com"}`,
];
const KEY_LINE = "  GITHUB_APP_PRIVATE_KEY  keychain";
const SECRET_LINE = "  GITHUB_WEBHOOK_SECRET   env";
const HEAD = [...settings("compose"), KEY_LINE, SECRET_LINE];
const CP = [
  "Control plane: token expires 2026-10-19T12:31:00Z (refreshed 2026-10-19T11:32:10Z)",
  "Control plane: last webhook from GitHub 2026-10-19T11:20:02Z",
];
const OK_LINE = `Webhook URL ${PROBE_URL}: reaches devbox with GitHub on`;
const MINTER_COMPOSE = "docker compose -f control-plane/docker-compose.yml logs github-token";
const MINTER_K8S = "kubectl --context kind-devbox -n devbox logs deploy/devbox-github-token";

describe("github status", () => {
  it("no App: the personal token and its source", async () => {
    const r = await run({ none: true, env: { GITHUB_TOKEN: "ghp_secret" } });
    expect(r.log).toEqual([
      "GitHub uses a personal token for compose (no App). Webhooks need an App: bun run github:setup",
      "  GITHUB_TOKEN  env",
    ]);
    expect(r.probed).toEqual([]);
    const missing = await run({ none: true, env: {}, keychain: {} });
    expect(missing.log[1]).toBe("  GITHUB_TOKEN  missing");
    const saved = await run({
      none: true,
      env: {},
      keychain: { "compose/GITHUB_TOKEN": "ghp_secret" },
    });
    expect(saved.log[1]).toBe("  GITHUB_TOKEN  keychain");
  });

  it("no App on k8s with the user's own token Secret: not read", async () => {
    const r = await run({ none: true, deployment: K8S, byoGithub: "my-token" });
    expect(r.log).toEqual([
      "GitHub uses a personal token for k8s:kind-devbox/devbox (no App). Webhooks need an App: bun run github:setup",
      '  GITHUB_TOKEN  from Secret "my-token" (not read)',
    ]);
  });

  it("disabled", async () => {
    const r = await run({ app: { enabled: false } });
    expect(r.log).toEqual([
      "The GitHub App is disabled for compose (enabled: false in devbox.config.json); GitHub uses a personal token. Turn it on again: bun run github:setup, or set enabled to true, then bun run up.",
    ]);
    expect(r.probed).toEqual([]);
  });

  it("configured: settings, sources, control plane, probe ok", async () => {
    const r = await run({});
    expect(r.log).toEqual([...HEAD, ...CP, OK_LINE]);
    expect(r.probed).toEqual([PROBE_URL]);
  });

  it("an organization's App links the organization's settings page", async () => {
    const r = await run({ app: { org: "example-org" } });
    expect(r.log).toEqual([
      ...settings("compose", {
        settingsUrl: "https://github.com/organizations/example-org/settings/apps/example-devbox",
      }),
      KEY_LINE,
      SECRET_LINE,
      ...CP,
      OK_LINE,
    ]);
  });

  it("a new App waiting for its install: the pending line", async () => {
    const r = await run({ app: { pending: { appId: 124, slug: "new-devbox" } } });
    expect(r.log).toEqual([
      ...settings("compose"),
      "  pending         App new-devbox (id 124) waits for its install: run bun run github:setup",
      KEY_LINE,
      SECRET_LINE,
      ...CP,
      OK_LINE,
    ]);
    const k8s = await run({
      deployment: K8S,
      app: { pending: { appId: 124, slug: "new-devbox" } },
      keychain: {},
    });
    expect(k8s.log[12]).toBe(
      "  pending         App new-devbox (id 124) waits for its install: run bun run github:setup --target devbox.config.json",
    );
  });

  it("the user's Secrets: sources say from Secret (not read)", async () => {
    const r = await run({
      deployment: K8S,
      byoKey: "my-key",
      byoIntegrations: "my-integrations",
    });
    expect(r.log).toEqual([
      ...settings("k8s:kind-devbox/devbox"),
      '  GITHUB_APP_PRIVATE_KEY  from Secret "my-key" (not read)',
      '  GITHUB_WEBHOOK_SECRET   from Secret "my-integrations" (not read)',
      ...CP,
      OK_LINE,
    ]);
  });

  it("missing sources, and a key file in the environment", async () => {
    const missing = await run({ env: {}, keychain: {} });
    expect(missing.log).toEqual([
      ...settings("compose"),
      "  GITHUB_APP_PRIVATE_KEY  missing",
      "  GITHUB_WEBHOOK_SECRET   missing",
      ...CP,
      OK_LINE,
    ]);
    const file = await run({ env: { GITHUB_APP_PRIVATE_KEY_FILE: "/k.pem" }, keychain: {} });
    expect(file.log).toEqual([
      ...settings("compose"),
      "  GITHUB_APP_PRIVATE_KEY  env",
      "  GITHUB_WEBHOOK_SECRET   missing",
      ...CP,
      OK_LINE,
    ]);
  });

  it("external tokens on Compose: the token file, present or missing; no key line", async () => {
    const ext = { tokens: "external" as const, tokenFile: "/home/me/gh-token" };
    const external = settings("compose", { tokens: "external" });
    const present = await run({ app: ext, tokenFileExists: true });
    expect(present.log).toEqual([
      ...external,
      "  tokenFile       /home/me/gh-token (exists; not read)",
      SECRET_LINE,
      ...CP,
      OK_LINE,
    ]);
    const absent = await run({ app: ext, tokenFileExists: false });
    expect(absent.log).toEqual([
      ...external,
      "  tokenFile       /home/me/gh-token (missing; not read)",
      SECRET_LINE,
      ...CP,
      OK_LINE,
    ]);
  });

  it("control plane unreachable: the probe still runs", async () => {
    const r = await run({
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

  it("an expired token names the minter's logs, per deployment", async () => {
    const expired = async () =>
      Response.json({ ...BODY, token: { ...BODY.token, expiresAt: "2026-10-19T11:59:00Z" } });
    const lines = (minter: string) => [
      `Control plane: the token has expired (2026-10-19T11:59:00Z): check the minter's logs: ${minter}`,
      "Control plane: last webhook from GitHub 2026-10-19T11:20:02Z",
      OK_LINE,
    ];
    const compose = await run({ api: expired });
    expect(compose.log).toEqual([...HEAD, ...lines(MINTER_COMPOSE)]);
    const k8s = await run({ api: expired, deployment: K8S });
    expect(k8s.log).toEqual([
      ...settings("k8s:kind-devbox/devbox"),
      KEY_LINE,
      SECRET_LINE,
      ...lines(MINTER_K8S),
    ]);
  });

  it("an expired token with external tokens does not name a minter", async () => {
    const r = await run({
      app: { tokens: "external", tokenFile: "/home/me/gh-token" },
      tokenFileExists: true,
      api: async () =>
        Response.json({ ...BODY, token: { ...BODY.token, expiresAt: "2026-10-19T11:59:00Z" } }),
    });
    expect(r.log.slice(-3)).toEqual([
      "Control plane: the token has expired (2026-10-19T11:59:00Z): check the tooling that writes it",
      "Control plane: last webhook from GitHub 2026-10-19T11:20:02Z",
      OK_LINE,
    ]);
  });

  it("no expiry known, last error, no webhook yet", async () => {
    const r = await run({
      api: async () =>
        Response.json({
          token: { source: "env", expiresAt: null, readAt: null, lastError: "unreadable" },
          webhooks: { enabled: true, lastWebhookAt: null, ciResults: true },
        }),
    });
    expect(r.log).toEqual([
      ...HEAD,
      "Control plane: token from env, no expiry known",
      "Last GitHub token error: unreadable",
      "Control plane: last webhook from GitHub none yet",
      OK_LINE,
    ]);
  });

  it("webhooks not on in the control plane", async () => {
    const r = await run({
      api: async () => Response.json({ ...BODY, webhooks: { enabled: false } }),
    });
    expect(r.log).toEqual([
      ...HEAD,
      CP[0] as string,
      "Control plane: GitHub webhooks are not on there yet. Run: bun run up",
      OK_LINE,
    ]);
  });

  it("an HTTP error from the control plane", async () => {
    const r = await run({ api: async () => new Response("no", { status: 500 }) });
    expect(r.log).toEqual([...HEAD, "Control plane: not reachable (HTTP 500)", OK_LINE]);
  });

  it("probe 404 / no answer / VPN hint / another answer", async () => {
    const notFound = await run({ fetch: async () => new Response("nope", { status: 404 }) });
    expect(notFound.log).toEqual([
      ...HEAD,
      ...CP,
      `the webhook URL ${PROBE_URL} got 404: something answered, but not devbox with GitHub on. Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that integrations.githubApp.enabled is true and applied, or restart the control plane`,
    ]);
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    const noAnswer = await run({ fetch: down });
    expect(noAnswer.log).toEqual([
      ...HEAD,
      ...CP,
      `the webhook URL ${PROBE_URL} got no answer (ECONNREFUSED): the public URL does not reach devbox. Is the tunnel down, or the Ingress or DNS not ready yet?`,
    ]);
    const vpn = await run({ fetch: down, fromApiIngress: true });
    expect(vpn.log).toEqual([
      ...HEAD,
      ...CP,
      `the webhook URL ${PROBE_URL} got no answer (ECONNREFUSED): the public URL does not reach devbox. Is the tunnel down, or the Ingress or DNS not ready yet? The URL comes from ingress.api, which may be reachable only over a VPN: enable a public ingress.webhooks in the target file`,
    ]);
    const wrong = await run({ fetch: async () => new Response("hi", { status: 200 }) });
    expect(wrong.log).toEqual([...HEAD, ...CP, `the webhook URL ${PROBE_URL} got 200: hi`]);
  });

  it("no publicUrl: no probe", async () => {
    const r = await run({ publicUrl: null });
    expect(r.log).toEqual([
      ...settings("compose", { publicUrl: "not set" }),
      KEY_LINE,
      SECRET_LINE,
      ...CP,
    ]);
    expect(r.probed).toEqual([]);
  });

  it("never prints a secret value", async () => {
    const r = await run({
      env: { GITHUB_WEBHOOK_SECRET: "whsec-VALUE" },
      keychain: { "compose/GITHUB_APP_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----" },
    });
    expect(r.log).toEqual([...HEAD, ...CP, OK_LINE]);
  });
});
