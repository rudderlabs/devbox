import { errorClass, HttpError, withTimeout } from "../http";
import { type JiraClient, PERMISSIONS } from "./client";
import type { JiraConfig } from "./config";

// Status calls may wait longer than the webhook's reads.
const STATUS_TIMEOUT_MS = 5_000;

export type JiraIntegrationStatus = {
  configured: true;
  lastWebhookAt: string | null;
  bot: { accountId: string; name: string };
  auth: "ok" | "rejected" | "unknown";
  // The PERMISSIONS the bot holds in no project, or why that can't be read.
  permissions: { missing: string[] } | { error: string };
  lastReplyFailure: { status: number | null; at: string } | null; // status null: no HTTP answer
};

// Backs GET /api/integrations/jira. Nothing here is a secret or upstream
// error text: failures show as a class (HTTP status, timeout, error name).
// lastWebhookAt and lastReplyFailure are in memory (this replica only), as
// for Linear and GitHub.
export class JiraStatusService {
  private lastWebhookAt: number | null = null;
  private lastReplyFailure: { status: number | null; at: string } | null = null;

  constructor(
    private readonly cfg: JiraConfig,
    private readonly client: Pick<JiraClient, "myself" | "myPermissions">,
    private readonly now: () => number = Date.now,
  ) {}

  // A signed webhook arrived.
  recordWebhook(): void {
    this.lastWebhookAt = this.now();
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
    const [auth, permissions] = await Promise.all([this.auth(), this.permissions()]);
    return {
      configured: true,
      lastWebhookAt:
        this.lastWebhookAt === null ? null : new Date(this.lastWebhookAt).toISOString(),
      bot: { accountId: this.cfg.botAccountId, name: this.cfg.botName },
      auth,
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
}
