// `bun run jira:status`: what is configured, where each secret would come
// from, what the running control plane reports (the token, the bot's
// permissions, failed and held replies) and whether the webhook URL reaches it.
// Read-only, never prompts, never prints a secret value; a control plane or
// URL that cannot be reached is reported, not a failure.
import { deploymentScope } from "../lib/keychain";
import { errorMessage } from "../lib/knownError";
import { probeWebhook } from "../lib/probe";
import { type PeekDeps, peekSecret } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import { permissionList } from "./check";
import type { JiraDeployment } from "./deployment";

export const STATUS_PATH = "/api/integrations/jira";

export type JiraStatusBody = {
  configured?: boolean;
  lastWebhookAt?: string | null;
  bot?: { accountId?: string; name?: string };
  auth?: "ok" | "rejected" | "unknown";
  permissions?: { missing?: string[]; error?: string };
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
  const p = s.permissions;
  if (p) {
    lines.push(
      p.error
        ? `Permissions: can't check (${p.error})`
        : p.missing?.length
          ? `Permissions: missing ${permissionList(p.missing)} in every project`
          : "Permissions: ok",
    );
  }
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
