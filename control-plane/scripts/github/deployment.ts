// The deployment `github:*` acts on: Compose without --target, the k8s
// deployment a target file describes with it. Each knows where its
// `integrations.githubApp` and trust lists live, the repos the App must
// cover, the commands that apply and check it, the user's own Secrets, and
// how to call its API through its CLI profile. Nothing here applies anything.
import { join, resolve } from "node:path";
import { installCommand } from "../k8s/kind";
import { NAMESPACE } from "../k8s/run";
import { existingSecret } from "../k8s/secrets";
import { loadTarget } from "../k8s/target";
import { enabledLinear, type GithubAppIntegration } from "../lib/integrations";
import type { Deployment } from "../lib/keychain";
import { ingressPublicUrl, ingressSource } from "../lib/publicUrl";
import { composeApi, k8sApi } from "../linear/deployment";
import { loadConfig, type RepoConfig } from "../up/config";

export type TrustLists = { trustedOrgs: string[]; trustedUsers: string[] };

export type GithubDeployment = {
  deployment: Deployment;
  // The file holding integrations.githubApp: devbox.config.json or the target file.
  configPath: string;
  // The App's block as configured, on or off.
  githubApp: GithubAppIntegration | undefined;
  // Whether Linear is on: its webhook URL follows the shared public URL.
  linear: boolean;
  // The repos the App's installation must cover (devbox.config.json).
  repos: RepoConfig[];
  // Who may drive the agent from GitHub: Compose's top-level `github`, or
  // the target's `values.github` on k8s. Empty lists when unset.
  trust: TrustLists;
  // The deployment's top-level publicUrl, shared with Linear.
  publicUrl?: string;
  // k8s: the URL derived from the target's Ingress values, and whether it is
  // the api Ingress's (which may be VPN-only).
  ingressUrl?: string;
  fromApiIngress?: boolean;
  applyCommand: string;
  statusCommand: string;
  // k8s: the user's own Secrets for the App's key and for the integrations'
  // secrets (secrets.githubApp / secrets.integrations existingSecret).
  byoGithubSecret?: string;
  byoKeySecret?: string;
  byoIntegrationsSecret?: string;
  // GET through the deployment's CLI profile; the body is read in full.
  api: (path: string) => Promise<Response>;
};

const DEFAULT_CONFIG_PATH = join(import.meta.dir, "..", "..", "..", "devbox.config.json");

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function loadDeployment(opts: {
  target?: string;
  noKeychain: boolean;
  // devbox.config.json; another file in tests.
  configPath?: string;
}): GithubDeployment {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  if (opts.target === undefined) {
    const cfg = loadConfig(configPath);
    return {
      deployment: { kind: "compose" },
      configPath,
      githubApp: cfg.integrations.githubApp,
      linear: enabledLinear(cfg.integrations) !== undefined,
      repos: cfg.repos,
      trust: { trustedOrgs: cfg.github.trustedOrgs, trustedUsers: cfg.github.trustedUsers },
      ...(cfg.publicUrl !== undefined ? { publicUrl: cfg.publicUrl } : {}),
      applyCommand: "bun run up",
      statusCommand: "bun run github:status",
      api: composeApi,
    };
  }

  const cfg = loadConfig(configPath, { integrations: false });
  const path = resolve(opts.target);
  const target = loadTarget(path);
  const github = (target.values.github ?? {}) as Record<string, unknown>;
  const byoGithub = existingSecret(target.values, "github");
  const byoKey = existingSecret(target.values, "githubApp");
  const byoIntegrations = existingSecret(target.values, "integrations");
  const ingressUrl = ingressPublicUrl(target);
  const apply = installCommand(target.context, path);
  return {
    deployment: { kind: "k8s", context: target.context, namespace: NAMESPACE },
    configPath: path,
    githubApp: target.integrations?.githubApp,
    linear: enabledLinear(target.integrations ?? {}) !== undefined,
    repos: cfg.repos,
    trust: { trustedOrgs: strings(github.trustedOrgs), trustedUsers: strings(github.trustedUsers) },
    ...(target.publicUrl !== undefined ? { publicUrl: target.publicUrl } : {}),
    ...(ingressUrl !== undefined ? { ingressUrl } : {}),
    fromApiIngress: ingressSource(target) === "api",
    applyCommand: apply,
    statusCommand: `bun run github:status --target ${path}`,
    ...(byoGithub !== undefined ? { byoGithubSecret: byoGithub } : {}),
    ...(byoKey !== undefined ? { byoKeySecret: byoKey } : {}),
    ...(byoIntegrations !== undefined ? { byoIntegrationsSecret: byoIntegrations } : {}),
    api: k8sApi(target, apply),
  };
}
