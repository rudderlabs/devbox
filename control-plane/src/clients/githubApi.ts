// GitHub REST wrappers + PR-URL parsing. Plain function exports, mirrors
// clients/linear.ts. This is the IMPLEMENTATION module; production code and
// tests import it through the ../clients/github barrel. github.test.ts imports
// it directly because this specifier is never mock.module'd — see github.ts and
// control-plane/README.md (Conventions) for why that matters.
//
// Auth: a bearer token from the GitHub token provider (./githubToken):
// GITHUB_TOKEN_FILE re-read on a TTL, or GITHUB_TOKEN. The control plane is
// not behind iron-proxy, so this is a real token.
//
// Never log the token. Error paths surface HTTP status + a body snippet only.

import { readFileSync } from "node:fs";
import { config } from "../config";
import { githubApiBaseUrl } from "../githubToken/mint";
import { HttpError, parseRetryAfter, TokenFetchError } from "../integrations/http";
import { logger } from "../logger";
import {
  type GithubTokenProvider,
  type GithubTokenSettings,
  type GithubTokenState,
  githubTokenProvider,
} from "./githubToken";

const API_BASE = githubApiBaseUrl();

type ReactionContent = "eyes" | "+1" | "heart" | "confused";

let githubToken: GithubTokenProvider | undefined;

function tokenProvider(): GithubTokenProvider {
  if (!githubToken) {
    // Some test suites module-mock config; keep this client resilient by
    // tolerating a missing github section in the mocked shape.
    const settings = (config as { github?: { tokenSettings?: GithubTokenSettings } }).github
      ?.tokenSettings ?? { token: process.env.GITHUB_TOKEN ?? "proxy-github-dummy-token" };
    githubToken = githubTokenProvider(settings, {
      readFile: (path) => readFileSync(path, "utf8"),
      now: Date.now,
      warn: (message, meta) => logger.warn(message, meta),
    });
  }
  return githubToken;
}

// No token means nothing was sent, so a send may be retried (TokenFetchError).
function token(): string {
  try {
    return tokenProvider()();
  } catch (err) {
    throw new TokenFetchError(err instanceof Error ? err.message : String(err));
  }
}

// The token provider's state, for GET /api/integrations/github.
export function githubTokenState(): GithubTokenState {
  return tokenProvider().state();
}

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

// One request. Throws an HttpError on non-2xx with status + a truncated body
// snippet (and Retry-After) — the token is never included in the message.
async function githubFetch(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: githubHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await resp.text();
  if (!resp.ok) {
    const snippet = text.slice(0, 500);
    throw new HttpError(
      `GitHub ${method} ${path} failed: HTTP ${resp.status} ${snippet}`,
      resp.status,
      // `?.`: the client tests stub fetch with header-less partial responses.
      parseRetryAfter(resp.headers?.get("retry-after") ?? null),
    );
  }
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: resp.status, json };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

// POST /repos/{owner}/{repo}/issues/{prNumber}/comments — a new top-level PR
// comment. (A PR is an issue for the comments API.)
export async function postIssueComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  signal?: AbortSignal,
): Promise<{ id: number; url: string }> {
  const { json } = await githubFetch(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments`,
    { body },
    signal,
  );
  const r = asRecord(json);
  return { id: Number(r.id), url: String(r.html_url ?? "") };
}

// POST /repos/{owner}/{repo}/pulls/{prNumber}/requested_reviewers — request
// review from one or more users. GitHub treats already-requested reviewers as
// idempotent/no-op for our best-effort completion signal.
export async function requestReviewers(
  owner: string,
  repo: string,
  prNumber: number,
  reviewers: string[],
  signal?: AbortSignal,
): Promise<void> {
  await githubFetch(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/requested_reviewers`,
    { reviewers },
    signal,
  );
}

// POST /repos/{owner}/{repo}/pulls/{prNumber}/comments with in_reply_to —
// an in-thread reply to an existing inline review comment.
export async function postReviewCommentReply(
  owner: string,
  repo: string,
  prNumber: number,
  inReplyTo: number,
  body: string,
  signal?: AbortSignal,
): Promise<{ id: number; url: string }> {
  const { json } = await githubFetch(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/comments`,
    { body, in_reply_to: inReplyTo },
    signal,
  );
  const r = asRecord(json);
  return { id: Number(r.id), url: String(r.html_url ?? "") };
}

// POST /repos/{owner}/{repo}/issues/comments/{commentId}/reactions — a 👀 (or
// other) reaction on a top-level issue/PR comment.
export async function addIssueCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  content: ReactionContent,
  signal?: AbortSignal,
): Promise<void> {
  await githubFetch(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
    { content },
    signal,
  );
}

// POST /repos/{owner}/{repo}/pulls/comments/{commentId}/reactions — a reaction
// on an inline review comment.
export async function addReviewCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  content: ReactionContent,
  signal?: AbortSignal,
): Promise<void> {
  await githubFetch(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}/reactions`,
    { content },
    signal,
  );
}

// GET /repos/{owner}/{repo}/pulls/{prNumber}/comments — the modern
// "Pull Request Review Comment" list (paginated). Filtered client-side by
// `pull_request_review_id === reviewId` to return only the inline comments
// attached to one submitted review.
//
// The dedicated `/reviews/{reviewId}/comments` endpoint serializes records as
// the *Legacy Review Comment* schema, which leaves `line`/`original_line` null
// even when the comment is line-anchored — only `position` (deprecated diff
// offset) is populated. The modern endpoint serializes the *Pull Request
// Review Comment* schema with `line` set to the file line, which is what the
// sandbox agent needs to address the comment.
export async function getReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
): Promise<
  Array<{
    id: number;
    path: string;
    line: number;
    startLine?: number;
    body: string;
    user: { login: string };
  }>
> {
  const asAnchorLine = (primary: unknown, fallback: unknown): number => {
    const fromPrimary = Number(primary);
    if (Number.isFinite(fromPrimary) && fromPrimary > 0) return fromPrimary;
    const fromFallback = Number(fallback);
    if (Number.isFinite(fromFallback) && fromFallback > 0) return fromFallback;
    return 0;
  };

  const out: Array<{
    id: number;
    path: string;
    line: number;
    startLine?: number;
    body: string;
    user: { login: string };
  }> = [];
  for (let page = 1; ; page++) {
    const { json } = await githubFetch(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(json) || json.length === 0) break;
    for (const item of json) {
      const r = asRecord(item);
      if (Number(r.pull_request_review_id) !== reviewId) continue;
      const user = asRecord(r.user);
      // `line` is null on an outdated comment — fall back to original_line.
      const line = asAnchorLine(r.line, r.original_line);
      // For multi-line comments, preserve the leading anchor only when GitHub
      // provides one. Do not synthesize it from end-line fallback.
      const startLineRaw = asAnchorLine(r.start_line, r.original_start_line);

      out.push({
        id: Number(r.id),
        path: String(r.path ?? ""),
        line,
        ...(startLineRaw > 0 ? { startLine: startLineRaw } : {}),
        body: String(r.body ?? ""),
        user: { login: String(user.login ?? "") },
      });
    }
    if (json.length < 100) break;
  }
  return out;
}

// GET /orgs/{org}/members?per_page=100 — full member list for a single org.
// Paginated. Returns a Set of numeric user ids — immutable, never re-issued by
// GitHub — so a rename (or the 90-day post-rename handle reclaim) can't grant
// a stranger trust. Needs `read:org` on the token. An empty set is a
// legitimate failure signal (scope-deficient token, wrong org name) —
// callers should treat it as such.
export async function fetchOrgMembers(org: string): Promise<Set<number>> {
  const members = new Set<number>();
  for (let page = 1; ; page++) {
    const { json } = await githubFetch(
      "GET",
      `/orgs/${encodeURIComponent(org)}/members?per_page=100&page=${page}`,
    );
    if (!Array.isArray(json) || json.length === 0) break;
    for (const m of json) {
      const id = Number(asRecord(m).id);
      if (Number.isFinite(id) && id > 0) members.add(id);
    }
    if (json.length < 100) break;
  }
  return members;
}

// POST /repos/{owner}/{repo}/issues/{prNumber}/assignees — add assignees to a
// PR. (A PR is an issue for the assignees API.) Idempotent: re-adding an
// existing assignee is a no-op. GitHub SILENTLY DROPS any login without push
// access to the repo and still returns 201 — so the post-call assignee list is
// returned for the caller to compare requested vs applied.
export async function addPrAssignees(
  owner: string,
  repo: string,
  prNumber: number,
  assignees: string[],
): Promise<{ assigned: string[] }> {
  const { json } = await githubFetch(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/assignees`,
    { assignees },
  );
  const list = asRecord(json).assignees;
  const assigned = Array.isArray(list)
    ? list.map((a) => String(asRecord(a).login ?? "")).filter((login) => login.length > 0)
    : [];
  return { assigned };
}

// GET /user/{id} — resolve an immutable numeric GitHub account id to the
// current login. Ids survive renames and are never re-issued, so this is the
// rename-proof lookup. Throws on 404 (githubFetch); callers catch.
export async function getUserById(
  id: string | number,
  signal?: AbortSignal,
): Promise<{ login: string; id: number }> {
  const { json } = await githubFetch(
    "GET",
    `/user/${encodeURIComponent(String(id))}`,
    undefined,
    signal,
  );
  const r = asRecord(json);
  return { login: String(r.login ?? ""), id: Number(r.id) };
}

// GET /users/{login} — resolve a login to its immutable numeric id, for the
// trusted-user setting. Returns null when the login does not exist (404) so a
// typo leaves that one user untrusted instead of failing the whole trusted set.
// Any other failure throws; callers treat that as transient.
export async function getUserIdByLogin(login: string): Promise<number | null> {
  try {
    const { json } = await githubFetch("GET", `/users/${encodeURIComponent(login)}`);
    const id = Number(asRecord(json).id);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch (err) {
    if (err instanceof Error && err.message.includes("HTTP 404")) return null;
    throw err;
  }
}

// Parse a github.com PR URL → {owner, repo, prNumber}; null for a non-GitHub
// or malformed URL. Used by the EventDispatcher pr_opened case to target the
// onboarding comment.
//   https://github.com/acme/widgets/pull/42
//     → { owner: "acme", repo: "widgets", prNumber: 42 }
export function parsePrUrl(
  prUrl: string,
): { owner: string; repo: string; prNumber: number } | null {
  const match = prUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  const prNumber = Number(match[3]);
  if (!owner || !repo || !Number.isFinite(prNumber)) return null;
  return { owner, repo, prNumber };
}
