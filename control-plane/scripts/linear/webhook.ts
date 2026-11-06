// Linear's webhook. Its URL is stored in the Linear app, so a new public URL
// is updated there by hand.
import { enabledLinear } from "../lib/integrations";
import type { WebhookTarget } from "../lib/publicUrl";

export const linearWebhookLine = (publicUrl: string): string =>
  `Update the webhook URL in the Linear app to ${publicUrl}/webhook/linear`;

export const linearWebhook: WebhookTarget = {
  name: "linear",
  onPublicUrlChange: (next, integrations) =>
    enabledLinear(integrations) ? linearWebhookLine(next) : undefined,
};
