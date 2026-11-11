// The ClickUp calls made with the bot's personal API token: whose token it
// is, the workspaces it is in, and the workspace's webhooks. Each failure
// names the cause and the next action; the token never appears in a message,
// and neither does ClickUp's answer, which may echo a webhook secret.
import type { EnabledClickup } from "../lib/integrations";
import { checkWithRetry, offerSave, type Resolved, type ResolverDeps } from "../lib/secrets";
import { CredentialRejected, type Fetch, PreflightError } from "../up/preflight";

export class ClickupCheckError extends PreflightError {}

export const CLICKUP_API = "https://api.clickup.com/api/v2";
export const WEBHOOK_PATH = "/webhook/clickup";
// Exactly what the control plane handles: assignments and comments.
export const EVENTS = ["taskAssigneeUpdated", "taskCommentPosted"];
export const TOKEN_LABEL = "ClickUp API token of the bot (pk_…)";

const TIMEOUT_MS = 10_000;
const UNREACHABLE = "can't reach api.clickup.com: check this machine's egress or proxy";

export type ClickupBot = { id: number; username: string };
// 1 owner, 2 admin, 3 member, 4 guest.
export type ClickupTeam = {
  id: string;
  name: string;
  members: { user: { id: number; role?: number | null } }[];
};
export type ClickupWebhook = {
  id: string;
  endpoint: string;
  secret?: string;
  health?: { status?: string; fail_count?: number };
};

// One call with the token. A 401 is a CredentialRejected, so a saved or typed
// token can be asked for again.
export async function clickupCall<T>(
  token: string,
  fetch: Fetch,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CLICKUP_API}${path}`, {
      method,
      headers: {
        Authorization: token,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ClickupCheckError(UNREACHABLE);
  }
  if (res.status === 401) {
    await res.body?.cancel();
    throw new CredentialRejected(
      "ClickUp rejected CLICKUP_API_TOKEN (401): use the bot's personal API token (pk_…), from ClickUp's Settings → Apps while signed in as the bot",
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ClickupCheckError(`ClickUp ${method} ${path} returned ${res.status}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}

// GET /user: the account the token belongs to.
export async function checkClickup(token: string, fetch: Fetch): Promise<ClickupBot> {
  const body = await clickupCall<{ user?: { id?: unknown; username?: unknown } }>(
    token,
    fetch,
    "GET",
    "/user",
  );
  const { id, username } = body.user ?? {};
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new ClickupCheckError("ClickUp GET /user returned no user id");
  }
  return { id, username: typeof username === "string" && username ? username : String(id) };
}

// GET /team: the workspaces the bot is in, with their members' roles.
export async function teamsOf(token: string, fetch: Fetch): Promise<ClickupTeam[]> {
  const body = await clickupCall<{ teams?: ClickupTeam[] }>(token, fetch, "GET", "/team");
  return Array.isArray(body.teams) ? body.teams : [];
}

// GET /team/{id}/webhook: the webhooks the token's user created there.
export async function webhooksOf(
  token: string,
  teamId: string,
  fetch: Fetch,
): Promise<ClickupWebhook[]> {
  const body = await clickupCall<{ webhooks?: ClickupWebhook[] }>(
    token,
    fetch,
    "GET",
    `/team/${teamId}/webhook`,
  );
  return Array.isArray(body.webhooks) ? body.webhooks : [];
}

// A webhook devbox made: one at any public URL's /webhook/clickup.
export const isDevboxWebhook = (h: ClickupWebhook): boolean =>
  typeof h.endpoint === "string" && h.endpoint.endsWith(WEBHOOK_PATH);

// The check before startup (`up`, `k8s:install`, `k8s:check`): the token is
// accepted and still belongs to the configured bot. `setup` is the
// deployment's clickup:setup command.
export async function checkClickupBot(
  clickup: Pick<EnabledClickup, "botUserId" | "botName">,
  token: string,
  fetch: Fetch,
  setup = "bun run clickup:setup",
): Promise<ClickupBot> {
  const bot = await checkClickup(token, fetch);
  if (bot.id !== clickup.botUserId) {
    throw new ClickupCheckError(
      `CLICKUP_API_TOKEN belongs to ${bot.username} (user ${bot.id}), not the configured bot ${clickup.botName} (user ${clickup.botUserId}): run ${setup}`,
    );
  }
  return bot;
}

export type ClickupSecrets = { token: Resolved; webhook: Resolved };

// Before startup (`up`, `k8s:install`): unless skipped, checks the token (a
// rejected saved or typed token is asked for again; a saved one is kept);
// then offers to save both secrets. The webhook secret can't be checked: only
// ClickUp uses it, to sign. Returns the secrets with the token that was
// accepted; none when the user's own Secret holds them.
export async function clickupPreflight(
  clickup: EnabledClickup,
  secrets: ClickupSecrets | undefined,
  deps: ResolverDeps,
  opts: { skip: boolean; fetch: Fetch; setup?: string },
): Promise<ClickupSecrets | undefined> {
  if (!secrets) return undefined;
  let token = secrets.token;
  if (!opts.skip) {
    const checked = await checkWithRetry(
      token,
      deps,
      (t) => checkClickupBot(clickup, t, opts.fetch, opts.setup),
      { forgetRejected: false, label: TOKEN_LABEL },
    );
    token = checked.resolved;
    deps.log(`ClickUp: devbox acts as ${checked.result.username} in workspace ${clickup.teamId}`);
  }
  await offerSave(token, deps);
  await offerSave(secrets.webhook, deps);
  return { token, webhook: secrets.webhook };
}
