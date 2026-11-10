// devbox.config.json and a target file → chart values. The
// target's values are chart values, verbatim. The installer adds only what it
// knows from devbox.config.json and from the cluster; an overlay (kind's
// settings) sits in between; values the user set always win.
import type { Integrations } from "../lib/integrations";
import type { DevboxConfig } from "../up/config";
import type { Identity } from "../up/preflight";
import type { Target } from "./target";

export type Values = Record<string, unknown>;
export type InstallerValues = {
  clusterIP?: string;
  publicBaseUrl?: string;
  identity?: Identity;
  // The target file's integrations block.
  integrations?: Integrations;
  // The GitLab Secrets the installer wrote: the token Secret (none when the
  // user brings one) and the CA bundle (none without gitlab.caFile).
  gitlabSecret?: string;
  gitlabCaSecret?: string;
  // The commit identity for GitLab repos (the token's GitLab user).
  gitlabGit?: Identity;
};

const isPlainObject = (v: unknown): v is Values =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function deepMerge(base: Values, top: Values): Values {
  const out: Values = { ...base };
  for (const [key, value] of Object.entries(top)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

// The block as chart values, verbatim; nothing when it is empty.
function integrationValues(integrations: Integrations = {}): Values {
  const { linear, slack, githubApp, gitlab } = integrations;
  const out: Values = {
    ...(linear
      ? {
          linear: {
            enabled: linear.enabled,
            ...(linear.clientId !== undefined ? { clientId: linear.clientId } : {}),
          },
        }
      : {}),
    ...(slack ? { slack } : {}),
    // The slug becomes the control plane's botLogin; tokenFile is Compose-only and org is for the CLI's links.
    ...(githubApp
      ? {
          githubApp: {
            enabled: githubApp.enabled,
            ...(githubApp.appId !== undefined ? { appId: githubApp.appId } : {}),
            ...(githubApp.slug !== undefined ? { botLogin: githubApp.slug } : {}),
            ...(githubApp.installationId !== undefined
              ? { installationId: githubApp.installationId }
              : {}),
            ...(githubApp.botUserId !== undefined ? { botUserId: githubApp.botUserId } : {}),
            ...(githubApp.tokens !== undefined ? { tokens: githubApp.tokens } : {}),
            tokenScope: githubApp.tokenScope,
            ciResults: githubApp.ciResults,
          },
        }
      : {}),
    // webhookAuth names the Secret key; the chart reads whichever is set.
    ...(gitlab
      ? {
          gitlab: {
            enabled: gitlab.enabled,
            ...(gitlab.botUsername !== undefined ? { botUsername: gitlab.botUsername } : {}),
            ...(gitlab.botUserId !== undefined ? { botUserId: gitlab.botUserId } : {}),
            ciResults: gitlab.ciResults,
          },
        }
      : {}),
  };
  return Object.keys(out).length > 0 ? { integrations: out } : {};
}

function llmValues(llm: DevboxConfig["llm"]): Values {
  const stages: Values = {};
  for (const [stage, setting] of Object.entries(llm.stages ?? {})) {
    const fields = {
      ...(setting.model !== undefined ? { model: setting.model } : {}),
      ...(setting.reasoningEffort !== undefined
        ? { reasoningEffort: setting.reasoningEffort }
        : {}),
    };
    if (Object.keys(fields).length > 0) stages[stage] = fields;
  }
  return {
    provider: llm.provider,
    baseUrl: llm.baseUrl,
    model: llm.model,
    ...(llm.reasoningEffort !== undefined ? { reasoningEffort: llm.reasoningEffort } : {}),
    ...(Object.keys(stages).length > 0 ? { stages } : {}),
  };
}

export function chartValues(
  cfg: DevboxConfig,
  user: Values,
  extra: InstallerValues,
  overlay: Values = {},
): Values {
  const ours: Values = {
    repos: cfg.repos.map(({ url, branch }) => ({ url, branch })),
    llm: llmValues(cfg.llm),
    ...(cfg.gitlab
      ? {
          gitlab: {
            baseUrl: cfg.gitlab.baseUrl,
            ...(extra.gitlabGit
              ? { git: { name: extra.gitlabGit.gitName, email: extra.gitlabGit.gitEmail } }
              : {}),
          },
        }
      : {}),
    ...(extra.gitlabSecret ? { secrets: { gitlab: { existingSecret: extra.gitlabSecret } } } : {}),
    ...(extra.clusterIP || extra.gitlabCaSecret
      ? {
          ironProxy: {
            ...(extra.clusterIP ? { clusterIP: extra.clusterIP } : {}),
            ...(extra.gitlabCaSecret ? { caBundle: extra.gitlabCaSecret } : {}),
          },
        }
      : {}),
    ...(extra.publicBaseUrl ? { controlPlane: { publicBaseUrl: extra.publicBaseUrl } } : {}),
    ...(extra.identity
      ? { git: { name: extra.identity.gitName, email: extra.identity.gitEmail } }
      : {}),
    ...integrationValues(extra.integrations),
  };
  return deepMerge(deepMerge(ours, overlay), user);
}

export function userValue(target: Pick<Target, "values">, path: string[]): unknown {
  let v: unknown = target.values;
  for (const key of path) v = isPlainObject(v) ? v[key] : undefined;
  return v;
}

// The URL of the api Ingress (the one that routes /, the API included), or
// undefined when there is none. The scheme follows the chart: https when the
// Ingress has TLS. When controlPlane.publicBaseUrl names the same host (TLS
// terminated at a load balancer, so `tls` is empty), its origin wins.
export function apiIngressUrl(target: Pick<Target, "values">): string | undefined {
  const api = userValue(target, ["ingress", "api"]);
  if (!isPlainObject(api) || api.enabled !== true) return undefined;
  if (typeof api.host !== "string" || api.host === "") return undefined;
  const base = userValue(target, ["controlPlane", "publicBaseUrl"]);
  if (typeof base === "string") {
    try {
      const u = new URL(base);
      if (u.hostname === api.host) return u.origin;
    } catch {
      // not a URL: fall through to the Ingress rule
    }
  }
  return `${Array.isArray(api.tls) && api.tls.length > 0 ? "https" : "http"}://${api.host}`;
}
