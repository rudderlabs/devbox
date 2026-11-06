import type { Logger } from "../types";
import type { LinearTokenProvider } from "./tokenProvider";

export type LinearStatus = {
  configured: true;
  workspace: { id: string; name: string; urlKey: string } | null;
  appUser: { id: string; name: string } | null;
  lastWebhookAt: string | null;
  lastTokenError: string | null;
};

type Identity = {
  workspace: { id: string; name: string; urlKey: string };
  appUser: { id: string; name: string };
};

type IdentityData = {
  viewer: { id: string; name: string };
  organization: { id: string; name: string; urlKey: string };
};

const IDENTITY_QUERY = "query { viewer { id name } organization { id name urlKey } }";

// Backs GET /api/integrations/linear. The workspace and app user are
// fetched once and cached for the process; a failed query leaves them null and
// is retried on the next call. lastWebhookAt is in memory (this replica only).
export class LinearStatusService {
  private identity: Identity | null = null;
  private lastWebhookAt: Date | null = null;

  constructor(
    private readonly provider: Pick<
      LinearTokenProvider,
      "getAuthorizedLinearClient" | "lastTokenError"
    >,
    private readonly log?: Pick<Logger, "warn">,
  ) {}

  recordWebhook(at: Date): void {
    this.lastWebhookAt = at;
  }

  async status(): Promise<LinearStatus> {
    if (!this.identity) this.identity = await this.fetchIdentity();
    return {
      configured: true,
      workspace: this.identity?.workspace ?? null,
      appUser: this.identity?.appUser ?? null,
      lastWebhookAt: this.lastWebhookAt?.toISOString() ?? null,
      lastTokenError: this.provider.lastTokenError,
    };
  }

  private async fetchIdentity(): Promise<Identity | null> {
    try {
      const client = await this.provider.getAuthorizedLinearClient();
      const { data } = await client.client.rawRequest<IdentityData, Record<string, never>>(
        IDENTITY_QUERY,
      );
      if (!data) return null;
      const { viewer, organization } = data;
      return {
        workspace: { id: organization.id, name: organization.name, urlKey: organization.urlKey },
        appUser: { id: viewer.id, name: viewer.name },
      };
    } catch (err) {
      // Message only: never the token. Token problems also show in lastTokenError.
      this.log?.warn("linear identity query failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
