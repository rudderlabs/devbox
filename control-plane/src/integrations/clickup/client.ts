// ClickUp API v2, only the calls devbox makes. Auth is the bot's personal
// token, sent as is in Authorization.
//
// Every URL is built from the base plus values checked here: task ids are
// lowercase letters and digits, team and list ids digits. So no value can add
// or climb a path segment, and nothing from a webhook payload is ever
// followed as a URL.
//
// A non-2xx answer is an HttpError, so integrations/http.ts decides what may
// be retried (a 429 honours Retry-After, or waits for X-RateLimit-Reset).
// Error messages carry the method, path and a short snippet of the answer;
// never the token. The webhook listing holds each webhook's secret, which is
// never read out of the answer.

import { HttpError, parseRetryAfter, rateLimitWaitMs } from "../http";
import { TASK_ID } from "./events";
import { type ClickUpPart, userId } from "./quill";

export type ClickUpUser = { id: number; username: string };
export type ClickUpMember = { id: number; role: number | null };
export type ClickUpTask = {
  id: string;
  name: string;
  markdownDescription: string;
  creatorId: number | null;
  assigneeIds: number[];
  status: string;
  listId: string;
  teamId: string;
};
export type ClickUpWebhook = {
  id: string;
  endpoint: string;
  health: { status: string; failCount: number };
};
export type ClickUpClient = ReturnType<typeof clickUpClient>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = "https://api.clickup.com/api/v2";
const DIGITS = /^\d{1,20}$/;

// The token lives in this closure only, so a logged client shows none.
// `fetchFn` is for the setup scripts (their tests fake it); the control plane
// uses the global fetch.
export function clickUpClient(cfg: { token: string }, fetchFn?: Fetch) {
  async function call(
    method: "GET" | "POST" | "PUT",
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const resp = await (fetchFn ?? fetch)(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: cfg.token,
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
      // Without Retry-After a rate limit waits for X-RateLimit-Reset (epoch
      // seconds), and at least a minute.
      const wait =
        parseRetryAfter(header("retry-after")) ??
        (resp.status === 429
          ? rateLimitWaitMs(Number(header("x-ratelimit-reset") ?? Number.NaN) * 1000)
          : undefined);
      throw new HttpError(
        `ClickUp ${method} ${path} failed: HTTP ${resp.status} ${text.slice(0, 200)}`,
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
    // GET /user: the token's own user.
    async user(signal: AbortSignal): Promise<ClickUpUser> {
      const u = record(record(await call("GET", "/user", signal)).user);
      const id = userId(u.id);
      if (id === null) throw new Error("ClickUp GET /user returned no user id");
      return { id, username: str(u.username) };
    },

    // GET /team: the workspace's members and their roles. Throws when the
    // token can't see the workspace.
    async members(teamId: string, signal: AbortSignal): Promise<ClickUpMember[]> {
      const id = digits(teamId);
      const teams = list(record(await call("GET", "/team", signal)).teams).map(record);
      const team = teams.find((t) => idString(t.id) === id);
      if (!team) throw new Error("ClickUp GET /team: the workspace isn't among the token's");
      return list(team.members).flatMap((m) => {
        const u = record(record(m).user);
        const id = userId(u.id);
        return id === null ? [] : [{ id, role: typeof u.role === "number" ? u.role : null }];
      });
    },

    // GET /task/{id}, its description as Markdown.
    async task(taskId: string, signal: AbortSignal): Promise<ClickUpTask> {
      const path = `/task/${task(taskId)}?include_markdown_description=true`;
      const r = record(await call("GET", path, signal));
      return {
        id: str(r.id),
        name: str(r.name),
        markdownDescription: str(r.markdown_description),
        creatorId: userId(record(r.creator).id),
        assigneeIds: list(r.assignees).flatMap((a) => {
          const id = userId(record(a).id);
          return id === null ? [] : [id];
        }),
        status: str(record(r.status).status),
        listId: idString(record(r.list).id),
        teamId: idString(r.team_id),
      };
    },

    // POST /task/{id}/comment with rich-text parts, notifying no one.
    async addComment(
      taskId: string,
      comment: ClickUpPart[],
      signal: AbortSignal,
    ): Promise<{ id: string }> {
      const r = record(
        await call("POST", `/task/${task(taskId)}/comment`, signal, { comment, notify_all: false }),
      );
      if ((typeof r.id !== "string" && typeof r.id !== "number") || r.id === "") {
        throw new Error("ClickUp POST /task/{id}/comment returned no comment id");
      }
      return { id: String(r.id) };
    },

    // PUT /task/{id} with a status name.
    async setStatus(taskId: string, status: string, signal: AbortSignal): Promise<void> {
      await call("PUT", `/task/${task(taskId)}`, signal, { status });
    },

    // GET /list/{id}: the names of the list's statuses.
    async listStatuses(listId: string, signal: AbortSignal): Promise<string[]> {
      const r = record(await call("GET", `/list/${digits(listId)}`, signal));
      return list(r.statuses)
        .map((s) => str(record(s).status))
        .filter(Boolean);
    },

    // GET /team/{id}/webhook: the webhooks the token's user created, without
    // their secrets.
    async webhooks(teamId: string, signal: AbortSignal): Promise<ClickUpWebhook[]> {
      const r = record(await call("GET", `/team/${digits(teamId)}/webhook`, signal));
      return list(r.webhooks).map((w) => {
        const h = record(record(w).health);
        return {
          id: str(record(w).id),
          endpoint: str(record(w).endpoint),
          health: {
            status: str(h.status),
            failCount: typeof h.fail_count === "number" ? h.fail_count : 0,
          },
        };
      });
    },
  };
}

function task(value: string): string {
  if (!TASK_ID.test(value)) throw new Error("ClickUp task id must be lowercase letters and digits");
  return value;
}

function digits(value: string): string {
  if (!DIGITS.test(value)) throw new Error("ClickUp id must be digits");
  return value;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// An id ClickUp may send as a string or a number.
function idString(v: unknown): string {
  return typeof v === "number" ? String(v) : str(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
