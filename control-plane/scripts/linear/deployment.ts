// The deployment `linear:*` acts on: Compose without --target, the
// k8s deployment a target file describes with it. Each knows where its
// `integrations.linear` lives, the commands that apply and check it, and how
// to call its API through its CLI profile. Nothing here applies anything.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { backgroundPortForward, isPortFree, profileFor } from "../k8s/connect";
import { installCommand } from "../k8s/kind";
import { kube, NAMESPACE, realRunner } from "../k8s/run";
import { existingSecret } from "../k8s/secrets";
import { loadTarget, type Target } from "../k8s/target";
import { enabledGithubApp, type Integrations, type LinearIntegration } from "../lib/integrations";
import type { Deployment } from "../lib/keychain";
import { ingressPublicUrl, ingressSource } from "../lib/publicUrl";
import { CliConfigError, cliConfigPath, readCliProfile } from "../up/cliLogin";
import { loadConfig } from "../up/config";

export type LinearDeployment = {
  deployment: Deployment;
  // The file holding integrations.linear: devbox.config.json or the target file.
  configPath: string;
  linear: LinearIntegration | undefined;
  // The deployment's top-level publicUrl, shared with GitHub.
  publicUrl?: string;
  // k8s: the URL derived from the target's Ingress values, and whether it is
  // the api Ingress's (which may be VPN-only).
  ingressUrl?: string;
  fromApiIngress?: boolean;
  // The commands that apply the config (`bun run up`, `bun run k8s:install
  // --target <file>`, or `bun run k8s:kind`) and check Linear.
  applyCommand: string;
  statusCommand: string;
  // k8s: the user's own integrations Secret (secrets.integrations.existingSecret).
  byoIntegrationsSecret?: string;
  // The enabled GitHub App (slug and who mints its tokens): used for the public
  // URL change lines and, as `<slug>[bot]`, as the bot's GitHub username.
  githubApp?: { tokens: "devbox" | "external"; slug: string; org?: string };
  // GET through the deployment's CLI profile; the body is read in full.
  api: (path: string) => Promise<Response>;
};

const ROOT = join(import.meta.dir, "..", "..", "..");
const CONFIG_PATH = join(ROOT, "devbox.config.json");
const API_TIMEOUT_MS = 10_000;

function profileUrl(profile: string, hint: string): { url: string; token: string } {
  const saved = readCliProfile(cliConfigPath(process.env, homedir()), profile);
  if (!saved) throw new CliConfigError(`no CLI profile "${profile}": run \`${hint}\` first`);
  return saved;
}

// The body is read before returning, so a port-forward can stop after it.
async function apiGet(url: string, token: string, path: string): Promise<Response> {
  const res = await fetch(`${url}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
}

function githubAppOf(i: Integrations): LinearDeployment["githubApp"] {
  const g = enabledGithubApp(i);
  return g
    ? { tokens: g.tokens, slug: g.slug, ...(g.org !== undefined ? { org: g.org } : {}) }
    : undefined;
}

// The Compose deployment's API, through the "local" CLI profile.
export const composeApi = async (path: string): Promise<Response> => {
  const p = profileUrl("local", "bun run up");
  return apiGet(p.url, p.token, path);
};

// A k8s deployment's API, through its CLI profile; `apply` is named when the
// profile is missing.
export function k8sApi(target: Target, apply: string): (path: string) => Promise<Response> {
  const k = kube(realRunner, target.context);
  return async (apiPath) => {
    const p = profileUrl(profileFor(target), apply);
    const url = new URL(p.url);
    const port = Number(url.port);
    // A running `k8s:connect` already forwards the profile's port.
    const forward =
      url.hostname === "localhost" && (await isPortFree(port))
        ? await backgroundPortForward(k, port)
        : undefined;
    try {
      return await apiGet(p.url, p.token, apiPath);
    } finally {
      forward?.stop();
    }
  };
}

export function loadDeployment(opts: { target?: string; noKeychain: boolean }): LinearDeployment {
  if (opts.target === undefined) {
    const cfg = loadConfig(CONFIG_PATH);
    const app = githubAppOf(cfg.integrations);
    return {
      deployment: { kind: "compose" },
      configPath: CONFIG_PATH,
      linear: cfg.integrations.linear,
      ...(app ? { githubApp: app } : {}),
      ...(cfg.publicUrl !== undefined ? { publicUrl: cfg.publicUrl } : {}),
      applyCommand: "bun run up",
      statusCommand: "bun run linear:status",
      api: composeApi,
    };
  }

  const path = resolve(opts.target);
  const target = loadTarget(path);
  const byo = existingSecret(target.values, "integrations");
  const app = githubAppOf(target.integrations ?? {});
  const apply = installCommand(target.context, path);
  return {
    deployment: { kind: "k8s", context: target.context, namespace: NAMESPACE },
    configPath: path,
    linear: target.integrations?.linear,
    ...(app ? { githubApp: app } : {}),
    ...(target.publicUrl !== undefined ? { publicUrl: target.publicUrl } : {}),
    ingressUrl: ingressPublicUrl(target),
    fromApiIngress: ingressSource(target) === "api",
    applyCommand: apply,
    statusCommand: `bun run linear:status --target ${path}`,
    ...(byo !== undefined ? { byoIntegrationsSecret: byo } : {}),
    api: k8sApi(target, apply),
  };
}
