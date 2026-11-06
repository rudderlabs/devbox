import { missingError, optionalNumber, parseSwitch, parseTrustList, present } from "../env";

// GitHub's webhook settings. GitHub is on exactly when its webhooks are.
export type GithubConfig = {
  // HMAC secret for /webhook/github (x-hub-signature-256).
  secret: string;
  // Login of the GitHub App / bot account. Used for @-mentions and to skip the
  // controller's own events.
  botLogin: string;
  // Numeric user id of the bot. Used by the workflow_run trust exemption.
  botUserId: number;
  // Orgs whose members, and logins of users, whose comments the agent trusts.
  trustedOrgs: string[];
  trustedUsers: string[];
  // Feature flag: enable workflow_run CI result inbox enqueue. Disabled by
  // default until the harness is ready to consume ci_result inbox rows.
  ciResultEnabled: boolean;
  // Loop breaker: max ci_result ROWS we forward to the harness per task.
  // harness fixes CI → pushes → CI re-runs → can fail again → fix → … a
  // runaway burns sandbox time and Linear noise. Once a task has this many
  // ci_result rows, further CI failures are dropped at enqueue. NOTE: the unit
  // is failed-workflow_run rows, NOT fix-cycles — a push that fails N parallel
  // CI workflows writes N rows, so on a multi-workflow repo the cap is reached
  // in ~max/N pushes. Size it with your workflow fan-out in mind. Configurable;
  // an explicit 0 (or negative) disables the breaker.
  ciResultMaxPerTask: number;
};

// Undefined unless GITHUB_WEBHOOKS_ENABLED=true; then the secret, bot and
// trust settings are required. GITHUB_CI_RESULT_MAX_PER_TASK is checked with
// webhooks off too, so a bad value fails boot either way.
export function parseGithubConfig(
  env: Record<string, string | undefined>,
): GithubConfig | undefined {
  const webhooks = parseSwitch(env, "GITHUB_WEBHOOKS_ENABLED") ? parseWebhooks(env) : undefined;
  const ciResultMaxPerTask = optionalNumber(env, "GITHUB_CI_RESULT_MAX_PER_TASK", 20);
  if (!webhooks) return undefined;
  return {
    ...webhooks,
    ciResultEnabled: env.GITHUB_CI_RESULT_ENABLED === "true",
    ciResultMaxPerTask,
  };
}

function parseWebhooks(env: Record<string, string | undefined>) {
  const trustedOrgs = parseTrustList(env.GITHUB_TRUSTED_ORGS);
  const trustedUsers = parseTrustList(env.GITHUB_TRUSTED_USERS);
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
    secret: secret as string,
    botLogin: botLogin as string,
    botUserId,
    trustedOrgs,
    trustedUsers,
  };
}
