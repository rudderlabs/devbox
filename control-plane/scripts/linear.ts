// The Linear integration:
//   bun run linear:setup [--target <file>] [--public-url <url>] [--name <app name>]
//                        [--reregister] [--no-keychain]
//   bun run linear:status  [--target <file>] [--no-keychain]
//   bun run linear:disable [--target <file>] [--no-keychain] [--forget [--yes]]
// Without --target it acts on the Compose deployment (devbox.config.json),
// with it on the k8s deployment that target file describes. Secret values are
// never printed.
import { parseArgs } from "node:util";
import { K8sPreflightError } from "./k8s/preflight";
import { KubeError } from "./k8s/run";
import { capture } from "./lib/capture";
import { DestructiveRefused } from "./lib/destructive";
import { keychainFor } from "./lib/keychain";
import { errorMessage, isKnownError } from "./lib/knownError";
import { openUrl } from "./lib/openUrl";
import type { ResolverDeps } from "./lib/secrets";
import { loadDeployment } from "./linear/deployment";
import { disable } from "./linear/disable";
import { SetupError, setup } from "./linear/setup";
import { status } from "./linear/status";
import { confirm, promptHidden, promptLine } from "./up/prompt";

const COMMANDS = ["setup", "status", "disable"];

const USAGE = `Usage:
  bun run linear:setup [--target <file>] [--public-url <url>] [--name <app name>]
                       [--reregister] [--no-keychain]

Registers a Linear app for devbox, saves its client ID and public URL in the
deployment's config and, if you choose, its secrets in the system keychain.
It applies nothing: it names the command that does (bun run up,
k8s:install with --target, or k8s:kind on kind).

  bun run linear:status  [--target <file>] [--no-keychain]
  bun run linear:disable [--target <file>] [--no-keychain] [--forget [--yes]]

status shows the configuration, where the secrets are found, what the control
plane reports and whether the webhook URL reaches devbox. disable switches
Linear off (enabled: false), keeping the app's settings and saved secrets so
that linear:setup turns it back on; it names the command that applies it.
--forget removes integrations.linear and the saved Linear secrets instead,
after you confirm (--yes confirms without a terminal); the app in Linear is
left for you to delete.

  --target <file>     the k8s deployment's target file (default: Compose)
  --public-url <url>  the public HTTPS URL Linear sends webhooks to
  --name <app name>   the app's name in Linear, when registering (default: devbox)
  --reregister        register a new app even if a client ID is configured
  --no-keychain       never read or write the system keychain
  --forget            disable: delete the configuration and saved secrets
  --yes               disable --forget: confirm without asking
`;

class UsageError extends Error {}

const log = (line: string) => process.stdout.write(`${line}\n`);

const SETUP_FLAGS = {
  target: { type: "string" },
  "public-url": { type: "string" },
  name: { type: "string" },
  reregister: { type: "boolean" },
  "no-keychain": { type: "boolean" },
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

async function main(command: string | undefined, argv: string[]): Promise<number> {
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (command) {
    case "setup": {
      const { values } = parseArgs({ args: argv, options: SETUP_FLAGS });
      if (values.help) {
        process.stdout.write(USAGE);
        return 0;
      }
      const noKeychain = values["no-keychain"] === true;
      const d = loadDeployment({ target: values.target, noKeychain });
      await setup(
        d,
        {
          publicUrl: values["public-url"],
          name: values.name ?? "devbox",
          reregister: values.reregister === true,
        },
        { resolver: resolverFor(d, noKeychain), promptLine, openUrl, fetch, log },
      );
      return 0;
    }
    case "status":
    case "disable": {
      const { values } = parseArgs({ args: argv, options: OTHER_FLAGS });
      if (values.help) {
        process.stdout.write(USAGE);
        return 0;
      }
      if (command === "status" && (values.forget || values.yes)) {
        throw new UsageError("--forget and --yes belong to linear:disable");
      }
      if (values.yes && !values.forget) throw new UsageError("--yes goes with --forget");
      const noKeychain = values["no-keychain"] === true;
      const d = loadDeployment({ target: values.target, noKeychain });
      const resolver = resolverFor(d, noKeychain);
      if (command === "status") await status(d, { resolver, fetch, log });
      else {
        await disable(
          d,
          { forget: values.forget === true, yes: values.yes === true },
          { resolver, log },
        );
      }
      return 0;
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
    process.stderr.write(`\nbun run linear:${command ?? ""}: ${errorMessage(err)}\n`);
    if (
      !isKnownError(
        err,
        UsageError,
        SetupError,
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
