import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearIntegration } from "../lib/integrations";
import { type Deployment, guarded, type Keychain, MemoryKeychain } from "../lib/keychain";
import { PublicUrlError } from "../lib/publicUrl";
import type { ResolverDeps } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import { type LinearDeployment, loadDeployment } from "./deployment";
import { linearManifest, manifestLink } from "./manifest";
import { type SetupDeps, SetupError, type SetupOptions, setup } from "./setup";

const dir = mkdtempSync(join(tmpdir(), "devbox-linear-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";
const PUBLIC = "https://hooks.example.com";
const COMPOSE: Deployment = { kind: "compose" };
const K8S: Deployment = { kind: "k8s", context: "kind-devbox", namespace: "devbox" };
const LINEAR: LinearIntegration = { enabled: true, clientId: "client-1" };

const URL_QUESTION =
  "Public HTTPS URL that forwards to port 3000 on this machine (a tunnel or reverse proxy): ";
const SAVE_COMPOSE = "Save the Linear secrets to the system keychain for compose? [Y/n] ";
const CLIENT_SECRET_Q = "Linear client secret (input hidden): ";
const WEBHOOK_SECRET_Q = "Linear webhook signing secret (input hidden): ";
const REGISTER = "Register the Linear app: open this link, review the app and click Create:";
const COPY =
  "Then copy the client ID, the client secret and the webhook signing secret from the app's page.";
const GITHUB_HINT =
  'set "GitHub username" to the GitHub account devbox works as (the owner of GITHUB_TOKEN)';
const LINK = `  ${manifestLink(linearManifest(PUBLIC, "devbox"))}`;
const ACT_AS = "devbox will act as devbox in workspace Example";
const NEXT_COMPOSE = ["Next: bun run up", "Then check Linear with: bun run linear:status"];
const SET_ENV = [
  "Set LINEAR_CLIENT_SECRET in your environment before bun run up, or it asks for them",
  "Set LINEAR_WEBHOOK_SECRET in your environment before bun run up, or it asks for them",
];
const REJECTED =
  "Linear rejected the client ID or LINEAR_CLIENT_SECRET (invalid_client): copy them again from the app's page in Linear (Settings → API → Applications)";
const AGAIN = "Enter LINEAR_CLIENT_SECRET again, or press Enter on an empty value to exit.";

let n = 0;
function configFile(content: unknown): string {
  const path = join(dir, `c${n++}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const platformError = () =>
  Object.assign(new Error("libsecret not available"), { code: "ERR_SECRETS_PLATFORM_ERROR" });

// A keychain whose platform has none: every call fails as Bun.secrets does.
const noPlatform: Keychain = {
  get: async () => {
    throw platformError();
  },
  set: async () => {
    throw platformError();
  },
  delete: async () => {
    throw platformError();
  },
};

type World = {
  log: string[];
  // Every question asked, in order: line prompts, hidden prompts, confirms.
  asked: string[];
  opened: string[];
  fetched: string[];
  keychain: MemoryKeychain;
};

function harness(o: {
  deployment?: Deployment;
  linear?: LinearIntegration;
  // The saved top-level publicUrl; PUBLIC when `linear` is, as setup saves both.
  publicUrl?: string;
  ingressUrl?: string;
  byoIntegrationsSecret?: string;
  githubApp?: { tokens: "devbox" | "external"; slug: string; org?: string };
  env?: Record<string, string>;
  keychain?: Keychain | "none";
  // Entries already in the default (in-memory) keychain.
  saved?: Record<string, string>;
  lines?: string[];
  hidden?: string[];
  save?: boolean;
  validSecrets?: string[];
  isTTY?: boolean;
}): { d: LinearDeployment; deps: SetupDeps; w: World } {
  const deployment = o.deployment ?? COMPOSE;
  const w: World = {
    log: [],
    asked: [],
    opened: [],
    fetched: [],
    keychain: new MemoryKeychain(o.saved),
  };
  const lines = [...(o.lines ?? [])];
  const hidden = [...(o.hidden ?? [])];
  const valid = new Set(o.validSecrets ?? ["client-secret"]);
  const fetch: Fetch = async (url, init) => {
    w.fetched.push(String(url));
    if (url === TOKEN_URL) {
      const secret = new URLSearchParams(String(init?.body)).get("client_secret") ?? "";
      return valid.has(secret)
        ? Response.json({ access_token: "tok", token_type: "Bearer", expires_in: 2592000 })
        : Response.json(
            { error: "invalid_client", error_description: "Invalid client" },
            { status: 401 },
          );
    }
    if (url === GRAPHQL_URL) {
      return Response.json({
        data: { viewer: { name: "devbox" }, organization: { name: "Example", urlKey: "example" } },
      });
    }
    return new Response("not routed", { status: 599 });
  };
  const savedUrl = o.publicUrl ?? (o.linear ? PUBLIC : undefined);
  const configPath = configFile({
    ...(o.linear ? { integrations: { linear: o.linear } } : { port: 1 }),
    ...(savedUrl !== undefined ? { publicUrl: savedUrl } : {}),
  });
  const resolver: ResolverDeps = {
    env: o.env ?? {},
    keychain: o.keychain === "none" ? undefined : (o.keychain ?? w.keychain),
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
  const target = deployment.kind === "k8s" ? ` --target ${configPath}` : "";
  // No apply and no api: setup has neither.
  const d: LinearDeployment = {
    deployment,
    configPath,
    linear: o.linear,
    ...(savedUrl !== undefined ? { publicUrl: savedUrl } : {}),
    ...(o.ingressUrl !== undefined ? { ingressUrl: o.ingressUrl } : {}),
    ...(o.byoIntegrationsSecret !== undefined
      ? { byoIntegrationsSecret: o.byoIntegrationsSecret }
      : {}),
    ...(o.githubApp ? { githubApp: o.githubApp } : {}),
    applyCommand: deployment.kind === "k8s" ? `bun run k8s:install${target}` : "bun run up",
    statusCommand: `bun run linear:status${target}`,
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
    openUrl: (url) => w.opened.push(url),
    fetch,
    log: (line) => w.log.push(line),
  };
  return { d, deps, w };
}

const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({
  name: "devbox",
  reregister: false,
  ...o,
});

describe("setup", () => {
  it("first run on Compose: URL prompt, register, client ID, write, save yes, next step", async () => {
    const { d, deps, w } = harness({
      lines: [PUBLIC, "client-1"],
      hidden: ["client-secret", "whsec"],
    });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([
      URL_QUESTION,
      "Client ID: ",
      SAVE_COMPOSE,
      CLIENT_SECRET_Q,
      WEBHOOK_SECRET_Q,
    ]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      REGISTER,
      LINK,
      COPY,
      GITHUB_HINT,
      `Wrote integrations.linear to ${d.configPath}`,
      ACT_AS,
      "Next: bun run up",
      "Then check Linear with: bun run linear:status",
    ]);
    expect(w.opened).toEqual([LINK.trim()]);
    expect(readJson(d.configPath)).toEqual({
      port: 1,
      integrations: { linear: { enabled: true, clientId: "client-1" } },
      publicUrl: PUBLIC,
    });
    expect(w.keychain.entries()).toEqual({
      "compose/LINEAR_CLIENT_SECRET": "client-secret",
      "compose/LINEAR_WEBHOOK_SECRET": "whsec",
    });
    expect(w.fetched).toEqual([TOKEN_URL, GRAPHQL_URL]);
  });

  it("k8s: next step includes the GitOps values line", async () => {
    const { d, deps, w } = harness({
      deployment: K8S,
      ingressUrl: PUBLIC,
      lines: ["client-1"],
      save: false,
    });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([
      "Client ID: ",
      "Save the Linear secrets to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
    ]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      REGISTER,
      LINK,
      COPY,
      GITHUB_HINT,
      `Wrote integrations.linear to ${d.configPath}`,
      `Set LINEAR_CLIENT_SECRET in your environment before bun run k8s:install --target ${d.configPath}, or it asks for them`,
      `Set LINEAR_WEBHOOK_SECRET in your environment before bun run k8s:install --target ${d.configPath}, or it asks for them`,
      `Next: bun run k8s:install --target ${d.configPath}`,
      "With GitOps, set these chart values instead: integrations.linear.enabled: true, integrations.linear.clientId: client-1",
      `Then check Linear with: bun run linear:status --target ${d.configPath}`,
    ]);
    expect(w.keychain.entries()).toEqual({});
    expect(w.fetched).toEqual([]);
  });

  it("save no: nothing asked, nothing saved; not-saved env lines", async () => {
    const { d, deps, w } = harness({
      linear: LINEAR,
      env: { LINEAR_WEBHOOK_SECRET: "whsec-env", LINEAR_CLIENT_SECRET: "" },
      save: false,
    });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([SAVE_COMPOSE]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      "Set LINEAR_CLIENT_SECRET in your environment before bun run up, or it asks for them",
      "bun run up will use LINEAR_WEBHOOK_SECRET from your environment",
      "Next: bun run up",
      "Then check Linear with: bun run linear:status",
    ]);
    expect(w.keychain.entries()).toEqual({});
    expect(w.fetched).toEqual([]);
  });

  it("no usable keychain with a terminal: no save question", async () => {
    for (const keychain of [guarded(noPlatform), "none" as const]) {
      const { d, deps, w } = harness({ linear: LINEAR, keychain });
      await setup(d, opts(), deps);
      expect(w.asked).toEqual([]);
      expect(w.log).toEqual([
        `Public URL: ${PUBLIC}`,
        `Wrote integrations.linear to ${d.configPath}`,
        "Set LINEAR_CLIENT_SECRET in your environment before bun run up, or it asks for them",
        "Set LINEAR_WEBHOOK_SECRET in your environment before bun run up, or it asks for them",
        "Next: bun run up",
        "Then check Linear with: bun run linear:status",
      ]);
    }
  });

  it("no terminal: no save question", async () => {
    const { d, deps, w } = harness({ linear: LINEAR, isTTY: false });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      ...SET_ENV,
      ...NEXT_COMPOSE,
    ]);
    expect(w.keychain.entries()).toEqual({});
  });

  it("the user's integrations Secret: asks nothing, names the Secret", async () => {
    const { d, deps, w } = harness({
      deployment: K8S,
      linear: LINEAR,
      byoIntegrationsSecret: "my-integrations",
      env: { LINEAR_CLIENT_SECRET: "x", LINEAR_WEBHOOK_SECRET: "y" },
    });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      'Put LINEAR_CLIENT_SECRET and LINEAR_WEBHOOK_SECRET in Secret "my-integrations" in namespace devbox.',
      `Next: bun run k8s:install --target ${d.configPath}`,
      "With GitOps, set these chart values instead: integrations.linear.enabled: true, integrations.linear.clientId: client-1",
      `Then check Linear with: bun run linear:status --target ${d.configPath}`,
    ]);
    expect(w.keychain.entries()).toEqual({});
    expect(w.fetched).toEqual([]);
  });

  it("a rejected client secret is asked again; an empty answer exits and saves nothing", async () => {
    const { d, deps, w } = harness({ linear: LINEAR, hidden: ["wrong", "client-secret", "whsec"] });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([SAVE_COMPOSE, CLIENT_SECRET_Q, CLIENT_SECRET_Q, WEBHOOK_SECRET_Q]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      REJECTED,
      AGAIN,
      ACT_AS,
      "Next: bun run up",
      "Then check Linear with: bun run linear:status",
    ]);
    expect(w.keychain.entries()).toEqual({
      "compose/LINEAR_CLIENT_SECRET": "client-secret",
      "compose/LINEAR_WEBHOOK_SECRET": "whsec",
    });

    const empty = harness({ linear: LINEAR, hidden: ["wrong", ""] });
    await expect(setup(empty.d, opts(), empty.deps)).rejects.toThrow(
      new SetupError(
        "No Linear client secret entered: nothing was saved. Run `bun run linear:setup` again when you have it.",
      ),
    );
    expect(empty.w.asked).toEqual([SAVE_COMPOSE, CLIENT_SECRET_Q, CLIENT_SECRET_Q]);
    expect(empty.w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${empty.d.configPath}`,
      REJECTED,
      AGAIN,
    ]);
    expect(empty.w.keychain.entries()).toEqual({});
  });

  it("an empty first answer exits and saves nothing", async () => {
    const client = harness({ linear: LINEAR, hidden: [""] });
    await expect(setup(client.d, opts(), client.deps)).rejects.toThrow(
      new SetupError(
        "No Linear client secret entered: nothing was saved. Run `bun run linear:setup` again when you have it.",
      ),
    );
    expect(client.w.asked).toEqual([SAVE_COMPOSE, CLIENT_SECRET_Q]);
    expect(client.w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${client.d.configPath}`,
    ]);
    expect(client.w.fetched).toEqual([]);

    const webhook = harness({ linear: LINEAR, hidden: ["client-secret", ""] });
    await expect(setup(webhook.d, opts(), webhook.deps)).rejects.toThrow(
      new SetupError(
        "No Linear webhook signing secret entered: nothing was saved. Run `bun run linear:setup` again when you have it.",
      ),
    );
    expect(webhook.w.asked).toEqual([SAVE_COMPOSE, CLIENT_SECRET_Q, WEBHOOK_SECRET_Q]);
    expect(webhook.w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${webhook.d.configPath}`,
      ACT_AS,
    ]);
    expect(webhook.w.keychain.entries()).toEqual({});
  });

  it("a keychain that fails while saving: the not-saved lines", async () => {
    // The platform's keychain answers reads but fails on the first write.
    const inner: Keychain = {
      get: async () => undefined,
      set: async () => {
        throw platformError();
      },
      delete: async () => false,
    };
    const { d, deps, w } = harness({
      linear: LINEAR,
      keychain: guarded(inner),
      hidden: ["client-secret", "whsec"],
    });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([SAVE_COMPOSE, CLIENT_SECRET_Q, WEBHOOK_SECRET_Q]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      ACT_AS,
      ...SET_ENV,
      ...NEXT_COMPOSE,
    ]);
  });

  it("registering with LINEAR_* in env warns they predate the app", async () => {
    const { d, deps, w } = harness({
      linear: LINEAR,
      env: { LINEAR_CLIENT_SECRET: "old", LINEAR_WEBHOOK_SECRET: "old-whsec" },
      lines: ["client-2"],
      hidden: ["client-secret", "whsec"],
    });
    await setup(d, opts({ reregister: true }), deps);
    expect(w.asked).toEqual(["Client ID: ", SAVE_COMPOSE, CLIENT_SECRET_Q, WEBHOOK_SECRET_Q]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      REGISTER,
      LINK,
      COPY,
      GITHUB_HINT,
      `Wrote integrations.linear to ${d.configPath}`,
      ACT_AS,
      "LINEAR_CLIENT_SECRET is set in your environment from before this app was created: set it to the new app's value, or unset it, before bun run up",
      "LINEAR_WEBHOOK_SECRET is set in your environment from before this app was created: set it to the new app's value, or unset it, before bun run up",
      "Next: bun run up",
      "Then check Linear with: bun run linear:status",
    ]);
  });

  it("no registration: saved and env differs warns; env equal is silent", async () => {
    const { d, deps, w } = harness({
      linear: LINEAR,
      env: { LINEAR_CLIENT_SECRET: "client-secret", LINEAR_WEBHOOK_SECRET: "other" },
      hidden: ["client-secret", "whsec"],
    });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([SAVE_COMPOSE, CLIENT_SECRET_Q, WEBHOOK_SECRET_Q]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      ACT_AS,
      "LINEAR_WEBHOOK_SECRET in your environment overrides the saved value at install: unset it, or set it to the new value",
      "Next: bun run up",
      "Then check Linear with: bun run linear:status",
    ]);
  });

  it("empty client ID with a terminal", async () => {
    const { d, deps, w } = harness({ lines: [""] });
    const before = readFileSync(d.configPath, "utf8");
    await expect(setup(d, opts({ publicUrl: PUBLIC }), deps)).rejects.toThrow(
      new SetupError(
        "No client ID entered: nothing was written. Run `bun run linear:setup` again when you have it.",
      ),
    );
    expect(w.asked).toEqual(["Client ID: "]);
    expect(w.log).toEqual([`Public URL: ${PUBLIC}`, REGISTER, LINK, COPY, GITHUB_HINT]);
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
  });

  it("empty client ID without a terminal", async () => {
    const { d, deps, w } = harness({ isTTY: false });
    const before = readFileSync(d.configPath, "utf8");
    await expect(setup(d, opts({ publicUrl: PUBLIC }), deps)).rejects.toThrow(
      new SetupError(
        `no Linear client ID: run \`bun run linear:setup\` in a terminal, or set integrations.linear.clientId in ${d.configPath}`,
      ),
    );
    expect(w.asked).toEqual([]);
    expect(w.log).toEqual([`Public URL: ${PUBLIC}`, REGISTER, LINK, COPY, GITHUB_HINT]);
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
  });

  it("GitHub username on Compose: the App's bot login when an App is enabled", async () => {
    const { d, deps, w } = harness({
      githubApp: { tokens: "devbox", slug: "devbox-bot" },
      lines: [PUBLIC, "client-1"],
      hidden: ["client-secret", "whsec"],
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      REGISTER,
      LINK,
      COPY,
      'set "GitHub username" to devbox-bot[bot]',
      `Wrote integrations.linear to ${d.configPath}`,
      ACT_AS,
      ...NEXT_COMPOSE,
    ]);
  });

  it("GitHub username suggestion from githubApp.slug as the bot login", async () => {
    const { d, deps, w } = harness({
      deployment: K8S,
      ingressUrl: PUBLIC,
      githubApp: { tokens: "devbox", slug: "devbox-bot" },
      lines: ["client-1"],
      save: false,
    });
    await setup(d, opts(), deps);
    const target = ` --target ${d.configPath}`;
    expect(w.asked).toEqual([
      "Client ID: ",
      "Save the Linear secrets to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
    ]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      REGISTER,
      LINK,
      COPY,
      'set "GitHub username" to devbox-bot[bot]',
      `Wrote integrations.linear to ${d.configPath}`,
      `Set LINEAR_CLIENT_SECRET in your environment before bun run k8s:install${target}, or it asks for them`,
      `Set LINEAR_WEBHOOK_SECRET in your environment before bun run k8s:install${target}, or it asks for them`,
      `Next: bun run k8s:install${target}`,
      "With GitOps, set these chart values instead: integrations.linear.enabled: true, integrations.linear.clientId: client-1",
      `Then check Linear with: bun run linear:status${target}`,
    ]);
  });

  it("http Ingress URL: the TLS hint", async () => {
    const { d, deps, w } = harness({ deployment: K8S, ingressUrl: "http://hooks.example.com" });
    await expect(setup(d, opts(), deps)).rejects.toThrow(
      new PublicUrlError(
        "Webhooks need a public HTTPS URL: http://hooks.example.com uses http:, not https:. If TLS ends at a load balancer in front of the Ingress, pass --public-url https://hooks.example.com",
      ),
    );
    expect(w.asked).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it("an Ingress host with a space: no TLS hint, no TypeError", async () => {
    const { d, deps, w } = harness({ deployment: K8S, ingressUrl: "http://hooks example.com" });
    await expect(setup(d, opts(), deps)).rejects.toThrow(
      new PublicUrlError(
        "Webhooks need a public HTTPS URL: the value is not an absolute URL (start it with https://)",
      ),
    );
    expect(w.asked).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it("k8s: no Ingress and no --public-url", async () => {
    const { d, deps, w } = harness({ deployment: K8S });
    await expect(setup(d, opts(), deps)).rejects.toThrow(
      new PublicUrlError(
        "Webhooks need a public HTTPS URL: enable ingress.webhooks, or pass --public-url.",
      ),
    );
    expect(w.asked).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it("Compose without a terminal and no URL fails naming --public-url", async () => {
    const { d, deps, w } = harness({ isTTY: false });
    await expect(setup(d, opts(), deps)).rejects.toThrow(
      new PublicUrlError(
        "Webhooks need a public HTTPS URL: pass --public-url <https URL that forwards to port 3000 on this machine>",
      ),
    );
    expect(w.asked).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it("re-run reuses config and skips register", async () => {
    const { d, deps, w } = harness({
      linear: { ...LINEAR, enabled: false },
      publicUrl: PUBLIC,
      save: false,
    });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([SAVE_COMPOSE]);
    expect(w.opened).toEqual([]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      "Set LINEAR_CLIENT_SECRET in your environment before bun run up, or it asks for them",
      "Set LINEAR_WEBHOOK_SECRET in your environment before bun run up, or it asks for them",
      "Next: bun run up",
      "Then check Linear with: bun run linear:status",
    ]);
    expect(readJson(d.configPath)).toEqual({
      integrations: { linear: LINEAR },
      publicUrl: PUBLIC,
    });
  });

  it("--reregister registers again", async () => {
    const { d, deps, w } = harness({ linear: LINEAR, lines: ["client-2"], save: false });
    await setup(d, opts({ reregister: true, name: "devbox-local" }), deps);
    const link = `  ${manifestLink(linearManifest(PUBLIC, "devbox-local"))}`;
    expect(w.asked).toEqual(["Client ID: ", SAVE_COMPOSE]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      REGISTER,
      link,
      COPY,
      GITHUB_HINT,
      `Wrote integrations.linear to ${d.configPath}`,
      ...SET_ENV,
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(d.configPath)).toEqual({
      integrations: { linear: { ...LINEAR, clientId: "client-2" } },
      publicUrl: PUBLIC,
    });
  });

  it("--reregister with the save declined names the earlier app's saved secrets", async () => {
    for (const deployment of [COMPOSE, K8S]) {
      const scope = deployment.kind === "k8s" ? "k8s:kind-devbox/devbox" : "compose";
      const saved = {
        [`${scope}/LINEAR_CLIENT_SECRET`]: "old-secret",
        [`${scope}/LINEAR_WEBHOOK_SECRET`]: "old-whsec",
      };
      const { d, deps, w } = harness({
        deployment,
        linear: LINEAR,
        saved,
        lines: ["client-2"],
        save: false,
      });
      await setup(d, opts({ reregister: true }), deps);
      const target = deployment.kind === "k8s" ? ` --target ${d.configPath}` : "";
      const apply = deployment.kind === "k8s" ? `bun run k8s:install${target}` : "bun run up";
      expect(w.asked).toEqual([
        "Client ID: ",
        `Save the Linear secrets to the system keychain for ${scope}? [Y/n] `,
      ]);
      expect(w.log).toEqual([
        `Public URL: ${PUBLIC}`,
        REGISTER,
        LINK,
        COPY,
        GITHUB_HINT,
        `Wrote integrations.linear to ${d.configPath}`,
        `Set LINEAR_CLIENT_SECRET in your environment before ${apply}, or it asks for them`,
        `The saved LINEAR_CLIENT_SECRET for ${scope} belongs to an earlier app: remove it with bun run secrets rm LINEAR_CLIENT_SECRET${target}`,
        `Set LINEAR_WEBHOOK_SECRET in your environment before ${apply}, or it asks for them`,
        `The saved LINEAR_WEBHOOK_SECRET for ${scope} belongs to an earlier app: remove it with bun run secrets rm LINEAR_WEBHOOK_SECRET${target}`,
        `Next: ${apply}`,
        ...(deployment.kind === "k8s"
          ? [
              "With GitOps, set these chart values instead: integrations.linear.enabled: true, integrations.linear.clientId: client-2",
            ]
          : []),
        `Then check Linear with: bun run linear:status${target}`,
      ]);
      // Nothing is removed for the user.
      expect(w.keychain.entries()).toEqual(saved);
    }
  });

  it("a changed public URL prints the update line", async () => {
    const { d, deps, w } = harness({
      linear: LINEAR,
      publicUrl: "https://old.example.com",
      save: false,
    });
    await setup(d, opts({ publicUrl: `${PUBLIC}/` }), deps);
    expect(w.asked).toEqual([SAVE_COMPOSE]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      `Update the webhook URL in the Linear app to ${PUBLIC}/webhook/linear`,
      ...SET_ENV,
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(d.configPath)).toEqual({
      integrations: { linear: LINEAR },
      publicUrl: PUBLIC,
    });
  });

  it("a changed public URL also prints the GitHub App line (devbox tokens)", async () => {
    const { d, deps, w } = harness({
      linear: LINEAR,
      publicUrl: "https://old.example.com",
      githubApp: { tokens: "devbox", slug: "example-devbox" },
      save: false,
    });
    await setup(d, opts({ publicUrl: PUBLIC }), deps);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      `Update the webhook URL in the Linear app to ${PUBLIC}/webhook/linear`,
      "Run bun run github:setup to update the GitHub App's webhook URL",
      ...SET_ENV,
      ...NEXT_COMPOSE,
    ]);
  });

  it("without a terminal, secrets saved in the keychain need no env line", async () => {
    const { d, deps, w } = harness({
      linear: LINEAR,
      isTTY: false,
      saved: { "compose/LINEAR_CLIENT_SECRET": "c", "compose/LINEAR_WEBHOOK_SECRET": "w" },
    });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
  });

  it("on k8s, the GitHub App line names the target file", async () => {
    const { d, deps, w } = harness({
      deployment: K8S,
      linear: LINEAR,
      publicUrl: "https://old.example.com",
      githubApp: { tokens: "devbox", slug: "example-devbox" },
      save: false,
    });
    await setup(d, opts({ publicUrl: PUBLIC }), deps);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      `Update the webhook URL in the Linear app to ${PUBLIC}/webhook/linear`,
      `Run bun run github:setup --target ${d.configPath} to update the GitHub App's webhook URL`,
      `Set LINEAR_CLIENT_SECRET in your environment before bun run k8s:install --target ${d.configPath}, or it asks for them`,
      `Set LINEAR_WEBHOOK_SECRET in your environment before bun run k8s:install --target ${d.configPath}, or it asks for them`,
      `Next: bun run k8s:install --target ${d.configPath}`,
      "With GitOps, set these chart values instead: integrations.linear.enabled: true, integrations.linear.clientId: client-1",
      `Then check Linear with: bun run linear:status --target ${d.configPath}`,
    ]);
  });

  it("a changed public URL prints the manual GitHub App line (external tokens)", async () => {
    const { d, deps, w } = harness({
      linear: LINEAR,
      publicUrl: "https://old.example.com",
      githubApp: { tokens: "external", slug: "example-devbox" },
      save: false,
    });
    await setup(d, opts({ publicUrl: PUBLIC }), deps);
    expect(w.log).toContain(
      `Update the webhook URL in the GitHub App to ${PUBLIC}/webhook/github: https://github.com/settings/apps/example-devbox`,
    );
  });

  it("an organization's App: the manual line links the organization's settings", async () => {
    const { d, deps, w } = harness({
      linear: LINEAR,
      publicUrl: "https://old.example.com",
      githubApp: { tokens: "external", slug: "example-devbox", org: "example-org" },
      save: false,
    });
    await setup(d, opts({ publicUrl: PUBLIC }), deps);
    expect(w.log).toContain(
      `Update the webhook URL in the GitHub App to ${PUBLIC}/webhook/github: https://github.com/organizations/example-org/settings/apps/example-devbox`,
    );
  });

  it("an unchanged public URL prints no update line", async () => {
    const { d, deps, w } = harness({ linear: LINEAR, publicUrl: PUBLIC, save: false });
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Wrote integrations.linear to ${d.configPath}`,
      ...SET_ENV,
      ...NEXT_COMPOSE,
    ]);
  });

  it("re-registering with a new URL prints no update line: the new app has it", async () => {
    const { d, deps, w } = harness({
      linear: LINEAR,
      publicUrl: "https://old.example.com",
      lines: ["client-2"],
      save: false,
    });
    await setup(d, opts({ publicUrl: PUBLIC, reregister: true }), deps);
    expect(w.log.some((l) => l.startsWith("Update the webhook URL"))).toBe(false);
  });

  it("never applies", () => {
    // Nothing under scripts/linear runs `up` or the installer.
    const sources = readdirSync(import.meta.dir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    const offending = sources.filter((f) => {
      const text = readFileSync(join(import.meta.dir, f), "utf8");
      return /from "\.\.\/up"|from "\.\.\/k8s"|from "\.\.\/k8s\/install"|install\(/.test(text);
    });
    expect(offending).toEqual([]);
  });
});

describe("setup on kind", () => {
  it("the env lines and the next step name k8s:kind", async () => {
    const kind: Deployment = { kind: "k8s", context: "kind-devbox", namespace: "devbox" };
    const path = configFile({ context: "kind-devbox", profile: "k8s-kind-devbox", values: {} });
    const d = loadDeployment({ target: path, noKeychain: false });
    const { deps, w } = harness({ deployment: kind, lines: ["client-1"], save: false });
    await setup(d, opts({ publicUrl: PUBLIC }), deps);
    expect(w.asked).toEqual([
      "Client ID: ",
      "Save the Linear secrets to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
    ]);
    expect(w.log).toEqual([
      `Public URL: ${PUBLIC}`,
      REGISTER,
      LINK,
      COPY,
      GITHUB_HINT,
      `Wrote integrations.linear to ${path}`,
      "Set LINEAR_CLIENT_SECRET in your environment before bun run k8s:kind, or it asks for them",
      "Set LINEAR_WEBHOOK_SECRET in your environment before bun run k8s:kind, or it asks for them",
      "Next: bun run k8s:kind",
      "With GitOps, set these chart values instead: integrations.linear.enabled: true, integrations.linear.clientId: client-1",
      `Then check Linear with: bun run linear:status --target ${path}`,
    ]);
    expect(readJson(path)).toEqual({
      context: "kind-devbox",
      profile: "k8s-kind-devbox",
      values: {},
      integrations: { linear: { enabled: true, clientId: "client-1" } },
      publicUrl: PUBLIC,
    });
  });
});
