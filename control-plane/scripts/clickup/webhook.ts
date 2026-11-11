// ClickUp's webhook. clickup:setup creates and updates it through ClickUp's
// API with the bot's token, so a new public URL is a setup re-run.
import { enabledClickup } from "../lib/integrations";
import type { WebhookTarget } from "../lib/publicUrl";

export const clickupWebhook: WebhookTarget = {
  name: "clickup",
  onPublicUrlChange: (_next, integrations, flag) =>
    enabledClickup(integrations)
      ? `Run bun run clickup:setup${flag} to update the ClickUp webhook's URL`
      : undefined,
};
