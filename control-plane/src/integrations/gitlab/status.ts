import type { GitlabTokenState } from "./token";

export type GitlabStatus = {
  token: GitlabTokenState;
  webhooks: { enabled: boolean; lastWebhookAt: string | null; ciResults: boolean };
};

export type GitlabWebhookInfo = {
  enabled: boolean;
  ciResults: boolean;
  lastWebhookAt: () => string | null;
};

// Backs GET /api/integrations/gitlab. Nothing here is a secret: token state
// carries timestamps and the provider's last read error only.
export class GitlabStatusService {
  constructor(
    private readonly tokenState: () => GitlabTokenState,
    private readonly webhooks: GitlabWebhookInfo,
  ) {}

  status(): GitlabStatus {
    const { enabled, ciResults, lastWebhookAt } = this.webhooks;
    return {
      token: this.tokenState(),
      webhooks: enabled
        ? { enabled: true, lastWebhookAt: lastWebhookAt(), ciResults }
        : { enabled: false, lastWebhookAt: null, ciResults: false },
    };
  }
}
