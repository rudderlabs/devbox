// The control plane's GitLab REST v4 client: what the GitLab integration and
// its webhook controller need, and nothing the sandboxes do (those go through
// iron-proxy with the harness's own client). One instance is configured:
// config.gitlab.baseUrl. Projects are addressed by their numeric id, which
// every webhook payload carries; the code host, which has only a merge
// request's URL, passes the project's path instead.
//
// Numbers: a merge request's `iid` (per project) is what URLs and every
// `/merge_requests/<n>` path use; the global `id` never leaves the payload.

import { readFileSync } from "node:fs";
import { config } from "../config";
import { HttpError, parseRetryAfter, rateLimitWaitMs } from "../integrations/http";
import { logger } from "../logger";
import {
  type GitlabTokenProvider,
  type GitlabTokenSettings,
  type GitlabTokenState,
  gitlabTokenProvider,
} from "./gitlabToken";

export type AwardName = "eyes" | "thumbsup" | "confused";

let provider: GitlabTokenProvider | undefined;
function tokenProvider(): GitlabTokenProvider {
  if (!provider) {
    const settings =
      (config as { gitlab?: { tokenSettings?: GitlabTokenSettings } }).gitlab?.tokenSettings ?? {};
    provider = gitlabTokenProvider(settings, {
      readFile: (path) => readFileSync(path, "utf8"),
      now: Date.now,
      warn: (message, meta) => logger.warn(message, meta),
    });
  }
  return provider;
}

// Throws, sending nothing, while there is no token (neither setting, or a
// token file that has never been readable). Only an operator can fix that, so
// callers drop the send instead of holding it, as with GitHub's token.
function token(): string {
  return tokenProvider()();
}

export function gitlabTokenState(): GitlabTokenState {
  return tokenProvider().state();
}

function apiBase(): string {
  const base = (config as { gitlab?: { baseUrl?: string } }).gitlab?.baseUrl;
  if (!base) throw new Error("GITLAB_BASE_URL is not set: no GitLab instance to talk to");
  return `${base}/api/v4`;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// One request. Throws an HttpError on non-2xx with status + a truncated body
// snippet (and Retry-After) — the token is never included in the message.
async function gitlabFetch(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown; headers: Headers | undefined }> {
  const resp = await fetch(`${apiBase()}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await resp.text();
  if (!resp.ok) {
    const snippet = text.slice(0, 500);
    // `?.`: tests stub fetch with header-less partial responses.
    const header = (name: string) => resp.headers?.get(name) ?? null;
    // GitLab rate limits answer 429 with Retry-After, or RateLimit-Reset (epoch
    // seconds) when the limit is a per-endpoint one.
    const rateLimited = resp.status === 429;
    throw new HttpError(
      `GitLab ${method} ${path} failed: HTTP ${resp.status} ${snippet}`,
      resp.status,
      parseRetryAfter(header("retry-after")) ??
        (rateLimited ? rateLimitWaitMs(Number(header("ratelimit-reset")) * 1000) : undefined),
      rateLimited,
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
  return { status: resp.status, json, headers: resp.headers };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

// Every page of a list endpoint. GitLab's pagination headers name the next
// page; a short or missing header is terminal.
async function paginated(path: string, signal?: AbortSignal): Promise<unknown[]> {
  const items: unknown[] = [];
  const separator = path.includes("?") ? "&" : "?";
  let page = 1;
  for (;;) {
    const { json, headers } = await gitlabFetch(
      "GET",
      `${path}${separator}per_page=100&page=${page}`,
      undefined,
      signal,
    );
    if (!Array.isArray(json)) throw new Error(`GitLab list endpoint returned non-list for ${path}`);
    items.push(...json);
    const next = headers?.get("x-next-page") ?? "";
    if (!next || json.length < 100) return items;
    const nextPage = Number(next);
    // A list is complete or not at all: a header that does not advance ends it,
    // nothing else does (a large group's members run past 10,000).
    if (!Number.isFinite(nextPage) || nextPage <= page) return items;
    page = nextPage;
  }
}

// A project is addressed by its numeric id (what webhooks carry) or by its
// path_with_namespace (what a merge request URL carries), URL-encoded.
const mr = (project: number | string, mrIid: number): string =>
  `/projects/${encodeURIComponent(String(project))}/merge_requests/${mrIid}`;

// POST .../merge_requests/{iid}/notes — a new top-level note on the merge request.
export async function postMrNote(
  projectId: number | string,
  mrIid: number,
  body: string,
  signal?: AbortSignal,
): Promise<{ id: number }> {
  const { json } = await gitlabFetch("POST", `${mr(projectId, mrIid)}/notes`, { body }, signal);
  return { id: Number(asRecord(json).id) };
}

// POST .../discussions/{discussionId}/notes — a reply inside one thread. Works
// for diff discussions and for the one-note discussion every plain note has.
export async function postDiscussionNote(
  projectId: number,
  mrIid: number,
  discussionId: string,
  body: string,
  signal?: AbortSignal,
): Promise<{ id: number }> {
  const { json } = await gitlabFetch(
    "POST",
    `${mr(projectId, mrIid)}/discussions/${encodeURIComponent(discussionId)}/notes`,
    { body },
    signal,
  );
  return { id: Number(asRecord(json).id) };
}

// The discussion a note belongs to, found by listing the merge request's
// discussions (a Note Hook does not always carry discussion_id). null when the
// note is not there.
export async function findDiscussionIdForNote(
  projectId: number,
  mrIid: number,
  noteId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const discussions = await paginated(`${mr(projectId, mrIid)}/discussions`, signal);
  for (const d of discussions) {
    const rec = asRecord(d);
    const notes = Array.isArray(rec.notes) ? rec.notes : [];
    if (notes.some((n) => Number(asRecord(n).id) === noteId)) return String(rec.id);
  }
  return null;
}

// POST .../notes/{noteId}/award_emoji — the 👀 acknowledgement and the 😕 of a
// missing workspace. GitLab answers 404 when the same user already awarded the
// same emoji (a redelivered webhook); that is a no-op here.
export async function awardNoteEmoji(
  projectId: number,
  mrIid: number,
  noteId: number,
  name: AwardName,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await gitlabFetch(
      "POST",
      `${mr(projectId, mrIid)}/notes/${noteId}/award_emoji`,
      { name },
      signal,
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return;
    throw err;
  }
}

// GET .../merge_requests?state=opened&source_branch=… — the open merge requests
// whose source is `branch`, for a branch pipeline that names no merge request.
export async function listOpenMergeRequestsForBranch(
  projectId: number,
  branch: string,
  signal?: AbortSignal,
): Promise<Array<{ iid: number; webUrl: string }>> {
  // One open merge request per source and target branch, so this is a page at
  // most; paginated anyway, so a long list of targets cannot hide one.
  const list = await paginated(
    `/projects/${projectId}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`,
    signal,
  );
  return list
    .map((item) => {
      const r = asRecord(item);
      return { iid: Number(r.iid), webUrl: typeof r.web_url === "string" ? r.web_url : "" };
    })
    .filter((item) => Number.isFinite(item.iid) && item.iid > 0);
}

// GET /groups/{group}/members/all — every member of the group, including
// inherited and shared ones, as immutable numeric user ids. An empty set is a
// failure signal (wrong group, a token without read access).
export async function fetchGroupMembers(group: string): Promise<Set<number>> {
  const members = new Set<number>();
  for (const m of await paginated(`/groups/${encodeURIComponent(group)}/members/all`)) {
    const id = Number(asRecord(m).id);
    if (Number.isFinite(id) && id > 0) members.add(id);
  }
  return members;
}

// GET /users?username=… — the immutable numeric id of a username, or null when
// no such user exists.
export async function getUserIdByUsername(username: string): Promise<number | null> {
  const { json } = await gitlabFetch("GET", `/users?username=${encodeURIComponent(username)}`);
  const first = Array.isArray(json) ? json[0] : undefined;
  const id = Number(asRecord(first).id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// The merge request web URL as GitLab renders it, and as the harness records it
// from the create response: <project web_url>/-/merge_requests/<iid>. Built the
// same way everywhere so findTaskByPrUrl's exact match holds.
export function mrWebUrl(projectWebUrl: string, mrIid: number): string {
  return `${projectWebUrl.replace(/\/+$/, "")}/-/merge_requests/${mrIid}`;
}

// (project path, iid) of a merge request URL under the configured instance;
// null for anything else.
export function parseMrUrl(
  url: string,
  baseUrl: string | undefined = (config as { gitlab?: { baseUrl?: string } }).gitlab?.baseUrl,
): { project: string; mrIid: number } | null {
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, "");
  if (!url.startsWith(`${base}/`)) return null;
  const match = url.slice(base.length).match(/^\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/);
  if (!match) return null;
  return { project: match[1] as string, mrIid: Number(match[2]) };
}
