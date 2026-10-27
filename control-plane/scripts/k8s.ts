// The Kubernetes installer and its companion commands:
//   bun run k8s:install --target <file> [--render <path>] [--skip-push-check]
//                       [--skip-llm-check] [--skip-linear-check]
//                       [--skip-netpol-check | --netpol-check]
//                       [--timeout 15m] [--no-keychain]
//   bun run k8s:connect | k8s:refresh-snapshot | k8s:uninstall [--purge [--yes]] --target <file>
//   bun run k8s:kind [install flags]   (writes and uses devbox.kind.json)
//   bun run k8s:check --target <file> [--skip-push-check]   (reads the Secrets)
// The target file names the cluster; there is no fallback to the current
// kube context.
// Secrets are found as for `bun run up` (scripts/lib/secrets.ts): the
// environment, then the OS keychain entry for this cluster's context and
// namespace, then `gh auth token` for GITHUB_TOKEN, then a hidden prompt, after
// which the typed value may be saved in the keychain. --no-keychain never reads
// or writes it. Values reach the cluster only as Secrets, never a file. The
// Linear secrets are resolved only when the target file has
// `integrations.linear`; devbox.config.json's `integrations` is not read.
// With the target file's `integrations.githubApp` and devbox-minted tokens,
// the App's private key replaces GITHUB_TOKEN: GITHUB_APP_PRIVATE_KEY_FILE (a
// path), then GITHUB_APP_PRIVATE_KEY, then the keychain; never prompted.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { k8sCheck } from "./k8s/check";
import { backgroundPortForward, connect, foregroundPortForward, isPortFree } from "./k8s/connect";
import { type InstallDeps, type InstallOptions, install } from "./k8s/install";
import { KIND_TARGET, KIND_TARGET_FILE, kindSetup } from "./k8s/kind";
import { K8sPreflightError } from "./k8s/preflight";
import { refreshSnapshot } from "./k8s/refresh";
import { KubeError, kube, realRunner } from "./k8s/run";
import { loadTarget, type Target } from "./k8s/target";
import { uninstall } from "./k8s/uninstall";
import { keychainFor } from "./lib/keychain";
import { errorMessage, isKnownError } from "./lib/knownError";
import { loadConfig } from "./up/config";
import { confirm, promptHidden } from "./up/prompt";

const ROOT = join(import.meta.dir, "..", "..");
const CONFIG_PATH = join(ROOT, "devbox.config.json");
const COMMANDS = ["install", "kind", "connect", "refresh-snapshot", "uninstall", "check"];

const USAGE = `Usage:
  bun run k8s:install --target <file> [--render <path>] [--skip-push-check]
                      [--skip-llm-check] [--skip-linear-check]
                      [--skip-netpol-check | --netpol-check] [--timeout 15m] [--no-keychain]
  bun run k8s:kind [install flags]   (writes and uses devbox.kind.json)
  bun run k8s:connect --target <file>
  bun run k8s:refresh-snapshot --target <file>
  bun run k8s:uninstall --target <file> [--purge [--yes]]
  bun run k8s:check --target <file> [--skip-push-check]
      Checks the Secrets the chart uses and the credentials in them; needs read
      access to Secrets in namespace devbox. Never prints a value.
`;

class UsageError extends Error {}

const log = (line: string) => process.stdout.write(`${line}\n`);

const TARGET_FLAG = { target: { type: "string" } } as const;

export function requireTarget(values: { target?: string }): { path: string; target: Target } {
  if (!values.target) {
    throw new UsageError(
      "--target <file> is required: the file naming the cluster to act on (docs/kubernetes/README.md#1-configure)",
    );
  }
  const path = resolve(values.target);
  return { path, target: loadTarget(path) };
}

// `linear:setup` passes the Linear secrets it resolved in `env`.
export function installDeps(
  target: Target,
  targetPath: string,
  values: { "no-keychain"?: boolean },
  env: Record<string, string | undefined> = process.env,
): InstallDeps {
  return {
    runner: realRunner,
    // The integrations' settings come from the target file.
    cfg: loadConfig(CONFIG_PATH, { integrations: false }),
    target,
    targetPath,
    env,
    keychain: keychainFor(values["no-keychain"]),
    isTTY: process.stdin.isTTY === true,
    home: homedir(),
    fetch,
    log,
    sleep: Bun.sleep,
    now: () => new Date(),
    prompt: promptHidden,
    confirm,
    portForward: backgroundPortForward,
    isPortFree,
    writeFile: (path, text) => writeFileSync(path, text),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },
  };
}

// Parses the flags of `install` (and of `k8s:kind`, which passes them on).
export function installOptions(values: {
  render?: string;
  "skip-push-check"?: boolean;
  "skip-llm-check"?: boolean;
  "skip-linear-check"?: boolean;
  "skip-netpol-check"?: boolean;
  "netpol-check"?: boolean;
  timeout?: string;
}): InstallOptions {
  if (values["skip-netpol-check"] && values["netpol-check"]) {
    throw new UsageError("--skip-netpol-check and --netpol-check exclude each other");
  }
  return {
    render: values.render,
    skipPushCheck: values["skip-push-check"] === true,
    skipLlmCheck: values["skip-llm-check"] === true,
    skipLinearCheck: values["skip-linear-check"] === true,
    netpol: values["skip-netpol-check"] ? "skip" : values["netpol-check"] ? "force" : "auto",
    timeout: values.timeout ?? "15m",
  };
}

// k8s:kind picks its own target file: a --target would otherwise fail as an
// unknown option, which does not say why.
export function checkKindArgs(argv: string[]): void {
  if (argv.some((a) => a === "--target" || a.startsWith("--target="))) {
    throw new UsageError(
      "k8s:kind takes no --target: it writes and uses devbox.kind.json (values of an existing one are kept)",
    );
  }
}

export const INSTALL_FLAGS = {
  render: { type: "string" },
  "skip-push-check": { type: "boolean" },
  "skip-llm-check": { type: "boolean" },
  "skip-linear-check": { type: "boolean" },
  "skip-netpol-check": { type: "boolean" },
  "netpol-check": { type: "boolean" },
  timeout: { type: "string" },
  "no-keychain": { type: "boolean" },
} as const;

async function main(command: string | undefined, argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (command) {
    case "install": {
      const { values } = parseArgs({ args: argv, options: { ...INSTALL_FLAGS, ...TARGET_FLAG } });
      const { path, target } = requireTarget(values);
      const opts = installOptions(values);
      await install(installDeps(target, path, values), opts);
      return 0;
    }
    case "kind": {
      // No --target: k8s:kind writes its own, devbox.kind.json, keeping the
      // values of an existing one, and installs from it.
      checkKindArgs(argv);
      const { values } = parseArgs({ args: argv, options: INSTALL_FLAGS });
      const deps = installDeps(
        { ...KIND_TARGET, values: {} },
        join(ROOT, KIND_TARGET_FILE),
        values,
      );
      await kindSetup(deps, installOptions(values), {
        install,
        mkdtemp: () => mkdtempSync(join(tmpdir(), "devbox-csi-hostpath-")),
      });
      return 0;
    }
    case "connect": {
      const { values } = parseArgs({ args: argv, options: TARGET_FLAG });
      const { target } = requireTarget(values);
      return connect({
        runner: realRunner,
        target,
        env: process.env,
        home: homedir(),
        log,
        isPortFree,
        forwardForeground: foregroundPortForward,
      });
    }
    case "refresh-snapshot": {
      const { values } = parseArgs({ args: argv, options: TARGET_FLAG });
      const { target } = requireTarget(values);
      const k = kube(realRunner, target.context);
      await refreshSnapshot(k, { sleep: Bun.sleep, log, now: () => new Date() });
      return 0;
    }
    case "uninstall": {
      const { values } = parseArgs({
        args: argv,
        options: { ...TARGET_FLAG, purge: { type: "boolean" }, yes: { type: "boolean" } },
      });
      if (values.yes && !values.purge) throw new UsageError("--yes goes with --purge");
      const { target } = requireTarget(values);
      await uninstall(
        {
          runner: realRunner,
          target,
          env: process.env,
          home: homedir(),
          isTTY: process.stdin.isTTY === true,
          confirm,
          log,
        },
        { purge: values.purge === true, yes: values.yes === true },
      );
      return 0;
    }
    case "check": {
      const { values } = parseArgs({
        args: argv,
        options: { ...TARGET_FLAG, "skip-push-check": { type: "boolean" } },
      });
      const { path, target } = requireTarget(values);
      return k8sCheck(
        {
          // The integrations' settings come from the target file.
          cfg: loadConfig(CONFIG_PATH, { integrations: false }),
          target,
          targetPath: path,
          runner: realRunner,
          fetch,
          log,
        },
        { skipPushCheck: values["skip-push-check"] === true },
      );
    }
    default:
      throw new UsageError(`unknown command "${command ?? ""}": use one of ${COMMANDS.join(", ")}`);
  }
}

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  try {
    process.exit(await main(command, argv));
  } catch (err) {
    process.stderr.write(`\nbun run k8s:${command ?? ""}: ${errorMessage(err)}\n`);
    if (
      !isKnownError(err, UsageError, KubeError, K8sPreflightError) &&
      err instanceof Error &&
      err.stack
    ) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  }
}
