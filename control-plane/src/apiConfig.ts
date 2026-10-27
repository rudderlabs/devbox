// /api settings. Pure: takes the env, so it is testable without
// mocking ../config. config.ts calls it at startup; a bad value fails boot.

export type ApiConfig = {
  enabled: boolean;
  authEnabled: boolean;
  // No trailing slash. The base for API tasks' external_url.
  publicBaseUrl: string;
  // Lower-cased hostnames without ports. Empty = any host.
  allowedHosts: string[];
  taskKeyPrefix: string;
  ssePollMs: number;
  sseMaxDurationMs: number;
};

const TASK_KEY_PREFIX_RE = /^[A-Z][A-Z0-9-]*-$/;

function positiveInt(env: Record<string, string | undefined>, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Env var ${name} must be a positive integer`);
  }
  return value;
}

export function parseApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const enabled = env.API_ENABLED === "true";
  const publicBaseUrl = (env.API_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (enabled && !publicBaseUrl) {
    throw new Error("API_PUBLIC_BASE_URL is required when API_ENABLED=true");
  }
  if (publicBaseUrl && !URL.canParse(publicBaseUrl)) {
    throw new Error("API_PUBLIC_BASE_URL must be an absolute URL");
  }
  const taskKeyPrefix = env.API_TASK_KEY_PREFIX?.trim() || "DBX-API-";
  if (!TASK_KEY_PREFIX_RE.test(taskKeyPrefix)) {
    throw new Error("API_TASK_KEY_PREFIX must match ^[A-Z][A-Z0-9-]*-$");
  }
  return {
    enabled,
    // Only the exact value "false" turns auth off.
    authEnabled: env.API_AUTH_ENABLED !== "false",
    publicBaseUrl,
    allowedHosts: (env.API_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase().replace(/:\d+$/, ""))
      .filter(Boolean),
    taskKeyPrefix,
    ssePollMs: positiveInt(env, "API_SSE_POLL_MS", 1000),
    sseMaxDurationMs: positiveInt(env, "API_SSE_MAX_DURATION_MS", 600_000),
  };
}
