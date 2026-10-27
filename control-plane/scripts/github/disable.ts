// `bun run github:disable [--forget]`. Plain, it switches the GitHub App off
// and keeps everything needed to switch it back on, a new App waiting for
// its install included (the next github:setup installs that one). --forget removes the
// block (with a new App waiting for its install, if any) and the saved App
// keys and webhook secrets, after the one destructive
// confirmation; the key is only ever deleted here, at the user's request.
// Neither applies anything: both name the command that does.
import { writeConfigKeys } from "../lib/configFile";
import { confirmDestructive } from "../lib/destructive";
import { appSettingsUrl } from "../lib/githubApp";
import { deploymentScope, entryName } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import type { GithubDeployment } from "./deployment";

export type DisableDeps = { resolver: ResolverDeps; log: (line: string) => void };
export type DisableOpts = { forget: boolean; yes: boolean };

// The App's secrets, and those of a new App waiting for its install.
const APP_SECRETS = [
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY_PENDING",
  "GITHUB_WEBHOOK_SECRET_PENDING",
] as const;

export async function disable(
  d: GithubDeployment,
  opts: DisableOpts,
  deps: DisableDeps,
): Promise<void> {
  const { log, resolver } = deps;
  const scope = deploymentScope(d.deployment);
  const app = d.githubApp;
  if (!app) {
    log(`The GitHub App is not configured for ${scope}. Nothing to disable.`);
    return;
  }

  if (!opts.forget) {
    // A new App waiting for its install stays: setup resumes it.
    const flag = d.deployment.kind === "k8s" ? ` --target ${d.configPath}` : "";
    const pending = app.pending
      ? `The new App ${app.pending.slug} is still waiting for its install: bun run github:setup${flag} resumes it, bun run github:disable${flag} --forget removes it`
      : undefined;
    if (!app.enabled) {
      log(`The GitHub App is already disabled for ${scope}.`);
      if (pending) log(pending);
      return;
    }
    writeConfigKeys(d.configPath, { "integrations.githubApp": { ...app, enabled: false } });
    log(`Disabled the GitHub App in ${d.configPath}.`);
    log(`GitHub falls back to a personal token: the next apply needs GITHUB_TOKEN.`);
    if (pending) log(pending);
    log(`Next: ${d.applyCommand}`);
    return;
  }

  const k = resolver.keychain && !resolver.keychain.disabled ? resolver.keychain : undefined;
  const saved: (typeof APP_SECRETS)[number][] = [];
  for (const name of APP_SECRETS) {
    if (k && (await k.get(entryName(d.deployment, name))) !== undefined) saved.push(name);
  }
  const proceed = await confirmDestructive(
    {
      command: "github:disable --forget",
      items: [
        `integrations.githubApp in ${d.configPath}`,
        ...(app.pending
          ? [
              `the pending App ${app.pending.slug} (integrations.githubApp.pending) in ${d.configPath}`,
            ]
          : []),
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
  writeConfigKeys(d.configPath, { "integrations.githubApp": undefined });
  log(`Next: ${d.applyCommand}`);
  if (app.slug) {
    const settings = appSettingsUrl(
      app.slug,
      app.org ? { login: app.org, type: "Organization" } : undefined,
    );
    log(`Delete the App on GitHub: ${settings}/advanced`);
  }
  if (app.pending) {
    const settings = appSettingsUrl(
      app.pending.slug,
      app.pending.org ? { login: app.pending.org, type: "Organization" } : undefined,
    );
    log(`Delete the pending App on GitHub: ${settings}/advanced`);
  }
}
