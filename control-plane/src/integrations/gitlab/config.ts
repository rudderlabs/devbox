import { missingError, optionalNumber, parseSwitch, parseTrustList, present } from "../env";

// GitLab's webhook settings. GitLab is on exactly when its webhooks are.
export type GitlabConfig = {
  // The webhook's signing token (`whsec_…`, GitLab 19.0+): deliveries carry
  // a Standard Webhooks signature made with it.
  signingToken: string | undefined;
  // The legacy secret token, compared with X-Gitlab-Token. Accepted on a
  // delivery without a signature only when it is configured.
  secretToken: string | undefined;
  // The user the GitLab token belongs to (a group or project access token's
  // bot user). Its own notes are skipped; its pipelines are the ones wanted.
  botUserId: number;
  // Its username: `@<username>` is the trigger.
  botUsername: string;
  // Groups whose members, and usernames of users, whose notes the agent trusts.
  trustedGroups: string[];
  trustedUsers: string[];
  // Whether a failed pipeline on a task's merge request becomes a round.
  ciResultEnabled: boolean;
  // Loop breaker: the most ci_result rounds GitLab queues per task. The agent
  // fixes CI, pushes, CI runs again and can fail again; once a task has this
  // many, further failures are dropped. 0 or negative: no cap.
  ciResultMaxPerTask: number;
};

// Undefined unless GITLAB_WEBHOOKS_ENABLED=true; then GITLAB_BASE_URL
// (sandboxConfig.ts validates it), the bot identity, a trust list and one of
// the two webhook tokens are required. GITLAB_CI_RESULT_MAX_PER_TASK is checked
// with webhooks off too, so a bad value fails boot either way.
export function parseGitlabConfig(
  env: Record<string, string | undefined>,
): GitlabConfig | undefined {
  const webhooks = parseSwitch(env, "GITLAB_WEBHOOKS_ENABLED") ? parseWebhooks(env) : undefined;
  const ciResultMaxPerTask = optionalNumber(env, "GITLAB_CI_RESULT_MAX_PER_TASK", 20);
  if (!webhooks) return undefined;
  return {
    ...webhooks,
    ciResultEnabled: env.GITLAB_CI_RESULT_ENABLED === "true",
    ciResultMaxPerTask,
  };
}

function parseWebhooks(env: Record<string, string | undefined>) {
  const trustedGroups = parseTrustList(env.GITLAB_TRUSTED_GROUPS);
  const trustedUsers = parseTrustList(env.GITLAB_TRUSTED_USERS);
  const signingToken = present(env, "GITLAB_WEBHOOK_SIGNING_TOKEN");
  const secretToken = present(env, "GITLAB_WEBHOOK_SECRET");
  const botUsername = present(env, "GITLAB_BOT_USERNAME");
  const rawBotUserId = present(env, "GITLAB_BOT_USER_ID");
  const missing: string[] = [];
  if (!present(env, "GITLAB_BASE_URL")) missing.push("GITLAB_BASE_URL");
  if (!signingToken && !secretToken) {
    missing.push("GITLAB_WEBHOOK_SIGNING_TOKEN or GITLAB_WEBHOOK_SECRET");
  }
  if (!botUsername) missing.push("GITLAB_BOT_USERNAME");
  if (!rawBotUserId) missing.push("GITLAB_BOT_USER_ID");
  if (trustedGroups.length === 0 && trustedUsers.length === 0) {
    missing.push("GITLAB_TRUSTED_GROUPS or GITLAB_TRUSTED_USERS");
  }
  if (missing.length > 0) throw missingError("GITLAB_WEBHOOKS_ENABLED", missing);
  if (signingToken && !signingToken.startsWith("whsec_")) {
    throw new Error("GITLAB_WEBHOOK_SIGNING_TOKEN must start with whsec_");
  }
  const botUserId = Number(rawBotUserId);
  if (!Number.isFinite(botUserId) || botUserId <= 0) {
    throw new Error("GITLAB_BOT_USER_ID must be a positive number");
  }
  return {
    signingToken,
    secretToken,
    botUsername: botUsername as string,
    botUserId,
    trustedGroups,
    trustedUsers,
  };
}
