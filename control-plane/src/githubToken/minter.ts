// The token minter loop: mint an installation token, write it to
// the sink, sleep until 30 min before it expires, repeat. In the loop,
// failures retry with backoff (5 s doubling to 5 min; 401/404 straight at the
// cap) and never end the process. With `once` the run is bounded:
// a 401/403/404/422 gives up at once, anything else after 5 attempts with the
// normal backoff; runMinter then throws MinterGaveUpError. Bad startup input
// is rejected by parseMinterInputs. The token, key and JWT never reach a log
// line.

import { createPrivateKey } from "node:crypto";
import { type Fetch, GithubAppError, mintInstallationToken } from "./mint";
import { parseSink, type TokenSink } from "./sinks";

export type MinterLogger = {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
};

export type MinterOptions = {
  appId: number;
  installationId: number;
  privateKeyPem: string;
  repositories?: string[];
  sink: TokenSink;
  once: boolean;
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: MinterLogger;
};

export const REFRESH_BEFORE_EXPIRY_MS = 30 * 60_000;
export const BACKOFF_START_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const ONCE_MAX_ATTEMPTS = 5;
// Under `once`, these won't fix themselves within a few retries.
const ONCE_FATAL_STATUSES = new Set([401, 403, 404, 422]);

// `once` could not write a token; the entry point exits 1.
export class MinterGaveUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinterGaveUpError";
  }
}

// `refused`: GitHub refused a token narrowed to a repo outside the installation.
function mintFailure(
  err: unknown,
  narrowed: boolean,
): { status: number | null; reason: string; refused: boolean } {
  if (!(err instanceof GithubAppError)) {
    return {
      status: null,
      reason: err instanceof Error ? err.message : String(err),
      refused: false,
    };
  }
  const refused = err.status === 422 && narrowed;
  const reason = refused
    ? `a repo in GITHUB_APP_REPOSITORIES is not in the installation (${err.reason})`
    : err.reason;
  return { status: err.status, reason, refused };
}

export async function runMinter(opts: MinterOptions): Promise<void> {
  const repositories = opts.repositories ?? [];
  let backoff = BACKOFF_START_MS;
  let attempts = 0;
  let currentTokenExpiresAt: string | null = null;
  const retry = async (ms: number) => {
    backoff = Math.min(ms * 2, BACKOFF_MAX_MS);
    await opts.sleep(ms);
  };

  for (;;) {
    attempts++;
    const lastOnceAttempt = opts.once && attempts >= ONCE_MAX_ATTEMPTS;
    let minted: { token: string; expiresAt: string };
    try {
      minted = await mintInstallationToken({
        appId: opts.appId,
        installationId: opts.installationId,
        privateKeyPem: opts.privateKeyPem,
        repositories,
        fetch: opts.fetch,
        now: opts.now,
      });
    } catch (err) {
      const { status, reason, refused } = mintFailure(err, repositories.length > 0);
      const fatal = opts.once && status !== null && ONCE_FATAL_STATUSES.has(status);
      // In the loop, a bad key/App id (401) or a removed installation (404)
      // won't fix itself in seconds: retry at the cap, leaving the backoff
      // alone so a later transient failure starts again at 5 s.
      const atCap = !opts.once && (status === 401 || status === 404);
      const delay = fatal || lastOnceAttempt ? null : atCap ? BACKOFF_MAX_MS : backoff;
      opts.log.warn("github_token.mint_failed", {
        installationId: opts.installationId,
        status,
        reason,
        retryInSec: delay === null ? null : delay / 1000,
        currentTokenExpiresAt,
      });
      if (fatal) {
        throw new MinterGaveUpError(
          refused
            ? `token request refused (HTTP ${status}): ${reason}`
            : `token request failed: HTTP ${status}: ${reason}`,
        );
      }
      if (delay === null) {
        throw new MinterGaveUpError(`gave up after ${attempts} attempts: ${reason}`);
      }
      if (atCap) await opts.sleep(delay);
      else await retry(delay);
      continue;
    }

    try {
      await opts.sink.write(minted);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.log.error("github_token.sink_failed", {
        sink: opts.sink.describe,
        reason,
        retryInSec: lastOnceAttempt ? null : backoff / 1000,
      });
      if (lastOnceAttempt) {
        throw new MinterGaveUpError(`gave up after ${attempts} attempts: ${reason}`);
      }
      await retry(backoff);
      continue;
    }

    currentTokenExpiresAt = minted.expiresAt;
    backoff = BACKOFF_START_MS;
    attempts = 0;
    opts.log.info("github_token.minted", {
      installationId: opts.installationId,
      expiresAt: minted.expiresAt,
      repositories: repositories.length,
      sink: opts.sink.describe,
    });
    if (opts.once) return;
    const untilRefresh =
      Date.parse(minted.expiresAt) - REFRESH_BEFORE_EXPIRY_MS - opts.now().getTime();
    await opts.sleep(Math.max(untilRefresh, BACKOFF_START_MS));
  }
}

export type MinterInputs = {
  appId: number;
  installationId: number;
  privateKeyPem: string;
  repositories: string[];
  sink: TokenSink;
  once: boolean;
};

const MAX_REPOSITORIES = 500;

function positiveInt(env: Record<string, string | undefined>, name: string): number {
  const raw = env[name]?.trim();
  if (!raw) throw new Error(`${name} is required`);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

// The entry point's inputs. Throws an Error naming the variable
// (or the key path) on anything missing or invalid; never echoes the key.
export function parseMinterInputs(
  env: Record<string, string | undefined>,
  argv: string[],
  readFile: (path: string) => string,
): MinterInputs {
  const appId = positiveInt(env, "GITHUB_APP_ID");
  const installationId = positiveInt(env, "GITHUB_APP_INSTALLATION_ID");

  const keyFile = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  if (!keyFile) throw new Error("GITHUB_APP_PRIVATE_KEY_FILE is required");

  const repositories = (env.GITHUB_APP_REPOSITORIES ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (repositories.some((r) => r.includes("/"))) {
    throw new Error("GITHUB_APP_REPOSITORIES takes repo names without the owner");
  }
  if (repositories.length > MAX_REPOSITORIES) {
    throw new Error(
      `GITHUB_APP_REPOSITORIES names ${repositories.length} repos; GitHub allows at most ${MAX_REPOSITORIES}`,
    );
  }

  const sinkSpec = env.GITHUB_TOKEN_SINK?.trim();
  if (!sinkSpec) throw new Error("GITHUB_TOKEN_SINK is required");
  const sink = parseSink(sinkSpec);

  let privateKeyPem: string;
  try {
    privateKeyPem = readFile(keyFile);
  } catch {
    throw new Error(
      `cannot read the GitHub App private key at ${keyFile} (GITHUB_APP_PRIVATE_KEY_FILE)`,
    );
  }
  let keyType: string | undefined;
  try {
    if (!privateKeyPem.includes("-----BEGIN")) throw new Error("not PEM");
    keyType = createPrivateKey(privateKeyPem).asymmetricKeyType;
  } catch {
    throw new Error(`${keyFile} is not a PEM private key (GITHUB_APP_PRIVATE_KEY_FILE)`);
  }
  if (keyType !== "rsa") {
    throw new Error(`${keyFile} is not an RSA private key (GITHUB_APP_PRIVATE_KEY_FILE)`);
  }

  return {
    appId,
    installationId,
    privateKeyPem,
    repositories,
    sink,
    once: argv.includes("--once"),
  };
}
