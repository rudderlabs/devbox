// The user-supplied Secrets, created by the installer from the
// values it resolved itself unless the user names an existingSecret; nothing
// is taken from env here. Sent to kubectl as a manifest on stdin, so values
// never reach argv or disk. The installer label lets `k8s:uninstall --purge`
// delete exactly these, never the user's own.
import { KubeError, NAMESPACE } from "./run";
import type { Values } from "./values";

export type UserSecret = { name: string; data: Record<string, string> };

export const INSTALLER_LABEL = "app.kubernetes.io/managed-by=devbox-installer";
export const INTEGRATIONS_SECRET = "devbox-integrations";
export const GITHUB_SECRET = "devbox-github";
export const GITHUB_APP_SECRET = "devbox-github-app";

// The secrets of every integration, as env names, the keys of the
// integrations Secret. The installer resolves only those of enabled integrations.
export type IntegrationSecretName =
  | "LINEAR_CLIENT_SECRET"
  | "LINEAR_WEBHOOK_SECRET"
  | "SLACK_BOT_TOKEN"
  | "GITHUB_WEBHOOK_SECRET";

// The name of the user's own Secret for `key`, or undefined when the installer owns it.
export const existingSecret = (values: Values, key: string): string | undefined => {
  const secrets = values.secrets as Record<string, { existingSecret?: string }> | undefined;
  return secrets?.[key]?.existingSecret || undefined;
};

export function userSecrets(
  values: Values,
  tokens: {
    // The token Secret's data; none when the installer has no token to write.
    github?: { token: string; expiresAt?: string };
    // The GitHub App's private key, for its devbox-minted tokens.
    githubApp?: { pem: string };
    llm: string;
    integrations: Partial<Record<IntegrationSecretName, string>>;
  },
): UserSecret[] {
  const out: UserSecret[] = [];
  if (tokens.github && !existingSecret(values, "github")) {
    const { token, expiresAt } = tokens.github;
    out.push({
      name: GITHUB_SECRET,
      data: { token, ...(expiresAt !== undefined ? { "expires-at": expiresAt } : {}) },
    });
  }
  if (tokens.githubApp && !existingSecret(values, "githubApp")) {
    out.push({ name: GITHUB_APP_SECRET, data: { "private-key": tokens.githubApp.pem } });
  }
  if (!existingSecret(values, "llm")) {
    if (!tokens.llm) {
      throw new KubeError(
        "Kubernetes installs need a non-empty LLM API key (LLM_API_KEY): iron-proxy cannot serve an empty one",
      );
    }
    out.push({ name: "devbox-llm", data: { "api-key": tokens.llm } });
  }
  if (!existingSecret(values, "integrations")) {
    const data = tokens.integrations as Record<string, string>;
    if (Object.keys(data).length > 0) out.push({ name: INTEGRATIONS_SECRET, data });
  }
  return out;
}

export function secretManifest(s: UserSecret): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: s.name,
      namespace: NAMESPACE,
      labels: {
        "app.kubernetes.io/part-of": "devbox",
        "app.kubernetes.io/managed-by": "devbox-installer",
      },
    },
    data: Object.fromEntries(
      Object.entries(s.data).map(([k, v]) => [k, Buffer.from(v).toString("base64")]),
    ),
  });
}
