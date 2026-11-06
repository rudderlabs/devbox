// The GitLab integration (Kubernetes only):
//   bun run gitlab:setup --target <file> [--public-url <url>]
//                        [--trusted-group <group>]... [--trusted-user <name>]...
//                        [--secret-token] [--bot-username <name> --bot-user-id <id>]
//                        [--skip-webhook] [--skip-push-check] [--no-keychain]
//   bun run gitlab:status  --target <file> [--no-keychain]
//   bun run gitlab:disable --target <file> [--no-keychain] [--forget [--yes]]
// Secret values are never printed, except the webhook token setup generated,
// once, when it could not be saved.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { GitlabCheckError } from "./gitlab/check";
import { GitlabDeploymentError, loadDeployment } from "./gitlab/deployment";
import { disable } from "./gitlab/disable";
import { SetupError, setup } from "./gitlab/setup";
import { status } from "./gitlab/status";
import { K8sPreflightError } from "./k8s/preflight";
import { KubeError } from "./k8s/run";
import { TargetError } from "./k8s/target";
import { capture } from "./lib/capture";
import { DestructiveRefused } from "./lib/destructive";
import { keychainFor } from "./lib/keychain";
import { errorMessage, isKnownError } from "./lib/knownError";
import { PublicUrlError } from "./lib/publicUrl";
import type { ResolverDeps } from "./lib/secrets";
import { SecretError } from "./lib/secrets";
import { ConfigError } from "./up/config";
import { PreflightError } from "./up/preflight";
import { confirm, promptHidden, promptLine } from "./up/prompt";

const COMMANDS = ["setup", "status", "disable"];

const USAGE = `Usage:
  bun run gitlab:setup [--target <file>] [--public-url <url>]
                       [--trusted-group <group>]... [--trusted-user <name>]...
                       [--secret-token] [--bot-username <name> --bot-user-id <id>]
                       [--skip-webhook] [--skip-push-check] [--no-keychain]

Checks the GitLab token against the instance in devbox.config.json (gitlab.baseUrl)
and the repos under it, learns the bot's identity from it, registers a webhook
on each project (comments and pipelines) with a token it generates, saves the
settings in devbox.config.json (Compose) or the target file (Kubernetes) and,
if you choose, the secrets in the system keychain. It applies nothing: it names
the command that does (bun run up, or k8s:install).

  bun run gitlab:status  [--target <file>] [--no-keychain]
  bun run gitlab:disable [--target <file>] [--no-keychain] [--forget [--yes]]

status shows the configuration, where the secrets are found, what the control
plane reports and whether the webhook URL reaches devbox. disable switches the
webhooks off (enabled: false), keeping the settings and saved secrets so that
gitlab:setup turns them back on. --forget removes integrations.gitlab, the
trust lists and the saved GitLab secrets instead, after you confirm (--yes
confirms without a terminal); the webhooks in GitLab are left for you to delete.

  --target <file>          a k8s deployment's target file; without it, the Compose stack
  --public-url <url>       the public HTTPS URL GitLab sends webhooks to
  --trusted-group <group>  a group (or group/subgroup) whose members may drive devbox
  --trusted-user <name>    a username who may drive devbox
  --secret-token           verify webhooks with the legacy secret token (X-Gitlab-Token)
  --bot-username, --bot-user-id  the bot, when the token is in your own Secret
  --skip-webhook           do not register the webhooks (create them by hand)
  --skip-push-check        do not check push and merge request access
  --no-keychain            never read or write the system keychain
  --forget                 disable: delete the configuration and saved secrets
  --yes                    disable --forget: confirm without asking
`;

class UsageError extends Error {}

const log = (line: string) => process.stdout.write(`${line}\n`);

const SETUP_FLAGS = {
  target: { type: "string" },
  "public-url": { type: "string" },
  "trusted-group": { type: "string", multiple: true },
  "trusted-user": { type: "string", multiple: true },
  "secret-token": { type: "boolean" },
  "bot-username": { type: "string" },
  "bot-user-id": { type: "string" },
  "skip-webhook": { type: "boolean" },
  "skip-push-check": { type: "boolean" },
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
    targetPath: d.configPath,
    isTTY: process.stdin.isTTY === true,
    prompt: promptHidden,
    confirm,
    run: (cmd) => capture(cmd),
    log,
  };
}

const readFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

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
      const rawId = values["bot-user-id"];
      const botUserId = rawId === undefined ? undefined : Number(rawId);
      if (botUserId !== undefined && !(Number.isInteger(botUserId) && botUserId > 0)) {
        throw new UsageError("--bot-user-id must be a positive integer");
      }
      await setup(
        d,
        {
          publicUrl: values["public-url"],
          trustedGroups: values["trusted-group"] ?? [],
          trustedUsers: values["trusted-user"] ?? [],
          secretToken: values["secret-token"] === true,
          botUsername: values["bot-username"],
          botUserId,
          skipWebhook: values["skip-webhook"] === true,
          skipPushCheck: values["skip-push-check"] === true,
        },
        { resolver: resolverFor(d, noKeychain), promptLine, fetch, log, readFile },
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
        throw new UsageError("--forget and --yes belong to gitlab:disable");
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
    process.stderr.write(`\nbun run gitlab:${command ?? ""}: ${errorMessage(err)}\n`);
    if (
      !isKnownError(
        err,
        UsageError,
        SetupError,
        GitlabDeploymentError,
        GitlabCheckError,
        PreflightError,
        SecretError,
        PublicUrlError,
        ConfigError,
        TargetError,
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
