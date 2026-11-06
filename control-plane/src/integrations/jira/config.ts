import { missingError, parseSwitch, parseTrustList, present } from "../env";

export type JiraConfig = {
  // https://<site>.atlassian.net: where people open issues (task URLs).
  siteUrl: string;
  // The site's cloud id (a UUID). API calls go through Atlassian's gateway for
  // it, since the site URL rejects a service account's scoped token.
  cloudId: string;
  // The bot account: its email (Basic auth with the token), immutable account
  // id (to spot assignments, mentions and its own events) and display name
  // (people type "@<name>" as a mention, and failure notices name it).
  botEmail: string;
  botAccountId: string;
  botName: string;
  // Upper-case project keys whose issues devbox acts on.
  projectKeys: string[];
  // Status names devbox moves an issue to; an absent one means no transition.
  statuses: { started?: string; done?: string; failed?: string };
  // When the API token expires (Atlassian tokens last at most a year).
  tokenExpiresAt: Date;
  // Act on issues restricted by a security level too (default no).
  allowRestrictedIssues: boolean;
  apiToken: string;
  // HMAC secret for /webhook/jira (X-Hub-Signature).
  webhookSecret: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The shapes the Jira module accepts in payloads and URLs.
const JIRA_ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\S*)?$/;

// Jira is on only with JIRA_ENABLED=true; then every setting read with need()
// is required, and each value is checked. JIRA_STATUS_STARTED,
// JIRA_STATUS_DONE and JIRA_STATUS_FAILED are optional. With the switch off
// the settings are ignored. Errors never echo a secret, an email or an
// account id. No JIRA_* name is forwarded to sandboxes.
export function parseJiraConfig(env: Record<string, string | undefined>): JiraConfig | undefined {
  if (!parseSwitch(env, "JIRA_ENABLED")) return undefined;
  const missing: string[] = [];
  const need = (name: string): string => {
    const value = present(env, name);
    if (value === undefined) missing.push(name);
    return value ?? "";
  };
  const siteUrl = need("JIRA_SITE_URL");
  const cloudId = need("JIRA_CLOUD_ID");
  const botEmail = need("JIRA_BOT_EMAIL");
  const botAccountId = need("JIRA_BOT_ACCOUNT_ID");
  const botName = need("JIRA_BOT_NAME");
  // A list of only separators (",") names no project, which would ignore every event.
  const projectKeys = parseTrustList(env.JIRA_PROJECT_KEYS).map((k) => k.toUpperCase());
  if (projectKeys.length === 0) missing.push("JIRA_PROJECT_KEYS");
  const expiresAt = need("JIRA_TOKEN_EXPIRES_AT");
  const apiToken = need("JIRA_API_TOKEN");
  const webhookSecret = need("JIRA_WEBHOOK_SECRET");
  if (missing.length > 0) throw missingError("JIRA_ENABLED", missing);

  if (!UUID.test(cloudId)) throw new Error("JIRA_CLOUD_ID must be a UUID");
  if (!JIRA_ACCOUNT_ID.test(botAccountId)) {
    throw new Error("JIRA_BOT_ACCOUNT_ID is not a Jira account id");
  }
  const badKey = projectKeys.find((k) => !JIRA_PROJECT_KEY.test(k));
  if (badKey !== undefined) {
    throw new Error(`JIRA_PROJECT_KEYS: "${badKey}" is not a Jira project key`);
  }
  const tokenExpiresAt = new Date(expiresAt);
  if (!ISO_DATE.test(expiresAt) || Number.isNaN(tokenExpiresAt.getTime())) {
    throw new Error("JIRA_TOKEN_EXPIRES_AT must be an ISO date such as 2027-01-31");
  }
  return {
    siteUrl: jiraSiteOrigin(siteUrl),
    cloudId,
    botEmail,
    botAccountId,
    botName,
    projectKeys,
    statuses: {
      started: present(env, "JIRA_STATUS_STARTED"),
      done: present(env, "JIRA_STATUS_DONE"),
      failed: present(env, "JIRA_STATUS_FAILED"),
    },
    tokenExpiresAt,
    allowRestrictedIssues: parseSwitch(env, "JIRA_ALLOW_RESTRICTED_ISSUES"),
    apiToken,
    webhookSecret,
  };
}

// The site as a bare https origin, so task URLs are always
// <origin>/browse/<key>. A trailing slash is fine; a path, query or
// credentials are not.
function jiraSiteOrigin(raw: string): string {
  const url = URL.parse(raw);
  if (
    url?.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("JIRA_SITE_URL must be an https origin such as https://example.atlassian.net");
  }
  return url.origin;
}
