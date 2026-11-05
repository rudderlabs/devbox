import { HttpError, withTimeout } from "../http";
import type { Logger } from "../types";
import type { JiraGroup } from "./client";
import { isNonHuman, type JiraActor } from "./events";

// How long a looked-up answer is served before the next use looks it up
// again. Same horizon as GitHub's trusted set, so removing someone takes
// effect within it everywhere (restart the control plane to apply it at once).
export const TRUST_TTL_MS = 6 * 60 * 60 * 1000;
// After a failed lookup, that account's next lookup waits this long.
export const TRUST_RETRY_MS = 60_000;
// A lookup runs inline on the webhook request, so it is kept short.
const LOOKUP_TIMEOUT_MS = 3_000;

// "unresolved": no usable answer, so the caller asks Jira to retry later.
export type TrustAnswer = boolean | "unresolved";

export type TrustStatus = {
  source: "groups" | "users" | "groups+users";
  cachedAccounts: number;
  lastError?: string; // the last lookup's failure class, cleared by a success
};

// Whether a Jira account may drive devbox: it is one of `trustedUsers`, or a
// member of one of `trustedGroups` (names compared in any case). App and
// customer accounts never are. Membership is read per account, because
// listing a group's members needs admin rights while reading one account's
// groups doesn't. Answers are cached per account:
// - served for TRUST_TTL_MS, then looked up again on next use, inline;
// - a failed lookup isn't cached: the account's next try waits TRUST_RETRY_MS,
//   and meanwhile, and when that fails too, the last answer is served for one
//   more TTL;
// - with no usable answer the result is "unresolved".
// Concurrent checks of one account share one lookup.
export class JiraTrust {
  private readonly users: ReadonlySet<string>;
  private readonly groups: ReadonlySet<string>;
  private readonly answers = new Map<string, { trusted: boolean; at: number }>();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<TrustAnswer>>();
  private lastError: string | undefined;

  constructor(
    cfg: { trustedUsers: string[]; trustedGroups: string[] },
    private readonly lookup: (accountId: string, signal: AbortSignal) => Promise<JiraGroup[]>,
    private readonly log: Pick<Logger, "warn">,
    private readonly now: () => number = Date.now,
  ) {
    this.users = new Set(cfg.trustedUsers);
    this.groups = new Set(cfg.trustedGroups.map((g) => g.toLowerCase()));
  }

  check(actor: JiraActor): Promise<TrustAnswer> {
    if (isNonHuman(actor)) return Promise.resolve(false);
    const id = actor.accountId;
    if (this.users.has(id)) return Promise.resolve(true);
    if (this.groups.size === 0) return Promise.resolve(false);
    const now = this.now();
    const known = this.answers.get(id);
    if (known && now - known.at < TRUST_TTL_MS) return Promise.resolve(known.trusted);
    const fallback: TrustAnswer =
      known && now - known.at < 2 * TRUST_TTL_MS ? known.trusted : "unresolved";
    const failed = this.failedAt.get(id);
    if (failed !== undefined && now - failed < TRUST_RETRY_MS) return Promise.resolve(fallback);
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.refresh(id, fallback).finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    return pending;
  }

  status(): TrustStatus {
    const source =
      this.groups.size === 0 ? "users" : this.users.size === 0 ? "groups" : "groups+users";
    return {
      source,
      cachedAccounts: this.answers.size,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private async refresh(id: string, fallback: TrustAnswer): Promise<TrustAnswer> {
    try {
      const groups = await withTimeout(LOOKUP_TIMEOUT_MS, (signal) => this.lookup(id, signal));
      const trusted = groups.some((g) => this.groups.has(g.name.toLowerCase()));
      this.answers.set(id, { trusted, at: this.now() });
      this.failedAt.delete(id);
      this.lastError = undefined;
      return trusted;
    } catch (err) {
      this.failedAt.set(id, this.now());
      this.lastError = errorClass(err);
      this.log.warn("jira trust lookup failed", { accountId: id, error: this.lastError });
      return fallback;
    }
  }
}

// What failed, without any upstream text: the HTTP status, "timeout", the
// network error code, or the error's name.
export function errorClass(err: unknown): string {
  if (err instanceof HttpError) return `http_${err.status}`;
  if (!(err instanceof Error)) return "unknown";
  if (err.message.startsWith("timed out after")) return "timeout";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : err.name;
}
