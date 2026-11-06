// `bun run gitlab:disable --target <file> [--forget]`. Plain, it switches
// the GitLab webhooks off and keeps everything needed to switch them back on;
// the repos stay, so tasks still open merge requests. --forget removes the
// block and the saved GitLab secrets, after the one destructive confirmation.
// Neither applies anything, and the webhooks in GitLab are left for you to
// delete: both name what is next.

import { writeConfigKeys } from "../lib/configFile";
import { confirmDestructive } from "../lib/destructive";
import { deploymentScope, entryName } from "../lib/keychain";
import type { ResolverDeps, SecretName } from "../lib/secrets";
import type { GitlabDeployment } from "./deployment";

export type DisableDeps = { resolver: ResolverDeps; log: (line: string) => void };
export type DisableOpts = { forget: boolean; yes: boolean };

const GITLAB_SECRETS: readonly SecretName[] = [
  "GITLAB_TOKEN",
  "GITLAB_WEBHOOK_SIGNING_TOKEN",
  "GITLAB_WEBHOOK_SECRET",
];

export async function disable(
  d: GitlabDeployment,
  opts: DisableOpts,
  deps: DisableDeps,
): Promise<void> {
  const { log, resolver } = deps;
  const scope = deploymentScope(d.deployment);
  if (!d.gitlab) {
    log(`GitLab webhooks are not configured for ${scope}. Nothing to disable.`);
    return;
  }

  if (!opts.forget) {
    if (!d.gitlab.enabled) {
      log(`GitLab webhooks are already disabled for ${scope}.`);
      return;
    }
    writeConfigKeys(d.configPath, { "integrations.gitlab": { ...d.gitlab, enabled: false } });
    log(`Disabled the GitLab webhooks in ${d.configPath}; the repos stay.`);
    log(`Next: ${d.applyCommand}`);
    return;
  }

  const k = resolver.keychain && !resolver.keychain.disabled ? resolver.keychain : undefined;
  const saved: SecretName[] = [];
  for (const name of GITLAB_SECRETS) {
    if (k && (await k.get(entryName(d.deployment, name))) !== undefined) saved.push(name);
  }
  const proceed = await confirmDestructive(
    {
      command: "gitlab:disable --forget",
      items: [
        `integrations.gitlab and values.gitlab in ${d.configPath}`,
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
  // Keychain first: if a delete fails, the block is still there to list on a retry.
  for (const name of saved) await k?.delete(entryName(d.deployment, name));
  writeConfigKeys(d.configPath, {
    "integrations.gitlab": undefined,
    "values.gitlab": undefined,
  });
  log(`Next: ${d.applyCommand}`);
  if (d.instance) {
    log(
      `Delete the devbox webhook on each project in GitLab: Settings → Webhooks on ${d.repos.map((r) => `${r.owner}/${r.name}`).join(", ") || "the projects"}`,
    );
  }
}
