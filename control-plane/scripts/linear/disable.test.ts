import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestructiveRefused } from "../lib/destructive";
import { type Deployment, MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import { type LinearDeployment, loadDeployment } from "./deployment";
import { disable } from "./disable";

const dir = mkdtempSync(join(tmpdir(), "devbox-linear-disable-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const COMPOSE: Deployment = { kind: "compose" };
const LINEAR = { enabled: true, clientId: "lin-client-id" };
const OFF = { ...LINEAR, enabled: false };
let n = 0;

async function run(o: {
  linear?: typeof LINEAR;
  forget?: boolean;
  yes?: boolean;
  isTTY?: boolean;
  answer?: boolean;
  saved?: Record<string, string>;
  noKeychain?: boolean;
  down?: boolean;
}) {
  const path = join(dir, `c${n++}.json`);
  const original = JSON.stringify({
    port: 1,
    ...(o.linear ? { integrations: { linear: o.linear } } : {}),
  });
  writeFileSync(path, original);
  const keychain = new MemoryKeychain({
    "compose/GITHUB_TOKEN": "c",
    ...(o.saved ?? {
      "compose/LINEAR_CLIENT_SECRET": "a",
      "compose/LINEAR_WEBHOOK_SECRET": "b",
    }),
  });
  const log: string[] = [];
  const asked: string[] = [];
  const applied: string[] = [];
  const d: LinearDeployment = {
    deployment: COMPOSE,
    configPath: path,
    linear: o.linear,
    applyCommand: "bun run up",
    statusCommand: "bun run linear:status",
    api: async () => {
      if (o.down) throw new Error("down");
      return Response.json({ configured: true, appUser: { id: "u", name: "devbox" } });
    },
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
    run: async (cmd: string[]) => {
      applied.push(cmd.join(" "));
      return { code: 0, stdout: "" };
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
    applied,
    error,
    path,
    keychain,
    original: JSON.parse(original),
    file: JSON.parse(readFileSync(path, "utf8")),
  };
}

const ALL_ENTRIES = {
  "compose/GITHUB_TOKEN": "c",
  "compose/LINEAR_CLIENT_SECRET": "a",
  "compose/LINEAR_WEBHOOK_SECRET": "b",
};

describe("linear disable", () => {
  it("switches off, keeps the block's keys and the keychain", async () => {
    const r = await run({ linear: LINEAR });
    expect(r.file).toEqual({ port: 1, integrations: { linear: OFF } });
    expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
    expect(r.asked).toEqual([]);
    expect(r.log).toEqual([`Disabled Linear in ${r.path}.`, "Next: bun run up"]);
  });

  it("already disabled", async () => {
    const r = await run({ linear: OFF });
    expect(r.file).toEqual(r.original);
    expect(r.log).toEqual(["Linear is already disabled for compose."]);
  });

  it("not configured", async () => {
    for (const forget of [false, true]) {
      const r = await run({ forget });
      expect(r.file).toEqual({ port: 1 });
      expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
      expect(r.log).toEqual(["Linear is not configured for compose. Nothing to disable."]);
    }
  });

  it("--forget lists and removes on yes", async () => {
    const r = await run({ linear: OFF, forget: true, answer: true });
    expect(r.asked).toEqual(["Remove these? [y/N] "]);
    expect(r.file).toEqual({ port: 1 });
    expect(r.keychain.entries()).toEqual({ "compose/GITHUB_TOKEN": "c" });
    expect(r.log).toEqual([
      "This deletes:",
      `  - integrations.linear in ${r.path}`,
      "  - LINEAR_CLIENT_SECRET for compose in the system keychain",
      "  - LINEAR_WEBHOOK_SECRET for compose in the system keychain",
      "Next: bun run up",
      "Delete the app in Linear: Settings → API → Applications → devbox",
    ]);
  });

  it("--forget falls back to a generic app name", async () => {
    const r = await run({ linear: LINEAR, forget: true, yes: true, down: true });
    expect(r.log).toEqual([
      "Next: bun run up",
      "Delete the app in Linear: Settings → API → Applications → the devbox app",
    ]);
  });

  it("--forget on no removes nothing", async () => {
    const r = await run({ linear: LINEAR, forget: true, answer: false });
    expect(r.file).toEqual(r.original);
    expect(r.keychain.entries()).toEqual(ALL_ENTRIES);
    expect(r.log).toEqual([
      "This deletes:",
      `  - integrations.linear in ${r.path}`,
      "  - LINEAR_CLIENT_SECRET for compose in the system keychain",
      "  - LINEAR_WEBHOOK_SECRET for compose in the system keychain",
      "Nothing was removed.",
    ]);
    expect(r.asked).toEqual(["Remove these? [y/N] "]);
  });

  it("--forget without a terminal refuses; --forget --yes removes", async () => {
    const refused = await run({ linear: LINEAR, forget: true, isTTY: false });
    expect(refused.error).toBeInstanceOf(DestructiveRefused);
    expect((refused.error as Error).message).toBe(
      "linear:disable --forget deletes data: pass --yes to confirm without a terminal",
    );
    expect(refused.file).toEqual(refused.original);
    expect(refused.keychain.entries()).toEqual(ALL_ENTRIES);

    const yes = await run({ linear: LINEAR, forget: true, yes: true, isTTY: false });
    expect(yes.error).toBeUndefined();
    expect(yes.asked).toEqual([]);
    expect(yes.file).toEqual({ port: 1 });
    expect(yes.keychain.entries()).toEqual({ "compose/GITHUB_TOKEN": "c" });
  });

  it("--forget lists only saved entries", async () => {
    const some = await run({
      linear: LINEAR,
      forget: true,
      answer: true,
      saved: { "compose/LINEAR_WEBHOOK_SECRET": "b" },
    });
    expect(some.log).toEqual([
      "This deletes:",
      `  - integrations.linear in ${some.path}`,
      "  - LINEAR_WEBHOOK_SECRET for compose in the system keychain",
      "Next: bun run up",
      "Delete the app in Linear: Settings → API → Applications → devbox",
    ]);
    expect(some.keychain.entries()).toEqual({ "compose/GITHUB_TOKEN": "c" });

    const none = await run({ linear: LINEAR, forget: true, answer: true, noKeychain: true });
    expect(none.log).toEqual([
      "This deletes:",
      `  - integrations.linear in ${none.path}`,
      "Next: bun run up",
      "Delete the app in Linear: Settings → API → Applications → devbox",
    ]);
    expect(none.keychain.entries()).toEqual(ALL_ENTRIES);
  });

  it("never applies", async () => {
    for (const forget of [false, true]) {
      const r = await run({ linear: LINEAR, forget, yes: true });
      expect(r.applied).toEqual([]);
      expect(r.log).toContain("Next: bun run up");
    }
  });
});

describe("linear disable on kind", () => {
  const KIND: Deployment = { kind: "k8s", context: "kind-devbox", namespace: "devbox" };
  // The public URL is the deployment's, shared with GitHub: --forget keeps it.
  const KIND_TARGET = {
    context: "kind-devbox",
    profile: "k8s-kind-devbox",
    publicUrl: "https://hooks.example.com",
    values: {},
  };

  function kindDeployment(linear: typeof LINEAR) {
    const path = join(dir, `kind${n++}.json`);
    writeFileSync(path, JSON.stringify({ ...KIND_TARGET, integrations: { linear } }));
    const d = loadDeployment({ target: path, noKeychain: false });
    const log: string[] = [];
    const keychain = new MemoryKeychain({
      "k8s:kind-devbox/devbox/LINEAR_CLIENT_SECRET": "a",
      "k8s:kind-devbox/devbox/LINEAR_WEBHOOK_SECRET": "b",
    });
    const resolver = {
      env: {},
      keychain,
      deployment: KIND,
      isTTY: true,
      confirm: async () => true,
    } as unknown as ResolverDeps;
    return { path, d, log, keychain, deps: { resolver, log: (l: string) => log.push(l) } };
  }

  it("the next step is k8s:kind", async () => {
    const off = kindDeployment(LINEAR);
    await disable(off.d, { forget: false, yes: false }, off.deps);
    expect(JSON.parse(readFileSync(off.path, "utf8"))).toEqual({
      ...KIND_TARGET,
      integrations: { linear: OFF },
    });
    expect(off.log).toEqual([`Disabled Linear in ${off.path}.`, "Next: bun run k8s:kind"]);

    const forget = kindDeployment(OFF);
    // The control plane is down: the generic app name.
    forget.d.api = async () => {
      throw new Error("down");
    };
    await disable(forget.d, { forget: true, yes: false }, forget.deps);
    expect(JSON.parse(readFileSync(forget.path, "utf8"))).toEqual(KIND_TARGET);
    expect(forget.keychain.entries()).toEqual({});
    expect(forget.log).toEqual([
      "This deletes:",
      `  - integrations.linear in ${forget.path}`,
      "  - LINEAR_CLIENT_SECRET for k8s:kind-devbox/devbox in the system keychain",
      "  - LINEAR_WEBHOOK_SECRET for k8s:kind-devbox/devbox in the system keychain",
      "Next: bun run k8s:kind",
      "Delete the app in Linear: Settings → API → Applications → the devbox app",
    ]);
  });
});
