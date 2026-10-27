import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubAppIntegration } from "../lib/integrations";
import { type Deployment, type Keychain, MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import type { RepoConfig } from "../up/config";
import type { GithubDeployment } from "./deployment";
import { CallbackError } from "./listener";
import { formPage, githubManifest, manifestPostUrl, registrationLink } from "./manifest";
import { type SetupDeps, SetupError, type SetupOptions, setup } from "./setup";

const dir = mkdtempSync(join(tmpdir(), "devbox-github-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const API = "https://api.github.com";
const PUBLIC = "https://hooks.example.com";
const OLD = "https://old.example.com";
const HOOK = `${PUBLIC}/webhook/github`;
const COMPOSE: Deployment = { kind: "compose" };
const K8S: Deployment = { kind: "k8s", context: "prod", namespace: "devbox" };
const SLUG = "example-devbox";
const HTML = `https://github.com/apps/${SLUG}`;
const INSTALL_URL = `${HTML}/installations/new`;
const STATE = "a".repeat(32);
const GENERATED = "a".repeat(64);
const BOT_ID = 1234567;
const ORG = { login: "example-org", type: "Organization" };
const USER = { login: "example-user", type: "User" };
const REPO: RepoConfig = {
  url: "https://github.com/example-org/example-repo.git",
  branch: "main",
  owner: "example-org",
  name: "example-repo",
};
const OTHER: RepoConfig = { ...REPO, url: "x", name: "other" };

const CONVERSION = {
  id: 123,
  slug: SLUG,
  pem: PEM,
  webhook_secret: "whsec-1",
  html_url: HTML,
  owner: { ...ORG, id: 9 },
};
const ENABLED: GithubAppIntegration = {
  enabled: true,
  appId: 123,
  slug: SLUG,
  installationId: 7,
  botUserId: BOT_ID,
  tokens: "devbox",
  tokenScope: "repos",
  ciResults: true,
  // The fixture App belongs to the example-org organization.
  org: "example-org",
};
const PROVISIONAL = {
  enabled: false,
  appId: 123,
  slug: SLUG,
  tokens: "devbox",
  tokenScope: "repos",
  ciResults: true,
  org: "example-org",
};

// A working App that --reregister replaces.
const OLD_APP: GithubAppIntegration = {
  ...ENABLED,
  appId: 99,
  slug: "old-devbox",
  installationId: 5,
  botUserId: 55,
};
const PENDING = { appId: 123, slug: SLUG, org: "example-org" };
const OLD_SAVED = {
  "compose/GITHUB_APP_PRIVATE_KEY": "old-key",
  "compose/GITHUB_WEBHOOK_SECRET": "old-secret",
};
const PENDING_SAVED = {
  "compose/GITHUB_APP_PRIVATE_KEY_PENDING": PEM,
  "compose/GITHUB_WEBHOOK_SECRET_PENDING": "whsec-1",
};
const KEEPS_WORKING = "The App old-devbox keeps working until the new App is installed.";
const EARLIER_KEY =
  "The saved GITHUB_APP_PRIVATE_KEY for compose is from an earlier App or key: remove it with bun run secrets rm GITHUB_APP_PRIVATE_KEY";
const EARLIER_HOOK =
  "The saved GITHUB_WEBHOOK_SECRET for compose is from an earlier App or key: remove it with bun run secrets rm GITHUB_WEBHOOK_SECRET";
const SHOW_HOOK_ONCE =
  "Press Enter to show the webhook secret (set it as GITHUB_WEBHOOK_SECRET before bun run up, once the new App is installed) ";
const OLD_REPLACED = "The old App's saved key and webhook secret were replaced by the new App's";
const REPLACE_Q =
  "A new App stale-devbox is already waiting for its install. Replace it with another one? [y/N] ";
const STALE_SAVED = {
  "compose/GITHUB_APP_PRIVATE_KEY_PENDING": "stale-key",
  "compose/GITHUB_WEBHOOK_SECRET_PENDING": "stale-secret",
};
const STALE_UNUSED =
  "The App stale-devbox is no longer used: delete it on GitHub: https://github.com/settings/apps/stale-devbox/advanced";
const STALE_DROPPED = [
  STALE_UNUSED,
  "Removed the saved secrets of the App stale-devbox from the system keychain",
];
const STALE_PENDING_LEFT =
  "The saved GITHUB_APP_PRIVATE_KEY_PENDING and GITHUB_WEBHOOK_SECRET_PENDING for compose are from an earlier App: remove them with bun run secrets rm GITHUB_APP_PRIVATE_KEY_PENDING and bun run secrets rm GITHUB_WEBHOOK_SECRET_PENDING";
const OLD_UNUSED =
  "The App old-devbox is no longer used: delete it on GitHub: https://github.com/organizations/example-org/settings/apps/old-devbox/advanced";
const MOVE_FAILED =
  "Moving the new App's secrets in the system keychain failed: The keychain is locked. Nothing changed: the App old-devbox keeps working and the new App's secrets stay saved as GITHUB_APP_PRIVATE_KEY_PENDING and GITHUB_WEBHOOK_SECRET_PENDING; run bun run github:setup again to finish";

// Lines, in order.
const PUBLIC_LINE = `Public URL: ${PUBLIC}`;
const REGISTER = [
  "Register the GitHub App: your browser opens GitHub's create page; review it and click Create.",
  "If it doesn't open, open http://localhost:4567/ in a browser on this machine.",
];
const INSTALL = [
  "Install the App on the repos devbox works on:",
  `  ${INSTALL_URL}`,
  "Waiting for the installation (press Enter to check now)...",
];
const INSTALLED_ORG = "The App is installed on example-org (installation 7)";
const NEXT_COMPOSE = ["Next: bun run up", "Then check GitHub with: bun run github:status"];
const SAVE_BOTH =
  "Save the App's private key and webhook secret to the system keychain for compose? [Y/n] ";
const SAVE_HOOK = "Save the App's webhook secret to the system keychain for compose? [Y/n] ";
const SHOW_HOOK =
  "Press Enter to show the webhook secret (set it as GITHUB_WEBHOOK_SECRET before bun run up) ";
const NO_KEY = "No private key for the App here: skipping the installation and repo checks";
const ADOPT_HOOK_Q = "The App's webhook secret (input hidden; press Enter to generate a new one): ";

type Call = { method: string; path: string; auth: boolean; body?: unknown };
type Answer = [number, unknown];

type World = {
  log: string[];
  asked: string[];
  opened: string[];
  shown: string[];
  calls: Call[];
  commands: string[][];
  keychain: MemoryKeychain;
  listened: { state: string; page: string; closed: boolean }[];
  slept: number[];
};

let n = 0;

function harness(o: {
  deployment?: Deployment;
  githubApp?: GithubAppIntegration;
  linear?: boolean;
  publicUrl?: string;
  ingressUrl?: string;
  repos?: RepoConfig[];
  trust?: { trustedOrgs: string[]; trustedUsers: string[] };
  byoKeySecret?: string;
  byoIntegrationsSecret?: string;
  env?: Record<string, string>;
  keychain?: Keychain | "none";
  saved?: Record<string, string>;
  save?: boolean;
  // Answers to the yes/no questions in turn; `save` (or yes) after them.
  confirms?: boolean[];
  lines?: string[];
  hidden?: string[];
  isTTY?: boolean;
  // GitHub's answers by "METHOD path"; a list is answered in turn (its last
  // answer repeats).
  github?: Record<string, Answer | Answer[]>;
  code?: Promise<string>;
  // Enter pressed while polling: next() resolves at once.
  enter?: boolean;
  extraConfig?: Record<string, unknown>;
}): { d: GithubDeployment; deps: SetupDeps; w: World; cwd: string } {
  const deployment = o.deployment ?? COMPOSE;
  const w: World = {
    log: [],
    asked: [],
    opened: [],
    shown: [],
    calls: [],
    commands: [],
    keychain: new MemoryKeychain(o.saved),
    listened: [],
    slept: [],
  };
  const cwd = mkdtempSync(join(dir, "cwd-"));
  const configPath = join(dir, `c${n++}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      ...(deployment.kind === "compose" ? { repos: [{ url: REPO.url }] } : { context: "prod" }),
      ...(o.publicUrl !== undefined ? { publicUrl: o.publicUrl } : {}),
      ...(o.githubApp ? { integrations: { githubApp: o.githubApp } } : {}),
      ...(o.extraConfig ?? {}),
    }),
  );
  const lines = [...(o.lines ?? [])];
  const hidden = [...(o.hidden ?? [])];
  const confirms = [...(o.confirms ?? [])];
  const github: Record<string, Answer | Answer[]> = {
    "POST /app-manifests/code-1/conversions": [201, CONVERSION],
    "GET /app": [200, { id: 123, slug: SLUG, html_url: HTML, owner: ORG }],
    "PATCH /app/hook/config": [200, {}],
    "GET /app/installations?per_page=100&page=1": [200, [{ id: 7, account: ORG }]],
    [`GET /users/${SLUG}%5Bbot%5D`]: [200, { id: BOT_ID }],
    "GET /repos/example-org/example-repo/installation": [200, { id: 7 }],
    ...o.github,
  };
  let t = Date.parse("2026-10-19T12:00:00Z");
  const resolver: ResolverDeps = {
    env: o.env ?? {},
    keychain: o.keychain === "none" ? undefined : (o.keychain ?? w.keychain),
    deployment,
    ...(deployment.kind === "k8s" ? { targetPath: configPath } : {}),
    isTTY: o.isTTY ?? true,
    prompt: async (q) => {
      w.asked.push(q);
      return hidden.shift() ?? "";
    },
    confirm: async (q) => {
      w.asked.push(q);
      return confirms.shift() ?? o.save ?? true;
    },
    run: async (cmd) => {
      w.commands.push(cmd);
      throw new Error("setup runs no command");
    },
    log: (line) => w.log.push(line),
  };
  const target = deployment.kind === "k8s" ? ` --target ${configPath}` : "";
  const d: GithubDeployment = {
    deployment,
    configPath,
    githubApp: o.githubApp,
    linear: o.linear ?? false,
    repos: o.repos ?? [REPO],
    trust: o.trust ?? { trustedOrgs: [], trustedUsers: [] },
    ...(o.publicUrl !== undefined ? { publicUrl: o.publicUrl } : {}),
    ...(o.ingressUrl !== undefined ? { ingressUrl: o.ingressUrl } : {}),
    applyCommand: deployment.kind === "k8s" ? `bun run k8s:install${target}` : "bun run up",
    statusCommand: `bun run github:status${target}`,
    ...(o.byoKeySecret ? { byoKeySecret: o.byoKeySecret } : {}),
    ...(o.byoIntegrationsSecret ? { byoIntegrationsSecret: o.byoIntegrationsSecret } : {}),
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
    openUrl: (url) => w.opened.push(url),
    fetch: async (url, init) => {
      const path = String(url).slice(API.length);
      const method = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization");
      w.calls.push({
        method,
        path,
        auth: auth !== null,
        ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const route = github[`${method} ${path}`];
      if (!route) return Response.json({ message: "Not Found" }, { status: 404 });
      let answer = route as Answer;
      if (Array.isArray(route[0])) {
        const list = route as Answer[];
        answer = (list.length > 1 ? list.shift() : list[0]) as Answer;
      }
      return Response.json(answer[1], { status: answer[0] });
    },
    now: () => new Date(t),
    sleep: async (ms) => {
      if (o.enter) return new Promise(() => {});
      w.slept.push(ms);
      t += ms;
    },
    enter: () => ({
      next: () => (o.enter ? Promise.resolve() : new Promise(() => {})),
      stop: () => {},
    }),
    listen: async (l) => {
      const entry = { state: l.state, page: l.page(4567), closed: false };
      w.listened.push(entry);
      return {
        port: 4567,
        code: o.code ?? Promise.resolve("code-1"),
        close: () => {
          entry.closed = true;
        },
      };
    },
    random: (bytes) => "a".repeat(bytes * 2),
    cwd,
    show: (text) => w.shown.push(text),
    log: (line) => w.log.push(line),
  };
  return { d, deps, w, cwd };
}

const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({
  name: "devbox",
  externalTokens: false,
  reregister: false,
  printRegistrationLink: false,
  ...o,
});

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const calls = (w: World) => w.calls.map((c) => `${c.method} ${c.path}`);
const configOf = (githubApp: unknown, github?: unknown) => ({
  repos: [{ url: REPO.url }],
  publicUrl: PUBLIC,
  ...(github !== undefined ? { github } : {}),
  integrations: { githubApp },
});
// The log of a first registration on Compose, the keychain taking both secrets.
const registeredLog = (configPath: string, installed: string[], trusted = "example-org") => [
  PUBLIC_LINE,
  ...REGISTER,
  ...INSTALL,
  ...installed,
  `Trusted: ${trusted} (edit ${configPath} to change)`,
  `Wrote integrations.githubApp to ${configPath}`,
  ...NEXT_COMPOSE,
];

describe("setup: registering", () => {
  it("first run on Compose: register, save to the keychain, install, write, next step", async () => {
    const { d, deps, w } = harness({ publicUrl: PUBLIC });
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      ...REGISTER,
      ...INSTALL,
      INSTALLED_ORG,
      `Trusted: example-org (edit ${d.configPath} to change)`,
      `Wrote integrations.githubApp to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(w.asked).toEqual([SAVE_BOTH]);
    expect(w.opened).toEqual(["http://localhost:4567/", INSTALL_URL]);
    expect(w.listened).toEqual([
      {
        state: STATE,
        page: formPage(
          manifestPostUrl(STATE),
          githubManifest({
            name: "devbox",
            publicUrl: PUBLIC,
            redirectUrl: "http://localhost:4567/callback",
          }),
        ),
        closed: true,
      },
    ]);
    expect(readJson(d.configPath)).toEqual({
      repos: [{ url: REPO.url }],
      publicUrl: PUBLIC,
      github: { trustedOrgs: ["example-org"] },
      integrations: { githubApp: ENABLED },
    });
    expect(w.keychain.entries()).toEqual({
      "compose/GITHUB_APP_PRIVATE_KEY": PEM,
      "compose/GITHUB_WEBHOOK_SECRET": "whsec-1",
    });
    expect(w.calls).toEqual([
      { method: "POST", path: "/app-manifests/code-1/conversions", auth: false },
      { method: "GET", path: "/app/installations?per_page=100&page=1", auth: true },
      { method: "GET", path: `/users/${SLUG}%5Bbot%5D`, auth: false },
      { method: "GET", path: "/repos/example-org/example-repo/installation", auth: true },
    ]);
    expect(w.shown).toEqual([]);
    expect(w.commands).toEqual([]);
    // Nothing secret reached the log.
    expect(w.log.join("\n")).not.toContain("whsec-1");
    expect(w.log.join("\n")).not.toContain("PRIVATE KEY");
  });

  it("under an organization: the form posts to the organization's create page", async () => {
    const { d, deps, w } = harness({ publicUrl: PUBLIC });
    await setup(d, opts({ org: "example-org", name: "example-devbox" }), deps);
    expect(w.listened[0]?.page).toBe(
      formPage(
        manifestPostUrl(STATE, "example-org"),
        githubManifest({
          name: "example-devbox",
          publicUrl: PUBLIC,
          redirectUrl: "http://localhost:4567/callback",
        }),
      ),
    );
  });

  it("asks for the public URL on Compose when none is saved", async () => {
    const { d, deps, w } = harness({ lines: [PUBLIC] });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([
      "Public HTTPS URL that forwards to port 3000 on this machine (a tunnel or reverse proxy): ",
      SAVE_BOTH,
    ]);
    expect((readJson(d.configPath) as { publicUrl: string }).publicUrl).toBe(PUBLIC);
  });

  it("a null webhook secret: one is generated and set on the App", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      github: {
        "POST /app-manifests/code-1/conversions": [201, { ...CONVERSION, webhook_secret: null }],
      },
    });
    await setup(d, opts(), deps);
    expect(w.keychain.entries()["compose/GITHUB_WEBHOOK_SECRET"]).toBe(GENERATED);
    expect(w.calls.slice(0, 2)).toEqual([
      { method: "POST", path: "/app-manifests/code-1/conversions", auth: false },
      { method: "PATCH", path: "/app/hook/config", auth: true, body: { secret: GENERATED } },
    ]);
  });

  it("a state that doesn't match: fails, writes and asks nothing", async () => {
    const wrong = new CallbackError(
      "The answer from GitHub doesn't match this run: run bun run github:setup again",
    );
    const { d, deps, w } = harness({ publicUrl: PUBLIC, code: Promise.reject(wrong) });
    const before = readFileSync(d.configPath, "utf8");
    expect(await setup(d, opts(), deps).catch((e) => e)).toBe(wrong);
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
    expect(w.calls).toEqual([]);
    expect(w.asked).toEqual([]);
    expect(w.listened[0]?.closed).toBe(true);
  });

  it("needs a terminal", async () => {
    const { d, deps, w } = harness({ publicUrl: PUBLIC, isTTY: false });
    expect(await setup(d, opts(), deps).catch((e) => e)).toEqual(
      new SetupError(
        "registering or adopting a GitHub App needs a terminal: run bun run github:setup in one",
      ),
    );
    expect(w.listened).toEqual([]);
  });
});

describe("setup: installation", () => {
  it("two installations: the one owning the repos is used", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      github: {
        "GET /app/installations?per_page=100&page=1": [
          200,
          [
            { id: 8, account: USER },
            { id: 7, account: ORG },
          ],
        ],
      },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual(registeredLog(d.configPath, [INSTALLED_ORG]));
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED, { trustedOrgs: ["example-org"] }));
  });
  it("several, none owning the repos alone: listed and asked", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      lines: ["2"],
      github: {
        "GET /app/installations?per_page=100&page=1": [
          200,
          [
            { id: 8, account: USER },
            { id: 9, account: { login: "example-other", type: "Organization" } },
          ],
        ],
      },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual(
      registeredLog(
        d.configPath,
        [
          "The App is installed on several accounts:",
          "  1. example-user (User, installation 8)",
          "  2. example-other (Organization, installation 9)",
          "The App is installed on example-other (installation 9)",
          "example-org/example-repo is not in the App's installation: add it at https://github.com/organizations/example-other/settings/installations/9",
        ],
        "example-other",
      ),
    );
    expect(w.asked).toEqual([SAVE_BOTH, "Which one does devbox use? [1-2]: "]);
    expect(readJson(d.configPath)).toEqual(
      configOf({ ...ENABLED, installationId: 9 }, { trustedOrgs: ["example-other"] }),
    );
  });
  it("polls every 3 s until the App is installed", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      github: {
        "GET /app/installations?per_page=100&page=1": [
          [200, []],
          [200, []],
          [200, [{ id: 7, account: ORG }]],
        ],
      },
    });
    await setup(d, opts(), deps);
    expect(w.slept).toEqual([3000, 3000]);
    expect(calls(w).filter((c) => c.includes("installations"))).toHaveLength(3);
    expect(w.log).toEqual(registeredLog(d.configPath, [INSTALLED_ORG]));
  });

  it("Enter checks again at once", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      enter: true,
      github: {
        "GET /app/installations?per_page=100&page=1": [
          [200, []],
          [200, [{ id: 7, account: ORG }]],
        ],
      },
    });
    await setup(d, opts(), deps);
    expect(w.slept).toEqual([]);
    expect(w.log).toEqual(registeredLog(d.configPath, [INSTALLED_ORG]));
  });

  it("not installed in 15 minutes: fails, the App already saved (disabled) so a re-run installs it", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      github: { "GET /app/installations?per_page=100&page=1": [200, []] },
    });
    expect(await setup(d, opts(), deps).catch((e) => e)).toEqual(
      new SetupError(
        `The App isn't installed yet: install it from ${INSTALL_URL}, then run bun run github:setup again`,
      ),
    );
    expect(w.slept).toEqual(Array(300).fill(3000));
    expect(readJson(d.configPath)).toEqual({
      repos: [{ url: REPO.url }],
      publicUrl: PUBLIC,
      integrations: { githubApp: PROVISIONAL },
    });
    expect(w.keychain.entries()).toEqual({
      "compose/GITHUB_APP_PRIVATE_KEY": PEM,
      "compose/GITHUB_WEBHOOK_SECRET": "whsec-1",
    });

    // The re-run: no second App; straight to the installation.
    const again = harness({
      publicUrl: PUBLIC,
      githubApp: PROVISIONAL as GithubAppIntegration,
      saved: w.keychain.entries(),
    });
    await setup(again.d, opts(), again.deps);
    expect(again.w.listened).toEqual([]);
    expect(again.w.asked).toEqual([]);
    expect(again.w.log).toEqual([
      PUBLIC_LINE,
      "GITHUB_APP_PRIVATE_KEY: from the system keychain (compose)",
      INSTALLED_ORG,
      `Trusted: example-org (edit ${again.d.configPath} to change)`,
      `Wrote integrations.githubApp to ${again.d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(calls(again.w)).toEqual([
      "GET /app",
      "GET /app/installations?per_page=100&page=1",
      `GET /users/${SLUG}%5Bbot%5D`,
      "GET /repos/example-org/example-repo/installation",
    ]);
    expect(readJson(again.d.configPath)).toEqual({
      repos: [{ url: REPO.url }],
      publicUrl: PUBLIC,
      github: { trustedOrgs: ["example-org"] },
      integrations: { githubApp: ENABLED },
    });
  });

  it("the re-run with the App still not installed: shows the install page again", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      githubApp: PROVISIONAL as GithubAppIntegration,
      saved: { "compose/GITHUB_APP_PRIVATE_KEY": PEM },
      github: {
        "GET /app/installations?per_page=100&page=1": [
          [200, []],
          [200, [{ id: 7, account: ORG }]],
        ],
      },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      "GITHUB_APP_PRIVATE_KEY: from the system keychain (compose)",
      ...INSTALL,
      INSTALLED_ORG,
      `Trusted: example-org (edit ${d.configPath} to change)`,
      `Wrote integrations.githubApp to ${d.configPath}`,
      "Set GITHUB_WEBHOOK_SECRET in your environment before bun run up, or it asks for it",
      ...NEXT_COMPOSE,
    ]);
    // Listed once before the install page, then found by the first poll.
    expect(w.slept).toEqual([]);
    expect(w.opened).toEqual([INSTALL_URL]);
  });
});

describe("setup: the App's owner", () => {
  const userOwned = { id: 123, slug: SLUG, html_url: HTML, owner: USER };
  const { org: _org, ...ENABLED_NO_ORG } = ENABLED;

  it("a user-owned registered App has no org key", async () => {
    const { d, deps } = harness({
      publicUrl: PUBLIC,
      github: {
        "POST /app-manifests/code-1/conversions": [
          201,
          { ...CONVERSION, owner: { ...USER, id: 9 } },
        ],
        "GET /app/installations?per_page=100&page=1": [200, [{ id: 7, account: USER }]],
        "GET /repos/example-org/example-repo/installation": [200, { id: 7 }],
      },
    });
    await setup(d, opts(), deps);
    expect(readJson(d.configPath)).toEqual(
      configOf(ENABLED_NO_ORG, { trustedUsers: ["example-user"] }),
    );
  });

  it("a user-owned adopted App drops a stale org key", async () => {
    const keyPath = join(dir, "owner.pem");
    writeFileSync(keyPath, PEM);
    const { d, deps } = harness({
      publicUrl: PUBLIC,
      githubApp: ENABLED,
      hidden: ["typed-secret"],
      github: { "GET /app": [200, userOwned] },
    });
    await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps);
    expect(
      (readJson(d.configPath) as { integrations: { githubApp: unknown } }).integrations.githubApp,
    ).toEqual(ENABLED_NO_ORG);
  });

  it("without the key, the saved org stands", async () => {
    const { d, deps } = harness({
      publicUrl: PUBLIC,
      githubApp: ENABLED,
      keychain: "none",
      trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
    });
    await setup(d, opts(), deps);
    expect(
      (readJson(d.configPath) as { integrations: { githubApp: unknown } }).integrations.githubApp,
    ).toEqual(ENABLED);
  });
});

describe("setup: what it writes", () => {
  it("a User installation: trustedUsers", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      repos: [{ ...REPO, owner: "example-user" }],
      github: {
        "GET /app/installations?per_page=100&page=1": [200, [{ id: 7, account: USER }]],
        "GET /repos/example-user/example-repo/installation": [200, { id: 7 }],
      },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual(
      registeredLog(
        d.configPath,
        ["The App is installed on example-user (installation 7)"],
        "example-user",
      ),
    );
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED, { trustedUsers: ["example-user"] }));
  });
  it("an existing trust list is kept", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      trust: { trustedOrgs: [], trustedUsers: ["someone"] },
      extraConfig: { github: { trustedUsers: ["someone"] } },
    });
    await setup(d, opts(), deps);
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED, { trustedUsers: ["someone"] }));
    expect(w.log).toEqual([
      PUBLIC_LINE,
      ...REGISTER,
      ...INSTALL,
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
  });
  it("tokenScope and ciResults set earlier are kept", async () => {
    const app = { ...ENABLED, tokenScope: "installation" as const, ciResults: false };
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      githubApp: app,
      saved: { "compose/GITHUB_APP_PRIVATE_KEY": PEM, "compose/GITHUB_WEBHOOK_SECRET": "w" },
      trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
    });
    await setup(d, opts(), deps);
    expect(readJson(d.configPath)).toEqual(configOf(app));
    expect(w.log).toEqual([
      PUBLIC_LINE,
      "GITHUB_APP_PRIVATE_KEY: from the system keychain (compose)",
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
  });
  it("a repo outside the installation: named, with where to add it; not a failure", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      repos: [REPO, OTHER],
      github: { "GET /repos/example-org/other/installation": [404, { message: "Not Found" }] },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual(
      registeredLog(d.configPath, [
        INSTALLED_ORG,
        "example-org/other is not in the App's installation: add it at https://github.com/organizations/example-org/settings/installations/7",
      ]),
    );
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED, { trustedOrgs: ["example-org"] }));
  });
  it("re-running a complete setup changes nothing and asks nothing", async () => {
    const saved = {
      "compose/GITHUB_APP_PRIVATE_KEY": PEM,
      "compose/GITHUB_WEBHOOK_SECRET": "whsec-1",
    };
    const first = harness({
      publicUrl: PUBLIC,
      githubApp: ENABLED,
      saved,
      trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
      extraConfig: { github: { trustedOrgs: ["example-org"] } },
    });
    const before = readJson(first.d.configPath);
    await setup(first.d, opts(), first.deps);
    expect(readJson(first.d.configPath)).toEqual({ ...(before as object), publicUrl: PUBLIC });
    expect(first.w.asked).toEqual([]);
    expect(first.w.opened).toEqual([]);
    expect(first.w.log).toEqual([
      PUBLIC_LINE,
      "GITHUB_APP_PRIVATE_KEY: from the system keychain (compose)",
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${first.d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    // The bot's id is reused.
    expect(calls(first.w)).toEqual([
      "GET /app",
      "GET /app/installations?per_page=100&page=1",
      "GET /repos/example-org/example-repo/installation",
    ]);
    const written = readFileSync(first.d.configPath, "utf8");
    await setup(first.d, opts(), first.deps);
    expect(readFileSync(first.d.configPath, "utf8")).toBe(written);
  });

  it("an App renamed on GitHub: the re-run takes the new slug and its bot", async () => {
    const RENAMED = "renamed-devbox";
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      githubApp: ENABLED,
      saved: { "compose/GITHUB_APP_PRIVATE_KEY": PEM, "compose/GITHUB_WEBHOOK_SECRET": "w" },
      trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
      github: {
        "GET /app": [
          200,
          { id: 123, slug: RENAMED, html_url: `https://github.com/apps/${RENAMED}`, owner: ORG },
        ],
        [`GET /users/${RENAMED}%5Bbot%5D`]: [200, { id: 42 }],
      },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      "GITHUB_APP_PRIVATE_KEY: from the system keychain (compose)",
      `The App was renamed on GitHub: its slug is now ${RENAMED} (was ${SLUG}); mention it as @${RENAMED}`,
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(d.configPath)).toEqual(configOf({ ...ENABLED, slug: RENAMED, botUserId: 42 }));
  });

  it("no key here on a re-run: the installation and repo checks are skipped", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      githubApp: ENABLED,
      saved: { "compose/GITHUB_WEBHOOK_SECRET": "w" },
      trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      NO_KEY,
      `Wrote integrations.githubApp to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(w.calls).toEqual([]);
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
  });

  it("no key and not installed: fails, naming the key's variable", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      githubApp: PROVISIONAL as GithubAppIntegration,
    });
    expect(await setup(d, opts(), deps).catch((e) => e)).toEqual(
      new SetupError(
        "The App isn't installed yet, and there is no private key for it here: set GITHUB_APP_PRIVATE_KEY_FILE to its path, then run bun run github:setup again",
      ),
    );
    expect(w.log).toEqual([PUBLIC_LINE, NO_KEY]);
  });

  it("k8s: the trust list goes to the target's values; the GitOps values line", async () => {
    const { d, deps, w } = harness({ deployment: K8S, ingressUrl: PUBLIC, save: false });
    await setup(d, opts(), deps);
    const t = d.configPath;
    expect(readJson(t)).toEqual({
      context: "prod",
      publicUrl: PUBLIC,
      values: { github: { trustedOrgs: ["example-org"] } },
      integrations: { githubApp: ENABLED },
    });
    expect(w.log.slice(-3)).toEqual([
      `Next: bun run k8s:install --target ${t}`,
      "With GitOps, set these chart values instead: integrations.githubApp.enabled: true, integrations.githubApp.appId: 123, integrations.githubApp.installationId: 7, integrations.githubApp.botLogin: example-devbox, integrations.githubApp.botUserId: 1234567, integrations.githubApp.tokens: devbox, integrations.githubApp.tokenScope: repos, integrations.githubApp.ciResults: true",
      `Then check GitHub with: bun run github:status --target ${t}`,
    ]);
  });
});

describe("setup: secrets", () => {
  it("keychain declined: the key goes to a 0600 file, the webhook secret is shown once", async () => {
    const { d, deps, w, cwd } = harness({ publicUrl: PUBLIC, save: false });
    await setup(d, opts(), deps);
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    expect(readFileSync(keyFile, "utf8")).toBe(PEM);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(w.asked).toEqual([SAVE_BOTH, SHOW_HOOK]);
    expect(w.shown).toEqual(["whsec-1"]);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      ...REGISTER,
      `Saved the App's private key to ${keyFile}. Keep it somewhere safe and set GITHUB_APP_PRIVATE_KEY_FILE=${keyFile} before bun run up`,
      ...INSTALL,
      INSTALLED_ORG,
      `Trusted: example-org (edit ${d.configPath} to change)`,
      `Wrote integrations.githubApp to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(w.keychain.entries()).toEqual({});
  });

  it("no keychain: nothing asked about it; the same file and secret", async () => {
    const { d, deps, w, cwd } = harness({ publicUrl: PUBLIC, keychain: "none" });
    await setup(d, opts(), deps);
    expect(w.asked).toEqual([SHOW_HOOK]);
    expect(existsSync(join(cwd, `${SLUG}.private-key.pem`))).toBe(true);
    expect(w.shown).toEqual(["whsec-1"]);
  });

  it("the key file exists already: refused, the App kept (disabled) with how to recover", async () => {
    const { d, deps, w, cwd } = harness({ publicUrl: PUBLIC, keychain: "none" });
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    writeFileSync(keyFile, "old");
    expect(await setup(d, opts(), deps).catch((e) => e)).toEqual(
      new SetupError(
        `${keyFile} exists already: nothing was overwritten. Generate a new private key on the App's settings page (https://github.com/organizations/example-org/settings/apps/${SLUG}), then run bun run github:setup --app-id 123 --private-key-file <its path>`,
      ),
    );
    expect(readFileSync(keyFile, "utf8")).toBe("old");
    expect(readJson(d.configPath)).toEqual(configOf(PROVISIONAL));
    expect(w.shown).toEqual([]);
  });

  it("registering again: env values and saved entries from before are named", async () => {
    const { d, deps, w, cwd } = harness({
      publicUrl: PUBLIC,
      githubApp: OLD_APP,
      trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
      save: false,
      env: { GITHUB_APP_PRIVATE_KEY_FILE: "/old.pem", GITHUB_WEBHOOK_SECRET: "old" },
      saved: { "compose/GITHUB_APP_PRIVATE_KEY": "old", "compose/GITHUB_WEBHOOK_SECRET": "old" },
    });
    await setup(d, opts({ reregister: true }), deps);
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      KEEPS_WORKING,
      ...REGISTER,
      `Saved the App's private key to ${keyFile}. Keep it somewhere safe and set GITHUB_APP_PRIVATE_KEY_FILE=${keyFile} before bun run up, once the new App is installed`,
      ...INSTALL,
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      OLD_UNUSED,
      "GITHUB_APP_PRIVATE_KEY_FILE is set in your environment from before this setup: set it to the new key's path, or unset it, before bun run up",
      "The saved GITHUB_APP_PRIVATE_KEY for compose is from an earlier App or key: remove it with bun run secrets rm GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET is set in your environment from before this setup: set it to the new value, or unset it, before bun run up",
      "The saved GITHUB_WEBHOOK_SECRET for compose is from an earlier App or key: remove it with bun run secrets rm GITHUB_WEBHOOK_SECRET",
      ...NEXT_COMPOSE,
    ]);
    expect(w.asked).toEqual([
      SAVE_BOTH,
      "Press Enter to show the webhook secret (set it as GITHUB_WEBHOOK_SECRET before bun run up, once the new App is installed) ",
    ]);
    expect(w.listened).toHaveLength(1);
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
    expect(w.keychain.entries()).toEqual({
      "compose/GITHUB_APP_PRIVATE_KEY": "old",
      "compose/GITHUB_WEBHOOK_SECRET": "old",
    });
  });

  it("a re-run names where the webhook secret will come from", async () => {
    const base = {
      publicUrl: PUBLIC,
      githubApp: ENABLED,
      trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
    };
    const missing = harness({ ...base, saved: { "compose/GITHUB_APP_PRIVATE_KEY": PEM } });
    await setup(missing.d, opts(), missing.deps);
    expect(missing.w.log.slice(-3)).toEqual([
      "Set GITHUB_WEBHOOK_SECRET in your environment before bun run up, or it asks for it",
      ...NEXT_COMPOSE,
    ]);
    const env = harness({
      ...base,
      saved: { "compose/GITHUB_APP_PRIVATE_KEY": PEM },
      env: { GITHUB_WEBHOOK_SECRET: "w" },
    });
    await setup(env.d, opts(), env.deps);
    expect(env.w.log.slice(-3)).toEqual([
      "bun run up will use GITHUB_WEBHOOK_SECRET from your environment",
      ...NEXT_COMPOSE,
    ]);
  });

  it("k8s with the user's own Secrets: nothing saved; which Secret takes what", async () => {
    const { d, deps, w, cwd } = harness({
      deployment: K8S,
      ingressUrl: PUBLIC,
      byoKeySecret: "my-app-key",
      byoIntegrationsSecret: "my-integrations",
    });
    await setup(d, opts(), deps);
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    expect(w.asked).toEqual([
      'Press Enter to show the webhook secret (put it in Secret "my-integrations" as GITHUB_WEBHOOK_SECRET) ',
    ]);
    expect(w.shown).toEqual(["whsec-1"]);
    expect(w.log[3]).toBe(
      `Saved the App's private key to ${keyFile}. Put it in Secret "my-app-key" (key private-key) in namespace devbox, then delete the file`,
    );
    expect(w.keychain.entries()).toEqual({});
  });

  it("external tokens on k8s: the key goes to a file for the user's tooling", async () => {
    const { d, deps, w, cwd } = harness({ deployment: K8S, ingressUrl: PUBLIC });
    await setup(d, opts({ externalTokens: true }), deps);
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    const t = d.configPath;
    expect(w.asked).toEqual([
      "Save the App's webhook secret to the system keychain for k8s:prod/devbox? [Y/n] ",
    ]);
    expect(w.keychain.entries()).toEqual({ "k8s:prod/devbox/GITHUB_WEBHOOK_SECRET": "whsec-1" });
    expect(w.log).toEqual([
      PUBLIC_LINE,
      ...REGISTER,
      `Saved the App's private key to ${keyFile}.`,
      ...INSTALL,
      INSTALLED_ORG,
      `Trusted: example-org (edit ${t} to change)`,
      `Wrote integrations.githubApp to ${t}`,
      "Store this key where your token tooling reads it (for example the External Secrets GithubAccessToken generator: appID 123, installID 7), then delete the file",
      `Next: bun run k8s:install --target ${t}`,
      "With GitOps, set these chart values instead: integrations.githubApp.enabled: true, integrations.githubApp.appId: 123, integrations.githubApp.installationId: 7, integrations.githubApp.botLogin: example-devbox, integrations.githubApp.botUserId: 1234567, integrations.githubApp.tokens: external, integrations.githubApp.tokenScope: repos, integrations.githubApp.ciResults: true",
      `Then check GitHub with: bun run github:status --target ${t}`,
    ]);
    expect(readJson(t)).toEqual({
      context: "prod",
      publicUrl: PUBLIC,
      values: { github: { trustedOrgs: ["example-org"] } },
      integrations: { githubApp: { ...ENABLED, tokens: "external" } },
    });
  });
  it("external tokens on Compose: asks for the token file first", async () => {
    const { d, deps, w, cwd } = harness({
      publicUrl: PUBLIC,
      lines: ["/var/lib/devbox-token/token"],
    });
    await setup(d, opts({ externalTokens: true }), deps);
    expect(w.asked).toEqual([
      "Path of the token file your tooling keeps fresh (absolute): ",
      SAVE_HOOK,
    ]);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      ...REGISTER,
      `Saved the App's private key to ${join(cwd, `${SLUG}.private-key.pem`)}.`,
      ...INSTALL,
      INSTALLED_ORG,
      `Trusted: example-org (edit ${d.configPath} to change)`,
      `Wrote integrations.githubApp to ${d.configPath}`,
      "Store this key where your token tooling reads it (for example the External Secrets GithubAccessToken generator: appID 123, installID 7), then delete the file",
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(d.configPath)).toEqual(
      configOf(
        { ...ENABLED, tokens: "external", tokenFile: "/var/lib/devbox-token/token" },
        { trustedOrgs: ["example-org"] },
      ),
    );
  });

  it("a keychain save that fails counts as not saved: the key goes to its file", async () => {
    const memory = new MemoryKeychain();
    const failing: Keychain = {
      get: (name) => memory.get(name),
      set: async () => {
        throw Object.assign(new Error("The keychain is locked"), {
          code: "ERR_SECRETS_INTERACTION_NOT_ALLOWED",
        });
      },
      delete: (name) => memory.delete(name),
    };
    const { d, deps, w, cwd } = harness({ publicUrl: PUBLIC, keychain: failing });
    await setup(d, opts(), deps);
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    expect(readFileSync(keyFile, "utf8")).toBe(PEM);
    expect(w.asked).toEqual([SAVE_BOTH, SHOW_HOOK]);
    expect(w.shown).toEqual(["whsec-1"]);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      ...REGISTER,
      "Saving GITHUB_APP_PRIVATE_KEY to the system keychain failed: The keychain is locked",
      "Saving GITHUB_WEBHOOK_SECRET to the system keychain failed: The keychain is locked",
      `Saved the App's private key to ${keyFile}. Keep it somewhere safe and set GITHUB_APP_PRIVATE_KEY_FILE=${keyFile} before bun run up`,
      ...INSTALL,
      INSTALLED_ORG,
      `Trusted: example-org (edit ${d.configPath} to change)`,
      `Wrote integrations.githubApp to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED, { trustedOrgs: ["example-org"] }));
  });
});

describe("setup: adopting an App", () => {
  const keyPath = join(dir, "adopt.pem");
  writeFileSync(keyPath, PEM);

  it("--app-id with --private-key-file: checks the key, sets the webhook, then installs", async () => {
    const { d, deps, w } = harness({ publicUrl: PUBLIC, hidden: ["typed-secret"] });
    await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps);
    expect(w.listened).toEqual([]);
    expect(w.asked).toEqual([ADOPT_HOOK_Q, SAVE_BOTH]);
    expect(w.log.slice(0, 2)).toEqual([
      PUBLIC_LINE,
      `Set the App's webhook URL to ${HOOK}. Check that the webhook is Active on the App's settings page: https://github.com/organizations/example-org/settings/apps/${SLUG}`,
    ]);
    expect(w.calls.slice(0, 3)).toEqual([
      { method: "GET", path: "/app", auth: true },
      {
        method: "PATCH",
        path: "/app/hook/config",
        auth: true,
        body: { url: HOOK, secret: "typed-secret" },
      },
      { method: "GET", path: "/app/installations?per_page=100&page=1", auth: true },
    ]);
    expect(w.keychain.entries()).toEqual({
      "compose/GITHUB_APP_PRIVATE_KEY": PEM,
      "compose/GITHUB_WEBHOOK_SECRET": "typed-secret",
    });
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED, { trustedOrgs: ["example-org"] }));
  });

  it("an empty webhook secret: a new one is generated; keychain declined → the env lines", async () => {
    const { d, deps, w } = harness({ publicUrl: PUBLIC, save: false });
    await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps);
    expect(w.calls[1]?.body).toEqual({ url: HOOK, secret: GENERATED });
    expect(w.shown).toEqual([GENERATED]);
    expect(w.log[2]).toBe(`Set GITHUB_APP_PRIVATE_KEY_FILE=${keyPath} before bun run up`);
  });

  it("a key GitHub rejects", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      github: { "GET /app": [401, { message: "Bad credentials" }] },
    });
    expect(
      await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps).catch((e) => e.message),
    ).toBe(
      "GitHub rejected the key for App 123: Bad credentials. Check --app-id, the private key and the system clock",
    );
    expect(w.asked).toEqual([]);
    expect(readJson(d.configPath)).toEqual({ repos: [{ url: REPO.url }], publicUrl: PUBLIC });
  });

  it("an App id GitHub doesn't know", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      github: { "GET /app": [404, { message: "Integration not found" }] },
    });
    expect(
      await setup(d, opts({ appId: 999, privateKeyFile: keyPath }), deps).catch((e) => e.message),
    ).toBe(
      "GitHub has no App with id 999: check --app-id (the App's settings page shows its App ID)",
    );
    expect(w.asked).toEqual([]);
  });

  it("a relative --private-key-file is read from where setup runs", async () => {
    const { d, deps, w, cwd } = harness({ publicUrl: PUBLIC, save: false });
    writeFileSync(join(cwd, "mine.pem"), PEM);
    await setup(d, opts({ appId: 123, privateKeyFile: "mine.pem" }), deps);
    expect(w.log[2]).toBe(
      `Set GITHUB_APP_PRIVATE_KEY_FILE=${join(cwd, "mine.pem")} before bun run up`,
    );
  });

  it("without --private-key-file: the key from the lookup; only the webhook secret is new", async () => {
    const { d, deps, w } = harness({
      publicUrl: PUBLIC,
      env: { GITHUB_APP_PRIVATE_KEY: PEM },
      hidden: ["typed-secret"],
    });
    await setup(d, opts({ appId: 123 }), deps);
    expect(w.asked).toEqual([ADOPT_HOOK_Q, SAVE_HOOK]);
    expect(w.log[1]).toBe("GITHUB_APP_PRIVATE_KEY: from your environment");
    expect(w.keychain.entries()).toEqual({ "compose/GITHUB_WEBHOOK_SECRET": "typed-secret" });
  });

  it("without any key: fails before calling GitHub", async () => {
    const { d, deps, w } = harness({ publicUrl: PUBLIC });
    expect(await setup(d, opts({ appId: 123 }), deps).catch((e) => e)).toEqual(
      new SetupError(
        "No private key for App 123: pass --private-key-file <path>, or set GITHUB_APP_PRIVATE_KEY_FILE",
      ),
    );
    expect(w.calls).toEqual([]);
  });
});

describe("setup: --print-registration-link", () => {
  it("prints the link and what to do next, and writes nothing", async () => {
    const { d, deps, w } = harness({ publicUrl: PUBLIC });
    const before = readFileSync(d.configPath, "utf8");
    await setup(d, opts({ printRegistrationLink: true, org: "example-org" }), deps);
    expect(w.log).toEqual([
      registrationLink({ org: "example-org", name: "devbox", publicUrl: PUBLIC }),
      "Create the App, generate a private key, then run: bun run github:setup --app-id <id> --private-key-file <path>",
    ]);
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
    expect(w.calls).toEqual([]);
    expect(w.opened).toEqual([]);
  });
});

describe("setup: a new public URL", () => {
  const base = {
    publicUrl: OLD,
    githubApp: ENABLED,
    trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
    linear: true,
  };

  it("devbox tokens with the key: the App's webhook URL is updated", async () => {
    const { d, deps, w } = harness({
      ...base,
      saved: { "compose/GITHUB_APP_PRIVATE_KEY": PEM, "compose/GITHUB_WEBHOOK_SECRET": "w" },
    });
    await setup(d, opts({ publicUrl: PUBLIC }), deps);
    expect(w.calls).toContainEqual({
      method: "PATCH",
      path: "/app/hook/config",
      auth: true,
      body: { url: HOOK },
    });
    expect(w.log.slice(3, 6)).toEqual([
      `Wrote integrations.githubApp to ${d.configPath}`,
      `Update the webhook URL in the Linear app to ${PUBLIC}/webhook/linear`,
      `Updated the GitHub App's webhook URL to ${HOOK}`,
    ]);
    expect((readJson(d.configPath) as { publicUrl: string }).publicUrl).toBe(PUBLIC);
  });

  it("devbox tokens without the key: the manual line", async () => {
    const { d, deps, w } = harness({ ...base, saved: { "compose/GITHUB_WEBHOOK_SECRET": "w" } });
    await setup(d, opts({ publicUrl: PUBLIC }), deps);
    expect(w.log.slice(1, 5)).toEqual([
      NO_KEY,
      `Wrote integrations.githubApp to ${d.configPath}`,
      `Update the webhook URL in the Linear app to ${PUBLIC}/webhook/linear`,
      `Update the webhook URL in the GitHub App to ${HOOK}: https://github.com/organizations/example-org/settings/apps/${SLUG}`,
    ]);
    expect(w.calls).toEqual([]);
  });

  it("external tokens with the key here: the organization's settings link", async () => {
    const { d, deps, w } = harness({
      ...base,
      githubApp: { ...ENABLED, tokens: "external", tokenFile: "/var/lib/devbox-token/token" },
      env: { GITHUB_APP_PRIVATE_KEY: PEM },
      saved: { "compose/GITHUB_WEBHOOK_SECRET": "w" },
    });
    await setup(d, opts({ publicUrl: PUBLIC }), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      "GITHUB_APP_PRIVATE_KEY: from your environment",
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      `Update the webhook URL in the Linear app to ${PUBLIC}/webhook/linear`,
      `Update the webhook URL in the GitHub App to ${HOOK}: https://github.com/organizations/example-org/settings/apps/${SLUG}`,
      ...NEXT_COMPOSE,
    ]);
    expect(w.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("external tokens: the manual line, nothing sent", async () => {
    const { d, deps, w } = harness({
      ...base,
      deployment: K8S,
      githubApp: { ...ENABLED, tokens: "external" },
      saved: { "k8s:prod/devbox/GITHUB_WEBHOOK_SECRET": "w" },
    });
    await setup(d, opts({ publicUrl: PUBLIC }), deps);
    expect(w.log).toContain(
      `Update the webhook URL in the GitHub App to ${HOOK}: https://github.com/organizations/example-org/settings/apps/${SLUG}`,
    );
    expect(w.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });
});

describe("setup --reregister over a working App", () => {
  const base = {
    publicUrl: PUBLIC,
    githubApp: OLD_APP,
    trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
  };
  const finalLog = (configPath: string, head: string[], tail: string[] = []) => [
    PUBLIC_LINE,
    ...head,
    INSTALLED_ORG,
    `Wrote integrations.githubApp to ${configPath}`,
    OLD_UNUSED,
    OLD_REPLACED,
    ...tail,
    ...NEXT_COMPOSE,
  ];

  it("the new App is pending until installed, then replaces the old one", async () => {
    const { d, deps, w } = harness({ ...base, saved: OLD_SAVED });
    await setup(d, opts({ reregister: true }), deps);
    expect(w.asked).toEqual([SAVE_BOTH]);
    expect(w.log).toEqual(finalLog(d.configPath, [KEEPS_WORKING, ...REGISTER, ...INSTALL]));
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
    expect(w.keychain.entries()).toEqual({
      "compose/GITHUB_APP_PRIVATE_KEY": PEM,
      "compose/GITHUB_WEBHOOK_SECRET": "whsec-1",
    });
  });

  it("abandoned before the install: the old App stays as it was; a re-run finishes the swap", async () => {
    const { d, deps, w } = harness({
      ...base,
      saved: OLD_SAVED,
      github: { "GET /app/installations?per_page=100&page=1": [200, []] },
    });
    expect(await setup(d, opts({ reregister: true }), deps).catch((e) => e)).toEqual(
      new SetupError(
        `The App isn't installed yet: install it from ${INSTALL_URL}, then run bun run github:setup again`,
      ),
    );
    expect(w.log).toEqual([PUBLIC_LINE, KEEPS_WORKING, ...REGISTER, ...INSTALL]);
    expect(readJson(d.configPath)).toEqual(configOf({ ...OLD_APP, pending: PENDING }));
    expect(w.keychain.entries()).toEqual({ ...OLD_SAVED, ...PENDING_SAVED });

    const again = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      saved: w.keychain.entries(),
    });
    await setup(again.d, opts(), again.deps);
    expect(again.w.asked).toEqual([]);
    expect(again.w.listened).toEqual([]);
    expect(again.w.log).toEqual(
      finalLog(again.d.configPath, [
        "The new App's private key: from the system keychain (compose)",
      ]),
    );
    expect(calls(again.w)).toEqual([
      "GET /app",
      "GET /app/installations?per_page=100&page=1",
      `GET /users/${SLUG}%5Bbot%5D`,
      "GET /repos/example-org/example-repo/installation",
    ]);
    expect(readJson(again.d.configPath)).toEqual(configOf(ENABLED));
    expect(again.w.keychain.entries()).toEqual({
      "compose/GITHUB_APP_PRIVATE_KEY": PEM,
      "compose/GITHUB_WEBHOOK_SECRET": "whsec-1",
    });
  });

  it("the re-run finds the new App's key in its file when the keychain has none", async () => {
    const { d, deps, w, cwd } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      keychain: "none",
    });
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    writeFileSync(keyFile, PEM);
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      `The new App's private key: from ${keyFile}`,
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      OLD_UNUSED,
      `Set GITHUB_APP_PRIVATE_KEY_FILE=${keyFile} before bun run up`,
      "Set GITHUB_WEBHOOK_SECRET in your environment before bun run up, or it asks for it",
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
  });

  it("the re-run takes the new App's key file over another App's _PENDING entries", async () => {
    const { d, deps, w, cwd } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      saved: { ...OLD_SAVED, ...STALE_SAVED },
    });
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    writeFileSync(keyFile, PEM);
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      `The new App's private key: from ${keyFile}`,
      STALE_PENDING_LEFT,
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      OLD_UNUSED,
      `Set GITHUB_APP_PRIVATE_KEY_FILE=${keyFile} before bun run up`,
      EARLIER_KEY,
      EARLIER_HOOK,
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
    expect(w.keychain.entries()).toEqual({ ...OLD_SAVED, ...STALE_SAVED });
  });

  it("a new --public-url survives an abandoned run; the re-run saves it and names the change", async () => {
    const NEW = "https://new.example.com";
    const { d, deps, w } = harness({
      ...base,
      linear: true,
      saved: OLD_SAVED,
      github: { "GET /app/installations?per_page=100&page=1": [200, []] },
    });
    expect(
      await setup(d, opts({ reregister: true, publicUrl: NEW }), deps).catch((e) => e),
    ).toBeInstanceOf(SetupError);
    expect(readJson(d.configPath)).toEqual(
      configOf({ ...OLD_APP, pending: { ...PENDING, publicUrl: NEW } }),
    );
    expect(w.listened[0]?.page).toBe(
      formPage(
        manifestPostUrl(STATE),
        githubManifest({
          name: "devbox",
          publicUrl: NEW,
          redirectUrl: "http://localhost:4567/callback",
        }),
      ),
    );

    const again = harness({
      ...base,
      linear: true,
      githubApp: { ...OLD_APP, pending: { ...PENDING, publicUrl: NEW } },
      saved: w.keychain.entries(),
    });
    await setup(again.d, opts(), again.deps);
    expect(again.w.log).toEqual([
      `Public URL: ${NEW}`,
      "The new App's private key: from the system keychain (compose)",
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${again.d.configPath}`,
      OLD_UNUSED,
      OLD_REPLACED,
      `Update the webhook URL in the Linear app to ${NEW}/webhook/linear`,
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(again.d.configPath)).toEqual({ ...configOf(ENABLED), publicUrl: NEW });
  });

  it("disabled while the new App waits: the re-run installs the new App, not the old one", async () => {
    const { d, deps, w } = harness({
      ...base,
      githubApp: { ...OLD_APP, enabled: false, pending: PENDING },
      saved: { ...OLD_SAVED, ...PENDING_SAVED },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual(
      finalLog(d.configPath, ["The new App's private key: from the system keychain (compose)"]),
    );
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
    expect(w.keychain.entries()).toEqual({
      "compose/GITHUB_APP_PRIVATE_KEY": PEM,
      "compose/GITHUB_WEBHOOK_SECRET": "whsec-1",
    });
  });

  it("the re-run after the new secrets went unsaved: the old ones in force are named", async () => {
    const { d, deps, w, cwd } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      saved: OLD_SAVED,
      env: { GITHUB_APP_PRIVATE_KEY_FILE: "/old.pem" },
    });
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    writeFileSync(keyFile, PEM);
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      `The new App's private key: from ${keyFile}`,
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      OLD_UNUSED,
      "GITHUB_APP_PRIVATE_KEY_FILE is set in your environment from before this setup: set it to the new key's path, or unset it, before bun run up",
      EARLIER_KEY,
      EARLIER_HOOK,
      ...NEXT_COMPOSE,
    ]);
    expect(w.keychain.entries()).toEqual(OLD_SAVED);
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
  });

  it("the re-run with the new webhook secret unsaved and the old one in env", async () => {
    const { d, deps, w } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      saved: { "compose/GITHUB_APP_PRIVATE_KEY_PENDING": PEM },
      env: { GITHUB_WEBHOOK_SECRET: "old-secret" },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      "The new App's private key: from the system keychain (compose)",
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      OLD_UNUSED,
      "GITHUB_WEBHOOK_SECRET is set in your environment from before this setup: set it to the new value, or unset it, before bun run up",
      ...NEXT_COMPOSE,
    ]);
    expect(w.keychain.entries()).toEqual({ "compose/GITHUB_APP_PRIVATE_KEY": PEM });
  });

  it("writing the config fails after the move: the entries are put back", async () => {
    const memory = { ...OLD_SAVED, ...PENDING_SAVED };
    const { d, deps, w } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      saved: memory,
    });
    rmSync(d.configPath);
    expect(await setup(d, opts(), deps).catch((e) => (e as NodeJS.ErrnoException).code)).toBe(
      "ENOENT",
    );
    expect(w.keychain.entries()).toEqual(memory);
  });

  it("the re-run without the new App's key: fails, nothing changed", async () => {
    const { d, deps, w, cwd } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      saved: OLD_SAVED,
    });
    expect(await setup(d, opts(), deps).catch((e) => e)).toEqual(
      new SetupError(
        `No private key for the new App ${SLUG} here (no GITHUB_APP_PRIVATE_KEY_PENDING in the system keychain, no ${join(cwd, `${SLUG}.private-key.pem`)}): adopt it again with bun run github:setup --app-id 123 --private-key-file <path>, or register another one with bun run github:setup --reregister`,
      ),
    );
    expect(w.calls).toEqual([]);
    expect(readJson(d.configPath)).toEqual(configOf({ ...OLD_APP, pending: PENDING }));
  });

  it("moving the keychain entries fails: the old App and both sets of entries stay", async () => {
    const memory = new MemoryKeychain({ ...OLD_SAVED, ...PENDING_SAVED });
    const locked: Keychain = {
      get: (name) => memory.get(name),
      set: async () => {
        throw Object.assign(new Error("The keychain is locked"), {
          code: "ERR_SECRETS_INTERACTION_NOT_ALLOWED",
        });
      },
      delete: (name) => memory.delete(name),
    };
    const { d, deps, w } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      keychain: locked,
    });
    expect(await setup(d, opts(), deps).catch((e) => e)).toEqual(new SetupError(MOVE_FAILED));
    expect(w.log).toEqual([
      PUBLIC_LINE,
      "The new App's private key: from the system keychain (compose)",
      INSTALLED_ORG,
    ]);
    expect(readJson(d.configPath)).toEqual(configOf({ ...OLD_APP, pending: PENDING }));
    expect(memory.entries()).toEqual({ ...OLD_SAVED, ...PENDING_SAVED });
  });

  it("moving the keychain entries fails with the old App disabled: says it stays disabled", async () => {
    const memory = new MemoryKeychain({ ...PENDING_SAVED });
    const locked: Keychain = {
      get: (name) => memory.get(name),
      set: async () => {
        throw new Error("The keychain is locked");
      },
      delete: (name) => memory.delete(name),
    };
    const { d, deps } = harness({
      ...base,
      githubApp: { ...OLD_APP, enabled: false, pending: PENDING },
      keychain: locked,
    });
    expect(await setup(d, opts(), deps).catch((e) => e)).toEqual(
      new SetupError(
        "Moving the new App's secrets in the system keychain failed: The keychain is locked. Nothing changed: the App old-devbox stays disabled and the new App's secrets stay saved as GITHUB_APP_PRIVATE_KEY_PENDING and GITHUB_WEBHOOK_SECRET_PENDING; run bun run github:setup again to finish",
      ),
    );
    expect(readJson(d.configPath)).toEqual(
      configOf({ ...OLD_APP, enabled: false, pending: PENDING }),
    );
  });

  it("the pending App renamed on GitHub before its install: the re-run takes the new slug", async () => {
    const RENAMED = "renamed-devbox";
    const { d, deps, w } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      saved: { ...OLD_SAVED, ...PENDING_SAVED },
      github: {
        "GET /app": [
          200,
          { id: 123, slug: RENAMED, html_url: `https://github.com/apps/${RENAMED}`, owner: ORG },
        ],
        [`GET /users/${RENAMED}%5Bbot%5D`]: [200, { id: 42 }],
      },
    });
    await setup(d, opts(), deps);
    expect(w.log).toEqual(
      finalLog(d.configPath, [
        "The new App's private key: from the system keychain (compose)",
        `The new App was renamed on GitHub: its slug is now ${RENAMED} (was ${SLUG}); mention it as @${RENAMED}`,
      ]),
    );
    expect(readJson(d.configPath)).toEqual(configOf({ ...ENABLED, slug: RENAMED, botUserId: 42 }));
  });

  it("the re-run with the key in its file and GITHUB_APP_PRIVATE_KEY in env: one key line", async () => {
    const { d, deps, w, cwd } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      keychain: "none",
      env: { GITHUB_APP_PRIVATE_KEY: "old-pem" },
    });
    const keyFile = join(cwd, `${SLUG}.private-key.pem`);
    writeFileSync(keyFile, PEM);
    await setup(d, opts(), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      `The new App's private key: from ${keyFile}`,
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      OLD_UNUSED,
      `Set GITHUB_APP_PRIVATE_KEY_FILE=${keyFile} before bun run up`,
      "Set GITHUB_WEBHOOK_SECRET in your environment before bun run up, or it asks for it",
      ...NEXT_COMPOSE,
    ]);
  });

  it("a second move failure halfway puts the first entry back", async () => {
    const memory = new MemoryKeychain({ ...OLD_SAVED, ...PENDING_SAVED });
    let sets = 0;
    const flaky: Keychain = {
      get: (name) => memory.get(name),
      set: async (name, value) => {
        sets++;
        if (sets === 2) {
          throw Object.assign(new Error("The keychain is locked"), {
            code: "ERR_SECRETS_INTERACTION_NOT_ALLOWED",
          });
        }
        await memory.set(name, value);
      },
      delete: (name) => memory.delete(name),
    };
    const { d, deps } = harness({
      ...base,
      githubApp: { ...OLD_APP, pending: PENDING },
      keychain: flaky,
    });
    expect(await setup(d, opts(), deps).catch((e) => e)).toEqual(new SetupError(MOVE_FAILED));
    expect(memory.entries()).toEqual({ ...OLD_SAVED, ...PENDING_SAVED });
  });

  describe("while a new App is pending", () => {
    const pendingBase = {
      ...base,
      githubApp: { ...OLD_APP, pending: { appId: 120, slug: "stale-devbox" } },
    };

    it("without a terminal: refused", async () => {
      const { d, deps, w } = harness({ ...pendingBase, isTTY: false });
      expect(await setup(d, opts({ reregister: true }), deps).catch((e) => e)).toEqual(
        new SetupError(
          "A new App stale-devbox is already waiting for its install: install it from https://github.com/apps/stale-devbox/installations/new and run bun run github:setup, or remove it with bun run github:disable --forget",
        ),
      );
      expect(w.listened).toEqual([]);
    });

    it("asked, no: nothing changes", async () => {
      const { d, deps, w } = harness({ ...pendingBase, save: false });
      const before = readFileSync(d.configPath, "utf8");
      expect(await setup(d, opts({ reregister: true }), deps).catch((e) => e)).toEqual(
        new SetupError(
          "Nothing was changed: install stale-devbox from https://github.com/apps/stale-devbox/installations/new, then run bun run github:setup",
        ),
      );
      expect(w.asked).toEqual([REPLACE_Q]);
      expect(readFileSync(d.configPath, "utf8")).toBe(before);
      expect(w.listened).toEqual([]);
    });

    it("asked, yes: another App replaces the pending one, whose entries go", async () => {
      const { d, deps, w } = harness({ ...pendingBase, saved: { ...OLD_SAVED, ...STALE_SAVED } });
      await setup(d, opts({ reregister: true }), deps);
      expect(w.asked).toEqual([REPLACE_Q, SAVE_BOTH]);
      expect(w.log).toEqual(
        finalLog(d.configPath, [...STALE_DROPPED, KEEPS_WORKING, ...REGISTER, ...INSTALL]),
      );
      expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
      expect(w.keychain.entries()).toEqual({
        "compose/GITHUB_APP_PRIVATE_KEY": PEM,
        "compose/GITHUB_WEBHOOK_SECRET": "whsec-1",
      });
    });

    it("asked, yes, then the new secrets not saved: stale entries are never moved", async () => {
      const { d, deps, w, cwd } = harness({
        ...pendingBase,
        saved: { ...OLD_SAVED, ...STALE_SAVED },
        confirms: [true, false],
      });
      await setup(d, opts({ reregister: true }), deps);
      const keyFile = join(cwd, `${SLUG}.private-key.pem`);
      expect(w.asked).toEqual([REPLACE_Q, SAVE_BOTH, SHOW_HOOK_ONCE]);
      expect(w.shown).toEqual(["whsec-1"]);
      expect(w.log).toEqual([
        PUBLIC_LINE,
        ...STALE_DROPPED,
        KEEPS_WORKING,
        ...REGISTER,
        `Saved the App's private key to ${keyFile}. Keep it somewhere safe and set GITHUB_APP_PRIVATE_KEY_FILE=${keyFile} before bun run up, once the new App is installed`,
        ...INSTALL,
        INSTALLED_ORG,
        `Wrote integrations.githubApp to ${d.configPath}`,
        OLD_UNUSED,
        EARLIER_KEY,
        EARLIER_HOOK,
        ...NEXT_COMPOSE,
      ]);
      expect(w.keychain.entries()).toEqual(OLD_SAVED);
      expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
    });

    it("asked, yes, with --no-keychain: says the pending App's saved secrets are left", async () => {
      const { d, deps, w, cwd } = harness({ ...pendingBase, keychain: "none" });
      await setup(d, opts({ reregister: true }), deps);
      const keyFile = join(cwd, `${SLUG}.private-key.pem`);
      expect(w.asked).toEqual([REPLACE_Q, SHOW_HOOK_ONCE]);
      expect(w.log).toEqual([
        PUBLIC_LINE,
        STALE_UNUSED,
        "--no-keychain left any saved secrets of the App stale-devbox in the system keychain: remove them with bun run secrets rm GITHUB_APP_PRIVATE_KEY_PENDING and bun run secrets rm GITHUB_WEBHOOK_SECRET_PENDING",
        KEEPS_WORKING,
        ...REGISTER,
        `Saved the App's private key to ${keyFile}. Keep it somewhere safe and set GITHUB_APP_PRIVATE_KEY_FILE=${keyFile} before bun run up, once the new App is installed`,
        ...INSTALL,
        INSTALLED_ORG,
        `Wrote integrations.githubApp to ${d.configPath}`,
        OLD_UNUSED,
        ...NEXT_COMPOSE,
      ]);
      expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
    });

    const DROP_Q =
      "A new App stale-devbox is waiting for its install; adopting App 123 again drops it. Drop it? [y/N] ";
    const ownBase = {
      ...base,
      githubApp: { ...ENABLED, pending: { appId: 120, slug: "stale-devbox" } },
    };

    it("adopting the configured App again (a new key): asked; no changes nothing", async () => {
      const keyPath = join(dir, "adopt-own-no.pem");
      writeFileSync(keyPath, PEM);
      const { d, deps, w } = harness({ ...ownBase, save: false });
      const before = readFileSync(d.configPath, "utf8");
      expect(
        await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps).catch((e) => e),
      ).toEqual(
        new SetupError(
          "Nothing was changed: install stale-devbox from https://github.com/apps/stale-devbox/installations/new, then run bun run github:setup",
        ),
      );
      expect(w.asked).toEqual([DROP_Q]);
      expect(readFileSync(d.configPath, "utf8")).toBe(before);
      expect(w.calls).toEqual([]);
    });

    it("adopting the configured App again, yes: the pending App and its entries go", async () => {
      const keyPath = join(dir, "adopt-own-yes.pem");
      writeFileSync(keyPath, PEM);
      const { d, deps, w } = harness({
        ...ownBase,
        saved: { ...STALE_SAVED },
        hidden: ["typed-secret"],
      });
      await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps);
      expect(w.asked).toEqual([DROP_Q, ADOPT_HOOK_Q, SAVE_BOTH]);
      expect(w.log).toEqual([
        PUBLIC_LINE,
        ...STALE_DROPPED,
        `Set the App's webhook URL to ${HOOK}. Check that the webhook is Active on the App's settings page: https://github.com/organizations/example-org/settings/apps/${SLUG}`,
        INSTALLED_ORG,
        `Wrote integrations.githubApp to ${d.configPath}`,
        ...NEXT_COMPOSE,
      ]);
      expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
      expect(w.keychain.entries()).toEqual({
        "compose/GITHUB_APP_PRIVATE_KEY": PEM,
        "compose/GITHUB_WEBHOOK_SECRET": "typed-secret",
      });
    });

    it("adopting the configured App again, yes, then a failure: the pending App is gone already", async () => {
      const keyPath = join(dir, "adopt-own-fail.pem");
      writeFileSync(keyPath, PEM);
      const { d, deps } = harness({
        ...ownBase,
        saved: { ...STALE_SAVED },
        hidden: ["typed-secret"],
        github: { "PATCH /app/hook/config": [500, { message: "boom" }] },
      });
      expect(
        await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps).catch((e) => e),
      ).toBeInstanceOf(Error);
      expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
    });

    it("adopting another App: the same question; no changes nothing", async () => {
      const keyPath = join(dir, "adopt-pending.pem");
      writeFileSync(keyPath, PEM);
      const { d, deps, w } = harness({ ...pendingBase, save: false });
      const before = readFileSync(d.configPath, "utf8");
      expect(
        await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps).catch((e) => e),
      ).toEqual(
        new SetupError(
          "Nothing was changed: install stale-devbox from https://github.com/apps/stale-devbox/installations/new, then run bun run github:setup",
        ),
      );
      expect(w.asked).toEqual([REPLACE_Q]);
      expect(readFileSync(d.configPath, "utf8")).toBe(before);
      expect(w.calls).toEqual([]);
    });

    it("adopting another App, yes, secrets not saved: stale entries go, none moved", async () => {
      const keyPath = join(dir, "adopt-pending2.pem");
      writeFileSync(keyPath, PEM);
      const { d, deps, w } = harness({
        ...pendingBase,
        saved: { ...OLD_SAVED, ...STALE_SAVED },
        confirms: [true, false],
        hidden: ["typed-secret"],
      });
      await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps);
      expect(w.asked).toEqual([REPLACE_Q, ADOPT_HOOK_Q, SAVE_BOTH, SHOW_HOOK_ONCE]);
      expect(w.shown).toEqual(["typed-secret"]);
      expect(w.log).toEqual([
        PUBLIC_LINE,
        ...STALE_DROPPED,
        KEEPS_WORKING,
        `Set the App's webhook URL to ${HOOK}. Check that the webhook is Active on the App's settings page: https://github.com/organizations/example-org/settings/apps/${SLUG}`,
        `Set GITHUB_APP_PRIVATE_KEY_FILE=${keyPath} before bun run up, once the new App is installed`,
        INSTALLED_ORG,
        `Wrote integrations.githubApp to ${d.configPath}`,
        OLD_UNUSED,
        EARLIER_KEY,
        EARLIER_HOOK,
        ...NEXT_COMPOSE,
      ]);
      expect(w.keychain.entries()).toEqual(OLD_SAVED);
    });
  });
});

describe("setup --app-id over a working App", () => {
  const keyPath = join(dir, "adopt-over.pem");
  writeFileSync(keyPath, PEM);
  const base = {
    publicUrl: PUBLIC,
    githubApp: OLD_APP,
    trust: { trustedOrgs: ["example-org"], trustedUsers: [] },
    saved: OLD_SAVED,
    hidden: ["typed-secret"],
  };
  const SET_HOOK = `Set the App's webhook URL to ${HOOK}. Check that the webhook is Active on the App's settings page: https://github.com/organizations/example-org/settings/apps/${SLUG}`;

  it("another App, already installed: it replaces the working one at once", async () => {
    const { d, deps, w } = harness(base);
    await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps);
    expect(w.asked).toEqual([ADOPT_HOOK_Q, SAVE_BOTH]);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      KEEPS_WORKING,
      SET_HOOK,
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      OLD_UNUSED,
      OLD_REPLACED,
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
    expect(w.keychain.entries()).toEqual({
      "compose/GITHUB_APP_PRIVATE_KEY": PEM,
      "compose/GITHUB_WEBHOOK_SECRET": "typed-secret",
    });
  });

  it("another App, not installed: it waits as pending and the working App stays on", async () => {
    const { d, deps, w } = harness({
      ...base,
      github: { "GET /app/installations?per_page=100&page=1": [200, []] },
    });
    expect(
      await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps).catch((e) => e),
    ).toEqual(
      new SetupError(
        `The App isn't installed yet: install it from ${INSTALL_URL}, then run bun run github:setup again`,
      ),
    );
    expect(w.log).toEqual([PUBLIC_LINE, KEEPS_WORKING, SET_HOOK, ...INSTALL]);
    expect(readJson(d.configPath)).toEqual(configOf({ ...OLD_APP, pending: PENDING }));
    expect(w.keychain.entries()).toEqual({
      ...OLD_SAVED,
      "compose/GITHUB_APP_PRIVATE_KEY_PENDING": PEM,
      "compose/GITHUB_WEBHOOK_SECRET_PENDING": "typed-secret",
    });
  });

  it("the working App itself: as before, no pending", async () => {
    const { d, deps, w } = harness({ ...base, githubApp: ENABLED });
    await setup(d, opts({ appId: 123, privateKeyFile: keyPath }), deps);
    expect(w.log).toEqual([
      PUBLIC_LINE,
      SET_HOOK,
      INSTALLED_ORG,
      `Wrote integrations.githubApp to ${d.configPath}`,
      ...NEXT_COMPOSE,
    ]);
    expect(readJson(d.configPath)).toEqual(configOf(ENABLED));
    expect(w.keychain.entries()).toEqual({
      "compose/GITHUB_APP_PRIVATE_KEY": PEM,
      "compose/GITHUB_WEBHOOK_SECRET": "typed-secret",
    });
  });
});
