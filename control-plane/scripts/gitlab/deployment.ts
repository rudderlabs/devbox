// The deployment `gitlab:*` acts on: Compose without --target, the k8s
// deployment a target file describes with it. Each knows the instance and the
// repos under it (devbox.config.json), where `integrations.gitlab` and the
// trust lists live (devbox.config.json's `gitlab` block on Compose, the target
// file's `values.gitlab` on k8s), the commands that apply and check it, the
// user's own Secrets, and how to call its API through its CLI profile.
// Nothing here applies anything.
import { join, resolve } from "node:path";
import { installCommand } from "../k8s/kind";
import { NAMESPACE } from "../k8s/run";
import { existingSecret } from "../k8s/secrets";
import { loadTarget } from "../k8s/target";
import { enabledGithubApp, enabledLinear, type GitlabIntegration } from "../lib/integrations";
import type { Deployment } from "../lib/keychain";
import { ingressPublicUrl, ingressSource } from "../lib/publicUrl";
import { composeApi, k8sApi } from "../linear/deployment";
import { type GitlabConfig, gitlabRepos, loadConfig, type RepoConfig } from "../up/config";

export type TrustLists = { trustedGroups: string[]; trustedUsers: string[] };

export type GitlabDeployment = {
  deployment: Deployment;
  // The file holding integrations.gitlab and the trust lists: devbox.config.json
  // on Compose, the target file on k8s.
  configPath: string;
  // The config key the trust lists live under: "gitlab" or "values.gitlab".
  trustKey: "gitlab" | "values.gitlab";
  // The instance (devbox.config.json); undefined when none is configured.
  instance: GitlabConfig | undefined;
  // The repos under it.
  repos: RepoConfig[];
  // The block as configured, on or off.
  gitlab: GitlabIntegration | undefined;
  // Who may drive the agent from GitLab: the target's values.gitlab.
  trust: TrustLists;
  // Whether Linear and the GitHub App are on: their webhook URLs follow the
  // shared public URL.
  linear: boolean;
  githubApp?: { tokens: "devbox" | "external"; slug: string; org?: string };
  publicUrl?: string;
  ingressUrl?: string;
  fromApiIngress?: boolean;
  applyCommand: string;
  statusCommand: string;
  // The user's own Secrets: the GitLab token (secrets.gitlab.existingSecret)
  // and the integrations' secrets (secrets.integrations.existingSecret).
  byoGitlabSecret?: string;
  byoIntegrationsSecret?: string;
  api: (path: string) => Promise<Response>;
};

export class GitlabDeploymentError extends Error {}

const DEFAULT_CONFIG_PATH = join(import.meta.dir, "..", "..", "..", "devbox.config.json");

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function loadDeployment(opts: {
  target?: string;
  noKeychain: boolean;
  // devbox.config.json; another file in tests.
  configPath?: string;
}): GitlabDeployment {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  if (opts.target === undefined) {
    const cfg = loadConfig(configPath);
    const app = enabledGithubApp(cfg.integrations);
    return {
      deployment: { kind: "compose" },
      configPath,
      trustKey: "gitlab",
      instance: cfg.gitlab,
      repos: gitlabRepos(cfg.repos),
      gitlab: cfg.integrations.gitlab,
      trust: {
        trustedGroups: cfg.gitlab?.trustedGroups ?? [],
        trustedUsers: cfg.gitlab?.trustedUsers ?? [],
      },
      linear: enabledLinear(cfg.integrations) !== undefined,
      ...(app
        ? {
            githubApp: {
              tokens: app.tokens,
              slug: app.slug,
              ...(app.org !== undefined ? { org: app.org } : {}),
            },
          }
        : {}),
      ...(cfg.publicUrl !== undefined ? { publicUrl: cfg.publicUrl } : {}),
      applyCommand: "bun run up",
      statusCommand: "bun run gitlab:status",
      api: composeApi,
    };
  }
  const cfg = loadConfig(configPath, { integrations: false });
  const path = resolve(opts.target);
  const target = loadTarget(path);
  const trust = (target.values.gitlab ?? {}) as Record<string, unknown>;
  const integrations = target.integrations ?? {};
  const app = enabledGithubApp(integrations);
  const ingressUrl = ingressPublicUrl(target);
  const apply = installCommand(target.context, path);
  const byoGitlab = existingSecret(target.values, "gitlab");
  const byoIntegrations = existingSecret(target.values, "integrations");
  return {
    deployment: { kind: "k8s", context: target.context, namespace: NAMESPACE },
    configPath: path,
    trustKey: "values.gitlab",
    instance: cfg.gitlab,
    repos: gitlabRepos(cfg.repos),
    gitlab: integrations.gitlab,
    trust: {
      trustedGroups: strings(trust.trustedGroups),
      trustedUsers: strings(trust.trustedUsers),
    },
    linear: enabledLinear(integrations) !== undefined,
    ...(app
      ? {
          githubApp: {
            tokens: app.tokens,
            slug: app.slug,
            ...(app.org !== undefined ? { org: app.org } : {}),
          },
        }
      : {}),
    ...(target.publicUrl !== undefined ? { publicUrl: target.publicUrl } : {}),
    ...(ingressUrl !== undefined ? { ingressUrl } : {}),
    fromApiIngress: ingressSource(target) === "api",
    applyCommand: apply,
    statusCommand: `bun run gitlab:status --target ${path}`,
    ...(byoGitlab !== undefined ? { byoGitlabSecret: byoGitlab } : {}),
    ...(byoIntegrations !== undefined ? { byoIntegrationsSecret: byoIntegrations } : {}),
    api: k8sApi(target, apply),
  };
}
