import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitlabIntegration } from "../lib/integrations";
import { type Deployment, type Keychain, MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import type { RepoConfig } from "../up/config";
import type { Fetch } from "../up/preflight";
import type { GitlabDeployment } from "./deployment";
import { newWebhookToken, type SetupDeps, SetupError, type SetupOptions, setup } from "./setup";

const dir = mkdtempSync(join(tmpdir(), "devbox-gitlab-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BASE = "https://gitlab.example.com";
const PUBLIC = "https://hooks.example.com";
const HOOK_URL = `${PUBLIC}/webhook/gitlab`;
const K8S: Deployment = { kind: "k8s", context: "prod", namespace: "devbox" };
const SCOPE = "k8s:prod/devbox";
const REPO: RepoConfig = {
  url: `${BASE}/platform/backend/api.git`,
  branch: "main",
  host: "gitlab",
  owner: "platform/backend",
  name: "api",
};
const GITLAB: GitlabIntegration = {
  enabled: true,
  botUsername: "devbox",
  botUserId: 2,
  ciResults: true,
  webhookAuth: "signing",
};
const PROJECT = `${BASE}/api/v4/projects/${encodeURIComponent("platform/backend/api")}`;
const RANDOM = Buffer.alloc(32, 7);
const SIGNING = `whsec_${RANDOM.toString("base64")}`;
const SECRET = RANDOM.toString("hex");

type Req = { method: string; url: string; body?: unknown };

let n = 0;
function targetFile(content: unknown): string {
  const path = join(dir, `t${n++}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function harness(o: {
  gitlab?: GitlabIntegration;
  instance?: { baseUrl: string; caFile?: string } | null;
  publicUrl?: string;
  ingressUrl?: string;
  trust?: { trustedGroups: string[]; trustedUsers: string[] };
  byoGitlabSecret?: string;
  byoIntegrationsSecret?: string;
  env?: Record<string, string>;
  keychain?: Keychain | "none";
  saved?: Record<string, string>;
  isTTY?: boolean;
  save?: boolean;
  version?: string;
  bot?: boolean;
  hooks?: Array<{ id: number; url: string }>;
  hooksStatus?: number;
  mrStatus?: number;
  members?: unknown[];
}) {
  const requests: Req[] = [];
  const log: string[] = [];
  const asked: string[] = [];
  const keychain = new MemoryKeychain(o.saved);
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const req: Req = { method, url: String(url) };
    if (init?.body) req.body = JSON.parse(String(init.body));
    requests.push(req);
    const u = String(url);
    if (u === `${BASE}/api/v4/version`) return Response.json({ version: o.version ?? "19.5.3" });
    if (u === `${BASE}/api/v4/user`) {
      return Response.json({ id: 2, username: "devbox", name: "devbox", bot: o.bot ?? true });
    }
    if (u === PROJECT) return Response.json({ id: 1 });
    if (u === `${BASE}/platform/backend/api.git/info/refs?service=git-receive-pack`) {
      return new Response("001f# service=git-receive-pack\n");
    }
    if (u === `${PROJECT}/merge_requests`) {
      return Response.json(
        { message: ["Source branch does not exist"] },
        { status: o.mrStatus ?? 400 },
      );
    }
    if (u === `${PROJECT}/pipelines?per_page=1` || u === `${PROJECT}/jobs?per_page=1`) {
      return Response.json([]);
    }
    if (u.startsWith(`${BASE}/api/v4/groups/`)) return Response.json(o.members ?? [{ id: 3 }]);
    if (u === `${PROJECT}/hooks`) {
      if (o.hooksStatus)
        return Response.json({ message: "403 Forbidden" }, { status: o.hooksStatus });
      return method === "GET"
        ? Response.json(o.hooks ?? [])
        : Response.json({ id: 11 }, { status: 201 });
    }
    if (u.startsWith(`${PROJECT}/hooks/`)) return Response.json({ id: 11 });
    return new Response("not routed", { status: 599 });
  };
  const configPath = targetFile({
    context: "prod",
    values: {
      storage: { storageClass: "gp3" },
      ...(o.trust ? { gitlab: o.trust } : {}),
    },
    ...(o.gitlab ? { integrations: { gitlab: o.gitlab } } : {}),
    ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}),
  });
  const resolver: ResolverDeps = {
    env: o.env ?? {},
    keychain: o.keychain === "none" ? undefined : (o.keychain ?? keychain),
    deployment: K8S,
    targetPath: configPath,
    isTTY: o.isTTY ?? true,
    prompt: async (q) => {
      asked.push(q);
      return "";
    },
    confirm: async (q) => {
      asked.push(q);
      return o.save ?? true;
    },
    run: async () => {
      throw new Error("setup runs no command");
    },
    log: (line) => log.push(line),
  };
  const d: GitlabDeployment = {
    deployment: K8S,
    configPath,
    trustKey: "values.gitlab",
    instance: o.instance === null ? undefined : (o.instance ?? { baseUrl: BASE }),
    repos: o.instance === null ? [] : [REPO],
    gitlab: o.gitlab,
    trust: o.trust ?? { trustedGroups: [], trustedUsers: [] },
    linear: false,
    ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}),
    ...(o.ingressUrl ? { ingressUrl: o.ingressUrl } : {}),
    ...(o.byoGitlabSecret ? { byoGitlabSecret: o.byoGitlabSecret } : {}),
    ...(o.byoIntegrationsSecret ? { byoIntegrationsSecret: o.byoIntegrationsSecret } : {}),
    applyCommand: `bun run k8s:install --target ${configPath}`,
    statusCommand: `bun run gitlab:status --target ${configPath}`,
    api: async () => {
      throw new Error("setup calls no API");
    },
  };
  const deps: SetupDeps = {
    resolver,
    promptLine: async (q) => {
      asked.push(q);
      return "";
    },
    fetch,
    log: (line) => log.push(line),
    readFile: (path) =>
      path === "/etc/corp-ca.pem" ? "-----BEGIN CERTIFICATE-----\nCA\n" : undefined,
    random: () => RANDOM,
  };
  return { d, deps, log, asked, requests, keychain, configPath };
}

const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({
  publicUrl: PUBLIC,
  trustedGroups: [],
  trustedUsers: [],
  secretToken: false,
  skipWebhook: false,
  skipPushCheck: false,
  ...o,
});

describe("newWebhookToken", () => {
  it("whsec_ + base64 for the signing token, hex for the secret token", () => {
    expect(newWebhookToken("signing", () => RANDOM)).toBe(SIGNING);
    expect(newWebhookToken("secret", () => RANDOM)).toBe(SECRET);
    expect(newWebhookToken("signing")).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
  });
});

describe("gitlab:setup", () => {
  it("first run: checks the saved token, registers the hook, saves the webhook token, writes the block", async () => {
    const h = harness({ saved: { [`${SCOPE}/GITLAB_TOKEN`]: "glpat-saved" } });
    await setup(h.d, opts(), h.deps);
    expect(h.asked).toEqual([
      `Save the webhook token (GITLAB_WEBHOOK_SIGNING_TOKEN) to the system keychain for ${SCOPE}? [Y/n] `,
    ]);
    expect(h.log).toEqual([
      `Public URL: ${PUBLIC}`,
      `Trust: no --trusted-group or --trusted-user and none saved: trusting the members of group platform/backend (the namespace of ${REPO.url})`,
      `GITLAB_TOKEN: from the system keychain (${SCOPE})`,
      `GitLab 19.5.3 at ${BASE}: devbox acts as devbox (id 2, a bot user)`,
      `Webhook on platform/backend/api: ${HOOK_URL} (note and pipeline events)`,
      `Wrote integrations.gitlab and values.gitlab to ${h.configPath}`,
      `Next: bun run k8s:install --target ${h.configPath}`,
      "With GitOps, set these chart values instead: integrations.gitlab {enabled: true, botUsername: devbox, botUserId: 2}, gitlab.trustedGroups, and GITLAB_WEBHOOK_SIGNING_TOKEN in the integrations Secret",
      `Then check GitLab with: bun run gitlab:status --target ${h.configPath}`,
    ]);
    // The check, the trust probe for the default group, then the hook.
    expect(h.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${BASE}/api/v4/version`,
      `GET ${BASE}/api/v4/user`,
      `GET ${PROJECT}`,
      `GET ${BASE}/platform/backend/api.git/info/refs?service=git-receive-pack`,
      `POST ${PROJECT}/merge_requests`,
      `GET ${PROJECT}/pipelines?per_page=1`,
      `GET ${PROJECT}/jobs?per_page=1`,
      `GET ${BASE}/api/v4/groups/platform%2Fbackend/members/all?per_page=1`,
      `GET ${PROJECT}/hooks`,
      `POST ${PROJECT}/hooks`,
    ]);
    expect(h.requests.at(-1)?.body).toEqual({
      url: HOOK_URL,
      name: "devbox",
      description: "devbox: merge request notes and pipelines",
      note_events: true,
      pipeline_events: true,
      push_events: false,
      merge_requests_events: false,
      confidential_note_events: false,
      enable_ssl_verification: true,
      signing_token: SIGNING,
    });
    expect(h.keychain.entries()).toEqual({
      [`${SCOPE}/GITLAB_TOKEN`]: "glpat-saved",
      [`${SCOPE}/GITLAB_WEBHOOK_SIGNING_TOKEN`]: SIGNING,
    });
    expect(readJson(h.configPath)).toEqual({
      context: "prod",
      values: {
        storage: { storageClass: "gp3" },
        gitlab: { trustedGroups: ["platform/backend"], trustedUsers: [] },
      },
      integrations: { gitlab: GITLAB },
      publicUrl: PUBLIC,
    });
    // The token never reaches the log.
    expect(h.log.join("\n")).not.toContain("glpat-saved");
    expect(h.log.join("\n")).not.toContain(SIGNING);
  });

  it("a re-run reuses the saved webhook token and updates the existing hook", async () => {
    const h = harness({
      gitlab: GITLAB,
      publicUrl: PUBLIC,
      trust: { trustedGroups: ["platform"], trustedUsers: ["rahul"] },
      saved: {
        [`${SCOPE}/GITLAB_TOKEN`]: "glpat-saved",
        [`${SCOPE}/GITLAB_WEBHOOK_SIGNING_TOKEN`]: "whsec_kept",
      },
      hooks: [{ id: 5, url: HOOK_URL }],
    });
    await setup(h.d, opts({ publicUrl: undefined }), h.deps);
    expect(h.asked).toEqual([]);
    const hook = h.requests.find((r) => r.url === `${PROJECT}/hooks/5`);
    expect(hook?.method).toBe("PUT");
    expect((hook?.body as { signing_token?: string } | undefined)?.signing_token).toBe(
      "whsec_kept",
    );
    expect(h.log).toContain(
      `Webhook token: GITLAB_WEBHOOK_SIGNING_TOKEN from the system keychain (${SCOPE})`,
    );
    expect(h.requests.map((r) => r.url)).toContain(
      `${BASE}/api/v4/groups/platform/members/all?per_page=1`,
    );
    expect((readJson(h.configPath) as { values: { gitlab: unknown } }).values.gitlab).toEqual({
      trustedGroups: ["platform"],
      trustedUsers: ["rahul"],
    });
  });

  it("without a usable keychain the webhook token is shown once", async () => {
    const h = harness({ env: { GITLAB_TOKEN: "glpat-env" }, keychain: "none" });
    await setup(h.d, opts(), h.deps);
    expect(h.log).toContain(
      `The webhook token, shown once (set it as GITLAB_WEBHOOK_SIGNING_TOKEN before bun run k8s:install --target ${h.configPath}):`,
    );
    expect(h.log).toContain(`  ${SIGNING}`);
    expect(h.log).toContain("GITLAB_TOKEN: from your environment");
  });

  it("an older instance, or --secret-token, uses the legacy secret token", async () => {
    const old = harness({ saved: { [`${SCOPE}/GITLAB_TOKEN`]: "t" }, version: "18.9.0" });
    await setup(old.d, opts(), old.deps);
    expect(old.log).toContain(
      "GitLab 18.9.0 is below 19.1: using the legacy secret token (X-Gitlab-Token) for the webhook",
    );
    expect((old.requests.at(-1)?.body as { token?: string } | undefined)?.token).toBe(SECRET);
    expect(
      (readJson(old.configPath) as { integrations: { gitlab: GitlabIntegration } }).integrations
        .gitlab.webhookAuth,
    ).toBe("secret");
    expect(old.keychain.entries()[`${SCOPE}/GITLAB_WEBHOOK_SECRET`]).toBe(SECRET);

    const flag = harness({ saved: { [`${SCOPE}/GITLAB_TOKEN`]: "t" } });
    await setup(flag.d, opts({ secretToken: true }), flag.deps);
    expect((flag.requests.at(-1)?.body as { token?: string } | undefined)?.token).toBe(SECRET);
  });

  it("a person's token is accepted with a note about their own comments", async () => {
    const h = harness({ saved: { [`${SCOPE}/GITLAB_TOKEN`]: "t" }, bot: false });
    await setup(h.d, opts(), h.deps);
    expect(h.log).toContain(`GitLab 19.5.3 at ${BASE}: devbox acts as devbox (id 2)`);
    expect(h.log.some((l) => l.startsWith("Note: devbox is a person, not a bot user"))).toBe(true);
  });

  it("the token's own Secret: no checks, the bot from the flags, no hooks registered", async () => {
    const h = harness({ byoGitlabSecret: "my-gitlab" });
    await setup(h.d, opts({ botUsername: "devbox", botUserId: 2 }), h.deps);
    expect(h.requests).toEqual([]);
    expect(h.log).toContain(
      'GitLab token: in your Secret "my-gitlab" (not read): skipping the token checks',
    );
    expect(h.log).toContain(
      "The token may not manage webhooks (Maintainer role needed). Create one on each project by hand:",
    );
    expect((readJson(h.configPath) as { integrations: unknown }).integrations).toEqual({
      gitlab: GITLAB,
    });
  });

  it("the token's own Secret without the bot flags stops", async () => {
    const h = harness({ byoGitlabSecret: "my-gitlab" });
    await expect(setup(h.d, opts(), h.deps)).rejects.toThrow(
      "the bot's identity is unknown: pass --bot-username and --bot-user-id",
    );
  });

  it("a token that may not manage hooks gets the manual instructions", async () => {
    const h = harness({ saved: { [`${SCOPE}/GITLAB_TOKEN`]: "t" }, hooksStatus: 403 });
    await setup(h.d, opts(), h.deps);
    expect(h.log).toContain(
      `  URL ${HOOK_URL}, triggers Comments and Pipeline events, signing token as below`,
    );
    expect(readJson(h.configPath)).toMatchObject({ integrations: { gitlab: GITLAB } });
  });

  it("--skip-webhook registers nothing", async () => {
    const h = harness({ saved: { [`${SCOPE}/GITLAB_TOKEN`]: "t" } });
    await setup(h.d, opts({ skipWebhook: true }), h.deps);
    expect(h.requests.some((r) => r.url.includes("/hooks"))).toBe(false);
    expect(h.log).toContain("Webhooks: not registered (--skip-webhook)");
  });

  it("the trust flags win and are checked; a private CA is read for the checks", async () => {
    const h = harness({
      saved: { [`${SCOPE}/GITLAB_TOKEN`]: "t" },
      instance: { baseUrl: BASE, caFile: "/etc/corp-ca.pem" },
    });
    await setup(h.d, opts({ trustedGroups: ["platform"], trustedUsers: ["rahul"] }), h.deps);
    expect(h.requests.map((r) => r.url)).toContain(
      `${BASE}/api/v4/groups/platform/members/all?per_page=1`,
    );
    expect((readJson(h.configPath) as { values: { gitlab: unknown } }).values.gitlab).toEqual({
      trustedGroups: ["platform"],
      trustedUsers: ["rahul"],
    });
  });

  it("a missing CA file, no instance, and no repo under it each stop before anything", async () => {
    const ca = harness({ instance: { baseUrl: BASE, caFile: "/nope.pem" } });
    await expect(setup(ca.d, opts(), ca.deps)).rejects.toThrow(
      "gitlab.caFile /nope.pem: cannot read it",
    );
    const none = harness({ instance: null });
    await expect(setup(none.d, opts(), none.deps)).rejects.toThrow(SetupError);
    const h = harness({});
    h.d.repos = [];
    await expect(setup(h.d, opts(), h.deps)).rejects.toThrow(`no repo under ${BASE}`);
  });

  it("a rejected token is asked again in a terminal, then the check runs on the new one", async () => {
    const h = harness({ saved: { [`${SCOPE}/GITLAB_TOKEN`]: "stale" } });
    let calls = 0;
    const inner = h.deps.fetch;
    h.deps.fetch = async (url, init) => {
      if (String(url) === `${BASE}/api/v4/version` && calls++ === 0) {
        return Response.json({ message: "401 Unauthorized" }, { status: 401 });
      }
      return inner(url, init);
    };
    h.deps.resolver.prompt = async (q) => {
      h.asked.push(q);
      return "glpat-fresh";
    };
    await setup(h.d, opts(), h.deps);
    expect(h.asked[0]).toBe("GitLab token (input hidden): ");
    expect(h.keychain.entries()[`${SCOPE}/GITLAB_TOKEN`]).toBe("glpat-fresh");
  });
});
