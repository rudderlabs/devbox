// `bun run k8s:uninstall --target <file> [--purge [--yes]]` removes the release
// and the CLI profile. --purge lists what it deletes and
// asks first (before anything runs); without a terminal it needs --yes. It
// deletes the sandbox namespace
// (task volumes and snapshots), the Secrets the chart generated or the
// installer created, and the Postgres volume. It never deletes a Secret by
// any other name or selector, so Secrets named by existingSecret survive,
// and with them the devbox namespace.
import { confirmDestructive, type DestructiveDeps } from "../lib/destructive";
import { cliConfigPath, readCliProfile, removeCliProfile } from "../up/cliLogin";
import { profileFor } from "./connect";
import { KubeError, kube, NAMESPACE, RELEASE, type Runner, SANDBOX_NAMESPACE } from "./run";
import { INSTALLER_LABEL } from "./secrets";
import type { Target } from "./target";

// Made by the chart's bootstrap Job; Helm does not own them.
const GENERATED_SECRETS = ["devbox-opensandbox", "devbox-postgres", "devbox-iron-proxy-ca"];

export type UninstallDeps = {
  runner: Runner;
  target: Target;
  env: Record<string, string | undefined>;
  home: string;
  isTTY: boolean;
  confirm: DestructiveDeps["confirm"];
  log: (line: string) => void;
};

export async function uninstall(
  deps: UninstallDeps,
  opts: { purge: boolean; yes: boolean },
): Promise<void> {
  const { log } = deps;
  const context = deps.target.context;
  if (opts.purge) {
    const go = await confirmDestructive(
      {
        command: "k8s:uninstall --purge",
        items: [
          `namespace ${SANDBOX_NAMESPACE}, with every task volume and repo snapshot`,
          `Secrets ${GENERATED_SECRETS.join(", ")}`,
          `the Secrets the installer created (label ${INSTALLER_LABEL})`,
          "the Postgres volume",
          `namespace ${NAMESPACE}, if no Secret of yours is left in it`,
        ],
        question: `Delete all of this in context ${context}? [y/N] `,
      },
      { yes: opts.yes, isTTY: deps.isTTY, confirm: deps.confirm, log },
    );
    if (!go) {
      log("Nothing was removed.");
      return;
    }
  }
  const k = kube(deps.runner, context);

  // Helm never deletes hooks; a failed install hook Job may still exist
  // (deleted by TTL after ten minutes): remove it so nothing references the
  // scratch PVC.
  await k.kubectlOk([
    "delete",
    "job",
    "devbox-snapshot-builder-install",
    "-n",
    SANDBOX_NAMESPACE,
    "--ignore-not-found",
    "--cascade=foreground",
    "--wait=true",
    "--timeout=2m",
  ]);
  const helm = await k.helm(["uninstall", RELEASE, "-n", NAMESPACE, "--wait"]);
  if (helm.code === 0) log(`removed the devbox release from context ${context}`);
  else if (/release: not found/.test(helm.stderr)) log(`no devbox release in context ${context}`);
  else throw new KubeError(`helm uninstall failed: ${helm.stderr.trim() || helm.stdout.trim()}`);

  if (opts.purge) {
    await k.kubectlOk([
      "delete",
      "namespace",
      SANDBOX_NAMESPACE,
      "--wait=true",
      "--timeout=10m",
      "--ignore-not-found",
    ]);
    await k.kubectlOk([
      "delete",
      "secret",
      ...GENERATED_SECRETS,
      "-n",
      NAMESPACE,
      "--ignore-not-found",
    ]);
    await k.kubectlOk(["delete", "secret", "-n", NAMESPACE, "-l", INSTALLER_LABEL]);
    await k.kubectlOk([
      "delete",
      "pvc",
      "-n",
      NAMESPACE,
      "-l",
      "app.kubernetes.io/component=postgres",
      "--ignore-not-found",
    ]);
    log(
      `deleted namespace ${SANDBOX_NAMESPACE}, the generated and installer-created Secrets and the Postgres volume`,
    );
    const left = (await k.kubectlOk(["get", "secrets", "-n", NAMESPACE, "-o", "name"]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (left.length === 0) {
      await k.kubectlOk(["delete", "namespace", NAMESPACE, "--wait=false", "--ignore-not-found"]);
      log(`deleted namespace ${NAMESPACE}`);
    } else {
      log(`kept namespace ${NAMESPACE}: it still holds Secrets you created (${left.join(", ")})`);
    }
  } else {
    log(
      `kept namespaces ${NAMESPACE} and ${SANDBOX_NAMESPACE}, their volumes and Secrets (--purge deletes them)`,
    );
  }

  const path = cliConfigPath(deps.env, deps.home);
  const profile = profileFor(deps.target);
  if (readCliProfile(path, profile)) {
    removeCliProfile(path, profile);
    log(`removed CLI profile "${profile}" from ${path}`);
  }
}
