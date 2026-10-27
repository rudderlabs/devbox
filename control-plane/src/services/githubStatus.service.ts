import type { GithubTokenState } from "../clients/githubToken";

export type GithubStatus = {
  token: GithubTokenState;
  webhooks: { enabled: boolean; lastWebhookAt: string | null; ciResults: boolean };
};

export type GithubWebhookInfo = {
  enabled: boolean;
  ciResults: boolean;
  lastWebhookAt: () => string | null;
};

// Backs GET /api/integrations/github. Nothing here is a secret:
// token state carries timestamps and the provider's last read error only.
export class GithubStatusService {
  constructor(
    private readonly tokenState: () => GithubTokenState,
    private readonly webhooks: GithubWebhookInfo,
  ) {}

  status(): GithubStatus {
    const { enabled, ciResults, lastWebhookAt } = this.webhooks;
    return {
      token: this.tokenState(),
      webhooks: enabled
        ? { enabled: true, lastWebhookAt: lastWebhookAt(), ciResults }
        : { enabled: false, lastWebhookAt: null, ciResults: false },
    };
  }
}
