// `bun run quickstart`: from devbox.config.json to a running local devbox, on
// Docker Compose or a kind cluster, with the GitHub App and Linear if chosen.
// Without the file it asks for the repos and the LLM and writes it
// (quickstart/createConfig.ts); an existing one is only reported. Then it asks
// what the flags leave open, checks the tools the platform needs, then runs the
// existing commands: the start command (`up` or `k8s:kind`), each chosen
// integration's setup, and the start command again to apply them
// (quickstart/steps.ts). Each of those is safe to re-run, so after a failure
// the fix is to run the quickstart again.
//
//   bun run quickstart [--compose | --kind] [--[no-]github-app] [--[no-]linear]
//                      [--public-url <url>] [--no-keychain]
//
// An omitted choice is asked for, never taken as "no"; without a terminal the
// quickstart stops and names the flags to pass.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { KIND_TARGET_FILE } from "./k8s/kind";
import { loadTarget } from "./k8s/target";
import { capture } from "./lib/capture";
import { enabledGithubApp, enabledLinear, type Integrations } from "./lib/integrations";
import { errorMessage, isKnownError } from "./lib/knownError";
import { PublicUrlError, validatePublicUrl } from "./lib/publicUrl";
import {
  ChoiceError,
  type ChoiceFlags,
  chooseIntegration,
  choosePlatform,
  type Enabled,
  type Platform,
  requireDecidable,
} from "./quickstart/choices";
import { ConfigMissing, describeConfig, loadForQuickstart } from "./quickstart/configReport";
import { createConfig } from "./quickstart/createConfig";
import { checkPrerequisites, DOCKER_INFO_TIMEOUT_MS, type Run } from "./quickstart/prerequisites";
import {
  integrationSteps,
  type Step,
  startStep,
  statusCommands,
  tunnelHint,
} from "./quickstart/steps";
import {
  bad,
  bold,
  cmd,
  colorWanted,
  dim,
  good,
  heading,
  setColor,
  warn,
} from "./quickstart/style";
import { confirm, promptLine } from "./up/prompt";

const ROOT = join(import.meta.dir, "..", "..");

export const USAGE = `Usage:
  bun run quickstart [--compose | --kind] [--[no-]github-app] [--[no-]linear]
                     [--public-url <url>] [--no-keychain]

Starts devbox on this machine from devbox.config.json, which it helps you
write when there is none: checks the config and the tools, starts devbox
(bun run up, or bun run k8s:kind), sets up the chosen integrations and
applies them. A choice you leave out is asked for.

  --compose, --kind     run with Docker Compose, or on a local kind cluster
  --github-app          set up the GitHub App (--no-github-app: don't)
  --linear              set up Linear (--no-linear: don't)
  --public-url <url>    the public HTTPS URL for webhooks, for the setups
  --no-keychain         never read or write the system keychain
`;

export class QuickstartError extends Error {}
class UsageError extends Error {}

export type QuickstartDeps = {
  root: string;
  isTTY: boolean;
  promptLine: (q: string) => Promise<string>;
  confirm: (q: string, opts: { defaultYes: boolean }) => Promise<boolean>;
  log: (line: string) => void;
  // For the prerequisite checks: captures output.
  run: Run;
  // For the steps: output goes to the terminal; resolves with the exit code.
  exec: (cmd: string[], cwd: string) => Promise<number>;
};

// Which integrations the platform's config already has on: devbox.config.json
// on Compose, devbox.kind.json (once k8s:kind wrote it) on kind.
function enabledIn(platform: Platform, composeIntegrations: Integrations, root: string): Enabled {
  let integrations = composeIntegrations;
  if (platform === "kind") {
    const path = join(root, KIND_TARGET_FILE);
    integrations = existsSync(path) ? (loadTarget(path).integrations ?? {}) : {};
  }
  return {
    githubApp: enabledGithubApp(integrations) !== undefined,
    linear: enabledLinear(integrations) !== undefined,
  };
}

// --public-url, checked before anything runs.
function flagPublicUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return validatePublicUrl(raw);
  } catch (err) {
    if (err instanceof PublicUrlError) throw new UsageError(`--public-url: ${err.message}`);
    throw err;
  }
}

// The public URL devbox.kind.json already has (a setup saved it).
function savedKindPublicUrl(root: string): string | undefined {
  const path = join(root, KIND_TARGET_FILE);
  return existsSync(path) ? loadTarget(path).publicUrl : undefined;
}

// Asked until it is a public HTTPS URL; empty stops the quickstart.
async function askPublicUrl(deps: QuickstartDeps): Promise<string> {
  for (;;) {
    const answer = (await deps.promptLine("Public HTTPS URL of the tunnel: ")).trim();
    if (!answer) {
      throw new QuickstartError(
        "no public URL entered: start the tunnel, then run bun run quickstart again (or pass --public-url)",
      );
    }
    try {
      return validatePublicUrl(answer);
    } catch (err) {
      if (!(err instanceof PublicUrlError)) throw err;
      deps.log(bad(err.message));
    }
  }
}

async function runStep(s: Step, deps: QuickstartDeps): Promise<void> {
  deps.log(`\n${heading(`==> ${s.title}`)}`);
  const code = await deps.exec(s.cmd, deps.root);
  if (code !== 0) {
    throw new QuickstartError(
      `${s.title} failed (exit ${code}). Fix what it reported, then run bun run quickstart again: what is already done is reused.`,
    );
  }
}

export async function quickstart(argv: string[], deps: QuickstartDeps): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      compose: { type: "boolean" },
      kind: { type: "boolean" },
      "github-app": { type: "boolean" },
      linear: { type: "boolean" },
      "public-url": { type: "string" },
      keychain: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowNegative: true,
    allowPositionals: false,
  });
  if (values.help) {
    deps.log(USAGE);
    return;
  }
  const flags: ChoiceFlags = values;
  // Every flag a missing terminal can't ask for, before any work.
  requireDecidable(flags, deps.isTTY);
  const log = deps.log;
  const configPath = join(deps.root, "devbox.config.json");

  log(heading("==> Config"));
  // Without a terminal, loadForQuickstart says what to write instead.
  if (deps.isTTY && !existsSync(configPath) && !(await createConfig(configPath, deps))) {
    throw new ConfigMissing(
      "devbox.config.json not created: copy devbox.config.example.json and fill in repos and llm, then run bun run quickstart again",
    );
  }
  // repos and llm first, as both platforms read them.
  for (const line of describeConfig(loadForQuickstart(configPath, "kind"))) log(line);

  log(`\n${heading("==> Choices")}`);
  const platform = await choosePlatform(flags, deps);
  const cfg = loadForQuickstart(configPath, platform);
  const enabled = enabledIn(platform, cfg.integrations, deps.root);
  const choices = {
    platform,
    githubApp: await chooseIntegration("githubApp", flags, enabled, deps),
    linear: await chooseIntegration("linear", flags, enabled, deps),
  };
  const yesNo = (b: boolean) => (b ? good("yes") : dim("no"));
  log(
    `platform ${bold(platform)}; GitHub App setup: ${yesNo(choices.githubApp)}; Linear setup: ${yesNo(choices.linear)}`,
  );
  // The setups ask for the public URL only on Compose: on kind it comes from
  // here, so without a terminal it must be known before the long install.
  let publicUrl = flagPublicUrl(values["public-url"]);
  const askUrl =
    platform === "kind" &&
    (choices.githubApp || choices.linear) &&
    publicUrl === undefined &&
    savedKindPublicUrl(deps.root) === undefined;
  if (askUrl && !deps.isTTY) {
    throw new QuickstartError(
      "on kind, the GitHub App and Linear need a public URL and there is no terminal to ask in: pass --public-url <url>",
    );
  }

  log(`\n${heading("==> Prerequisites")}`);
  const found = await checkPrerequisites(platform, deps.run);
  for (const w of found.warnings) log(`${warn("!")} ${w}`);
  for (const p of found.problems) log(`${bad("✗")} ${p}`);
  if (found.problems.length > 0) {
    throw new QuickstartError(
      `${found.problems.length} prerequisite(s) missing: fix them, then run bun run quickstart again`,
    );
  }
  log(`${good("✓")} all found`);

  const noKeychain = values.keychain === false;
  const start = startStep(choices, { noKeychain });
  await runStep(start, deps);
  if (choices.githubApp || choices.linear) {
    log("");
    for (const line of tunnelHint(choices)) log(warn(line));
    if (askUrl) publicUrl = await askPublicUrl(deps);
    for (const s of integrationSteps(choices, { noKeychain, publicUrl })) await runStep(s, deps);
    await runStep(start, deps);
  }

  log(`\n${heading("==> Done")}`);
  log(good(`✓ devbox is running (${platform === "compose" ? "Docker Compose" : "kind"}).`));
  const status = statusCommands(choices, enabled);
  if (status.length > 0) log(`Check the integrations with: ${status.map(cmd).join(", ")}`);
  log(dim("Run bun run quickstart again at any time: what is already set up is reused."));
}

async function exec(cmd: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

const run: Run = async (cmd) => {
  try {
    return await capture(cmd, { timeoutMs: DOCKER_INFO_TIMEOUT_MS });
  } catch {
    return { code: 127, stdout: "", stderr: "", missing: true };
  }
};

if (import.meta.main) {
  setColor(colorWanted(process.stdout.isTTY === true, process.env));
  try {
    await quickstart(process.argv.slice(2), {
      root: ROOT,
      isTTY: process.stdin.isTTY === true,
      promptLine: (q) => promptLine(q),
      confirm: (q, o) => confirm(q, o),
      log: (line) => process.stdout.write(`${line}\n`),
      run,
      exec,
    });
  } catch (err) {
    const known = isKnownError(err, QuickstartError, ChoiceError, ConfigMissing, UsageError);
    process.stderr.write(`\n${bad(bold("bun run quickstart:"))} ${errorMessage(err)}\n`);
    if (err instanceof UsageError || err instanceof ChoiceError) process.stderr.write(`\n${USAGE}`);
    if (!known && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  }
}
