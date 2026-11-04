import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestructiveRefused } from "../lib/destructive";
import type { GitlabIntegration } from "../lib/integrations";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import type { GitlabDeployment } from "./deployment";
import { disable } from "./disable";

const dir = mkdtempSync(join(tmpdir(), "devbox-gitlab-disable-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const K8S: Deployment = { kind: "k8s", context: "prod", namespace: "devbox" };
const GITLAB: GitlabIntegration = {
  enabled: true,
  botUsername: "devbox",
  botUserId: 2,
  ciResults: true,
  webhookAuth: "signing",
};
let n = 0;

async function run(o: {
  gitlab?: GitlabIntegration;
  forget?: boolean;
  yes?: boolean;
  isTTY?: boolean;
  answer?: boolean;
  saved?: Record<string, string>;
}) {
  const path = join(dir, `t${n++}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      context: "prod",
      values: { gitlab: { trustedGroups: ["platform"] }, storage: { storageClass: "gp3" } },
      ...(o.gitlab ? { integrations: { gitlab: o.gitlab } } : {}),
    }),
  );
  const keychain = new MemoryKeychain({
    "k8s:prod/devbox/GITHUB_TOKEN": "c",
    ...(o.saved ?? {
      "k8s:prod/devbox/GITLAB_TOKEN": "a",
      "k8s:prod/devbox/GITLAB_WEBHOOK_SIGNING_TOKEN": "b",
    }),
  });
  const log: string[] = [];
  const asked: string[] = [];
  const d: GitlabDeployment = {
    deployment: K8S,
    configPath: path,
    instance: { baseUrl: "https://gitlab.example.com" },
    repos: [
      {
        url: "https://gitlab.example.com/platform/api.git",
        branch: "main",
        host: "gitlab",
        owner: "platform",
        name: "api",
      },
    ],
    gitlab: o.gitlab,
    trust: { trustedGroups: ["platform"], trustedUsers: [] },
    linear: false,
    applyCommand: `bun run k8s:install --target ${path}`,
    statusCommand: `bun run gitlab:status --target ${path}`,
    api: async () => Response.json({}),
  };
  const resolver = {
    env: {},
    keychain,
    deployment: K8S,
    isTTY: o.isTTY ?? true,
    prompt: async () => "",
    confirm: async (q: string) => {
      asked.push(q);
      return o.answer ?? true;
    },
    run: async () => ({ code: 1, stdout: "" }),
    log: (l: string) => log.push(l),
  } as unknown as ResolverDeps;
  let error: unknown;
  try {
    await disable(
      d,
      { forget: o.forget === true, yes: o.yes === true },
      { resolver, log: (l) => log.push(l) },
    );
  } catch (err) {
    error = err;
  }
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { log, asked, file, keychain: keychain.entries(), error };
}

describe("gitlab:disable", () => {
  it("switches the webhooks off and keeps the rest", async () => {
    const r = await run({ gitlab: GITLAB });
    expect(r.file.integrations).toEqual({ gitlab: { ...GITLAB, enabled: false } });
    expect((r.file.values as Record<string, unknown>).gitlab).toEqual({
      trustedGroups: ["platform"],
    });
    expect(r.log[0]).toContain("Disabled the GitLab webhooks");
    expect(Object.keys(r.keychain)).toHaveLength(3);
  });

  it("nothing to disable without the block, or when already off", async () => {
    expect((await run({})).log).toEqual([
      "GitLab webhooks are not configured for k8s:prod/devbox. Nothing to disable.",
    ]);
    expect((await run({ gitlab: { ...GITLAB, enabled: false } })).log).toEqual([
      "GitLab webhooks are already disabled for k8s:prod/devbox.",
    ]);
  });

  it("--forget removes the block, the trust lists and the saved secrets after confirming", async () => {
    const r = await run({ gitlab: GITLAB, forget: true });
    expect(r.asked).toEqual(["Remove these? [y/N] "]);
    expect(r.file.integrations).toBeUndefined();
    expect((r.file.values as Record<string, unknown>).gitlab).toBeUndefined();
    expect((r.file.values as Record<string, unknown>).storage).toEqual({ storageClass: "gp3" });
    expect(Object.keys(r.keychain)).toEqual(["k8s:prod/devbox/GITHUB_TOKEN"]);
    expect(r.log.at(-1)).toContain("Delete the devbox webhook on each project in GitLab");
  });

  it("--forget declined removes nothing", async () => {
    const r = await run({ gitlab: GITLAB, forget: true, answer: false });
    expect(r.log.at(-1)).toBe("Nothing was removed.");
    expect(r.file.integrations).toEqual({ gitlab: GITLAB });
    expect(Object.keys(r.keychain)).toHaveLength(3);
  });

  it("--forget without a terminal needs --yes", async () => {
    const r = await run({ gitlab: GITLAB, forget: true, isTTY: false });
    expect(r.error).toBeInstanceOf(DestructiveRefused);
    expect(r.file.integrations).toEqual({ gitlab: GITLAB });
    const y = await run({ gitlab: GITLAB, forget: true, isTTY: false, yes: true });
    expect(y.file.integrations).toBeUndefined();
  });
});
