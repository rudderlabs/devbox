// GitHub App API calls: the installation token request, plus the
// generic App-authenticated fetch the CLI's setup uses. Errors carry the
// method, path, status and GitHub's own message; never the JWT, key or token.

import { appJwt } from "./jwt";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// The control plane's GitHub client (clients/githubApi.ts) reads the same
// default and override.
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const githubApiBaseUrl = (env: Record<string, string | undefined> = process.env) =>
  env.GITHUB_API_BASE_URL || DEFAULT_GITHUB_API_BASE_URL;

const REASON_MAX = 300;
export const GITHUB_TIMEOUT_MS = 30_000;

export class GithubAppError extends Error {
  status: number;
  body: string;
  // GitHub's `message` (or the raw body), truncated.
  reason: string;
  constructor(method: string, path: string, status: number, body: string) {
    const reason = githubMessage(body).slice(0, REASON_MAX);
    super(`GitHub ${method} ${path}: HTTP ${status}: ${reason}`);
    this.name = "GithubAppError";
    this.status = status;
    this.body = body.slice(0, 2000);
    this.reason = reason;
  }
}

function githubMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // not JSON: fall through to the raw body
  }
  return body.trim();
}

export type GithubAppInit = {
  method: string;
  // An App JWT, or a signer called on every request so long-running callers
  // never send an expired one.
  jwt?: string | (() => string);
  // An installation or user token.
  token?: string;
  body?: unknown;
};

export async function githubAppFetch(
  path: string,
  init: GithubAppInit,
  deps: { fetch: Fetch; apiBase: string; timeoutMs?: number },
): Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const bearer = typeof init.jwt === "function" ? init.jwt() : (init.jwt ?? init.token);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  // One deadline for the whole call, body included, so a stalled connection
  // surfaces as a failure the caller retries instead of hanging forever.
  const signal = AbortSignal.timeout(timeoutMs);
  let resp: Response;
  let text: string;
  try {
    resp = await deps.fetch(`${deps.apiBase}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
    text = await resp.text();
  } catch (err) {
    if (signal.aborted) {
      throw new Error(`GitHub ${init.method} ${path}: timed out after ${timeoutMs / 1000} s`);
    }
    throw err;
  }
  if (!resp.ok) throw new GithubAppError(init.method, path, resp.status, text);
  if (text.length === 0) return null;
  return JSON.parse(text);
}

export type MintOptions = {
  appId: number;
  installationId: number;
  privateKeyPem: string;
  // Repo names (no owner) to narrow the token to; empty or omitted = all the
  // installation's repos.
  repositories?: string[];
  fetch: Fetch;
  apiBase?: string;
  now?: () => Date;
};

export async function mintInstallationToken(
  opts: MintOptions,
): Promise<{ token: string; expiresAt: string }> {
  const now = opts.now ?? (() => new Date());
  const repositories = opts.repositories ?? [];
  const out = (await githubAppFetch(
    `/app/installations/${opts.installationId}/access_tokens`,
    {
      method: "POST",
      jwt: () => appJwt(opts.appId, opts.privateKeyPem, now()),
      body: repositories.length > 0 ? { repositories } : {},
    },
    { fetch: opts.fetch, apiBase: opts.apiBase ?? githubApiBaseUrl() },
  )) as { token?: unknown; expires_at?: unknown } | null;
  if (typeof out?.token !== "string" || typeof out.expires_at !== "string") {
    throw new Error("GitHub token response is missing token or expires_at");
  }
  // The minter schedules its refresh from this; NaN would make it spin.
  if (Number.isNaN(Date.parse(out.expires_at))) {
    throw new Error(
      `GitHub token response has an invalid expires_at: ${JSON.stringify(out.expires_at.slice(0, 64))}`,
    );
  }
  return { token: out.token, expiresAt: out.expires_at };
}
