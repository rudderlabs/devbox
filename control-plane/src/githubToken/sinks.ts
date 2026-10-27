// Where the minter writes each token: a file on a shared volume
// (Compose) or keys of a k8s Secret (the kubelet then refreshes the mounted
// files). Both write `token` and `expires-at` (ISO 8601).

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { patchSecret } from "../clients/k8s";

export type MintedToken = { token: string; expiresAt: string };
export type TokenSink = { write(t: MintedToken): Promise<void>; describe: string };

// Write then rename in the same directory, so a reader never sees a partial
// file. The temp name is unique per write, so a leftover temp file (and its
// mode) is never reused; the `wx` flag guarantees a fresh file. 0644: on
// Compose the readers (control plane, iron-proxy) may run as a different user;
// the volume itself is the boundary.
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o644, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function fileSink(path: string): TokenSink {
  return {
    describe: `file:${path}`,
    async write(t) {
      mkdirSync(dirname(path), { recursive: true });
      writeAtomic(path, t.token);
      writeAtomic(join(dirname(path), "expires-at"), t.expiresAt);
    },
  };
}

export function secretSink(ns: string, name: string, patch = patchSecret): TokenSink {
  return {
    describe: `secret:${ns}/${name}`,
    async write(t) {
      await patch({ namespace: ns, name, data: { token: t.token, "expires-at": t.expiresAt } });
    },
  };
}

export function parseSink(spec: string): TokenSink {
  if (spec.startsWith("file:")) {
    const path = spec.slice("file:".length);
    if (isAbsolute(path)) return fileSink(path);
  }
  const secret = /^secret:([^/]+)\/([^/]+)$/.exec(spec);
  if (secret) return secretSink(secret[1] as string, secret[2] as string);
  throw new Error(
    `bad GITHUB_TOKEN_SINK: ${JSON.stringify(spec)} (want file:<absolute path> or secret:<namespace>/<name>)`,
  );
}
