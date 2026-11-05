// /api's own settings, for every source's tasks it serves. The settings of the
// tasks the API creates are the API integration's (integrations/api/config.ts).
// Pure: takes the env, so it is testable without mocking ../config. config.ts
// calls it at startup; a bad value fails boot.
import { api } from "./integrations/api";

export type ApiConfig = {
  enabled: boolean;
  authEnabled: boolean;
  // Lower-cased hostnames without ports. Empty = any host.
  allowedHosts: string[];
  ssePollMs: number;
  sseMaxDurationMs: number;
};

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
  // API_ENABLED, read by the API integration's definition, so /api is mounted
  // exactly when that integration is on. The definition also checks the API's
  // task settings, so a bad one fails boot here, before migrations.
  const enabled = api.parseConfig(env) !== undefined;
  return {
    enabled,
    // Only the exact value "false" turns auth off.
    authEnabled: env.API_AUTH_ENABLED !== "false",
    allowedHosts: (env.API_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase().replace(/:\d+$/, ""))
      .filter(Boolean),
    ssePollMs: positiveInt(env, "API_SSE_POLL_MS", 1000),
    sseMaxDurationMs: positiveInt(env, "API_SSE_MAX_DURATION_MS", 600_000),
  };
}
