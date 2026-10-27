// Checks before startup: the GitHub token, push and
// pull-request access to every configured repo, and a tiny completion against
// the LLM endpoint. Each failure names the secret, repo or setting that is
// wrong. Never prints a secret. docs/configuration.md#what-preflight-checks
// lists every call made with the token; keep it in step with this file.
import { randomBytes } from "node:crypto";
import type { DevboxConfig, RepoConfig } from "./config";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type Identity = { gitName: string; gitEmail: string };

export class PreflightError extends Error {}
// The service refused the credential itself (401, or a 403 that is about the
// token): a saved value is then stale and gets replaced.
export class CredentialRejected extends PreflightError {}

const GITHUB_API = "https://api.github.com";
const PROMPT = "Reply with OK.";
const DOCS = "see docs/configuration.md#what-preflight-checks";

const apiHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "devbox-up",
  "X-GitHub-Api-Version": "2022-11-28",
});

async function call(what: string, f: () => Promise<Response>): Promise<Response> {
  try {
    return await f();
  } catch (err) {
    throw new PreflightError(`GitHub check failed: ${what}: ${(err as Error).message}`);
  }
}

const githubGet = (token: string, path: string, fetch: Fetch) =>
  call(`GET ${path}`, () => fetch(`${GITHUB_API}${path}`, { headers: apiHeaders(token) }));

// GitHub's reason for a refusal: `message` from an API answer, or the text git's
// endpoint sends (an archived repo, SAML enforcement, an IP allow list).
async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") message = parsed;
    else if (parsed && typeof parsed === "object") {
      message = String((parsed as { message?: unknown }).message ?? "");
    }
  } catch {}
  return message.replace(/\s+/g, " ").trim().slice(0, 200);
}

const withReason = (status: number, why: string) => `${status}${why ? `: ${why}` : ""}`;

// A rate-limited token gets 403 or 429, which would otherwise read as a missing
// permission (or, on /user, as an App token).
function throwIfRateLimited(res: Response, why: string, what: string): void {
  const limited =
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(why)));
  if (!limited) return;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(res.headers.get("retry-after"));
  const when =
    res.headers.get("retry-after") && Number.isFinite(retryAfter)
      ? `; retry in ${retryAfter}s`
      : res.headers.get("x-ratelimit-reset") && Number.isFinite(reset)
        ? `; retry after ${new Date(reset * 1000).toISOString()}`
        : "";
  throw new PreflightError(
    `GitHub rate limit hit (${what} returned ${withReason(res.status, why)})${when}`,
  );
}

// GitHub's `permissions` field can't answer "can this token push": for a
// fine-grained PAT it is the owner's role on the repo, whatever the token was
// granted, and for an App installation token it is all false. Git's push
// advertisement is served only to a token that can push, and writes nothing.
async function checkPush(
  token: string,
  tokenName: string,
  slug: string,
  i: number,
  fetch: Fetch,
): Promise<void> {
  const url = `https://github.com/${slug}.git/info/refs?service=git-receive-pack`;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const res = await call(`GET ${url}`, () =>
    fetch(url, {
      headers: { Authorization: `Basic ${basic}`, "User-Agent": "git/devbox-up" },
      redirect: "manual",
    }),
  );
  if (res.status === 200) {
    await res.body?.cancel();
    return;
  }
  // The API follows a renamed or transferred repo; git's endpoint redirects.
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    const to = res.headers.get("location");
    throw new PreflightError(
      `${slug} (repos[${i}]) has moved${to ? ` to ${to}` : ""}: update repos[${i}].url`,
    );
  }
  const why = await reason(res);
  throwIfRateLimited(res, why, "git's push endpoint");
  throw new PreflightError(
    `${tokenName} cannot push to ${slug} (repos[${i}]): git's push endpoint returned ${withReason(res.status, why)}; check the token has Contents: read and write (${DOCS})`,
  );
}

// Asks for a pull request from a branch that doesn't exist. GitHub checks the
// token's permission first: 403 means it cannot open pull requests, 422 means
// it can and the request failed validation, so no pull request is created.
async function checkPullRequests(
  token: string,
  tokenName: string,
  repo: RepoConfig,
  i: number,
  head: string,
  fetch: Fetch,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const path = `/repos/${slug}/pulls`;
  const res = await call(`POST ${path}`, () =>
    fetch(`${GITHUB_API}${path}`, {
      method: "POST",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "devbox preflight check (never created)",
        head,
        base: repo.branch,
      }),
    }),
  );
  if (res.status === 422) {
    await res.body?.cancel();
    return;
  }
  if (res.status === 201) return closeAccidentalPullRequest(token, slug, head, res, fetch);
  const why = await reason(res);
  throwIfRateLimited(res, why, `POST ${path}`);
  throw new PreflightError(
    `${tokenName} cannot open pull requests in ${slug} (repos[${i}]): POST ${path} returned ${withReason(res.status, why)}; check the token has Pull requests: read and write (${DOCS})`,
  );
}

// Only if `head` existed after all: the token can open pull requests, and the
// one it opened must not stay open. Fails loudly if it can't be closed.
async function closeAccidentalPullRequest(
  token: string,
  slug: string,
  head: string,
  created: Response,
  fetch: Fetch,
): Promise<void> {
  const pr = (await created.json().catch(() => ({}))) as { number?: number; html_url?: string };
  const leftOpen = (detail: string) =>
    new PreflightError(
      `the pull request check opened a real pull request in ${slug}, because branch ${head} exists, and could not close it (${detail}): close ${pr.html_url ?? `the pull request from ${head}`} by hand`,
    );
  if (typeof pr.number !== "number") throw leftOpen("GitHub's answer had no pull request number");
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/repos/${slug}/pulls/${pr.number}`, {
      method: "PATCH",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });
  } catch (err) {
    throw leftOpen((err as Error).message);
  }
  if (!res.ok) throw leftOpen(`PATCH returned ${withReason(res.status, await reason(res))}`);
  await res.body?.cancel();
}

// The name goes into a Makefile recipe inside quotes (harness/Makefile), so
// drop the characters that would end or expand them.
const safeName = (name: unknown): string =>
  typeof name === "string" ? name.replace(/["'$`\\]/g, "").trim() : "";

export async function checkGithub(
  token: string,
  repos: RepoConfig[],
  fetch: Fetch,
  opts: {
    requirePush?: boolean;
    headName?: () => string;
    // How messages name the token: GITHUB_TOKEN, or the App's token.
    tokenName?: string;
  } = {},
): Promise<Identity | undefined> {
  const tokenName = opts.tokenName ?? "GITHUB_TOKEN";
  if (!token) {
    const can = opts.requirePush === false ? "read" : "push to";
    throw new PreflightError(
      `${tokenName} is empty: devbox needs a token that can ${can} the repos`,
    );
  }
  const res = await githubGet(token, "/user", fetch);
  let user: { id: number; login: string; name: string | null } | undefined;
  if (res.ok) {
    user = (await res.json()) as { id: number; login: string; name: string | null };
  } else {
    const why = await reason(res);
    throwIfRateLimited(res, why, "GET /user");
    // A GitHub App installation token (Actions' GITHUB_TOKEN too) has no user
    // identity, but the repo checks below still apply. Any other 403 (SAML
    // enforcement, an IP allow list) is a rejection.
    if (res.status !== 403 || !why.includes("Resource not accessible by integration")) {
      const Err = res.status === 401 || res.status === 403 ? CredentialRejected : PreflightError;
      throw new Err(
        `GitHub rejected ${tokenName} (GET /user returned ${withReason(res.status, why)})`,
      );
    }
  }
  const headName = opts.headName ?? (() => `devbox-preflight-${randomBytes(8).toString("hex")}`);
  for (const [i, repo] of repos.entries()) {
    const slug = `${repo.owner}/${repo.name}`;
    const r = await githubGet(token, `/repos/${slug}`, fetch);
    if (!r.ok) {
      const why = await reason(r);
      throwIfRateLimited(r, why, `GET /repos/${slug}`);
      throw new PreflightError(
        `${slug} (repos[${i}]) does not exist or ${tokenName} cannot see it (GET /repos/${slug} returned ${withReason(r.status, why)})`,
      );
    }
    await r.body?.cancel();
    // Kubernetes CI installs with a read-only token (--skip-push-check).
    if (opts.requirePush === false) continue;
    await checkPush(token, tokenName, slug, i, fetch);
    await checkPullRequests(token, tokenName, repo, i, headName(), fetch);
  }
  if (!user) return undefined;
  return {
    gitName: safeName(user.name) || user.login,
    gitEmail: `${user.id}+${user.login}@users.noreply.github.com`,
  };
}

type LlmRequest = { url: string; body: unknown; headers: Record<string, string> };

// Each check sends the request shape the harness sends, so a model that
// rejects it fails here rather than in every stage. Not /models, which many
// proxies don't serve.

// The Responses API (OpenAI, Azure) with reasoning, as the harness calls it.
// It takes 16 output tokens at least; a capped reply still answers 200.
function openaiRequest(llm: DevboxConfig["llm"], apiKey: string): LlmRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["api-key"] = apiKey;
  }
  return {
    url: `${llm.baseUrl}/responses`,
    body: {
      model: llm.model,
      input: PROMPT,
      max_output_tokens: 16,
      reasoning: { effort: "low", summary: "auto" },
      store: false,
      include: ["reasoning.encrypted_content"],
    },
    headers,
  };
}

// The Messages API with adaptive thinking and an effort, as the harness calls
// it. It requires max_tokens; a capped reply still answers 200.
function anthropicRequest(llm: DevboxConfig["llm"], apiKey: string): LlmRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  return {
    url: `${llm.baseUrl}/v1/messages`,
    body: {
      model: llm.model,
      max_tokens: 16,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: PROMPT }],
    },
    headers,
  };
}

export async function checkLlm(
  llm: DevboxConfig["llm"],
  apiKey: string,
  fetch: Fetch,
): Promise<void> {
  const { url, body, headers } =
    llm.provider === "anthropic" ? anthropicRequest(llm, apiKey) : openaiRequest(llm, apiKey);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new PreflightError(`LLM check failed: POST ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let text = (await res.text().catch(() => "")).trim().slice(0, 300);
    if (apiKey) text = text.replaceAll(apiKey, "***");
    const Err = res.status === 401 || res.status === 403 ? CredentialRejected : PreflightError;
    throw new Err(
      `LLM check failed: POST ${url} returned ${res.status} (check llm.baseUrl, llm.model and LLM_API_KEY)${text ? `: ${text}` : ""}`,
    );
  }
}
