import { errorClass, HttpError, withTimeout } from "../http";
import type { Logger } from "../types";
import { type JiraClient, PERMISSIONS } from "./client";
import type { JiraConfig } from "./config";

// Status calls may wait longer than the webhook's reads.
const STATUS_TIMEOUT_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A token with fewer days left than this is warned about.
const TOKEN_WARN_DAYS = 14;

export type JiraIntegrationStatus = {
  configured: true;
  lastWebhookAt: string | null;
  bot: { accountId: string; name: string };
  auth: "ok" | "rejected" | "unknown";
  tokenDaysLeft: number;
  // The PERMISSIONS the bot holds in no project, or why that can't be read.
  permissions: { missing: string[] } | { error: string };
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
    private readonly client: Pick<JiraClient, "myself" | "myPermissions">,
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
    const [auth, permissions] = await Promise.all([this.auth(), this.permissions()]);
    return {
      configured: true,
      lastWebhookAt:
        this.lastWebhookAt === null ? null : new Date(this.lastWebhookAt).toISOString(),
      bot: { accountId: this.cfg.botAccountId, name: this.cfg.botName },
      auth,
      tokenDaysLeft: this.tokenDaysLeft(),
      permissions,
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

  // Asked without a project, Jira says a project permission is held when the
  // bot has it in at least one project, so a missing one is missing in all.
  private async permissions(): Promise<JiraIntegrationStatus["permissions"]> {
    try {
      const held = await withTimeout(STATUS_TIMEOUT_MS, (signal) =>
        this.client.myPermissions(PERMISSIONS, signal),
      );
      return { missing: PERMISSIONS.filter((p) => !held[p]) };
    } catch (err) {
      return { error: errorClass(err) };
    }
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
