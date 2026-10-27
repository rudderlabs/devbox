import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestructiveRefused } from "../lib/destructive";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import type { GithubDeployment } from "./deployment";
import { disable } from "./disable";

const dir = mkdtempSync(join(tmpdir(), "devbox-github-disable-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const COMPOSE: Deployment = { kind: "compose" };
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
const OFF = { ...APP, enabled: false };
const SHARED = { publicUrl: "https://hooks.example.com", github: { trustedOrgs: ["example-org"] } };
let n = 0;

async function run(o: {
  app?: typeof APP & { org?: string; pending?: { appId: number; slug: string; org?: string } };
  forget?: boolean;
  yes?: boolean;
  isTTY?: boolean;
  answer?: boolean;
  saved?: Record<string, string>;
  noKeychain?: boolean;
}) {
  const path = join(dir, `c${n++}.json`);
  const original = JSON.stringify({
    port: 1,
    ...SHARED,
    ...(o.app
      ? { integrations: { githubApp: o.app, linear: { enabled: true, clientId: "c" } } }
      : {}),
  });
  writeFileSync(path, original);
  const keychain = new MemoryKeychain({
    "compose/GITHUB_TOKEN": "c",
    ...(o.saved ?? {
      "compose/GITHUB_APP_PRIVATE_KEY": "pem",
      "compose/GITHUB_WEBHOOK_SECRET": "b",
    }),
  });
  const log: string[] = [];
  const asked: string[] = [];
  const d: GithubDeployment = {
    deployment: COMPOSE,
    configPath: path,
    githubApp: o.app,
    linear: false,
    repos: [],
    trust: { trustedOrgs: [], trustedUsers: [] },
    applyCommand: "bun run up",
    statusCommand: "bun run github:status",
    api: async () => Response.json({}),
  };
  const resolver = {
    env: {},
    keychain: o.noKeychain ? undefined : keychain,
    deployment: COMPOSE,
    isTTY: o.isTTY ?? true,
    confirm: async (q: string) => {
      asked.push(q);
      return o.answer ?? false;
    },
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
  return {
    log,
    asked,
    error,
    path,
    keychain,
    original: JSON.parse(original),
    file: JSON.parse(readFileSync(path, "utf8")),
  };
}

const ALL_ENTRIES = {
  "compose/GITHUB_TOKEN": "c",
  "compose/GITHUB_APP_PRIVATE_KEY": "pem",
  "compose/GITHUB_WEBHOOK_SECRET": "b",
};
const LINEAR = { enabled: true, clientId: "c" };

describe("github disable", () => {
  it("switches off, keeps the block's keys, the shared keys and the keychain", async () => {
    const r = await run({ app: APP });
    expect(r.file).toEqual({
      port: 1,
      ...SHARED,
      integrations: { githubApp: OFF, linear: LINEAR },
    });
    expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
    expect(r.asked).toEqual([]);
    expect(r.log).toEqual([
      `Disabled the GitHub App in ${r.path}.`,
      "GitHub falls back to a personal token: the next apply needs GITHUB_TOKEN.",
      "Next: bun run up",
    ]);
  });

  it("a new App pending: kept, and named with how to resume or remove it", async () => {
    const pending = { appId: 124, slug: "new-devbox" };
    const r = await run({ app: { ...APP, pending } });
    expect(r.file).toEqual({
      port: 1,
      ...SHARED,
      integrations: { githubApp: { ...OFF, pending }, linear: LINEAR },
    });
    expect(r.log).toEqual([
      `Disabled the GitHub App in ${r.path}.`,
      "GitHub falls back to a personal token: the next apply needs GITHUB_TOKEN.",
      "The new App new-devbox is still waiting for its install: bun run github:setup resumes it, bun run github:disable --forget removes it",
      "Next: bun run up",
    ]);

    const again = await run({ app: { ...OFF, pending } as typeof APP });
    expect(again.file).toEqual(again.original);
    expect(again.log).toEqual([
      "The GitHub App is already disabled for compose.",
      "The new App new-devbox is still waiting for its install: bun run github:setup resumes it, bun run github:disable --forget removes it",
    ]);
  });

  it("already disabled", async () => {
    const r = await run({ app: OFF as typeof APP });
    expect(r.file).toEqual(r.original);
    expect(r.log).toEqual(["The GitHub App is already disabled for compose."]);
  });

  it("not configured", async () => {
    for (const forget of [false, true]) {
      const r = await run({ forget });
      expect(r.file).toEqual(r.original);
      expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
      expect(r.log).toEqual(["The GitHub App is not configured for compose. Nothing to disable."]);
    }
  });

  it("--forget lists the block and both entries, removes them on yes, keeps shared keys", async () => {
    const r = await run({ app: APP, forget: true, answer: true });
    expect(r.asked).toEqual(["Remove these? [y/N] "]);
    expect(r.file).toEqual({ port: 1, ...SHARED, integrations: { linear: LINEAR } });
    expect(r.keychain.entries()).toEqual({ "compose/GITHUB_TOKEN": "c" });
    expect(r.log).toEqual([
      "This deletes:",
      `  - integrations.githubApp in ${r.path}`,
      "  - GITHUB_APP_PRIVATE_KEY for compose in the system keychain",
      "  - GITHUB_WEBHOOK_SECRET for compose in the system keychain",
      "Next: bun run up",
      "Delete the App on GitHub: https://github.com/settings/apps/example-devbox/advanced",
    ]);
  });

  it("--forget with a new App pending: lists and removes it and its entries too", async () => {
    const r = await run({
      app: { ...APP, pending: { appId: 124, slug: "new-devbox", org: "example-org" } },
      forget: true,
      answer: true,
      saved: {
        "compose/GITHUB_APP_PRIVATE_KEY": "pem",
        "compose/GITHUB_WEBHOOK_SECRET": "b",
        "compose/GITHUB_APP_PRIVATE_KEY_PENDING": "pem2",
        "compose/GITHUB_WEBHOOK_SECRET_PENDING": "b2",
      },
    });
    expect(r.file).toEqual({ port: 1, ...SHARED, integrations: { linear: LINEAR } });
    expect(r.keychain.entries()).toEqual({ "compose/GITHUB_TOKEN": "c" });
    expect(r.log).toEqual([
      "This deletes:",
      `  - integrations.githubApp in ${r.path}`,
      `  - the pending App new-devbox (integrations.githubApp.pending) in ${r.path}`,
      "  - GITHUB_APP_PRIVATE_KEY for compose in the system keychain",
      "  - GITHUB_WEBHOOK_SECRET for compose in the system keychain",
      "  - GITHUB_APP_PRIVATE_KEY_PENDING for compose in the system keychain",
      "  - GITHUB_WEBHOOK_SECRET_PENDING for compose in the system keychain",
      "Next: bun run up",
      "Delete the App on GitHub: https://github.com/settings/apps/example-devbox/advanced",
      "Delete the pending App on GitHub: https://github.com/organizations/example-org/settings/apps/new-devbox/advanced",
    ]);
  });

  it("--forget on an organization's App names the organization's page", async () => {
    const r = await run({ app: { ...APP, org: "example-org" }, forget: true, yes: true });
    expect(r.file).toEqual({ port: 1, ...SHARED, integrations: { linear: LINEAR } });
    expect(r.log).toEqual([
      "Next: bun run up",
      "Delete the App on GitHub: https://github.com/organizations/example-org/settings/apps/example-devbox/advanced",
    ]);
  });

  it("--forget on a disabled App works too", async () => {
    const r = await run({ app: OFF as typeof APP, forget: true, yes: true });
    expect(r.file).toEqual({ port: 1, ...SHARED, integrations: { linear: LINEAR } });
  });

  it("--forget on no removes nothing", async () => {
    const r = await run({ app: APP, forget: true, answer: false });
    expect(r.file).toEqual(r.original);
    expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
    expect(r.log).toEqual([
      "This deletes:",
      `  - integrations.githubApp in ${r.path}`,
      "  - GITHUB_APP_PRIVATE_KEY for compose in the system keychain",
      "  - GITHUB_WEBHOOK_SECRET for compose in the system keychain",
      "Nothing was removed.",
    ]);
  });

  it("--forget without a terminal refuses; --forget --yes removes", async () => {
    const refused = await run({ app: APP, forget: true, isTTY: false });
    expect(refused.error).toBeInstanceOf(DestructiveRefused);
    expect((refused.error as Error).message).toBe(
      "github:disable --forget deletes data: pass --yes to confirm without a terminal",
    );
    expect(refused.file).toEqual(refused.original);
    expect(refused.keychain.entries()).toEqual(ALL_ENTRIES);

    const yes = await run({ app: APP, forget: true, yes: true, isTTY: false });
    expect(yes.error).toBeUndefined();
    expect(yes.asked).toEqual([]);
    expect(yes.keychain.entries()).toEqual({ "compose/GITHUB_TOKEN": "c" });
  });

  it("--forget lists only saved entries", async () => {
    const some = await run({
      app: APP,
      forget: true,
      answer: true,
      saved: { "compose/GITHUB_WEBHOOK_SECRET": "b" },
    });
    expect(some.log.slice(0, 3)).toEqual([
      "This deletes:",
      `  - integrations.githubApp in ${some.path}`,
      "  - GITHUB_WEBHOOK_SECRET for compose in the system keychain",
    ]);
    const none = await run({ app: APP, forget: true, answer: true, noKeychain: true });
    expect(none.log.slice(0, 3)).toEqual([
      "This deletes:",
      `  - integrations.githubApp in ${none.path}`,
      "Next: bun run up",
    ]);
    expect(none.keychain.entries()).toEqual(ALL_ENTRIES);
  });
});
