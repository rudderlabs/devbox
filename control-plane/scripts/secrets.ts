// `bun run secrets ls|rm|clear`: what devbox keeps in the system
// keychain for a deployment, and the way to remove it (`clear` lists what it
// removes and asks; without a terminal it needs --yes). `ls` also reports a
// secret set in the environment or, for GITHUB_TOKEN, available from `gh auth
// token`. Never prints a value.
import { parseArgs } from "node:util";
import { NAMESPACE } from "./k8s/run";
import { loadTarget, type Target } from "./k8s/target";
import { capture } from "./lib/capture";
import { confirmDestructive } from "./lib/destructive";
import { peekPrivateKey } from "./lib/githubAppKey";
import {
  bunKeychain,
  type Deployment,
  deploymentScope,
  entryName,
  guarded,
  type Keychain,
} from "./lib/keychain";
import { peekSecret, type SecretName, secretNamesFor } from "./lib/secrets";
import { confirm } from "./up/prompt";

export type SecretsDeps = {
  keychain: Keychain;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  confirm: (q: string, opts: { defaultYes: boolean }) => Promise<boolean>;
  // Runs `gh auth token` for `ls`; its output is never printed.
  run: (cmd: string[]) => Promise<{ code: number; stdout: string }>;
  log: (line: string) => void;
  loadTarget: (path: string) => Target;
};

// A new GitHub App's secrets while it waits for its install (github:setup
// --reregister or --app-id over a working App): listed only when saved.
const PENDING_NAMES: Record<string, string> = {
  GITHUB_APP_PRIVATE_KEY_PENDING: "GitHub App private key of the new App, not installed yet",
  GITHUB_WEBHOOK_SECRET_PENDING: "GitHub webhook secret of the new App, not installed yet",
};

const USAGE = "usage: bun run secrets <ls|rm <NAME>|clear [--yes]> [--target <file>]";

export async function secretsCommand(argv: string[], deps: SecretsDeps): Promise<number> {
  const { log, keychain } = deps;
  let parsed: ReturnType<
    typeof parseArgs<{
      options: { target: { type: "string" }; yes: { type: "boolean" } };
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args: argv,
      options: { target: { type: "string" }, yes: { type: "boolean" } },
      allowPositionals: true,
    });
  } catch (err) {
    log(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, name, ...extra] = parsed.positionals;
  if (!(command === "ls" || command === "clear" || command === "rm") || extra.length > 0) {
    log(USAGE);
    return 2;
  }
  if ((command === "rm") !== (name !== undefined) || (command === "clear" && name !== undefined)) {
    log(USAGE);
    return 2;
  }
  if (parsed.values.yes && command !== "clear") {
    log(`--yes goes with clear\n${USAGE}`);
    return 2;
  }
  let deployment: Deployment = { kind: "compose" };
  const targetPath = parsed.values.target;
  if (targetPath !== undefined) {
    deployment = {
      kind: "k8s",
      context: deps.loadTarget(targetPath).context,
      namespace: NAMESPACE,
    };
  }
  const scope = deploymentScope(deployment);
  const names = secretNamesFor(deployment);
  const pendingNames = Object.keys(PENDING_NAMES);
  const removable = [...names, ...pendingNames];

  if (command === "rm" && !removable.includes(name as string)) {
    log(`unknown secret "${name}": use one of ${removable.join(", ")}`);
    return 2;
  }

  // A first read tells whether the platform has a keychain at all.
  await keychain.get(entryName(deployment, names[0] as SecretName));
  if (keychain.disabled) {
    log("The system keychain is not available on this machine.");
    return 1;
  }

  if (command === "ls") {
    const peek = { env: deps.env, keychain, deployment, run: deps.run };
    const rows: [string, string][] = [];
    for (const n of names) {
      const where =
        n === "GITHUB_APP_PRIVATE_KEY" ? await peekPrivateKey(peek) : await peekSecret(n, peek);
      rows.push([n, where]);
    }
    for (const n of pendingNames) {
      if ((await keychain.get(entryName(deployment, n))) !== undefined) {
        rows.push([n, `keychain (${PENDING_NAMES[n]})`]);
      }
    }
    const width = Math.max(...rows.map(([n]) => n.length)) + 2;
    const lines = [`Secrets for ${scope}:`];
    for (const [n, where] of rows) lines.push(`  ${n.padEnd(width)}${where}`);
    log(lines.join("\n"));
    return 0;
  }

  if (command === "rm") {
    const removed = await keychain.delete(entryName(deployment, name as string));
    log(removed ? `Removed ${name} for ${scope}.` : `${name} is not saved for ${scope}.`);
    return 0;
  }

  // clear: destructive.
  const saved: string[] = [];
  for (const n of removable) {
    if ((await keychain.get(entryName(deployment, n))) !== undefined) saved.push(n);
  }
  if (saved.length === 0) {
    log(`No saved secrets for ${scope}.`);
    return 0;
  }
  const go = await confirmDestructive(
    {
      command: "secrets clear",
      items: saved.map((n) => `${n} for ${scope}`),
      question: "Remove these from the system keychain? [y/N] ",
    },
    { yes: parsed.values.yes === true, isTTY: deps.isTTY, confirm: deps.confirm, log },
  );
  if (!go) {
    log("Nothing was removed.");
    return 0;
  }
  let count = 0;
  for (const n of saved) {
    if (await keychain.delete(entryName(deployment, n))) count++;
  }
  log(`Removed ${count} saved ${count === 1 ? "secret" : "secrets"} for ${scope}.`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(
      await secretsCommand(process.argv.slice(2), {
        keychain: guarded(bunKeychain()),
        env: process.env,
        isTTY: Boolean(process.stdin.isTTY),
        confirm,
        run: (cmd) => capture(cmd),
        log: (line) => process.stdout.write(`${line}\n`),
        loadTarget,
      }),
    );
  } catch (err) {
    process.stderr.write(`bun run secrets: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
