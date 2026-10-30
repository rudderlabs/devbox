// Linear, Slack, and GitHub settings. Pure: takes the env, so it is
// testable without mocking ../config. config.ts calls these at startup; a bad
// combination fails boot with an error that names what is missing.

import { taskSource } from "./db/schema";
import type { TaskSource } from "./integrations/types";

export type LinearConfig = {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
};

export type SlackConfig = {
  // Bot token (xoxb-…) used to post task-completion updates.
  botToken: string;
  // Channel id (C…) the updates are posted to.
  channel: string;
  // The task sources whose tasks post (SLACK_NOTIFY_SOURCES; default linear).
  notifySources: TaskSource[];
};

export type GithubWebhooksConfig = {
  // HMAC secret for /webhook/github (x-hub-signature-256).
  secret: string;
  // Login of the GitHub App / bot account. Used for @-mentions and to skip the
  // controller's own events.
  botLogin: string;
  // Numeric user id of the bot. Used by the workflow_run trust exemption.
  botUserId: number;
  trustedOrgs: string[];
  trustedUsers: string[];
};

export type GithubIntegrationConfig = {
  // Defined only when GITHUB_WEBHOOKS_ENABLED=true.
  webhooks: GithubWebhooksConfig | undefined;
  // Orgs whose members, and logins of users, whose comments the agent trusts.
  // Parsed whether or not webhooks are on: both lists are forwarded to the
  // sandbox for PR-discussion trust.
  trustedOrgs: string[];
  trustedUsers: string[];
};

type Env = Record<string, string | undefined>;

function present(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

// Comma- or whitespace-separated list. Empty or unset yields [].
export function parseTrustList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[\s,]+/).filter(Boolean);
}

type SwitchName = "LINEAR_ENABLED" | "SLACK_ENABLED" | "GITHUB_WEBHOOKS_ENABLED";

// Each integration has an explicit switch. Exactly "true" turns it
// on; unset, empty or "false" is off; anything else fails startup. Switch
// values are not secrets, so the error echoes the raw value.
export function parseSwitch(env: Env, name: SwitchName): boolean {
  const raw = present(env, name);
  if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

function missingError(name: SwitchName, missing: string[]): Error {
  return new Error(`${name} is true but these are missing: ${missing.join(", ")}`);
}

const LINEAR_NAMES = ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"] as const;

// Linear is on only with LINEAR_ENABLED=true; then all three settings are
// required. With the switch off the settings are ignored. The old
// LINEAR_REDIRECT_URI is no longer read and is ignored.
export function parseLinearConfig(env: Env): LinearConfig | undefined {
  if (!parseSwitch(env, "LINEAR_ENABLED")) return undefined;
  const values = LINEAR_NAMES.map((name) => present(env, name));
  const missing = LINEAR_NAMES.filter((_, i) => values[i] === undefined);
  if (missing.length > 0) throw missingError("LINEAR_ENABLED", missing);
  const [clientId, clientSecret, webhookSecret] = values as [string, string, string];
  return { clientId, clientSecret, webhookSecret };
}

// Slack is on only with SLACK_ENABLED=true; then the token and channel are
// required. SLACK_NOTIFY_SOURCES lists the task sources that post (comma- or
// whitespace-separated, default linear); an unknown source fails startup.
export function parseSlackConfig(env: Env): SlackConfig | undefined {
  if (!parseSwitch(env, "SLACK_ENABLED")) return undefined;
  const botToken = present(env, "SLACK_BOT_TOKEN");
  const channel = present(env, "SLACK_CHANNEL_ID");
  const missing: string[] = [];
  if (!botToken) missing.push("SLACK_BOT_TOKEN");
  if (!channel) missing.push("SLACK_CHANNEL_ID");
  if (!botToken || !channel) throw missingError("SLACK_ENABLED", missing);
  const sources = parseTrustList(env.SLACK_NOTIFY_SOURCES);
  const known: readonly string[] = taskSource.enumValues;
  const unknown = sources.find((s) => !known.includes(s));
  if (unknown !== undefined) {
    throw new Error(
      `SLACK_NOTIFY_SOURCES: unknown task source "${unknown}" (allowed: ${known.join(", ")})`,
    );
  }
  const notifySources: TaskSource[] = sources.length > 0 ? (sources as TaskSource[]) : ["linear"];
  return { botToken, channel, notifySources };
}

export function parseGithubConfig(env: Env): GithubIntegrationConfig {
  const trustedOrgs = parseTrustList(env.GITHUB_TRUSTED_ORGS);
  const trustedUsers = parseTrustList(env.GITHUB_TRUSTED_USERS);
  if (!parseSwitch(env, "GITHUB_WEBHOOKS_ENABLED")) {
    return { webhooks: undefined, trustedOrgs, trustedUsers };
  }

  const secret = present(env, "GITHUB_WEBHOOK_SECRET");
  const botLogin = present(env, "GITHUB_BOT_LOGIN");
  const rawBotUserId = present(env, "GITHUB_BOT_USER_ID");
  const missing: string[] = [];
  if (!secret) missing.push("GITHUB_WEBHOOK_SECRET");
  if (!botLogin) missing.push("GITHUB_BOT_LOGIN");
  if (!rawBotUserId) missing.push("GITHUB_BOT_USER_ID");
  if (trustedOrgs.length === 0 && trustedUsers.length === 0) {
    missing.push("GITHUB_TRUSTED_ORGS or GITHUB_TRUSTED_USERS");
  }
  if (missing.length > 0) throw missingError("GITHUB_WEBHOOKS_ENABLED", missing);
  const botUserId = Number(rawBotUserId);
  if (!Number.isFinite(botUserId)) throw new Error("GITHUB_BOT_USER_ID must be a number");
  return {
    webhooks: {
      secret: secret as string,
      botLogin: botLogin as string,
      botUserId,
      trustedOrgs,
      trustedUsers,
    },
    trustedOrgs,
    trustedUsers,
  };
}
