import { describe, expect, it } from "bun:test";
import type { GitlabIntegration } from "../lib/integrations";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { PeekDeps } from "../lib/secrets";
import type { RepoConfig } from "../up/config";
import type { GitlabDeployment } from "./deployment";
import { status } from "./status";

const K8S: Deployment = { kind: "k8s", context: "prod", namespace: "devbox" };
const BASE = "https://gitlab.example.com";
const PUBLIC = "https://hooks.example.com";
const GITLAB: GitlabIntegration = {
  enabled: true,
  botUsername: "devbox",
  botUserId: 2,
  ciResults: true,
  webhookAuth: "signing",
};
const REPO: RepoConfig = {
  url: `${BASE}/platform/api.git`,
  branch: "main",
  host: "gitlab",
  owner: "platform",
  name: "api",
};
const BODY = {
  token: { configured: true, source: "file", readAt: "2026-11-04T08:00:00.000Z", lastError: null },
  webhooks: { enabled: true, lastWebhookAt: "2026-11-04T08:05:00.000Z", ciResults: true },
};
const unsigned = () => Response.json({ error: "invalid signature" }, { status: 401 });

async function run(o: {
  gitlab?: GitlabIntegration;
  instance?: { baseUrl: string; caFile?: string } | null;
  publicUrl?: string | null;
  api?: () => Promise<Response>;
  byoIntegrations?: string;
  byoGitlab?: string;
  env?: Record<string, string>;
}): Promise<{ log: string[]; probed: string[] }> {
  const log: string[] = [];
  const probed: string[] = [];
  const d: GitlabDeployment = {
    deployment: K8S,
    configPath: "devbox.k8s.json",
    trustKey: "values.gitlab",
    instance: o.instance === null ? undefined : (o.instance ?? { baseUrl: BASE }),
    repos: [REPO],
    gitlab: o.gitlab,
    trust: { trustedGroups: ["platform"], trustedUsers: [] },
    integrations: {},
    ...(o.publicUrl === null ? {} : { publicUrl: o.publicUrl ?? PUBLIC }),
    applyCommand: "bun run k8s:install --target devbox.k8s.json",
    statusCommand: "bun run gitlab:status --target devbox.k8s.json",
    ...(o.byoIntegrations ? { byoIntegrationsSecret: o.byoIntegrations } : {}),
    ...(o.byoGitlab ? { byoGitlabSecret: o.byoGitlab } : {}),
    api: o.api ?? (async () => Response.json(BODY)),
  };
  const resolver = {
    env: o.env ?? {},
    keychain: new MemoryKeychain({ "k8s:prod/devbox/GITLAB_TOKEN": "glpat" }),
    deployment: K8S,
    run: async () => ({ code: 1, stdout: "" }),
  } as unknown as PeekDeps;
  await status(d, {
    resolver,
    fetch: async (url) => {
      probed.push(url);
      return unsigned();
    },
    log: (l) => log.push(l),
  });
  return { log, probed };
}

describe("gitlab:status", () => {
  it("shows the instance, the token's source, the block, the control plane and the probe", async () => {
    const { log, probed } = await run({
      gitlab: GITLAB,
      env: { GITLAB_WEBHOOK_SIGNING_TOKEN: "whsec_x" },
    });
    expect(log).toEqual([
      "GitLab (k8s:prod/devbox)",
      `  baseUrl         ${BASE}`,
      "  caFile          none (a public CA)",
      "  repos           platform/api",
      "  GITLAB_TOKEN    keychain",
      "  botUsername     devbox",
      "  botUserId       2",
      "  ciResults       true",
      "  webhookAuth     signing token",
      "  trustedGroups   platform",
      "  trustedUsers    none",
      `  publicUrl       ${PUBLIC}`,
      "  GITLAB_WEBHOOK_SIGNING_TOKEN  env",
      "Control plane: token from file (read 2026-11-04T08:00:00.000Z)",
      "Control plane: last webhook from GitLab 2026-11-04T08:05:00.000Z, CI results on",
      `Webhook URL ${PUBLIC}/webhook/gitlab: reaches devbox with GitLab on`,
    ]);
    expect(probed).toEqual([`${PUBLIC}/webhook/gitlab`]);
  });

  it("no instance: says so and stops", async () => {
    const { log, probed } = await run({ instance: null });
    expect(log).toEqual([
      "No GitLab instance is configured for k8s:prod/devbox (gitlab.baseUrl in devbox.config.json).",
    ]);
    expect(probed).toEqual([]);
  });

  it("an instance without the webhooks points at gitlab:setup", async () => {
    const { log } = await run({});
    expect(log.at(-1)).toBe(
      "Webhooks are not configured for k8s:prod/devbox. Run: bun run gitlab:setup --target devbox.k8s.json",
    );
  });

  it("disabled webhooks say how to turn them on", async () => {
    const { log } = await run({ gitlab: { ...GITLAB, enabled: false } });
    expect(log.at(-1)).toContain("Webhooks are disabled for k8s:prod/devbox");
  });

  it("the user's own Secrets are named, not read; the legacy token is labelled", async () => {
    const { log } = await run({
      gitlab: { ...GITLAB, webhookAuth: "secret" },
      byoIntegrations: "my-ints",
      byoGitlab: "my-gitlab",
      instance: { baseUrl: BASE, caFile: "/etc/devbox/corp-ca.pem" },
    });
    expect(log).toContain("  caFile          /etc/devbox/corp-ca.pem");
    expect(log).toContain('  GITLAB_TOKEN    from Secret "my-gitlab" (not read)');
    expect(log).toContain("  webhookAuth     secret token (X-Gitlab-Token)");
    expect(log).toContain('  GITLAB_WEBHOOK_SECRET         from Secret "my-ints" (not read)');
  });

  it("an unreachable control plane and a not-yet-applied one are reported", async () => {
    const down = await run({
      gitlab: GITLAB,
      api: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(down.log).toContain("Control plane: not reachable (connect ECONNREFUSED)");
    const off = await run({
      gitlab: GITLAB,
      api: async () =>
        Response.json({ token: { configured: false }, webhooks: { enabled: false } }),
    });
    expect(off.log).toContain(
      "Control plane: no GitLab token (GITLAB_TOKEN_FILE is not set there)",
    );
    expect(off.log).toContain(
      "Control plane: GitLab webhooks are not on there yet. Run: bun run k8s:install --target devbox.k8s.json",
    );
  });
});
