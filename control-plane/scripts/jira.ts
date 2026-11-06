// The Jira integration:
//   bun run jira:setup [--target <file>] [--public-url <url>] [--site <url>]
//                      [--email <address>] [--token-expires <YYYY-MM-DD>]
//                      [--no-keychain]
//   bun run jira:status  [--target <file>] [--no-keychain]
//   bun run jira:disable [--target <file>] [--no-keychain] [--forget [--yes]]
// Without --target it acts on the Compose deployment (devbox.config.json),
// with it on the k8s deployment that target file describes. Secret values are
// never logged; a webhook secret setup generates is shown once on the
// terminal, to paste into Jira.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { loadDeployment } from "./jira/deployment";
import { disable } from "./jira/disable";
import { SetupError, setup } from "./jira/setup";
import { status } from "./jira/status";
import { K8sPreflightError } from "./k8s/preflight";
import { KubeError } from "./k8s/run";
import { capture } from "./lib/capture";
import { DestructiveRefused } from "./lib/destructive";
import { keychainFor } from "./lib/keychain";
import { errorMessage, isKnownError } from "./lib/knownError";
import { openUrl } from "./lib/openUrl";
import type { ResolverDeps } from "./lib/secrets";
import { confirm, promptHidden, promptLine } from "./up/prompt";

const COMMANDS = ["setup", "status", "disable"];

const USAGE = `Usage:
  bun run jira:setup [--target <file>] [--public-url <url>] [--site <url>]
                     [--email <address>] [--token-expires <YYYY-MM-DD>]
                     [--no-keychain]

Connects devbox to a Jira Cloud site through a service account: checks its
API token (from JIRA_API_TOKEN, the system keychain or a hidden prompt) and
its permissions, saves the settings in the deployment's config and, if you
choose, the token and the webhook secret in the system keychain, and prints
the webhook a Jira admin creates. It applies nothing: it names the command
that does (bun run up, k8s:install with --target, or k8s:kind on kind).

  bun run jira:status  [--target <file>] [--no-keychain]
  bun run jira:disable [--target <file>] [--no-keychain] [--forget [--yes]]

status shows the configuration, where the secrets are found, what the control
plane reports and whether the webhook URL reaches devbox. disable switches
Jira off (enabled: false), keeping its settings and saved secrets so that
jira:setup turns it back on; it names the command that applies it. --forget
removes integrations.jira and the saved Jira secrets instead, after you
confirm (--yes confirms without a terminal). Either way, disable the webhook
in Jira yourself.

  --target <file>          the k8s deployment's target file (default: Compose)
  --public-url <url>       the public HTTPS URL Jira sends webhooks to
  --site <url>             the Jira site, e.g. https://example.atlassian.net
  --email <address>        the service account's email
  --token-expires <date>   when the API token expires, e.g. 2027-01-31
  --no-keychain            never read or write the system keychain
  --forget                 disable: delete the configuration and saved secrets
  --yes                    disable --forget: confirm without asking
`;

class UsageError extends Error {}

const log = (line: string) => process.stdout.write(`${line}\n`);

const SETUP_FLAGS = {
  target: { type: "string" },
  "public-url": { type: "string" },
  site: { type: "string" },
  email: { type: "string" },
  "token-expires": { type: "string" },
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
        {
          publicUrl: values["public-url"],
          site: values.site,
          email: values.email,
          tokenExpires: values["token-expires"],
        },
        {
          resolver: resolverFor(d, values["no-keychain"] === true),
          promptLine,
          fetch,
          random: (bytes) => randomBytes(bytes).toString("hex"),
          // The terminal, not the log: shown once, for the user to copy.
          show: (secret) => process.stderr.write(`${secret}\n`),
          openUrl,
          now: () => new Date(),
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
        throw new UsageError("--forget and --yes belong to jira:disable");
      }
      if (values.yes && !values.forget) throw new UsageError("--yes goes with --forget");
      const d = loadDeployment({ target: values.target });
      const resolver = resolverFor(d, values["no-keychain"] === true);
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
    process.stderr.write(`\nbun run jira:${command ?? ""}: ${errorMessage(err)}\n`);
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
