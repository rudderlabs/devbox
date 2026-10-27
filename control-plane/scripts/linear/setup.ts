// `bun run linear:setup`: resolve the public URL, register the
// Linear app from a manifest link, record its client ID and public URL in the
// deployment's config, optionally save its secrets in the system keychain, and
// name the command that applies it. setup never applies, never touches the
// cluster, sends no webhook and never takes a secret from env.
// Re-running is safe: each step reuses what is already configured.

import { writeConfigKeys } from "../lib/configFile";
import { deploymentScope, entryName, keychainUsable } from "../lib/keychain";
import { publicUrlChangeLines, resolvePublicUrl } from "../lib/publicUrl";
import { checkWithRetry, type Resolved, type ResolverDeps, SecretError } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import { checkLinear, type LinearIdentity } from "./check";
import type { LinearDeployment } from "./deployment";
import { linearManifest, manifestLink } from "./manifest";

export class SetupError extends Error {}

export type SetupOptions = {
  publicUrl?: string; // --public-url
  name: string; // --name, the app's name in Linear
  reregister: boolean;
};

export type SetupDeps = {
  resolver: ResolverDeps;
  // Asks with echo; empty at EOF.
  promptLine: (q: string) => Promise<string>;
  // Opens the link in a browser, best effort: it is always printed too.
  openUrl: (url: string) => void;
  fetch: Fetch;
  log: (line: string) => void;
};

const LINEAR_SECRETS = ["LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"] as const;
const AGAIN = "Run `bun run linear:setup` again when you have it.";

// 3. Asked only when registering, or when the config has none.
async function askClientId(d: LinearDeployment, deps: SetupDeps): Promise<string> {
  if (!deps.resolver.isTTY) {
    throw new SetupError(
      `no Linear client ID: run \`bun run linear:setup\` in a terminal, or set integrations.linear.clientId in ${d.configPath}`,
    );
  }
  const id = (await deps.promptLine("Client ID: ")).trim();
  if (!id) throw new SetupError(`No client ID entered: nothing was written. ${AGAIN}`);
  return id;
}

const noSecret = (label: string) =>
  new SetupError(`No ${label} entered: nothing was saved. ${AGAIN}`);

async function askSecret(deps: SetupDeps, label: string): Promise<string> {
  const value = (await deps.resolver.prompt(`${label} (input hidden): `)).trim();
  if (!value) throw noSecret(label);
  return value;
}

type Saved = Record<(typeof LINEAR_SECRETS)[number], string>;

// 5. With a terminal and a keychain that works, offer to save both secrets;
// the client secret is checked against Linear first. Returns what was saved,
// and whether the keychain can be read (for the earlier app's entries).
async function saveSecrets(
  d: LinearDeployment,
  clientId: string,
  deps: SetupDeps,
): Promise<{ saved?: Saved; usable: boolean }> {
  const { resolver, log } = deps;
  const k = resolver.keychain;
  const usable = await keychainUsable(k, entryName(d.deployment, "LINEAR_CLIENT_SECRET"));
  if (!resolver.isTTY || !k || !usable) return { usable };
  const scope = deploymentScope(d.deployment);
  const yes = await resolver.confirm(
    `Save the Linear secrets to the system keychain for ${scope}? [Y/n] `,
    { defaultYes: true },
  );
  if (!yes) return { usable };

  const typed = await askSecret(deps, "Linear client secret");
  let client: Resolved;
  let identity: LinearIdentity;
  try {
    ({ resolved: client, result: identity } = await checkWithRetry(
      { name: "LINEAR_CLIENT_SECRET", value: typed, source: "prompt" },
      resolver,
      (s) => checkLinear(clientId, s, deps.fetch, { log }),
    ));
  } catch (err) {
    // An empty answer at the re-ask: setup's own message, not up's env hint.
    if (err instanceof SecretError) throw noSecret("Linear client secret");
    throw err;
  }
  log(`devbox will act as ${identity.viewerName} in workspace ${identity.workspaceName}`);
  const webhook = await askSecret(deps, "Linear webhook signing secret");

  const saved = { LINEAR_CLIENT_SECRET: client.value, LINEAR_WEBHOOK_SECRET: webhook };
  for (const name of LINEAR_SECRETS) await k.set(entryName(d.deployment, name), saved[name]);
  // A keychain that switched itself off during `set` saved nothing.
  return k.disabled ? { usable: false } : { saved, usable: true };
}

// What env will do to each secret at the next apply, and, after a
// registration, the earlier app's entries left in the keychain. Compared in
// memory, never printed. An empty value counts as unset.
async function secretLines(
  d: LinearDeployment,
  deps: SetupDeps,
  registered: boolean,
  outcome: { saved?: Saved; usable: boolean },
): Promise<string[]> {
  const { env, keychain } = deps.resolver;
  const { saved, usable } = outcome;
  const apply = d.applyCommand;
  const scope = deploymentScope(d.deployment);
  const target = d.deployment.kind === "k8s" ? ` --target ${d.configPath}` : "";
  const lines: string[] = [];
  for (const name of LINEAR_SECRETS) {
    const value = env[name] || undefined;
    if (registered && value !== undefined) {
      lines.push(
        `${name} is set in your environment from before this app was created: set it to the new app's value, or unset it, before ${apply}`,
      );
    } else if (saved) {
      if (!registered && value !== undefined && value !== saved[name]) {
        lines.push(
          `${name} in your environment overrides the saved value at install: unset it, or set it to the new value`,
        );
      }
    } else if (value === undefined) {
      // Not asked this run (no terminal): the next apply reads the value saved
      // for this app from the keychain. After a registration it is an earlier
      // app's, named below.
      const kept = !registered && usable && (await keychain?.get(entryName(d.deployment, name)));
      if (!kept) lines.push(`Set ${name} in your environment before ${apply}, or it asks for them`);
    } else {
      lines.push(`${apply} will use ${name} from your environment`);
    }
    if (registered && !saved && usable && (await keychain?.get(entryName(d.deployment, name)))) {
      lines.push(
        `The saved ${name} for ${scope} belongs to an earlier app: remove it with bun run secrets rm ${name}${target}`,
      );
    }
  }
  return lines;
}

export async function setup(
  d: LinearDeployment,
  opts: SetupOptions,
  deps: SetupDeps,
): Promise<void> {
  const { log } = deps;
  const publicUrl = await resolvePublicUrl(d, opts, deps);
  log(`Public URL: ${publicUrl}`);

  // 2. Register.
  const register = !d.linear?.clientId || opts.reregister;
  if (register) {
    const link = manifestLink(linearManifest(publicUrl, opts.name));
    log("Register the Linear app: open this link, review the app and click Create:");
    log(`  ${link}`);
    deps.openUrl(link);
    log(
      "Then copy the client ID, the client secret and the webhook signing secret from the app's page.",
    );
    log(
      `set "GitHub username" to ${d.githubApp ? `${d.githubApp.slug}[bot]` : "the GitHub account devbox works as (the owner of GITHUB_TOKEN)"}`,
    );
  }

  // 3. Client ID.
  const clientId = register ? await askClientId(d, deps) : (d.linear?.clientId ?? "");

  // 4. Write.
  writeConfigKeys(d.configPath, {
    "integrations.linear": { enabled: true, clientId },
    publicUrl,
  });
  log(`Wrote integrations.linear to ${d.configPath}`);
  // A new app was just registered with this URL: nothing to update in Linear.
  for (const line of publicUrlChangeLines(
    d.publicUrl,
    publicUrl,
    { linear: !register, ...(d.githubApp ? { githubApp: d.githubApp } : {}) },
    "linear",
    d.deployment.kind === "k8s" ? ` --target ${d.configPath}` : "",
  )) {
    log(line);
  }

  // 5. Secrets. The user's own integrations Secret holds them; env is moot.
  if (d.deployment.kind === "k8s" && d.byoIntegrationsSecret) {
    log(
      `Put LINEAR_CLIENT_SECRET and LINEAR_WEBHOOK_SECRET in Secret "${d.byoIntegrationsSecret}" in namespace ${d.deployment.namespace}.`,
    );
  } else {
    const outcome = await saveSecrets(d, clientId, deps);
    for (const line of await secretLines(d, deps, register, outcome)) log(line);
  }

  // 6. Next step.
  log(`Next: ${d.applyCommand}`);
  if (d.deployment.kind === "k8s") {
    log(
      `With GitOps, set these chart values instead: integrations.linear.enabled: true, integrations.linear.clientId: ${clientId}`,
    );
  }
  log(`Then check Linear with: ${d.statusCommand}`);
}
