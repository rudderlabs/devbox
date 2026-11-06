// Jira's webhook. A Jira admin creates it by hand, so a new public URL is
// updated there by hand too.
import { enabledJira } from "../lib/integrations";
import type { WebhookTarget } from "../lib/publicUrl";

export const jiraWebhook: WebhookTarget = {
  name: "jira",
  onPublicUrlChange: (next, integrations) =>
    enabledJira(integrations)
      ? `Update the webhook URL in Jira (Settings → System → WebHooks) to ${next}/webhook/jira`
      : undefined,
};
