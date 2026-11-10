// The control plane's own GitLab token (it runs outside the sandbox egress
// path, so it needs a real one). On Kubernetes it is the mounted token Secret
// (GITLAB_TOKEN_FILE): the kubelet rewrites the file when the Secret changes,
// so re-reading it at most every TTL picks up a rotated token without a
// restart. GITLAB_TOKEN serves local runs. Optional: with neither set, the
// first GitLab call throws and its send is dropped, as with GitHub's token.
// The token never appears in an error or log line.

export type GitlabTokenSettings = { file?: string; token?: string };

export const GITLAB_TOKEN_TTL_MS = 60_000;

export function parseGitlabTokenSettings(
  env: Record<string, string | undefined>,
): GitlabTokenSettings {
  const file = env.GITLAB_TOKEN_FILE?.trim();
  if (file) return { file };
  const token = env.GITLAB_TOKEN?.trim();
  return token ? { token } : {};
}

export type GitlabTokenDeps = {
  readFile: (path: string) => string;
  now: () => number;
  warn: (message: string, meta: Record<string, unknown>) => void;
};

export type GitlabTokenState = {
  // false when neither GITLAB_TOKEN_FILE nor GITLAB_TOKEN is set.
  configured: boolean;
  source: "file" | "env" | null;
  // When the token file was last read successfully; null for env or unset.
  readAt: string | null;
  // The last read error (cleared by the next good read); null for env or unset.
  lastError: string | null;
};

export type GitlabTokenProvider = (() => string) & { state: () => GitlabTokenState };

// Throws when no token is configured, or no good token has been read yet.
export function gitlabTokenProvider(
  settings: GitlabTokenSettings,
  deps: GitlabTokenDeps,
): GitlabTokenProvider {
  const { file } = settings;
  if (!file) {
    const token = settings.token;
    const read = (): string => {
      if (!token) throw new Error("no GitLab token: set GITLAB_TOKEN_FILE or GITLAB_TOKEN");
      return token;
    };
    return Object.assign(read, {
      state: (): GitlabTokenState => ({
        configured: token !== undefined,
        source: token !== undefined ? "env" : null,
        readAt: null,
        lastError: null,
      }),
    });
  }
  let cached: string | undefined;
  let readAt = 0; // last attempt (success or failure), drives the TTL
  let readOkAt: number | null = null;
  let lastError: string | null = null;

  const refresh = (): string => {
    if (cached !== undefined && deps.now() - readAt < GITLAB_TOKEN_TTL_MS) return cached;
    let value: string;
    try {
      // Trimmed: a Secret written from `echo` ends with a newline.
      value = deps.readFile(file).trim();
      if (!value) throw new Error("the file is empty");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      lastError = `cannot read GITLAB_TOKEN_FILE ${file}: ${reason}`;
      if (cached === undefined) throw new Error(lastError);
      // Keep serving the last good token and retry after the next TTL.
      deps.warn("gitlab_token_file_unreadable", { file, reason });
      readAt = deps.now();
      return cached;
    }
    cached = value;
    readAt = deps.now();
    readOkAt = readAt;
    lastError = null;
    return value;
  };

  return Object.assign(refresh, {
    state: (): GitlabTokenState => {
      try {
        refresh();
      } catch {
        // Recorded in lastError.
      }
      return {
        configured: true,
        source: "file",
        readAt: readOkAt === null ? null : new Date(readOkAt).toISOString(),
        lastError,
      };
    },
  });
}
