// `bun run gitlab:status --target <file>`: what is configured, where each
// secret would come from, what the running control plane reports and whether
// the webhook URL reaches it. Read-only, never prompts, never reads a Secret
// or prints a secret value; a control plane or URL that cannot be reached is
// reported, not a failure.
import { gitlabWebhookSecretName } from "../lib/integrations";
import { deploymentScope } from "../lib/keychain";
import { errorMessage } from "../lib/knownError";
import { probeWebhook } from "../lib/probe";
import { type PeekDeps, peekSecret } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import type { GitlabDeployment } from "./deployment";

export const STATUS_PATH = "/api/integrations/gitlab";

export type GitlabStatusBody = {
  token?: {
    configured?: boolean;
    source?: string | null;
    readAt?: string | null;
    lastError?: string | null;
  };
  webhooks?: { enabled?: boolean; lastWebhookAt?: string | null; ciResults?: boolean };
};

export type StatusDeps = { resolver: PeekDeps; fetch: Fetch; log: (line: string) => void };

export async function readStatus(
  d: GitlabDeployment,
): Promise<{ body: GitlabStatusBody } | { error: string }> {
  try {
    const res = await d.api(STATUS_PATH);
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    return { body: (await res.json()) as GitlabStatusBody };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function status(d: GitlabDeployment, deps: StatusDeps): Promise<void> {
  const { log, resolver } = deps;
  const scope = deploymentScope(d.deployment);
  if (!d.instance) {
    log(`No GitLab instance is configured for ${scope} (gitlab.baseUrl in devbox.config.json).`);
    return;
  }
  log(`GitLab (${scope})`);
  log(`  baseUrl         ${d.instance.baseUrl}`);
  log(`  caFile          ${d.instance.caFile ?? "none (a public CA)"}`);
  log(`  repos           ${d.repos.map((r) => `${r.owner}/${r.name}`).join(", ") || "none"}`);
  const tokenWhere = d.byoGitlabSecret
    ? `from Secret "${d.byoGitlabSecret}" (not read)`
    : await peekSecret("GITLAB_TOKEN", resolver);
  log(`  GITLAB_TOKEN    ${tokenWhere}`);
  const g = d.gitlab;
  if (!g) {
    log(
      `Webhooks are not configured for ${scope}. Run: bun run gitlab:setup${d.deployment.kind === "k8s" ? ` --target ${d.configPath}` : ""}`,
    );
    return;
  }
  if (!g.enabled) {
    log(
      `Webhooks are disabled for ${scope} (enabled: false in ${d.configPath}). Turn them on again: bun run gitlab:setup${d.deployment.kind === "k8s" ? ` --target ${d.configPath}` : ""}, or set enabled to true, then ${d.applyCommand}.`,
    );
    return;
  }
  log(`  botUsername     ${g.botUsername}`);
  log(`  botUserId       ${g.botUserId}`);
  log(`  ciResults       ${g.ciResults}`);
  log(
    `  webhookAuth     ${g.webhookAuth === "secret" ? "secret token (X-Gitlab-Token)" : "signing token"}`,
  );
  log(`  trustedGroups   ${d.trust.trustedGroups.join(", ") || "none"}`);
  log(`  trustedUsers    ${d.trust.trustedUsers.join(", ") || "none"}`);
  log(`  publicUrl       ${d.publicUrl ?? "not set"}`);
  const secretName = gitlabWebhookSecretName(g);
  const where = d.byoIntegrationsSecret
    ? `from Secret "${d.byoIntegrationsSecret}" (not read)`
    : await peekSecret(secretName, resolver);
  log(`  ${secretName.padEnd(29)} ${where}`);

  const r = await readStatus(d);
  if ("error" in r) {
    log(`Control plane: not reachable (${r.error})`);
  } else {
    const { token, webhooks } = r.body;
    if (token?.configured === false) {
      log("Control plane: no GitLab token (GITLAB_TOKEN_FILE is not set there)");
    } else {
      log(
        `Control plane: token from ${token?.source ?? "unknown"}${token?.readAt ? ` (read ${token.readAt})` : ""}`,
      );
    }
    if (token?.lastError) log(`Last GitLab token error: ${token.lastError}`);
    if (webhooks?.enabled === false) {
      log(`Control plane: GitLab webhooks are not on there yet. Run: ${d.applyCommand}`);
    } else {
      log(
        `Control plane: last webhook from GitLab ${webhooks?.lastWebhookAt ?? "none yet"}, CI results ${webhooks?.ciResults ? "on" : "off"}`,
      );
    }
  }

  if (!d.publicUrl) return;
  const probe = await probeWebhook(d.publicUrl, "/webhook/gitlab", deps.fetch, {
    fromApiIngress: d.fromApiIngress === true,
    integration: "GitLab",
  });
  log(
    probe.ok
      ? `Webhook URL ${d.publicUrl}/webhook/gitlab: reaches devbox with GitLab on`
      : probe.message,
  );
}
