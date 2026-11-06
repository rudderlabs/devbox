// Sandbox runtime settings. Pure: takes the env, so it is
// testable without mocking ../config. config.ts calls it at startup; a bad
// value fails boot. Empty values count as unset.

export type SandboxRuntime = "k8s" | "docker";

export type SandboxRuntimeConfig = {
  sandboxRuntime: SandboxRuntime;
  baseImage: string;
  sandboxResourceMemory: string;
  pvcNamespace: string;
  pvcStorageClass: string;
};

export function parseSandboxRuntimeConfig(
  env: Record<string, string | undefined>,
): SandboxRuntimeConfig {
  // docker by default, so a bare `bun run` of the control plane works; the
  // chart and docker-compose.yml set it explicitly.
  const runtime = env.SANDBOX_RUNTIME || "docker";
  if (runtime !== "k8s" && runtime !== "docker") {
    throw new Error(`SANDBOX_RUNTIME must be "k8s" or "docker" (got "${runtime}")`);
  }
  // No default: storage classes differ per cluster.
  const pvcStorageClass = env.PVC_STORAGE_CLASS?.trim() ?? "";
  if (runtime === "k8s" && !pvcStorageClass) {
    throw new Error("PVC_STORAGE_CLASS is required when SANDBOX_RUNTIME=k8s");
  }
  return {
    sandboxRuntime: runtime,
    // The tag `make -C harness build IRON_PROXY_CA=...` produces.
    baseImage: env.SANDBOX_IMAGE || "devbox-dev:local",
    sandboxResourceMemory: env.SANDBOX_RESOURCE_MEMORY || "8Gi",
    pvcNamespace: env.PVC_NAMESPACE || "devbox-sandboxes",
    pvcStorageClass,
  };
}

export type GitIdentity = { name: string; email: string };

// The commit identity sandboxes use (GIT_AUTHOR_* / GIT_COMMITTER_*). The
// local image bakes one in; on Kubernetes the chart sets these.
export function parseSandboxGitIdentity(
  env: Record<string, string | undefined>,
): GitIdentity | undefined {
  const name = env.SANDBOX_GIT_NAME?.trim();
  const email = env.SANDBOX_GIT_EMAIL?.trim();
  if (!name && !email) return undefined;
  if (!name || !email) {
    throw new Error("SANDBOX_GIT_NAME and SANDBOX_GIT_EMAIL must be set together");
  }
  return { name, email };
}

// The commit identity for repos on the GitLab instance (the chart's
// gitlab.git, the installer's from the token's user). A sandbox has one
// identity of its own, the GitHub user's or App bot's; without this one,
// commits on GitLab would carry that GitHub name. Both or neither.
export function parseSandboxGitlabGitIdentity(
  env: Record<string, string | undefined>,
): GitIdentity | undefined {
  const name = env.SANDBOX_GITLAB_GIT_NAME?.trim();
  const email = env.SANDBOX_GITLAB_GIT_EMAIL?.trim();
  if (!name && !email) return undefined;
  if (!name || !email) {
    throw new Error("SANDBOX_GITLAB_GIT_NAME and SANDBOX_GITLAB_GIT_EMAIL must be set together");
  }
  return { name, email };
}

// The one self-managed GitLab instance sandboxes may push to and open merge
// requests on (GITLAB_BASE_URL; the chart sets it from gitlab.baseUrl).
// Normalised to scheme://host[/prefix] with no trailing slash, so the harness,
// the proxy allowlist and the snapshot builder all compare the same string.
// Undefined when GitLab is not configured. Like llm.baseUrl, it must use the
// default port: iron-proxy intercepts only 80 and 443.
export function parseGitlabBaseUrl(env: Record<string, string | undefined>): string | undefined {
  const raw = env.GITLAB_BASE_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`GITLAB_BASE_URL must be an http(s) URL (got "${raw}")`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`GITLAB_BASE_URL must be an http(s) URL (got "${raw}")`);
  }
  if (url.port) {
    throw new Error(`GITLAB_BASE_URL must use the default port (80 or 443), got ${url.port}`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error("GITLAB_BASE_URL must not have a query, fragment or credentials");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
