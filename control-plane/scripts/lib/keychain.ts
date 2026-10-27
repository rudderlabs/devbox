// The OS keychain for secrets uses macOS Keychain, the Secret Service on Linux
// (libsecret), or Windows Credential Manager through Bun.secrets. Every
// entry lives under the service "devbox"; its name carries the deployment, so
// a local stack and each cluster keep their own credentials.

export interface Keychain {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
  // True once the keychain switched itself off for this run (the platform has
  // none); it then acts as an empty one.
  readonly disabled?: boolean;
}

export const KEYCHAIN_SERVICE = "devbox";

export type Deployment = { kind: "compose" } | { kind: "k8s"; context: string; namespace: string };

export const deploymentScope = (d: Deployment): string =>
  d.kind === "compose" ? "compose" : `k8s:${d.context}/${d.namespace}`;

export const entryName = (d: Deployment, name: string): string => `${deploymentScope(d)}/${name}`;

export function bunKeychain(): Keychain {
  const service = KEYCHAIN_SERVICE;
  return {
    get: async (name) => (await Bun.secrets.get({ service, name })) ?? undefined,
    set: (name, value) => Bun.secrets.set({ service, name, value }),
    delete: (name) => Bun.secrets.delete({ service, name }),
  };
}

// A keychain that, once the platform has none (headless Linux without
// libsecret), acts as an empty one for the rest of the run, without a word.
export type GuardedKeychain = Keychain & { readonly disabled: boolean };

export function guarded(k: Keychain): GuardedKeychain {
  let disabled = false;
  const call = async <T>(f: () => Promise<T>, off: T): Promise<T> => {
    if (disabled) return off;
    try {
      return await f();
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== "ERR_SECRETS_PLATFORM_ERROR") throw err;
      disabled = true;
      return off;
    }
  };
  return {
    get disabled() {
      return disabled;
    },
    get: (name) => call(() => k.get(name), undefined),
    set: (name, value) => call(() => k.set(name, value), undefined),
    delete: (name) => call(() => k.delete(name), false),
  };
}

// The keychain `up` and `k8s:install` use: none with --no-keychain.
export const keychainFor = (noKeychain: boolean | undefined): GuardedKeychain | undefined =>
  noKeychain ? undefined : guarded(bunKeychain());

// Whether a keychain can be offered: a guarded one learns that its platform
// has none only from a first call, so one read of `probeName` (the value is
// dropped) settles it.
export async function keychainUsable(k: Keychain | undefined, probeName: string): Promise<boolean> {
  if (!k) return false;
  await k.get(probeName);
  return !k.disabled;
}

// For tests.
export class MemoryKeychain implements Keychain {
  private readonly map: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.map = new Map(Object.entries(entries));
  }

  async get(name: string): Promise<string | undefined> {
    return this.map.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    this.map.set(name, value);
  }

  async delete(name: string): Promise<boolean> {
    return this.map.delete(name);
  }

  entries(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}
