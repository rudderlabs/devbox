// The deployment `jira:*` acts on: Compose without --target, the k8s
// deployment a target file describes with it. Each knows where its
// `integrations.jira` lives, the commands that apply and check it, the user's
// own integrations Secret, and how to call its API through its CLI profile.
// Nothing here applies anything.
import { join, resolve } from "node:path";
import { installCommand } from "../k8s/kind";
import { NAMESPACE } from "../k8s/run";
import { existingSecret } from "../k8s/secrets";
import { loadTarget } from "../k8s/target";
import type { Integrations, JiraIntegration } from "../lib/integrations";
import type { Deployment } from "../lib/keychain";
import { ingressPublicUrl, ingressSource } from "../lib/publicUrl";
import { composeApi, k8sApi } from "../linear/deployment";
import { loadConfig } from "../up/config";

export type JiraDeployment = {
  deployment: Deployment;
  // The file holding integrations.jira: devbox.config.json or the target file.
  configPath: string;
  jira: JiraIntegration | undefined;
  // Every integration's block, for what the others need when the public URL
  // changes.
  integrations: Integrations;
  // The deployment's top-level publicUrl, shared by every integration.
  publicUrl?: string;
  // k8s: the URL derived from the target's Ingress values, and whether it is
  // the api Ingress's (which may be VPN-only).
  ingressUrl?: string;
  fromApiIngress?: boolean;
  // ` --target <file>` on k8s, empty on Compose: for the commands named.
  flag: string;
  applyCommand: string;
  // k8s: the user's own integrations Secret (secrets.integrations.existingSecret).
  byoIntegrationsSecret?: string;
  // GET through the deployment's CLI profile; the body is read in full.
  api: (path: string) => Promise<Response>;
};

const DEFAULT_CONFIG_PATH = join(import.meta.dir, "..", "..", "..", "devbox.config.json");

export function loadDeployment(opts: {
  target?: string;
  // devbox.config.json; another file in tests.
  configPath?: string;
}): JiraDeployment {
  if (opts.target === undefined) {
    const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
    const cfg = loadConfig(configPath);
    return {
      deployment: { kind: "compose" },
      configPath,
      jira: cfg.integrations.jira,
      integrations: cfg.integrations,
      ...(cfg.publicUrl !== undefined ? { publicUrl: cfg.publicUrl } : {}),
      flag: "",
      applyCommand: "bun run up",
      api: composeApi,
    };
  }

  const path = resolve(opts.target);
  const target = loadTarget(path);
  const integrations = target.integrations ?? {};
  const byo = existingSecret(target.values, "integrations");
  const ingressUrl = ingressPublicUrl(target);
  const apply = installCommand(target.context, path);
  return {
    deployment: { kind: "k8s", context: target.context, namespace: NAMESPACE },
    configPath: path,
    jira: integrations.jira,
    integrations,
    ...(target.publicUrl !== undefined ? { publicUrl: target.publicUrl } : {}),
    ...(ingressUrl !== undefined ? { ingressUrl } : {}),
    fromApiIngress: ingressSource(target) === "api",
    flag: ` --target ${path}`,
    applyCommand: apply,
    ...(byo !== undefined ? { byoIntegrationsSecret: byo } : {}),
    api: k8sApi(target, apply),
  };
}
