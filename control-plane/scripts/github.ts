// The GitHub App:
//   bun run github:setup [--target <file>] [--public-url <url>] [--org <org>]
//                        [--name <app name>] [--external-tokens]
//                        [--app-id <id> [--private-key-file <path>]]
//                        [--reregister] [--no-keychain] [--print-registration-link]
//   bun run github:status  [--target <file>] [--no-keychain]
//   bun run github:disable [--target <file>] [--no-keychain] [--forget [--yes]]
// Without --target it acts on the Compose deployment (devbox.config.json),
// with it on the k8s deployment that target file describes. The App's key and
// webhook secret are never printed to the log.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { GithubAppError } from "../src/githubToken/mint";
import { AppApiError } from "./github/appApi";
import { loadDeployment } from "./github/deployment";
import { disable } from "./github/disable";
import { CallbackError, startCallbackListener } from "./github/listener";
import { SetupError, setup } from "./github/setup";
import { status } from "./github/status";
import { K8sPreflightError } from "./k8s/preflight";
import { KubeError } from "./k8s/run";
import { capture } from "./lib/capture";
import { DestructiveRefused } from "./lib/destructive";
import { keychainFor } from "./lib/keychain";
import { errorMessage, isKnownError } from "./lib/knownError";
import { openUrl } from "./lib/openUrl";
import type { ResolverDeps } from "./lib/secrets";
import { confirm, promptHidden, promptLine, watchEnter } from "./up/prompt";

const COMMANDS = ["setup", "status", "disable"];

const USAGE = `Usage:
  bun run github:setup [--target <file>] [--public-url <url>] [--org <org>]
                       [--name <app name>] [--external-tokens]
                       [--app-id <id> [--private-key-file <path>]]
                       [--reregister] [--no-keychain] [--print-registration-link]

Registers a GitHub App for devbox (your browser opens GitHub's pre-filled
create page), saves its private key and webhook secret, waits for you to
install it, and writes its settings, the public URL and a default trust list
to the deployment's config. It applies nothing: it names the command that
does (bun run up, k8s:install with --target, or k8s:kind on kind).

  --target <file>          the k8s deployment's target file (default: Compose)
  --public-url <url>       the public HTTPS URL GitHub sends webhooks to
  --org <org>              register the App under this organization
                           (default: your account)
  --name <app name>        the App's name on GitHub (default: devbox)
  --external-tokens        your own tooling mints the App's tokens, not devbox
  --app-id <id>            adopt an existing App instead of registering one
  --private-key-file <path>  that App's private key (default: GITHUB_APP_PRIVATE_KEY_FILE,
                           GITHUB_APP_PRIVATE_KEY, then the keychain)
  --reregister             register a new App even if one is configured
  --no-keychain            never read or write the system keychain
  --print-registration-link
                           for a machine without a browser: print a link that
                           creates the App, then adopt it with --app-id

  bun run github:status  [--target <file>] [--no-keychain]
  bun run github:disable [--target <file>] [--no-keychain] [--forget [--yes]]

status shows the configuration, where the key and webhook secret are found,
what the control plane reports and whether the webhook URL reaches devbox.
disable switches the App off (enabled: false), keeping its settings and saved
secrets so that github:setup turns it back on; GitHub then uses a personal
token. --forget removes integrations.githubApp and the saved App key and
webhook secret instead, after you confirm (--yes confirms without a terminal);
the App on GitHub is left for you to delete.

  --forget                 disable: delete the configuration and saved secrets
  --yes                    disable --forget: confirm without asking
`;

class UsageError extends Error {}

const log = (line: string) => process.stdout.write(`${line}\n`);

const SETUP_FLAGS = {
  target: { type: "string" },
  "public-url": { type: "string" },
  org: { type: "string" },
  name: { type: "string" },
  "external-tokens": { type: "boolean" },
  "app-id": { type: "string" },
  "private-key-file": { type: "string" },
  reregister: { type: "boolean" },
  "no-keychain": { type: "boolean" },
  "print-registration-link": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const OTHER_FLAGS = {
  target: { type: "string" },
  "no-keychain": { type: "boolean" },
  forget: { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function resolverFor(d: ReturnType<typeof loadDeployment>, noKeychain: boolean): ResolverDeps {
  return {
    env: process.env,
    keychain: keychainFor(noKeychain),
    deployment: d.deployment,
    ...(d.deployment.kind === "k8s" ? { targetPath: d.configPath } : {}),
    isTTY: process.stdin.isTTY === true,
    prompt: promptHidden,
    confirm,
    run: (cmd) => capture(cmd),
    log,
  };
}

function appIdFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) throw new UsageError(`--app-id: a positive number, got "${raw}"`);
  return Number(raw);
}

async function main(command: string | undefined, argv: string[]): Promise<number> {
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "status" || command === "disable") {
    const { values } = parseArgs({ args: argv, options: OTHER_FLAGS });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (command === "status" && (values.forget || values.yes)) {
      throw new UsageError("--forget and --yes belong to github:disable");
    }
    if (values.yes && !values.forget) throw new UsageError("--yes goes with --forget");
    const noKeychain = values["no-keychain"] === true;
    const d = loadDeployment({ target: values.target, noKeychain });
    const resolver = resolverFor(d, noKeychain);
    if (command === "status") {
      await status(d, { resolver, fetch, now: () => new Date(), log });
    } else {
      await disable(
        d,
        { forget: values.forget === true, yes: values.yes === true },
        { resolver, log },
      );
    }
    return 0;
  }
  if (command !== "setup") {
    throw new UsageError(`unknown command "${command ?? ""}": use one of ${COMMANDS.join(", ")}`);
  }
  const { values } = parseArgs({ args: argv, options: SETUP_FLAGS });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const appId = appIdFlag(values["app-id"]);
  if (values["private-key-file"] !== undefined && appId === undefined) {
    throw new UsageError("--private-key-file goes with --app-id");
  }
  if (values["print-registration-link"] && appId !== undefined) {
    throw new UsageError(
      "--print-registration-link registers a new App; --app-id adopts one: use one of them",
    );
  }
  if (values.reregister && appId !== undefined) {
    throw new UsageError("--reregister registers a new App; --app-id adopts one: use one of them");
  }
  const noKeychain = values["no-keychain"] === true;
  const d = loadDeployment({ target: values.target, noKeychain });
  const resolver = resolverFor(d, noKeychain);
  await setup(
    d,
    {
      publicUrl: values["public-url"],
      ...(values.org !== undefined ? { org: values.org } : {}),
      name: values.name ?? "devbox",
      externalTokens: values["external-tokens"] === true,
      ...(appId !== undefined ? { appId } : {}),
      ...(values["private-key-file"] !== undefined
        ? { privateKeyFile: values["private-key-file"] }
        : {}),
      reregister: values.reregister === true,
      printRegistrationLink: values["print-registration-link"] === true,
    },
    {
      resolver,
      promptLine,
      openUrl,
      fetch,
      now: () => new Date(),
      sleep: (ms) => Bun.sleep(ms),
      enter: () => watchEnter(),
      listen: startCallbackListener,
      random: (bytes) => randomBytes(bytes).toString("hex"),
      cwd: process.cwd(),
      // The terminal, not the log: shown once, for the user to copy.
      show: (secret) => process.stderr.write(`${secret}\n`),
      log,
    },
  );
  return 0;
}

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  try {
    process.exit(await main(command, argv));
  } catch (err) {
    process.stderr.write(`\nbun run github:${command ?? ""}: ${errorMessage(err)}\n`);
    if (
      !isKnownError(
        err,
        UsageError,
        SetupError,
        CallbackError,
        AppApiError,
        GithubAppError,
        KubeError,
        K8sPreflightError,
        DestructiveRefused,
      ) &&
      err instanceof Error &&
      err.stack
    ) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  }
}
