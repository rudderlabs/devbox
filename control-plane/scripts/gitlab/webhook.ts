// GitLab's webhooks: one per project, pointing at <publicUrl>/webhook/gitlab.
// gitlab:setup creates a webhook for the URL it is given and leaves one with
// another URL alone, so a new public URL is changed on each project's webhook.
import { enabledGitlab } from "../lib/integrations";
import type { WebhookTarget } from "../lib/publicUrl";

export const gitlabWebhook: WebhookTarget = {
  name: "gitlab",
  onPublicUrlChange: (next, integrations) =>
    enabledGitlab(integrations)
      ? `Update the URL of the devbox webhook on each GitLab project (Settings → Webhooks) to ${next}/webhook/gitlab`
      : undefined,
};
