// `bun run clickup:status`: what is configured, where each secret would come
// from, what the running control plane reports (the token, the webhook's
// health in ClickUp, failed replies) and whether the webhook URL reaches it.
// Read-only, never prompts, never prints a secret value; a control plane or
// URL that cannot be reached is reported, not a failure.
import { deploymentScope } from "../lib/keychain";
import { errorMessage } from "../lib/knownError";
import { probeWebhook } from "../lib/probe";
import { type PeekDeps, peekSecret } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import { WEBHOOK_PATH } from "./check";
import type { ClickupDeployment } from "./deployment";

export const STATUS_PATH = "/api/integrations/clickup";

export type ClickupStatusBody = {
  configured?: boolean;
  bot?: { id?: number; name?: string };
  team?: string;
  auth?: "ok" | "rejected" | "unknown";
  lastWebhookAt?: string | null;
  webhook?: { health?: string; failCount?: number } | null;
  lastReplyFailure?: { at: string; error: string } | null;
};

export type StatusDeps = { resolver: PeekDeps; fetch: Fetch; log: (line: string) => void };

// The status endpoint's body, or why it cannot be read.
export async function readStatus(
  d: ClickupDeployment,
): Promise<{ body: ClickupStatusBody } | { error: string }> {
  try {
    const res = await d.api(STATUS_PATH);
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    return { body: (await res.json()) as ClickupStatusBody };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// The control plane's view, in a few lines.
function controlPlaneLines(d: ClickupDeployment, s: ClickupStatusBody): string[] {
  const setup = `bun run clickup:setup${d.flag}`;
  const lines = [
    `Control plane: bot ${s.bot?.name ?? "unknown"}, auth ${s.auth ?? "unknown"}, last webhook from ClickUp ${s.lastWebhookAt ?? "none yet"}`,
  ];
  if (s.auth === "rejected") {
    lines.push(
      `ClickUp rejects CLICKUP_API_TOKEN: generate a new personal token for the bot, run ${setup}, then ${d.applyCommand}`,
    );
  }
  const hook = s.webhook;
  if (hook === null) {
    lines.push(`Webhook in ClickUp: none for this workspace. Run: ${setup}`);
  } else if (hook) {
    const fails = hook.failCount ? `, ${hook.failCount} failed deliveries` : "";
    lines.push(`Webhook in ClickUp: ${hook.health ?? "unknown"}${fails}`);
    if (hook.health === "suspended") {
      lines.push(`ClickUp sends nothing to a suspended webhook: ${setup} reactivates it`);
    }
  }
  const failure = s.lastReplyFailure;
  if (failure) lines.push(`Last failed reply to ClickUp: ${failure.error} at ${failure.at}`);
  return lines;
}

export async function status(d: ClickupDeployment, deps: StatusDeps): Promise<void> {
  const { log } = deps;
  const scope = deploymentScope(d.deployment);
  const c = d.clickup;
  if (!c) {
    log(`ClickUp is not configured for ${scope}. Run: bun run clickup:setup${d.flag}`);
    return;
  }
  if (!c.enabled) {
    log(
      `ClickUp is disabled for ${scope} (enabled: false in ${d.configPath}). Turn it on again: bun run clickup:setup${d.flag}, or set enabled to true, then ${d.applyCommand}.`,
    );
    return;
  }
  log(`ClickUp (${scope})`);
  log(`  workspace       ${c.teamId}`);
  log(`  bot             ${c.botName} (user ${c.botUserId})`);
  log(`  publicUrl       ${d.publicUrl ?? "not set"}`);
  for (const name of ["CLICKUP_API_TOKEN", "CLICKUP_WEBHOOK_SECRET"] as const) {
    const where = d.byoIntegrationsSecret
      ? `from Secret "${d.byoIntegrationsSecret}" (not read)`
      : await peekSecret(name, deps.resolver);
    log(`  ${name.padEnd(22)}  ${where}`);
  }

  const r = await readStatus(d);
  if ("error" in r) log(`Control plane: not reachable (${r.error})`);
  else if (!r.body.configured)
    log(`Control plane: ClickUp is not on there yet. Run: ${d.applyCommand}`);
  else for (const line of controlPlaneLines(d, r.body)) log(line);

  if (!d.publicUrl) return;
  const probe = await probeWebhook(d.publicUrl, WEBHOOK_PATH, deps.fetch, {
    fromApiIngress: d.fromApiIngress === true,
    integration: "ClickUp",
  });
  log(
    probe.ok
      ? `Webhook URL ${d.publicUrl}${WEBHOOK_PATH}: reaches devbox with ClickUp on`
      : probe.message,
  );
}
