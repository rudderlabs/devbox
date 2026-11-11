import { errorClass, HttpError, withTimeout } from "../http";
import type { ClickUpClient } from "./client";
import type { ClickUpConfig } from "./config";

// Status calls may wait longer than the webhook's reads.
const STATUS_TIMEOUT_MS = 5_000;
// The route devbox's webhook delivers to, whatever the public URL.
const WEBHOOK_PATH = "/webhook/clickup";

export type ClickUpIntegrationStatus = {
  configured: true;
  bot: { id: number; name: string };
  team: string;
  auth: "ok" | "rejected" | "unknown";
  lastWebhookAt: string | null;
  // The webhook's health as ClickUp reports it; null when the bot has none
  // for devbox. Left out when the listing can't be read.
  webhook?: { health: string; failCount: number } | null;
  lastReplyFailure: { at: string; error: string } | null;
};

// Backs GET /api/integrations/clickup. Nothing here is a secret or upstream
// error text: failures show as a class (HTTP status, timeout, error name).
// lastWebhookAt and lastReplyFailure are in memory (this replica only), as
// for Jira.
export class ClickUpStatusService {
  private lastWebhookAt: number | null = null;
  private lastReplyFailure: { at: string; error: string } | null = null;

  constructor(
    private readonly cfg: ClickUpConfig,
    private readonly client: Pick<ClickUpClient, "user" | "webhooks">,
    private readonly now: () => number = Date.now,
  ) {}

  // A signed webhook arrived.
  recordWebhook(): void {
    this.lastWebhookAt = this.now();
  }

  // A reply part ClickUp didn't take.
  recordReplyFailure(err: unknown): void {
    this.lastReplyFailure = { at: new Date(this.now()).toISOString(), error: errorClass(err) };
  }

  async status(): Promise<ClickUpIntegrationStatus> {
    const [auth, webhook] = await Promise.all([this.auth(), this.webhook()]);
    return {
      configured: true,
      bot: { id: this.cfg.botUserId, name: this.cfg.botName },
      team: this.cfg.teamId,
      auth,
      lastWebhookAt:
        this.lastWebhookAt === null ? null : new Date(this.lastWebhookAt).toISOString(),
      ...(webhook === undefined ? {} : { webhook }),
      lastReplyFailure: this.lastReplyFailure,
    };
  }

  private async auth(): Promise<"ok" | "rejected" | "unknown"> {
    try {
      await withTimeout(STATUS_TIMEOUT_MS, (signal) => this.client.user(signal));
      return "ok";
    } catch (err) {
      return err instanceof HttpError && err.status === 401 ? "rejected" : "unknown";
    }
  }

  private async webhook(): Promise<ClickUpIntegrationStatus["webhook"]> {
    try {
      const hooks = await withTimeout(STATUS_TIMEOUT_MS, (signal) =>
        this.client.webhooks(this.cfg.teamId, signal),
      );
      const hook = hooks.find((h) => h.endpoint.endsWith(WEBHOOK_PATH));
      return hook ? { health: hook.health.status, failCount: hook.health.failCount } : null;
    } catch {
      return undefined;
    }
  }
}
