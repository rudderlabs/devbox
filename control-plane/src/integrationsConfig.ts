// Slack settings. Pure: takes the env, so it is testable without mocking
// ../config. config.ts calls it at startup; a bad combination fails boot with
// an error that names what is missing. Each integration's own settings are in
// integrations/<name>/config.ts.
import { missingError, parseSwitch, present } from "./integrations/env";

export type SlackConfig = {
  // Bot token (xoxb-…) used to post task-completion updates.
  botToken: string;
  // Channel id (C…) the updates are posted to.
  channel: string;
};

// Slack is on only with SLACK_ENABLED=true; then the token and channel are
// required.
export function parseSlackConfig(env: Record<string, string | undefined>): SlackConfig | undefined {
  if (!parseSwitch(env, "SLACK_ENABLED")) return undefined;
  const botToken = present(env, "SLACK_BOT_TOKEN");
  const channel = present(env, "SLACK_CHANNEL_ID");
  const missing: string[] = [];
  if (!botToken) missing.push("SLACK_BOT_TOKEN");
  if (!channel) missing.push("SLACK_CHANNEL_ID");
  if (!botToken || !channel) throw missingError("SLACK_ENABLED", missing);
  return { botToken, channel };
}
