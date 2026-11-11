// The ClickUp integration:
//   bun run clickup:setup [--target <file>] [--public-url <url>] [--team <id>]
//                         [--no-keychain]
//   bun run clickup:status  [--target <file>] [--no-keychain]
//   bun run clickup:disable [--target <file>] [--no-keychain] [--forget [--yes]]
// Without --target it acts on the Compose deployment (devbox.config.json),
// with it on the k8s deployment that target file describes. Secret values are
// never logged; a webhook secret setup doesn't save is shown once on the
// terminal.
import { parseArgs } from "node:util";
import { loadDeployment } from "./clickup/deployment";
import { disable } from "./clickup/disable";
import { SetupError, setup } from "./clickup/setup";
import { status } from "./clickup/status";
import { K8sPreflightError } from "./k8s/preflight";
import { KubeError } from "./k8s/run";
import { capture } from "./lib/capture";
import { DestructiveRefused } from "./lib/destructive";
import { keychainFor } from "./lib/keychain";
import { errorMessage, isKnownError } from "./lib/knownError";
import type { ResolverDeps } from "./lib/secrets";
import { confirm, promptHidden, promptLine } from "./up/prompt";

const COMMANDS = ["setup", "status", "disable"];

const USAGE = `Usage:
  bun run clickup:setup [--target <file>] [--public-url <url>] [--team <id>]
                        [--no-keychain]

Connects devbox to a ClickUp workspace through a bot, a member account: checks
its personal API token (from CLICKUP_API_TOKEN, the system keychain or a
hidden prompt) and its role, creates or updates the devbox webhook through
ClickUp's API, saves the settings in the deployment's config and, if you
choose, the token and the webhook secret in the system keychain. It applies
nothing: it names the command that does (bun run up, k8s:install with
--target, or k8s:kind on kind).

  bun run clickup:status  [--target <file>] [--no-keychain]
  bun run clickup:disable [--target <file>] [--no-keychain] [--forget [--yes]]

status shows the configuration, where the secrets are found, what the control
plane reports and whether the webhook URL reaches devbox. disable switches
ClickUp off (enabled: false), keeping its settings, its webhook and saved
secrets so that clickup:setup turns it back on; it names the command that
applies it. --forget instead deletes the devbox webhook in ClickUp (with the
bot's token from the environment or the keychain), integrations.clickup and
the saved ClickUp secrets, after you confirm (--yes confirms without a
terminal).

  --target <file>          the k8s deployment's target file (default: Compose)
  --public-url <url>       the public HTTPS URL ClickUp sends webhooks to
  --team <id>              the ClickUp workspace id, when the bot is in several
  --no-keychain            never read or write the system keychain
  --forget                 disable: delete the webhook, configuration and saved secrets
  --yes                    disable --forget: confirm without asking
`;

class UsageError extends Error {}

const log = (line: string) => process.stdout.write(`${line}\n`);

const SETUP_FLAGS = {
  target: { type: "string" },
  "public-url": { type: "string" },
  team: { type: "string" },
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
      const d = loadDeployment({ target: values.target });
      await setup(
        d,
        { publicUrl: values["public-url"], team: values.team },
        {
          resolver: resolverFor(d, values["no-keychain"] === true),
          promptLine,
          fetch,
          // The terminal, not the log: shown once, for the user to copy.
          show: (secret) => process.stderr.write(`${secret}\n`),
          log,
        },
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
        throw new UsageError("--forget and --yes belong to clickup:disable");
      }
      if (values.yes && !values.forget) throw new UsageError("--yes goes with --forget");
      const d = loadDeployment({ target: values.target });
      const resolver = resolverFor(d, values["no-keychain"] === true);
      if (command === "status") await status(d, { resolver, fetch, log });
      else {
        await disable(
          d,
          { forget: values.forget === true, yes: values.yes === true },
          { resolver, fetch, log },
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
    process.stderr.write(`\nbun run clickup:${command ?? ""}: ${errorMessage(err)}\n`);
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
