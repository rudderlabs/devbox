// Where `bun run up` and `bun run k8s:install` find the real secrets:
// env var → the deployment's keychain entry → `gh auth token` (for
// GITHUB_TOKEN only) → a hidden prompt (terminal only) → an offer to save the
// typed value. Values never reach argv, logs, files or error messages.
//
// A GITHUB_TOKEN or LLM_API_KEY that is set, even to the empty string, wins:
// an empty GITHUB_TOKEN means "no token" (anonymous clones; the checks before
// startup then refuse it), an empty LLM_API_KEY an endpoint that needs no key.
// An empty Linear, Slack or webhook secret counts as missing.
import { installCommand } from "../k8s/kind";
import { CredentialRejected } from "../up/preflight";
import { type Deployment, deploymentScope, entryName, type Keychain } from "./keychain";

export type SecretName =
  | "GITHUB_TOKEN"
  | "LLM_API_KEY"
  | "LINEAR_CLIENT_SECRET"
  | "LINEAR_WEBHOOK_SECRET"
  | "SLACK_BOT_TOKEN"
  | "GITHUB_WEBHOOK_SECRET"
  | "GITHUB_APP_PRIVATE_KEY";

const COMPOSE_SECRET_NAMES: readonly SecretName[] = [
  "GITHUB_TOKEN",
  "LLM_API_KEY",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
];

// Slack is only wired up on Kubernetes.
const K8S_SECRET_NAMES: readonly SecretName[] = [...COMPOSE_SECRET_NAMES, "SLACK_BOT_TOKEN"];

export const secretNamesFor = (d: Deployment): readonly SecretName[] =>
  d.kind === "compose" ? COMPOSE_SECRET_NAMES : K8S_SECRET_NAMES;

export type SecretSource = "env" | "keychain" | "gh" | "prompt";
export type Resolved = { name: SecretName; value: string; source: SecretSource };

export type ResolverDeps = {
  env: Record<string, string | undefined>;
  keychain: Keychain | undefined; // undefined = --no-keychain
  deployment: Deployment;
  // On k8s, the target file, for the hint in messages.
  targetPath?: string;
  isTTY: boolean;
  // Asks with hidden input and returns the answer (empty at EOF).
  prompt: (q: string) => Promise<string>;
  // A yes/no question; Enter alone answers `defaultYes`, Ctrl-D no.
  confirm: (q: string, opts: { defaultYes: boolean }) => Promise<boolean>;
  // Runs a command and returns its exit code and stdout. Throws if it can't start.
  run: (cmd: string[]) => Promise<{ code: number; stdout: string }>;
  log: (line: string) => void;
};

export class SecretError extends Error {}

const LABELS: Record<SecretName, string> = {
  GITHUB_TOKEN: "GitHub token",
  LLM_API_KEY: "LLM API key",
  LINEAR_CLIENT_SECRET: "Linear client secret",
  LINEAR_WEBHOOK_SECRET: "Linear webhook signing secret",
  SLACK_BOT_TOKEN: "Slack bot token",
  GITHUB_WEBHOOK_SECRET: "GitHub webhook secret",
  GITHUB_APP_PRIVATE_KEY: "GitHub App private key",
};

const EMPTY_IS_SET: ReadonlySet<SecretName> = new Set(["GITHUB_TOKEN", "LLM_API_KEY"]);

// "a", "a or b", "a, b, or c".
const either = (xs: string[]): string =>
  xs.length < 3 ? xs.join(" or ") : `${xs.slice(0, -1).join(", ")}, or ${xs.at(-1)}`;

// The interactive run that offers to save a typed secret: there is no
// `secrets set`.
const savingCommand = (deps: ResolverDeps): string =>
  deps.deployment.kind === "compose"
    ? "bun run up"
    : installCommand(deps.deployment.context, deps.targetPath ?? "<file>");

function missing(name: SecretName, deps: ResolverDeps, prompted: boolean): SecretError {
  const ways = [`set ${name}`];
  if (name === "GITHUB_TOKEN") ways.push("log in with `gh auth login`");
  if (prompted) ways.push("enter one at the prompt");
  else if (deps.keychain && !deps.keychain.disabled) {
    ways.push(`run \`${savingCommand(deps)}\` once in a terminal to save it in the keychain`);
  }
  return new SecretError(`no ${LABELS[name]}: ${either(ways)}`);
}

// What `secrets ls` needs to tell where a secret would come from.
export type PeekDeps = Pick<ResolverDeps, "env" | "keychain" | "deployment" | "run">;

// The env var or the deployment's keychain entry.
async function stored(name: SecretName, deps: PeekDeps): Promise<Resolved | undefined> {
  const env = deps.env[name];
  if (env !== undefined && (env !== "" || EMPTY_IS_SET.has(name))) {
    return { name, value: env, source: "env" };
  }
  const saved = await deps.keychain?.get(entryName(deps.deployment, name));
  return saved ? { name, value: saved, source: "keychain" } : undefined;
}

async function ghToken(deps: Pick<ResolverDeps, "run">): Promise<string> {
  try {
    const { code, stdout } = await deps.run(["gh", "auth", "token"]);
    return code === 0 ? stdout.trim() : "";
  } catch {
    return ""; // gh is not installed
  }
}

async function promptFor(name: SecretName, deps: ResolverDeps): Promise<Resolved> {
  const value = (await deps.prompt(`${LABELS[name]} (input hidden): `)).trim();
  if (!value) throw missing(name, deps, true);
  return { name, value, source: "prompt" };
}

export async function resolveSecret(
  name: SecretName,
  deps: ResolverDeps,
  opts: { noPrompt?: boolean } = {},
): Promise<Resolved> {
  const found = await stored(name, deps);
  if (found) {
    deps.log(
      found.source === "env"
        ? `${name}: from your environment`
        : `${name}: from the system keychain (${deploymentScope(deps.deployment)})`,
    );
    return found;
  }
  if (name === "GITHUB_TOKEN") {
    const value = await ghToken(deps);
    if (value) {
      deps.log("GITHUB_TOKEN: from gh");
      return { name, value, source: "gh" };
    }
  }
  if (!deps.isTTY || opts.noPrompt) throw missing(name, deps, false);
  return promptFor(name, deps);
}

// Where a secret would come from, without prompting. For GITHUB_TOKEN it may
// run `gh auth token` (read-only); the value is dropped.
export async function peekSecret(
  name: SecretName,
  deps: PeekDeps,
): Promise<SecretSource | "missing"> {
  const found = await stored(name, deps);
  if (found) return found.source;
  if (name === "GITHUB_TOKEN" && (await ghToken(deps))) return "gh";
  return "missing";
}

// After a prompt and that value's own check (or right away when its check is
// skipped), with a terminal and a working keychain. Values from env or `gh`
// are never saved. Not destructive, so Enter alone saves.
export async function offerSave(r: Resolved, deps: ResolverDeps): Promise<void> {
  const k = deps.keychain;
  if (r.source !== "prompt" || !deps.isTTY || !k || k.disabled) return;
  const scope = deploymentScope(deps.deployment);
  if (
    await deps.confirm(`Save ${r.name} to the system keychain for ${scope}? [Y/n] `, {
      defaultYes: true,
    })
  ) {
    await k.set(entryName(deps.deployment, r.name), r.value);
  }
}

// Runs `check` on the value. A saved value the service rejects is
// removed. A rejected saved or typed value, with a terminal, is asked for again
// until one is accepted; an empty answer exits. A rejected value from env or
// `gh`, or any rejection without a terminal, stops the run.
export async function checkWithRetry<T>(
  r: Resolved,
  deps: ResolverDeps,
  check: (value: string) => Promise<T>,
): Promise<{ resolved: Resolved; result: T }> {
  let current = r;
  for (;;) {
    try {
      return { resolved: current, result: await check(current.value) };
    } catch (err) {
      if (!(err instanceof CredentialRejected)) throw err;
      if (current.source === "keychain" && deps.keychain) {
        const scope = deploymentScope(deps.deployment);
        deps.log(`The saved ${current.name} for ${scope} was rejected; removing it`);
        await deps.keychain.delete(entryName(deps.deployment, current.name));
      }
      if (!deps.isTTY || (current.source !== "keychain" && current.source !== "prompt")) throw err;
      deps.log(err.message);
      deps.log(`Enter ${current.name} again, or press Enter on an empty value to exit.`);
      current = await promptFor(current.name, deps);
    }
  }
}
