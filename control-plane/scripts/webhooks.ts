// Every integration that takes webhooks at the deployment's public URL, in
// the order their lines print. A new one is a `webhook.ts` next to its setup
// and one entry here.
import { clickupWebhook } from "./clickup/webhook";
import { githubWebhook } from "./github/webhook";
import { gitlabWebhook } from "./gitlab/webhook";
import { jiraWebhook } from "./jira/webhook";
import type { Integrations } from "./lib/integrations";
import type { WebhookTarget } from "./lib/publicUrl";
import { linearWebhook } from "./linear/webhook";

export const webhooks: readonly WebhookTarget[] = [
  linearWebhook,
  githubWebhook,
  gitlabWebhook,
  jiraWebhook,
  clickupWebhook,
];

// What each integration that is on needs when the public URL changes from
// `old` to `next`. `self` is the integration whose setup changed it: its line
// is `self.line`, as that setup knows more than the config does (a new app
// already has the URL), and none when it prints its own.
export function publicUrlChangeLines(
  old: string | undefined,
  next: string,
  integrations: Integrations,
  self: { name: string; line?: string },
  flag = "",
): string[] {
  if (old === undefined || old === next) return [];
  return webhooks.flatMap((w) => {
    const line = w.name === self.name ? self.line : w.onPublicUrlChange(next, integrations, flag);
    return line === undefined ? [] : [line];
  });
}
