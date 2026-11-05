// The Jira checks made with the bot's API token: the site's cloud id, the
// account the token belongs to, and per project the permissions devbox needs
// and the statuses its workflows have. Calls go through Atlassian's API
// gateway, as the control plane's do. Each failure names the cause and the
// next action; the token never appears in a message.
import { HttpError } from "../../src/integrations/http";
import { GROUPS_PERMISSION, jiraClient, PERMISSIONS } from "../../src/integrations/jira/client";
import type { EnabledJira } from "../lib/integrations";
import { checkWithRetry, offerSave, type Resolved, type ResolverDeps } from "../lib/secrets";
import { CredentialRejected, type Fetch, PreflightError } from "../up/preflight";

export class JiraCheckError extends PreflightError {}

export type JiraBot = { accountId: string; displayName: string };
export type ProjectCheck =
  | { key: string; missingPermissions: string[]; statuses: string[] }
  | { key: string; error: string };

const TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A token with fewer days left than this is warned about, as the control plane does.
export const TOKEN_WARN_DAYS = 14;
export const SCOPES = "read:jira-work, write:jira-work and read:jira-user";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GATEWAY_UNREACHABLE = "can't reach api.atlassian.com: check this machine's egress or proxy";

// GET <site>/_edge/tenant_info: the site's cloud id, which the gateway needs.
export async function cloudIdOf(siteUrl: string, fetch: Fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${siteUrl}/_edge/tenant_info`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new JiraCheckError(
      `can't reach ${siteUrl}: check the site URL and this machine's egress or proxy`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { cloudId?: unknown } | null;
  const cloudId = body?.cloudId;
  if (!res.ok || typeof cloudId !== "string" || !UUID.test(cloudId)) {
    throw new JiraCheckError(
      `${siteUrl} is not a Jira Cloud site (no cloud id at /_edge/tenant_info): check the site URL`,
    );
  }
  return cloudId;
}

// GET /myself with the token: the account it belongs to. A 401 is a
// CredentialRejected, so a saved or typed token can be asked for again. Basic
// auth is email:token, so the 401 may mean the email is wrong.
export async function checkJira(
  c: { cloudId: string; email: string },
  token: string,
  fetch: Fetch,
): Promise<JiraBot> {
  const client = jiraClient({ cloudId: c.cloudId, email: c.email, token }, fetch);
  try {
    const me = await client.myself(AbortSignal.timeout(TIMEOUT_MS));
    return { accountId: me.accountId, displayName: me.displayName || me.accountId };
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      throw new CredentialRejected(
        `Jira rejected JIRA_API_TOKEN, or the email ${c.email} doesn't match it (401): use the service account's API token, with scopes ${SCOPES}, and the service account's email`,
      );
    }
    if (err instanceof HttpError) {
      throw new JiraCheckError(`Jira check failed: GET /myself returned ${err.status}`);
    }
    if (err instanceof Error && err.message.startsWith("Jira ")) {
      throw new JiraCheckError(`Jira check failed: ${err.message}`);
    }
    throw new JiraCheckError(GATEWAY_UNREACHABLE);
  }
}

// The check before startup (`up`, `k8s:install`, `k8s:check`): the token is
// accepted and still belongs to the configured bot. `setup` is the
// deployment's jira:setup command.
export async function checkJiraBot(
  jira: Pick<EnabledJira, "cloudId" | "botEmail" | "botAccountId" | "botName">,
  token: string,
  fetch: Fetch,
  setup = "bun run jira:setup",
): Promise<JiraBot> {
  const bot = await checkJira({ cloudId: jira.cloudId, email: jira.botEmail }, token, fetch);
  if (bot.accountId !== jira.botAccountId) {
    throw new JiraCheckError(
      `JIRA_API_TOKEN belongs to ${bot.displayName} (${bot.accountId}), not the configured bot ${jira.botName} (${jira.botAccountId}): run ${setup}`,
    );
  }
  return bot;
}

export type JiraSecrets = { token: Resolved; webhook: Resolved };

// Before startup (`up`, `k8s:install`): warns when the token expires soon
// and, unless skipped, checks it (a rejected saved or typed token is asked
// for again; a saved one is kept, since a 401 may mean the email is wrong);
// then offers to save both secrets. The webhook secret can't be
// checked: only Jira uses it, to sign. Returns the secrets with the token
// that was accepted; none when the user's own Secret holds them.
export async function jiraPreflight(
  jira: EnabledJira,
  secrets: JiraSecrets | undefined,
  deps: ResolverDeps,
  opts: { skip: boolean; fetch: Fetch; now: Date; setup?: string },
): Promise<JiraSecrets | undefined> {
  const warning = tokenExpiryWarning(jira.tokenExpiresAt, opts.now, opts.setup);
  if (warning) deps.log(warning);
  if (!secrets) return undefined;
  let token = secrets.token;
  if (!opts.skip) {
    const checked = await checkWithRetry(
      token,
      deps,
      (t) => checkJiraBot(jira, t, opts.fetch, opts.setup),
      { forgetRejected: false },
    );
    token = checked.resolved;
    deps.log(`Jira: devbox acts as ${checked.result.displayName} on ${jira.siteUrl}`);
  }
  await offerSave(token, deps);
  await offerSave(secrets.webhook, deps);
  return { token, webhook: secrets.webhook };
}

// Per project, in order: the permissions the bot lacks and the status names
// its workflows have, or why they can't be read. A project the bot can't see
// answers 404.
export async function checkProjects(
  c: { cloudId: string; email: string },
  token: string,
  keys: string[],
  fetch: Fetch,
): Promise<ProjectCheck[]> {
  const client = jiraClient({ cloudId: c.cloudId, email: c.email, token }, fetch);
  return Promise.all(
    keys.map(async (key): Promise<ProjectCheck> => {
      try {
        const signal = AbortSignal.timeout(TIMEOUT_MS);
        const [held, statuses] = await Promise.all([
          client.myPermissions(key, PERMISSIONS, signal),
          client.projectStatuses(key, signal),
        ]);
        return {
          key,
          missingPermissions: PERMISSIONS.filter((p) => !held[p]),
          statuses: statuses.map((s) => s.name),
        };
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          return {
            key,
            error: "the bot can't see this project: check the key, and give the bot access to it",
          };
        }
        if (err instanceof HttpError) return { key, error: `HTTP ${err.status}` };
        return { key, error: GATEWAY_UNREACHABLE };
      }
    }),
  );
}

// Whether the bot holds Browse users and groups, the global permission that
// reading a person's groups needs: without it trust by group never resolves.
// Global permissions are asked for without a project key. A warning when it
// is missing or can't be read.
export async function checkGroupsPermission(
  c: { cloudId: string; email: string },
  token: string,
  fetch: Fetch,
): Promise<string | undefined> {
  const client = jiraClient({ cloudId: c.cloudId, email: c.email, token }, fetch);
  try {
    const held = await client.myPermissions(
      undefined,
      [GROUPS_PERMISSION],
      AbortSignal.timeout(TIMEOUT_MS),
    );
    if (held[GROUPS_PERMISSION]) return undefined;
    return `warning: the bot lacks ${permissionList([GROUPS_PERMISSION])}: ${GRANT_GROUPS_PERMISSION}`;
  } catch (err) {
    const why = err instanceof HttpError ? `HTTP ${err.status}` : GATEWAY_UNREACHABLE;
    return `warning: can't check the bot's global permission ${GROUPS_PERMISSION}: ${why}`;
  }
}

export const GRANT_GROUPS_PERMISSION =
  "grant it to a group the service account is in (Jira Settings → System → Global permissions)";

// Missing permission keys for a message, the ones whose key doesn't say it
// with what they are for. ASSIGNABLE_USER reads like ASSIGN_ISSUES (assigning
// others), which devbox doesn't need.
export const permissionList = (missing: string[]): string =>
  missing
    .map((p) =>
      p === "ASSIGNABLE_USER"
        ? `${p} (needed to assign issues to the bot)`
        : p === GROUPS_PERMISSION
          ? `${p} (the global permission Browse users and groups, needed to trust groups)`
          : p,
    )
    .join(", ");

// Whole days until the token expires (negative once it has), as the control
// plane counts them.
export const tokenDaysLeft = (expiresAt: string, now: Date): number =>
  Math.floor((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS);

// A warning when the token has expired or expires within TOKEN_WARN_DAYS;
// `setup` is the deployment's jira:setup command.
export function tokenExpiryWarning(
  expiresAt: string,
  now: Date,
  setup = "bun run jira:setup",
): string | undefined {
  const days = tokenDaysLeft(expiresAt, now);
  if (days >= TOKEN_WARN_DAYS) return undefined;
  const when = days < 0 ? `expired on ${expiresAt}` : `expires in ${days} days (${expiresAt})`;
  return `warning: the Jira API token ${when}: create a new one for the service account, then run ${setup}`;
}
