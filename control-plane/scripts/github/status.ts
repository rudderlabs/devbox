// `bun run github:status`: what is configured, where each secret would come
// from, what the running control plane reports and whether the webhook URL
// reaches it. Read-only, never prompts, never reads a Secret or prints a
// secret value; a control plane or URL that cannot be reached is reported,
// not a failure.
import { existsSync } from "node:fs";
import { appSettingsUrl } from "../lib/githubApp";
import { peekPrivateKey } from "../lib/githubAppKey";
import { deploymentScope } from "../lib/keychain";
import { errorMessage } from "../lib/knownError";
import { probeWebhook } from "../lib/probe";
import { type PeekDeps, peekSecret } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import type { GithubDeployment } from "./deployment";

export const STATUS_PATH = "/api/integrations/github";

export type GithubStatusBody = {
  token?: {
    source?: string;
    expiresAt?: string | null;
    readAt?: string | null;
    lastError?: string | null;
  };
  webhooks?: { enabled?: boolean; lastWebhookAt?: string | null; ciResults?: boolean };
};

export type StatusDeps = {
  resolver: PeekDeps;
  fetch: Fetch;
  now: () => Date;
  fileExists?: (path: string) => boolean;
  log: (line: string) => void;
};

async function readStatus(
  d: GithubDeployment,
): Promise<{ body: GithubStatusBody } | { error: string }> {
  try {
    const res = await d.api(STATUS_PATH);
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    return { body: (await res.json()) as GithubStatusBody };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// Where to read the minter's output.
function minterLogs(d: GithubDeployment): string {
  return d.deployment.kind === "k8s"
    ? `kubectl --context ${d.deployment.context} -n ${d.deployment.namespace} logs deploy/devbox-github-token`
    : "docker compose -f control-plane/docker-compose.yml logs github-token";
}

export async function status(d: GithubDeployment, deps: StatusDeps): Promise<void> {
  const { log, resolver } = deps;
  const scope = deploymentScope(d.deployment);
  const app = d.githubApp;
  if (!app) {
    log(
      `GitHub uses a personal token for ${scope} (no App). Webhooks need an App: bun run github:setup`,
    );
    const where = d.byoGithubSecret
      ? `from Secret "${d.byoGithubSecret}" (not read)`
      : await peekSecret("GITHUB_TOKEN", resolver);
    log(`  GITHUB_TOKEN  ${where}`);
    return;
  }
  if (!app.enabled) {
    log(
      `The GitHub App is disabled for ${scope} (enabled: false in ${d.configPath}); GitHub uses a personal token. Turn it on again: bun run github:setup, or set enabled to true, then ${d.applyCommand}.`,
    );
    return;
  }

  log(`GitHub App (${scope})`);
  log(`  appId           ${app.appId}`);
  log(`  slug            ${app.slug}`);
  log(
    `  settings        ${appSettingsUrl(app.slug as string, app.org ? { login: app.org, type: "Organization" } : undefined)}`,
  );
  log(`  installationId  ${app.installationId}`);
  log(`  botUserId       ${app.botUserId}`);
  log(`  tokens          ${app.tokens}`);
  log(`  tokenScope      ${app.tokenScope}`);
  log(`  ciResults       ${app.ciResults}`);
  log(`  trustedOrgs     ${d.trust.trustedOrgs.join(", ") || "none"}`);
  log(`  trustedUsers    ${d.trust.trustedUsers.join(", ") || "none"}`);
  log(`  publicUrl       ${d.publicUrl ?? "not set"}`);
  if (app.pending) {
    const flag = d.deployment.kind === "k8s" ? ` --target ${d.configPath}` : "";
    log(
      `  pending         App ${app.pending.slug} (id ${app.pending.appId}) waits for its install: run bun run github:setup${flag}`,
    );
  }
  if (app.tokens === "external" && app.tokenFile) {
    const exists = (deps.fileExists ?? existsSync)(app.tokenFile);
    log(`  tokenFile       ${app.tokenFile} (${exists ? "exists" : "missing"}; not read)`);
  }
  if (app.tokens === "devbox") {
    const where = d.byoKeySecret
      ? `from Secret "${d.byoKeySecret}" (not read)`
      : await peekPrivateKey(resolver);
    log(`  GITHUB_APP_PRIVATE_KEY  ${where}`);
  }
  const webhookSecret = d.byoIntegrationsSecret
    ? `from Secret "${d.byoIntegrationsSecret}" (not read)`
    : await peekSecret("GITHUB_WEBHOOK_SECRET", resolver);
  log(`  GITHUB_WEBHOOK_SECRET   ${webhookSecret}`);

  const r = await readStatus(d);
  if ("error" in r) {
    log(`Control plane: not reachable (${r.error})`);
  } else {
    const { token, webhooks } = r.body;
    const expiresAt = token?.expiresAt;
    if (!expiresAt) {
      log(`Control plane: token from ${token?.source ?? "unknown"}, no expiry known`);
    } else if (Date.parse(expiresAt) <= deps.now().getTime()) {
      const fix =
        app.tokens === "devbox"
          ? `check the minter's logs: ${minterLogs(d)}`
          : "check the tooling that writes it";
      log(`Control plane: the token has expired (${expiresAt}): ${fix}`);
    } else {
      log(
        `Control plane: token expires ${expiresAt}${token?.readAt ? ` (refreshed ${token.readAt})` : ""}`,
      );
    }
    if (token?.lastError) log(`Last GitHub token error: ${token.lastError}`);
    if (webhooks?.enabled === false) {
      log(`Control plane: GitHub webhooks are not on there yet. Run: ${d.applyCommand}`);
    } else {
      log(`Control plane: last webhook from GitHub ${webhooks?.lastWebhookAt ?? "none yet"}`);
    }
  }

  if (!d.publicUrl) return;
  const probe = await probeWebhook(d.publicUrl, "/webhook/github", deps.fetch, {
    fromApiIngress: d.fromApiIngress === true,
    integration: "GitHub",
  });
  log(
    probe.ok
      ? `Webhook URL ${d.publicUrl}/webhook/github: reaches devbox with GitHub on`
      : probe.message,
  );
}
