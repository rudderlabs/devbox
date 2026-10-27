// The control plane's own GitHub token. On Kubernetes it
// is a mounted Secret file (GITHUB_TOKEN_FILE): the kubelet rewrites the file
// when the Secret changes, so re-reading it at most every TTL picks up a
// rotated token without a restart. Compose sets GITHUB_TOKEN instead. The
// token never appears in an error or log line.

import { dirname, join } from "node:path";

export type GithubTokenSettings = { file?: string; token?: string };

export const GITHUB_TOKEN_TTL_MS = 60_000;

export function parseGithubTokenSettings(
  env: Record<string, string | undefined>,
): GithubTokenSettings {
  const file = env.GITHUB_TOKEN_FILE?.trim();
  if (file) return { file };
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing required env var: GITHUB_TOKEN (or GITHUB_TOKEN_FILE)");
  return { token };
}

export type GithubTokenDeps = {
  readFile: (path: string) => string;
  now: () => number;
  warn: (message: string, meta: Record<string, unknown>) => void;
};

export type GithubTokenState = {
  source: "file" | "env";
  // ISO 8601 from the `expires-at` file the minter writes next to the token;
  // null for env, or when the file is absent or not a date.
  expiresAt: string | null;
  // When the token file was last read successfully; null for env.
  readAt: string | null;
  // The last read error (cleared by the next good read); null for env.
  lastError: string | null;
};

export type GithubTokenProvider = (() => string) & { state: () => GithubTokenState };

export function githubTokenProvider(
  settings: GithubTokenSettings,
  deps: GithubTokenDeps,
): GithubTokenProvider {
  const { file } = settings;
  if (!file) {
    const token = settings.token ?? "";
    return Object.assign(() => token, {
      state: (): GithubTokenState => ({
        source: "env",
        expiresAt: null,
        readAt: null,
        lastError: null,
      }),
    });
  }
  const expiresFile = join(dirname(file), "expires-at");
  let cached: string | undefined;
  let expiresAt: string | null = null;
  let readAt = 0; // last attempt (success or failure), drives the TTL
  let readOkAt: number | null = null;
  let lastError: string | null = null;

  const readExpiresAt = (): string | null => {
    try {
      const value = deps.readFile(expiresFile).trim();
      return value && !Number.isNaN(Date.parse(value)) ? value : null;
    } catch {
      return null;
    }
  };

  // Re-reads at most once per TTL. Throws only when there is no good token yet.
  const refresh = (): string => {
    if (cached !== undefined && deps.now() - readAt < GITHUB_TOKEN_TTL_MS) return cached;
    let value: string;
    try {
      // Trimmed: a Secret written from `echo` ends with a newline, which
      // would make the Authorization header invalid.
      value = deps.readFile(file).trim();
      if (!value) throw new Error("the file is empty");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      lastError = `cannot read GITHUB_TOKEN_FILE ${file}: ${reason}`;
      if (cached === undefined) throw new Error(lastError);
      // Keep serving the last good token and retry after the next TTL.
      deps.warn("github_token_file_unreadable", { file, reason });
      readAt = deps.now();
      return cached;
    }
    cached = value;
    readAt = deps.now();
    readOkAt = readAt;
    lastError = null;
    expiresAt = readExpiresAt();
    return value;
  };

  return Object.assign(refresh, {
    state: (): GithubTokenState => {
      try {
        refresh();
      } catch {
        // Recorded in lastError.
      }
      return {
        source: "file",
        expiresAt,
        readAt: readOkAt === null ? null : new Date(readOkAt).toISOString(),
        lastError,
      };
    },
  });
}
