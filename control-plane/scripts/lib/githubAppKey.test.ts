import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPem,
  PrivateKeyError,
  peekPrivateKey,
  readPrivateKeyFile,
  resolvePrivateKey,
} from "./githubAppKey";
import { type Deployment, MemoryKeychain } from "./keychain";
import type { ResolverDeps } from "./secrets";

const K8S: Deployment = { kind: "k8s", context: "ctx", namespace: "devbox" };
const PKCS1 =
  "-----BEGIN RSA PRIVATE KEY-----\nQUJDREVGRw==\nSElKS0xNTg==\n-----END RSA PRIVATE KEY-----\n";
const PKCS8 = "-----BEGIN PRIVATE KEY-----\nQUJDREVGRw==\n-----END PRIVATE KEY-----\n";

const dir = mkdtempSync(join(tmpdir(), "devbox-key-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: string): string => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

function setup(opts: {
  env?: Record<string, string | undefined>;
  entries?: Record<string, string>;
  deployment?: Deployment;
  noKeychain?: boolean;
}) {
  const log: string[] = [];
  const prompts: string[] = [];
  const keychain = new MemoryKeychain(opts.entries);
  const deps: ResolverDeps = {
    env: opts.env ?? {},
    keychain: opts.noKeychain ? undefined : keychain,
    deployment: opts.deployment ?? { kind: "compose" },
    isTTY: true,
    prompt: async (q) => {
      prompts.push(q);
      return "";
    },
    confirm: async () => false,
    run: async () => ({ code: 1, stdout: "" }),
    log: (l) => void log.push(l),
  };
  return { deps, log, prompts };
}

describe("isPem", () => {
  it("accepts PKCS#1 and PKCS#8 blocks, with surrounding text", () => {
    expect(isPem(PKCS1)).toBe(true);
    expect(isPem(PKCS8)).toBe(true);
    expect(isPem(`  \n${PKCS8}\n`)).toBe(true);
  });

  it("rejects other text, mismatched or public-key blocks", () => {
    expect(isPem("")).toBe(false);
    expect(isPem("not a key")).toBe(false);
    expect(isPem("-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----\n")).toBe(false);
    expect(isPem("-----BEGIN PRIVATE KEY-----\nQUJD\n")).toBe(false);
    expect(isPem("-----BEGIN RSA PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n")).toBe(false);
  });
});

describe("resolvePrivateKey", () => {
  it("the key file wins over the env var and the keychain", async () => {
    const p = file("a.pem", PKCS1);
    const s = setup({
      env: { GITHUB_APP_PRIVATE_KEY_FILE: p, GITHUB_APP_PRIVATE_KEY: PKCS8 },
      entries: { "compose/GITHUB_APP_PRIVATE_KEY": "kc" },
    });
    expect(await resolvePrivateKey(s.deps)).toEqual({ pem: PKCS1, source: "env", path: p });
    expect(s.log).toEqual([`GITHUB_APP_PRIVATE_KEY: from ${p} (GITHUB_APP_PRIVATE_KEY_FILE)`]);
  });

  it("the env var wins over the keychain", async () => {
    const s = setup({
      env: { GITHUB_APP_PRIVATE_KEY: PKCS8 },
      entries: { "compose/GITHUB_APP_PRIVATE_KEY": PKCS1 },
    });
    expect(await resolvePrivateKey(s.deps)).toEqual({ pem: PKCS8, source: "env" });
    expect(s.log).toEqual(["GITHUB_APP_PRIVATE_KEY: from your environment"]);
  });

  it("an empty file path or env var counts as unset", async () => {
    const s = setup({
      env: { GITHUB_APP_PRIVATE_KEY_FILE: "", GITHUB_APP_PRIVATE_KEY: "" },
      entries: { "compose/GITHUB_APP_PRIVATE_KEY": PKCS1 },
    });
    expect((await resolvePrivateKey(s.deps))?.source).toBe("keychain");
  });

  it("falls back to the deployment's keychain entry", async () => {
    const s = setup({
      deployment: K8S,
      entries: { "k8s:ctx/devbox/GITHUB_APP_PRIVATE_KEY": PKCS1 },
    });
    expect(await resolvePrivateKey(s.deps)).toEqual({ pem: PKCS1, source: "keychain" });
    expect(s.log).toEqual(["GITHUB_APP_PRIVATE_KEY: from the system keychain (k8s:ctx/devbox)"]);
  });

  it("returns undefined, without prompting, when there is no key", async () => {
    const s = setup({});
    expect(await resolvePrivateKey(s.deps)).toBeUndefined();
    expect(await resolvePrivateKey(setup({ noKeychain: true }).deps)).toBeUndefined();
    expect(s.prompts).toEqual([]);
    expect(s.log).toEqual([]);
  });

  it("a key file that cannot be used fails without falling through", async () => {
    const missing = join(dir, "missing.pem");
    const asDir = join(dir, "adir");
    mkdirSync(asDir);
    const notPem = file("notpem.txt", "hello, I am not a key\n");
    const cases: Array<[string, string]> = [
      [missing, "cannot read it"],
      [asDir, "is a directory"],
      [notPem, "does not hold a PEM private key"],
    ];
    for (const [path, why] of cases) {
      const s = setup({
        env: { GITHUB_APP_PRIVATE_KEY_FILE: path, GITHUB_APP_PRIVATE_KEY: PKCS8 },
        entries: { "compose/GITHUB_APP_PRIVATE_KEY": PKCS1 },
      });
      const err = await resolvePrivateKey(s.deps).catch((e) => e);
      expect(err).toBeInstanceOf(PrivateKeyError);
      expect(err.message).toBe(`GITHUB_APP_PRIVATE_KEY_FILE=${path}: ${why}`);
      expect(s.log).toEqual([]);
    }
  });

  it("an env var that is not a PEM fails without falling through", async () => {
    const s = setup({
      env: { GITHUB_APP_PRIVATE_KEY: "just some text" },
      entries: { "compose/GITHUB_APP_PRIVATE_KEY": PKCS1 },
    });
    const err = await resolvePrivateKey(s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PrivateKeyError);
    expect(err.message).toBe("GITHUB_APP_PRIVATE_KEY does not hold a PEM private key");
  });

  it("the key's content never appears in a message", async () => {
    const body = "SECRETBODYSECRETBODY";
    const bad = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n`; // no END line
    const p = file("trunc.pem", bad);
    const s = setup({ env: { GITHUB_APP_PRIVATE_KEY_FILE: p } });
    const err = await resolvePrivateKey(s.deps).catch((e) => e);
    expect(err.message).not.toContain(body);
    const e2 = setup({ env: { GITHUB_APP_PRIVATE_KEY: bad } });
    const err2 = await resolvePrivateKey(e2.deps).catch((e) => e);
    expect(err2.message).not.toContain(body);
    const ok = setup({ env: { GITHUB_APP_PRIVATE_KEY: PKCS1.replace("QUJDREVGRw==", body) } });
    await resolvePrivateKey(ok.deps);
    expect(ok.log.join("\n")).not.toContain(body);
  });
});

describe("peekPrivateKey", () => {
  it("reports env for a file path or the env var, keychain, or missing", async () => {
    expect(await peekPrivateKey(setup({ env: { GITHUB_APP_PRIVATE_KEY_FILE: "/x" } }).deps)).toBe(
      "env",
    );
    expect(await peekPrivateKey(setup({ env: { GITHUB_APP_PRIVATE_KEY: PKCS1 } }).deps)).toBe(
      "env",
    );
    expect(
      await peekPrivateKey(setup({ entries: { "compose/GITHUB_APP_PRIVATE_KEY": PKCS1 } }).deps),
    ).toBe("keychain");
    expect(await peekPrivateKey(setup({}).deps)).toBe("missing");
  });
});

describe("readPrivateKeyFile", () => {
  it("reads a PEM, naming the file by the flag that gave it", () => {
    expect(readPrivateKeyFile(file("flag.pem", PKCS1), "--private-key-file")).toBe(PKCS1);
    const missing = join(dir, "nope.pem");
    expect(() => readPrivateKeyFile(missing, "--private-key-file")).toThrow(
      new PrivateKeyError(`--private-key-file ${missing}: cannot read it`),
    );
    const notPem = file("flag.pub", "ssh-rsa AAAA");
    expect(() => readPrivateKeyFile(notPem, "--private-key-file")).toThrow(
      new PrivateKeyError(`--private-key-file ${notPem}: does not hold a PEM private key`),
    );
  });
});
