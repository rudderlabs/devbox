// `bun run jira:status`: what is configured, where each secret would come
// from, what the running control plane reports (the token, trust, each
// project, failed and held replies) and whether the webhook URL reaches it.
// Read-only, never prompts, never prints a secret value; a control plane or
// URL that cannot be reached is reported, not a failure.
import { deploymentScope } from "../lib/keychain";
import { errorMessage } from "../lib/knownError";
import { probeWebhook } from "../lib/probe";
import { type PeekDeps, peekSecret } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import { GRANT_GROUPS_PERMISSION, permissionList, TOKEN_WARN_DAYS } from "./check";
import type { JiraDeployment } from "./deployment";

export const STATUS_PATH = "/api/integrations/jira";
// Trust without trustedGroups or trustedUsers.
const EVERYONE = "everyone with access to the site";

type ProjectHealth = { missingPermissions?: string[]; missingStatuses?: string[]; error?: string };

export type JiraStatusBody = {
  configured?: boolean;
  lastWebhookAt?: string | null;
  bot?: { accountId?: string; name?: string };
  auth?: "ok" | "rejected" | "unknown";
  tokenDaysLeft?: number;
  trust?: {
    source?: string;
    cachedAccounts?: number;
    lastError?: string;
    missingPermissions?: string[];
  };
  projects?: Record<string, ProjectHealth>;
  lastReplyFailure?: { status: number | null; at: string } | null;
  holds?: { heldTasks?: number; oldestHoldAgeMs?: number };
};

export type StatusDeps = { resolver: PeekDeps; fetch: Fetch; log: (line: string) => void };

// The status endpoint's body, or why it cannot be read.
export async function readStatus(
  d: JiraDeployment,
): Promise<{ body: JiraStatusBody } | { error: string }> {
  try {
    const res = await d.api(STATUS_PATH);
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    return { body: (await res.json()) as JiraStatusBody };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function projectLine(key: string, p: ProjectHealth): string {
  if (p.error) return `Project ${key}: can't check (${p.error})`;
  const problems = [
    ...(p.missingPermissions?.length ? [`missing ${permissionList(p.missingPermissions)}`] : []),
    ...(p.missingStatuses?.length
      ? [`no status ${p.missingStatuses.map((s) => `"${s}"`).join(", ")}`]
      : []),
  ];
  return `Project ${key}: ${problems.length > 0 ? problems.join("; ") : "ok"}`;
}

// The control plane's view, in a few lines.
function controlPlaneLines(d: JiraDeployment, s: JiraStatusBody): string[] {
  const setup = `bun run jira:setup${d.flag}`;
  const lines = [
    `Control plane: bot ${s.bot?.name ?? "unknown"}, auth ${s.auth ?? "unknown"}, last webhook from Jira ${s.lastWebhookAt ?? "none yet"}`,
  ];
  if (s.auth === "rejected") {
    lines.push(
      `Jira rejects JIRA_API_TOKEN: create a new token for the service account, run ${setup}, then ${d.applyCommand}`,
    );
  }
  const days = s.tokenDaysLeft;
  if (typeof days === "number") {
    lines.push(
      days < 0
        ? `API token: expired ${-days} days ago`
        : `API token: expires in ${days} days${days < TOKEN_WARN_DAYS ? `: rotate it soon (create a new one, then run ${setup})` : ""}`,
    );
  }
  if (s.trust?.source === "site") {
    // Nothing is looked up, so there is no cache or lookup failure to show.
    lines.push(`Trust: ${EVERYONE}`);
  } else if (s.trust) {
    const cached = `${s.trust.cachedAccounts ?? 0} accounts cached`;
    const failed = s.trust.lastError ? `, last lookup failed: ${s.trust.lastError}` : "";
    const missing = s.trust.missingPermissions?.length
      ? `, missing ${permissionList(s.trust.missingPermissions)}: ${GRANT_GROUPS_PERMISSION}`
      : "";
    lines.push(`Trust: ${s.trust.source ?? "unknown"}, ${cached}${failed}${missing}`);
  }
  for (const [key, p] of Object.entries(s.projects ?? {})) lines.push(projectLine(key, p));
  const failure = s.lastReplyFailure;
  if (failure) {
    const what = failure.status === null ? "no answer" : `HTTP ${failure.status}`;
    lines.push(`Last failed reply to Jira: ${what} at ${failure.at}`);
  }
  const held = s.holds?.heldTasks ?? 0;
  if (held > 0) {
    const minutes = Math.round((s.holds?.oldestHoldAgeMs ?? 0) / 60_000);
    lines.push(
      `Replies held for ${held} task(s), the oldest for ${minutes} min: Jira is refusing or rate-limiting them`,
    );
  }
  return lines;
}

export async function status(d: JiraDeployment, deps: StatusDeps): Promise<void> {
  const { log } = deps;
  const scope = deploymentScope(d.deployment);
  const j = d.jira;
  if (!j) {
    log(`Jira is not configured for ${scope}. Run: bun run jira:setup${d.flag}`);
    return;
  }
  if (!j.enabled) {
    log(
      `Jira is disabled for ${scope} (enabled: false in ${d.configPath}). Turn it on again: bun run jira:setup${d.flag}, or set enabled to true, then ${d.applyCommand}.`,
    );
    return;
  }
  log(`Jira (${scope})`);
  log(`  site            ${j.siteUrl}`);
  log(`  bot             ${j.botName} (${j.botEmail})`);
  log(`  projectKeys     ${j.projectKeys?.join(", ")}`);
  const trust = [
    ...(j.trustedGroups?.length ? [`groups ${j.trustedGroups.join(", ")}`] : []),
    ...(j.trustedUsers?.length ? [`users ${j.trustedUsers.join(", ")}`] : []),
  ];
  log(`  trust           ${trust.join("; ") || EVERYONE}`);
  log(`  tokenExpiresAt  ${j.tokenExpiresAt}`);
  log(`  publicUrl       ${d.publicUrl ?? "not set"}`);
  for (const name of ["JIRA_API_TOKEN", "JIRA_WEBHOOK_SECRET"] as const) {
    const where = d.byoIntegrationsSecret
      ? `from Secret "${d.byoIntegrationsSecret}" (not read)`
      : await peekSecret(name, deps.resolver);
    log(`  ${name.padEnd(19)}  ${where}`);
  }

  const r = await readStatus(d);
  if ("error" in r) log(`Control plane: not reachable (${r.error})`);
  else if (!r.body.configured)
    log(`Control plane: Jira is not on there yet. Run: ${d.applyCommand}`);
  else for (const line of controlPlaneLines(d, r.body)) log(line);

  if (!d.publicUrl) return;
  const probe = await probeWebhook(d.publicUrl, "/webhook/jira", deps.fetch, {
    fromApiIngress: d.fromApiIngress === true,
    integration: "Jira",
  });
  log(
    probe.ok
      ? `Webhook URL ${d.publicUrl}/webhook/jira: reaches devbox with Jira on`
      : probe.message,
  );
}
