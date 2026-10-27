import { describe, expect, it, spyOn } from "bun:test";
import {
  deploymentScope,
  entryName,
  guarded,
  type Keychain,
  keychainUsable,
  MemoryKeychain,
} from "./keychain";

const platformError = () =>
  Object.assign(new Error("libsecret not available"), { code: "ERR_SECRETS_PLATFORM_ERROR" });

// An inner keychain that counts calls and throws `err` from every method.
function throwing(err: Error): { k: Keychain; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    k: {
      get: async (name) => {
        calls.push(`get ${name}`);
        throw err;
      },
      set: async (name) => {
        calls.push(`set ${name}`);
        throw err;
      },
      delete: async (name) => {
        calls.push(`delete ${name}`);
        throw err;
      },
    },
  };
}

describe("guarded", () => {
  it("guarded disables itself on a platform error, silently", async () => {
    // guarded takes no logger; it must not write anywhere else either.
    const spies = [
      spyOn(process.stdout, "write"),
      spyOn(process.stderr, "write"),
      spyOn(console, "log"),
      spyOn(console, "warn"),
      spyOn(console, "error"),
    ];
    const inner = throwing(platformError());
    const k = guarded(inner.k);
    expect(await k.get("compose/GITHUB_TOKEN")).toBeUndefined();
    expect(await k.get("compose/LLM_API_KEY")).toBeUndefined();
    expect(await k.set("compose/LLM_API_KEY", "sk-new")).toBeUndefined();
    expect(await k.delete("compose/LLM_API_KEY")).toBe(false);
    expect(inner.calls).toEqual(["get compose/GITHUB_TOKEN"]);
    const written = spies.map((s) => s.mock.calls.length);
    for (const s of spies) s.mockRestore();
    expect(written).toEqual([0, 0, 0, 0, 0]);
    expect(k.disabled).toBe(true);
  });

  it("guarded rethrows other errors", async () => {
    const err = Object.assign(new Error("user denied access"), { code: "ERR_SECRETS_ACCESS" });
    const inner = throwing(err);
    const k = guarded(inner.k);
    await expect(k.get("compose/GITHUB_TOKEN")).rejects.toBe(err);
    await expect(k.set("compose/GITHUB_TOKEN", "v")).rejects.toBe(err);
    await expect(k.delete("compose/GITHUB_TOKEN")).rejects.toBe(err);
    expect(inner.calls).toEqual([
      "get compose/GITHUB_TOKEN",
      "set compose/GITHUB_TOKEN",
      "delete compose/GITHUB_TOKEN",
    ]);
    expect(k.disabled).toBe(false);
  });

  it("passes calls through while the keychain works", async () => {
    const inner = new MemoryKeychain({ "compose/GITHUB_TOKEN": "ghp_saved" });
    const k = guarded(inner);
    expect(await k.get("compose/GITHUB_TOKEN")).toBe("ghp_saved");
    await k.set("compose/LLM_API_KEY", "sk-new");
    expect(await k.delete("compose/GITHUB_TOKEN")).toBe(true);
    expect(await k.delete("compose/GITHUB_TOKEN")).toBe(false);
    expect(inner.entries()).toEqual({ "compose/LLM_API_KEY": "sk-new" });
  });
});

describe("keychainUsable", () => {
  it("keychainUsable is false after a platform error", async () => {
    const inner = throwing(platformError());
    expect(await keychainUsable(guarded(inner.k), "compose/LINEAR_CLIENT_SECRET")).toBe(false);
    expect(inner.calls).toEqual(["get compose/LINEAR_CLIENT_SECRET"]);
  });

  it("is true for a working keychain and false for none", async () => {
    const k = guarded(new MemoryKeychain({ "compose/LINEAR_CLIENT_SECRET": "saved" }));
    expect(await keychainUsable(k, "compose/LINEAR_CLIENT_SECRET")).toBe(true);
    expect(await keychainUsable(undefined, "compose/LINEAR_CLIENT_SECRET")).toBe(false);
  });
});

describe("entry names", () => {
  it("scopes Compose and each k8s context and namespace apart", () => {
    expect(deploymentScope({ kind: "compose" })).toBe("compose");
    expect(deploymentScope({ kind: "k8s", context: "kind-x", namespace: "devbox" })).toBe(
      "k8s:kind-x/devbox",
    );
    expect(entryName({ kind: "compose" }, "GITHUB_TOKEN")).toBe("compose/GITHUB_TOKEN");
    expect(
      entryName({ kind: "k8s", context: "prod", namespace: "devbox" }, "LINEAR_CLIENT_SECRET"),
    ).toBe("k8s:prod/devbox/LINEAR_CLIENT_SECRET");
  });
});
