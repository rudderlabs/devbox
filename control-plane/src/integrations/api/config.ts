import type { Env } from "../types";

// The settings that shape the tasks the API integration creates. /api's own
// settings (auth, allowed hosts, streams) are core's, in apiConfig.ts, because
// /api serves every source's tasks.
export type ApiSettings = {
  // No trailing slash. The base for an API task's stored URL.
  publicBaseUrl: string;
  taskKeyPrefix: string;
};

const TASK_KEY_PREFIX_RE = /^[A-Z][A-Z0-9-]*-$/;

// On only with API_ENABLED=true, which also mounts /api; then
// API_PUBLIC_BASE_URL is required. Both settings are checked even while it is
// off, so a bad value fails boot either way.
export function parseApiSettings(env: Env): ApiSettings | undefined {
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
  return enabled ? { publicBaseUrl, taskKeyPrefix } : undefined;
}
