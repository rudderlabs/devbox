import type { logger } from "../logger";
import type { LinearTokenProvider } from "./linearTokenProvider";

export type LinearStatus =
  | { configured: false }
  | {
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
    private readonly provider:
      | Pick<LinearTokenProvider, "getAuthorizedLinearClient" | "lastTokenError">
      | undefined,
    private readonly log?: Pick<typeof logger, "warn">,
  ) {}

  recordWebhook(at: Date): void {
    this.lastWebhookAt = at;
  }

  async status(): Promise<LinearStatus> {
    const provider = this.provider;
    if (!provider) return { configured: false };
    if (!this.identity) this.identity = await this.fetchIdentity(provider);
    return {
      configured: true,
      workspace: this.identity?.workspace ?? null,
      appUser: this.identity?.appUser ?? null,
      lastWebhookAt: this.lastWebhookAt?.toISOString() ?? null,
      lastTokenError: provider.lastTokenError,
    };
  }

  private async fetchIdentity(
    provider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">,
  ): Promise<Identity | null> {
    try {
      const client = await provider.getAuthorizedLinearClient();
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
