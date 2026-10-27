// `bun run linear:status`: what is configured, where each secret
// would come from, what the running control plane reports and whether the
// webhook URL reaches it. Read-only, never prompts, never prints a secret
// value; a control plane or URL that cannot be reached is reported, not a
// failure.
import { deploymentScope } from "../lib/keychain";
import { errorMessage } from "../lib/knownError";
import { probeWebhook } from "../lib/probe";
import { type PeekDeps, peekSecret } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import type { LinearDeployment } from "./deployment";

export const STATUS_PATH = "/api/integrations/linear";

export type LinearStatusBody = {
  configured?: boolean;
  workspace?: { name?: string; urlKey?: string } | null;
  appUser?: { name?: string } | null;
  lastWebhookAt?: string | null;
  lastTokenError?: string | null;
};

export type StatusDeps = { resolver: PeekDeps; fetch: Fetch; log: (line: string) => void };

// The status endpoint's body, or undefined when it cannot be read.
export async function readStatus(
  d: LinearDeployment,
): Promise<{ body: LinearStatusBody } | { error: string }> {
  try {
    const res = await d.api(STATUS_PATH);
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    return { body: (await res.json()) as LinearStatusBody };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function status(d: LinearDeployment, deps: StatusDeps): Promise<void> {
  const { log } = deps;
  const scope = deploymentScope(d.deployment);
  if (!d.linear) {
    log(`Linear is not configured for ${scope}. Run: bun run linear:setup`);
    return;
  }
  if (!d.linear.enabled) {
    log(
      `Linear is disabled for ${scope} (enabled: false in ${d.configPath}). Turn it on again: bun run linear:setup, or set enabled to true, then ${d.applyCommand}.`,
    );
    return;
  }
  log(`Linear (${scope})`);
  log(`  clientId   ${d.linear.clientId}`);
  log(`  publicUrl  ${d.publicUrl ?? "not set"}`);
  for (const name of ["LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"] as const) {
    const where = d.byoIntegrationsSecret
      ? `from Secret "${d.byoIntegrationsSecret}" (not read)`
      : await peekSecret(name, deps.resolver);
    log(`  ${name.padEnd(21)}  ${where}`);
  }

  const r = await readStatus(d);
  if ("error" in r) {
    log(`Control plane: not reachable (${r.error})`);
  } else if (!r.body.configured) {
    log(`Control plane: Linear is not on there yet. Run: ${d.applyCommand}`);
  } else {
    const s = r.body;
    const workspace = s.workspace ? `${s.workspace.name} (${s.workspace.urlKey})` : "unknown";
    log(
      `Control plane: workspace ${workspace}, app user ${s.appUser?.name ?? "unknown"}, last webhook from Linear ${s.lastWebhookAt ?? "none yet"}`,
    );
    if (s.lastTokenError) log(`Last Linear token error: ${s.lastTokenError}`);
  }

  if (!d.publicUrl) return;
  const probe = await probeWebhook(d.publicUrl, "/webhook/linear", deps.fetch, {
    fromApiIngress: d.fromApiIngress === true,
    integration: "Linear",
  });
  log(
    probe.ok
      ? `Webhook URL ${d.publicUrl}/webhook/linear: reaches devbox with Linear on`
      : probe.message,
  );
}
