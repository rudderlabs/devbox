// The deployment `gitlab:*` acts on: the k8s deployment a target file
// describes. GitLab repos are Kubernetes only (the Compose stack refuses
// them), so --target is required. Each knows the instance and the repos under
// it (devbox.config.json), where `integrations.gitlab` and the trust lists
// live (the target file), the commands that apply and check it, the user's
// own Secrets, and how to call its API through its CLI profile. Nothing here
// applies anything.
import { join, resolve } from "node:path";
import { installCommand } from "../k8s/kind";
import { NAMESPACE } from "../k8s/run";
import { existingSecret } from "../k8s/secrets";
import { loadTarget } from "../k8s/target";
import { enabledGithubApp, enabledLinear, type GitlabIntegration } from "../lib/integrations";
import type { Deployment } from "../lib/keychain";
import { ingressPublicUrl, ingressSource } from "../lib/publicUrl";
import { k8sApi } from "../linear/deployment";
import { type GitlabConfig, gitlabRepos, loadConfig, type RepoConfig } from "../up/config";

export type TrustLists = { trustedGroups: string[]; trustedUsers: string[] };

export type GitlabDeployment = {
  deployment: Deployment;
  // The target file, holding integrations.gitlab and values.gitlab.
  configPath: string;
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
  if (opts.target === undefined) {
    throw new GitlabDeploymentError(
      "GitLab repos are supported on Kubernetes only: pass --target <file> (the Compose stack takes GitHub repos)",
    );
  }
  const cfg = loadConfig(opts.configPath ?? DEFAULT_CONFIG_PATH, { integrations: false });
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
