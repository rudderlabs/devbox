// The GitHub App's webhook. The App stores its URL: with devbox-minted tokens
// github:setup holds the App's key and updates it; otherwise it is updated by
// hand on the App's settings page.
import { appSettingsUrl } from "../lib/githubApp";
import { enabledGithubApp } from "../lib/integrations";
import type { WebhookTarget } from "../lib/publicUrl";

// org: the organization that owns the App, when one does (its settings page
// is there).
export const githubByHandLine = (publicUrl: string, slug: string, org?: string): string =>
  `Update the webhook URL in the GitHub App to ${publicUrl}/webhook/github: ${appSettingsUrl(slug, org ? { login: org, type: "Organization" } : undefined)}`;

export const githubWebhook: WebhookTarget = {
  name: "github",
  onPublicUrlChange: (next, integrations, flag) => {
    const app = enabledGithubApp(integrations);
    if (!app) return undefined;
    return app.tokens === "devbox"
      ? `Run bun run github:setup${flag} to update the GitHub App's webhook URL`
      : githubByHandLine(next, app.slug, app.org);
  },
};
