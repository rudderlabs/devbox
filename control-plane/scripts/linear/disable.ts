// `bun run linear:disable [--forget]`. Plain, it switches Linear
// off and keeps everything needed to switch it back on. --forget removes the
// block and the saved Linear secrets, after the one destructive confirmation.
// Neither applies anything: both name the command that does.

import { writeConfigKeys } from "../lib/configFile";
import { confirmDestructive } from "../lib/destructive";
import { deploymentScope, entryName } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import type { LinearDeployment } from "./deployment";
import { readStatus } from "./status";

export type DisableDeps = { resolver: ResolverDeps; log: (line: string) => void };
export type DisableOpts = { forget: boolean; yes: boolean };

const LINEAR_SECRETS = ["LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"] as const;

export async function disable(
  d: LinearDeployment,
  opts: DisableOpts,
  deps: DisableDeps,
): Promise<void> {
  const { log, resolver } = deps;
  const scope = deploymentScope(d.deployment);
  if (!d.linear) {
    log(`Linear is not configured for ${scope}. Nothing to disable.`);
    return;
  }

  if (!opts.forget) {
    if (!d.linear.enabled) {
      log(`Linear is already disabled for ${scope}.`);
      return;
    }
    writeConfigKeys(d.configPath, { "integrations.linear": { ...d.linear, enabled: false } });
    log(`Disabled Linear in ${d.configPath}.`);
    log(`Next: ${d.applyCommand}`);
    return;
  }

  const k = resolver.keychain && !resolver.keychain.disabled ? resolver.keychain : undefined;
  const saved: (typeof LINEAR_SECRETS)[number][] = [];
  for (const name of LINEAR_SECRETS) {
    if (k && (await k.get(entryName(d.deployment, name))) !== undefined) saved.push(name);
  }
  const proceed = await confirmDestructive(
    {
      command: "linear:disable --forget",
      items: [
        `integrations.linear in ${d.configPath}`,
        ...saved.map((name) => `${name} for ${scope} in the system keychain`),
      ],
      question: "Remove these? [y/N] ",
    },
    { yes: opts.yes, isTTY: resolver.isTTY, confirm: resolver.confirm, log },
  );
  if (!proceed) {
    log("Nothing was removed.");
    return;
  }

  // While the control plane still knows the name.
  const read = await readStatus(d);
  const appName = ("body" in read && read.body.appUser?.name) || "the devbox app";

  // Keychain first: if a delete fails, the block is still there to list on a retry.
  for (const name of saved) await k?.delete(entryName(d.deployment, name));
  writeConfigKeys(d.configPath, { "integrations.linear": undefined });
  log(`Next: ${d.applyCommand}`);
  log(`Delete the app in Linear: Settings → API → Applications → ${appName}`);
}
