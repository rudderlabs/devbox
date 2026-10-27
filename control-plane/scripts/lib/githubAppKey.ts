// Finds the GitHub App's private key (a multi-line PEM) for the scripts:
// the file named by GITHUB_APP_PRIVATE_KEY_FILE, then GITHUB_APP_PRIVATE_KEY,
// then the deployment's keychain entry. It never prompts (a prompt takes one
// line), and neither messages nor logs ever carry the key itself.
import { readFileSync } from "node:fs";
import { deploymentScope, entryName } from "./keychain";
import type { PeekDeps, ResolverDeps } from "./secrets";

export class PrivateKeyError extends Error {}

const KEY = "GITHUB_APP_PRIVATE_KEY";
const KEY_FILE = "GITHUB_APP_PRIVATE_KEY_FILE";

// A PKCS#1 (`RSA PRIVATE KEY`, what GitHub issues) or PKCS#8 (`PRIVATE KEY`) block.
const PEM = /-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/;

export const isPem = (text: string): boolean => PEM.test(text);

// A key file, named in messages the way it was given: `GITHUB_APP_PRIVATE_KEY_FILE=<path>`
// by default, or `<flag> <path>`.
export function readPrivateKeyFile(path: string, flag?: string): string {
  const fail = (why: string) =>
    new PrivateKeyError(`${flag ? `${flag} ${path}` : `${KEY_FILE}=${path}`}: ${why}`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw fail(code === "EISDIR" ? "is a directory" : "cannot read it");
  }
  if (!isPem(text)) throw fail("does not hold a PEM private key");
  return text;
}

export type PrivateKey = { pem: string; source: "env" | "keychain"; path?: string };

export async function resolvePrivateKey(deps: ResolverDeps): Promise<PrivateKey | undefined> {
  const path = deps.env[KEY_FILE];
  if (path) {
    const pem = readPrivateKeyFile(path);
    deps.log(`${KEY}: from ${path} (${KEY_FILE})`);
    return { pem, source: "env", path };
  }
  const inline = deps.env[KEY];
  if (inline) {
    if (!isPem(inline)) throw new PrivateKeyError(`${KEY} does not hold a PEM private key`);
    deps.log(`${KEY}: from your environment`);
    return { pem: inline, source: "env" };
  }
  const saved = await deps.keychain?.get(entryName(deps.deployment, KEY));
  if (saved) {
    deps.log(`${KEY}: from the system keychain (${deploymentScope(deps.deployment)})`);
    return { pem: saved, source: "keychain" };
  }
  return undefined;
}

// Where the key would come from, for status; nothing is read or logged.
export async function peekPrivateKey(
  deps: Pick<PeekDeps, "env" | "keychain" | "deployment">,
): Promise<"env" | "keychain" | "missing"> {
  if (deps.env[KEY_FILE] || deps.env[KEY]) return "env";
  return (await deps.keychain?.get(entryName(deps.deployment, KEY))) ? "keychain" : "missing";
}
