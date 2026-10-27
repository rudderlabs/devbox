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
