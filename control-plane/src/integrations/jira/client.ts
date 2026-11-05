// Jira Cloud REST v3, only the calls devbox makes. Requests go through
// Atlassian's API gateway for the site's cloud id, because the site URL
// rejects the scoped tokens service accounts have. Auth is Basic
// email:token.
//
// Every URL is built from config plus values checked here: the cloud id is a
// UUID, project keys are letters, digits and underscores, issue and
// transition ids are plain numbers, and account ids are encoded. So no value
// can add or climb a path segment (encodeURIComponent alone lets "." and ".."
// through), and nothing from a webhook payload is ever followed as a URL.
//
// A non-2xx answer is an HttpError, so integrations/http.ts decides what may
// be retried (a 429 honours Retry-After). Error messages carry the method,
// path and a short snippet of the answer; never the token or the email.

import { HttpError, parseRetryAfter, rateLimitWaitMs } from "../http";
import type { AdfDoc } from "./adf";

export type JiraClientConfig = { cloudId: string; email: string; token: string };
export type JiraUser = { accountId: string; accountType: string; displayName: string };
export type JiraGroup = { name: string; groupId: string | null };
export type JiraStatus = { id: string; name: string };
export type JiraTransition = { id: string; name: string; to: JiraStatus };
export type JiraIssue = { id: string; key: string; fields: Record<string, unknown> };
export type RemoteLink = { globalId: string; url: string; title: string };
export type JiraClient = ReturnType<typeof jiraClient>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// What devbox needs in each project: see issues, comment, move them between
// statuses, link the pull request, and be assigned issues (ASSIGNABLE_USER:
// without it Jira won't let anyone assign the bot).
export const PERMISSIONS = [
  "BROWSE_PROJECTS",
  "ADD_COMMENTS",
  "TRANSITION_ISSUES",
  "LINK_ISSUES",
  "ASSIGNABLE_USER",
];

// The global permission Browse users and groups: GET /user/groups needs it,
// so trust by group can't read anyone's groups without it.
export const GROUPS_PERMISSION = "USER_PICKER";

const NUMERIC = /^[1-9]\d{0,14}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The credentials live in this closure only, so a logged client shows none.
// Throws when the cloud id isn't a UUID. `fetchFn` is the setup scripts'
// (their tests fake it); the control plane uses the global fetch.
export function jiraClient(cfg: JiraClientConfig, fetchFn?: Fetch) {
  if (!UUID.test(cfg.cloudId)) throw new Error("Jira cloud id must be a UUID");
  const base = `https://api.atlassian.com/ex/jira/${cfg.cloudId}/rest/api/3`;
  const auth = `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64")}`;

  async function call(
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const resp = await (fetchFn ?? fetch)(`${base}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      // `?.`: tests stub fetch with header-less partial responses.
      const header = (name: string) => resp.headers?.get(name) ?? null;
      // Without Retry-After a rate limit waits for X-RateLimit-Reset (an ISO
      // timestamp), and at least a minute.
      const wait =
        parseRetryAfter(header("retry-after")) ??
        (resp.status === 429
          ? rateLimitWaitMs(Date.parse(header("x-ratelimit-reset") ?? ""))
          : undefined);
      throw new HttpError(
        `Jira ${method} ${path} failed: HTTP ${resp.status} ${text.slice(0, 200)}`,
        resp.status,
        wait,
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  return {
    // GET /myself: the bot's own account.
    async myself(signal: AbortSignal): Promise<JiraUser> {
      const r = record(await call("GET", "/myself", signal));
      if (typeof r.accountId !== "string" || !r.accountId) {
        throw new Error("Jira GET /myself returned no accountId");
      }
      return {
        accountId: r.accountId,
        accountType: str(r.accountType),
        displayName: str(r.displayName),
      };
    },

    // GET /user/groups: the groups one account is in. Listing a group's
    // members needs more than the bot's scopes; reading one account's groups
    // doesn't.
    async userGroups(accountId: string, signal: AbortSignal): Promise<JiraGroup[]> {
      const json = await call("GET", `/user/groups?${query({ accountId })}`, signal);
      return list(json)
        .map(record)
        .filter((g) => typeof g.name === "string")
        .map((g) => ({
          name: str(g.name),
          groupId: typeof g.groupId === "string" ? g.groupId : null,
        }));
    },

    // POST /issue/{id}/comment with an ADF body. Returns the new comment's id.
    async addComment(issueId: string, body: AdfDoc, signal: AbortSignal): Promise<{ id: string }> {
      const r = record(await call("POST", `/issue/${id(issueId)}/comment`, signal, { body }));
      if (typeof r.id !== "string" || !r.id) {
        throw new Error("Jira POST /issue/{id}/comment returned no comment id");
      }
      return { id: r.id };
    },

    // GET /issue/{id}, limited to `fields`.
    async getIssue(issueId: string, fields: string[], signal: AbortSignal): Promise<JiraIssue> {
      const path = `/issue/${id(issueId)}?${query({ fields: fields.join(",") })}`;
      const r = record(await call("GET", path, signal));
      return { id: str(r.id), key: str(r.key), fields: record(r.fields) };
    },

    // GET /issue/{id}/transitions: the moves open to the bot from the current status.
    async transitions(issueId: string, signal: AbortSignal): Promise<JiraTransition[]> {
      const r = record(await call("GET", `/issue/${id(issueId)}/transitions`, signal));
      return list(r.transitions)
        .map(record)
        .map((t) => ({ id: str(t.id), name: str(t.name), to: status(t.to) }));
    },

    // POST /issue/{id}/transitions.
    async transition(issueId: string, transitionId: string, signal: AbortSignal): Promise<void> {
      await call("POST", `/issue/${id(issueId)}/transitions`, signal, {
        transition: { id: id(transitionId) },
      });
    },

    // POST /issue/{id}/remotelink: Jira updates the link with the same
    // globalId in place, so this runs safely more than once.
    async upsertRemoteLink(issueId: string, link: RemoteLink, signal: AbortSignal): Promise<void> {
      await call("POST", `/issue/${id(issueId)}/remotelink`, signal, {
        globalId: link.globalId,
        object: { url: link.url, title: link.title },
      });
    },

    // GET /mypermissions for one project, or with no project key for global
    // permissions (Jira answers 400 when one request mixes the two): each
    // asked-for key and whether the bot holds it (a key Jira leaves out counts
    // as not held).
    async myPermissions(
      projectKey: string | undefined,
      permissions: string[],
      signal: AbortSignal,
    ): Promise<Record<string, boolean>> {
      const params = {
        ...(projectKey === undefined ? {} : { projectKey: key(projectKey) }),
        permissions: permissions.join(","),
      };
      const path = `/mypermissions?${query(params)}`;
      const held = record(record(await call("GET", path, signal)).permissions);
      return Object.fromEntries(
        permissions.map((p) => [p, record(held[p]).havePermission === true]),
      );
    },

    // GET /project/{key}/statuses: every status any issue type in the project
    // uses, once each.
    async projectStatuses(projectKey: string, signal: AbortSignal): Promise<JiraStatus[]> {
      const path = `/project/${key(projectKey)}/statuses`;
      const byId = new Map<string, JiraStatus>();
      for (const type of list(await call("GET", path, signal))) {
        for (const s of list(record(type).statuses).map(status)) byId.set(s.id, s);
      }
      return [...byId.values()];
    },
  };
}

// An issue or transition id for a URL path: digits only.
function id(value: string): string {
  if (!NUMERIC.test(value)) throw new Error("Jira id must be numeric");
  return value;
}

function key(projectKey: string): string {
  if (!PROJECT_KEY.test(projectKey)) throw new Error("Jira project key is malformed");
  return projectKey;
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function status(v: unknown): JiraStatus {
  const r = record(v);
  return { id: str(r.id), name: str(r.name) };
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
