import { errorClass, HttpError, withTimeout } from "../http";
import type { Logger } from "../types";
import { type JiraClient, PERMISSIONS } from "./client";
import type { JiraConfig } from "./config";

// Status calls may wait longer than the webhook's reads.
const STATUS_TIMEOUT_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A token with fewer days left than this is warned about.
const TOKEN_WARN_DAYS = 14;

type ProjectHealth =
  | { missingPermissions: string[]; missingStatuses: string[] }
  | { error: string };

export type JiraIntegrationStatus = {
  configured: true;
  lastWebhookAt: string | null;
  bot: { accountId: string; name: string };
  auth: "ok" | "rejected" | "unknown";
  tokenDaysLeft: number;
  projects: Record<string, ProjectHealth>;
  lastReplyFailure: { status: number | null; at: string } | null; // status null: no HTTP answer
};

// Backs GET /api/integrations/jira. Nothing here is a secret or upstream
// error text: failures show as a class (HTTP status, timeout, error name).
// lastWebhookAt and lastReplyFailure are in memory (this replica only), as
// for Linear and GitHub. The token warning is checked lazily, on webhooks and
// status calls, with no timer.
export class JiraStatusService {
  private lastWebhookAt: number | null = null;
  private lastReplyFailure: { status: number | null; at: string } | null = null;
  private tokenWarnedAt: number | null = null;

  constructor(
    private readonly cfg: JiraConfig,
    private readonly client: Pick<JiraClient, "myself" | "myPermissions" | "projectStatuses">,
    private readonly log: Pick<Logger, "warn">,
    private readonly now: () => number = Date.now,
  ) {}

  // A signed webhook arrived.
  recordWebhook(): void {
    this.lastWebhookAt = this.now();
    this.warnIfTokenExpiring();
  }

  // A reply part Jira didn't take; `err` an HttpError or anything else
  // (no HTTP answer).
  recordReplyFailure(err: unknown): void {
    this.lastReplyFailure = {
      status: err instanceof HttpError ? err.status : null,
      at: new Date(this.now()).toISOString(),
    };
  }

  async status(): Promise<JiraIntegrationStatus> {
    this.warnIfTokenExpiring();
    const [auth, projects] = await Promise.all([this.auth(), this.projects()]);
    return {
      configured: true,
      lastWebhookAt:
        this.lastWebhookAt === null ? null : new Date(this.lastWebhookAt).toISOString(),
      bot: { accountId: this.cfg.botAccountId, name: this.cfg.botName },
      auth,
      tokenDaysLeft: this.tokenDaysLeft(),
      projects,
      lastReplyFailure: this.lastReplyFailure,
    };
  }

  private async auth(): Promise<"ok" | "rejected" | "unknown"> {
    try {
      await withTimeout(STATUS_TIMEOUT_MS, (signal) => this.client.myself(signal));
      return "ok";
    } catch (err) {
      return err instanceof HttpError && err.status === 401 ? "rejected" : "unknown";
    }
  }

  // Per project: the permissions the bot lacks, and the configured status
  // names the project's workflows don't have (compared in any case).
  private async projects(): Promise<Record<string, ProjectHealth>> {
    const { statuses } = this.cfg;
    const wanted = [statuses.started, statuses.done, statuses.failed].filter(
      (s): s is string => s !== undefined,
    );
    const health = async (key: string): Promise<ProjectHealth> => {
      try {
        const [held, available] = await withTimeout(STATUS_TIMEOUT_MS, (signal) =>
          Promise.all([
            this.client.myPermissions(key, PERMISSIONS, signal),
            this.client.projectStatuses(key, signal),
          ]),
        );
        const names = new Set(available.map((s) => s.name.toLowerCase()));
        return {
          missingPermissions: PERMISSIONS.filter((p) => !held[p]),
          missingStatuses: wanted.filter((s) => !names.has(s.toLowerCase())),
        };
      } catch (err) {
        return { error: errorClass(err) };
      }
    };
    const keys = this.cfg.projectKeys;
    const results = await Promise.all(keys.map(health));
    return Object.fromEntries(keys.map((key, i) => [key, results[i] as ProjectHealth]));
  }

  private tokenDaysLeft(): number {
    return Math.floor((this.cfg.tokenExpiresAt.getTime() - this.now()) / DAY_MS);
  }

  // At most once a day per replica.
  private warnIfTokenExpiring(): void {
    const daysLeft = this.tokenDaysLeft();
    if (daysLeft >= TOKEN_WARN_DAYS) return;
    const now = this.now();
    if (this.tokenWarnedAt !== null && now - this.tokenWarnedAt < DAY_MS) return;
    this.tokenWarnedAt = now;
    this.log.warn(
      "Jira API token expires soon: rotate it, then update JIRA_API_TOKEN and JIRA_TOKEN_EXPIRES_AT",
      { daysLeft },
    );
  }
}
