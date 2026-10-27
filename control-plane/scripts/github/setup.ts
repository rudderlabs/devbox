// `bun run github:setup`: resolve the public URL, register the GitHub App
// through GitHub's manifest flow (or adopt an existing one), save its private
// key and webhook secret, wait for it to be installed, record its settings
// and a default trust list in the deployment's config, check that the
// installation covers the repos, and name the command that applies it.
// setup never applies: no `up`, no `k8s:install`, no cluster access; its
// network calls go only to GitHub. The key and the webhook secret are never
// logged, put in argv or written to the config file.
// --reregister (or --app-id with another App) over a working App keeps that
// App working: the new one waits as `pending`, its secrets under _PENDING
// names (and a new public URL in it), until it is installed. A pending App is
// dropped only when the user agrees (or with github:disable --forget);
// otherwise the next run installs it, even after a plain github:disable.
// Re-running is safe: each step reuses what is already configured.
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GithubAppError, githubApiBaseUrl } from "../../src/githubToken/mint";
import { writeConfigKeys } from "../lib/configFile";
import {
  appSettingsUrl,
  callWithAppKey,
  checkCoverage,
  installationSettingsUrl,
  savedKeyFix,
  verifyApp,
} from "../lib/githubApp";
import { readPrivateKeyFile, resolvePrivateKey } from "../lib/githubAppKey";
import { type PendingGithubApp, parseIntegrations } from "../lib/integrations";
import { deploymentScope, entryName, keychainUsable } from "../lib/keychain";
import { publicUrlChangeLines, resolvePublicUrl } from "../lib/publicUrl";
import type { ResolverDeps } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import { type AppAccount, type AppApi, type AppKey, appApi, type Installation } from "./appApi";
import type { GithubDeployment } from "./deployment";
import { CALLBACK_TIMEOUT_MS, type CallbackListener } from "./listener";
import { formPage, githubManifest, manifestPostUrl, registrationLink } from "./manifest";

export class SetupError extends Error {}

export type SetupOptions = {
  publicUrl?: string; // --public-url
  org?: string; // --org: register under this organization
  name: string; // --name, the App's name on GitHub
  externalTokens: boolean; // --external-tokens
  appId?: number; // --app-id: adopt this App
  privateKeyFile?: string; // --private-key-file
  reregister: boolean;
  printRegistrationLink: boolean;
};

export type SetupDeps = {
  resolver: ResolverDeps;
  // Asks with echo; empty at EOF.
  promptLine: (q: string) => Promise<string>;
  // Opens a page in a browser, best effort: it is always printed too.
  openUrl: (url: string) => void;
  fetch: Fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  // Enter pressed while waiting for the installation checks again at once.
  enter: () => { next(): Promise<void>; stop(): void };
  listen: (opts: {
    state: string;
    timeoutMs: number;
    page: (port: number) => string;
  }) => Promise<CallbackListener>;
  // `bytes` random bytes, as hex.
  random: (bytes: number) => string;
  // Where a key file is written.
  cwd: string;
  // Shows a secret on the terminal, once; never through `log`.
  show: (secret: string) => void;
  log: (line: string) => void;
};

const KEY = "GITHUB_APP_PRIVATE_KEY";
const KEY_FILE = "GITHUB_APP_PRIVATE_KEY_FILE";
const HOOK_SECRET = "GITHUB_WEBHOOK_SECRET";
// A new App registered to replace a working one keeps its secrets under
// these names until it is installed, so the working App's stay as they are.
const PENDING = "_PENDING";
const POLL_MS = 3_000;
const INSTALL_WAIT_MS = 15 * 60_000;
const NO_KEY = "No private key for the App here: skipping the installation and repo checks";

// The App this run works with.
type App = { appId: number; slug: string; htmlUrl: string; owner?: AppAccount };

// What this run got that is new: the private key (and the file it came from,
// when adopted) and the webhook secret. `saved*` once the keychain took them;
// `keyFile` when setup wrote the key to a file.
type Fresh = {
  key?: { pem: string; path?: string };
  webhook?: string;
  savedKey?: boolean;
  savedWebhook?: boolean;
  keyFile?: string;
  // Resuming a new App whose webhook secret was shown, not saved: whatever
  // is saved or set under the main name belongs to the old App.
  webhookShown?: boolean;
  // Resuming a new App whose key was found in the file setup wrote for it.
  keyFromPendingFile?: boolean;
};

type Ctx = {
  d: GithubDeployment;
  opts: SetupOptions;
  deps: SetupDeps;
  api: AppApi;
  publicUrl: string;
  tokens: "devbox" | "external";
  tokenFile?: string;
  // " --target <file>" on k8s, for the commands named in messages.
  flag: string;
  fresh: Fresh;
  // The new App replaces the configured, working one once installed: until
  // then it is `pending` and its secrets are saved under the _PENDING names.
  replacing: boolean;
};

const hookUrl = (publicUrl: string) => `${publicUrl}/webhook/github`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// tokens "external" on Compose needs the file the user's tooling keeps fresh.
async function askTokenFile(d: GithubDeployment, deps: SetupDeps): Promise<string> {
  if (!deps.resolver.isTTY) {
    throw new SetupError(
      `tokens "external" on Compose needs integrations.githubApp.tokenFile: set it in ${d.configPath} to the absolute path of the token file your tooling keeps fresh, or run bun run github:setup in a terminal`,
    );
  }
  const answer = (
    await deps.promptLine("Path of the token file your tooling keeps fresh (absolute): ")
  ).trim();
  if (!answer) {
    throw new SetupError(
      "No token file entered: nothing was written. Run bun run github:setup --external-tokens again when you have it.",
    );
  }
  parseIntegrations(
    { githubApp: { enabled: false, tokenFile: answer } },
    (msg) => {
      throw new SetupError(msg);
    },
    { platform: "compose" },
  );
  return answer;
}

// The App's settings before it is installed, so a re-run skips registration
// and goes to the installation. A working configuration of the same App is
// left as it is.
function saveRegistered(ctx: Ctx, app: App): void {
  const { d } = ctx;
  if (ctx.replacing) {
    const org = app.owner?.type === "Organization" ? app.owner.login : undefined;
    // The saved public URL is the working App's until the new one is installed.
    const publicUrl = ctx.publicUrl !== d.publicUrl ? ctx.publicUrl : undefined;
    writeConfigKeys(d.configPath, {
      "integrations.githubApp.pending": {
        appId: app.appId,
        slug: app.slug,
        ...(org !== undefined ? { org } : {}),
        ...(publicUrl !== undefined ? { publicUrl } : {}),
      },
    });
    return;
  }
  if (d.githubApp?.enabled && d.githubApp.appId === app.appId) return;
  writeConfigKeys(d.configPath, {
    "integrations.githubApp": {
      enabled: false,
      appId: app.appId,
      slug: app.slug,
      tokens: ctx.tokens,
      tokenScope: d.githubApp?.tokenScope ?? "repos",
      ciResults: d.githubApp?.ciResults ?? true,
      ...(ctx.tokenFile !== undefined ? { tokenFile: ctx.tokenFile } : {}),
      ...(app.owner?.type === "Organization" ? { org: app.owner.login } : {}),
    },
    publicUrl: ctx.publicUrl,
  });
}

// The key goes to a new file next to where setup runs, readable by the user
// only; an existing file is never overwritten.
function writeKeyFile(ctx: Ctx, app: App, pem: string): string {
  const path = join(ctx.deps.cwd, `${app.slug}.private-key.pem`);
  try {
    writeFileSync(path, pem, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new SetupError(
      `${path} exists already: nothing was overwritten. Generate a new private key on the App's settings page (${appSettingsUrl(app.slug, app.owner)}), then run bun run github:setup${ctx.flag} --app-id ${app.appId} --private-key-file <its path>`,
    );
  }
  return path;
}

// Saves what is new: to the keychain when the user agrees; otherwise the key
// to a file (or its own file, when adopted) and the webhook secret shown once.
// With tokens "external" the key never goes to devbox; the user's own k8s
// Secrets take what they hold.
async function storeSecrets(ctx: Ctx, app: App): Promise<void> {
  const { d, deps, fresh, tokens } = ctx;
  const { resolver, log } = deps;
  const k = resolver.keychain;
  const suffix = ctx.replacing ? PENDING : "";
  // A replacing App's secrets are used only once it is installed.
  const once = ctx.replacing ? ", once the new App is installed" : "";
  const keyToKeychain = fresh.key !== undefined && tokens === "devbox" && !d.byoKeySecret;
  const hookToKeychain = fresh.webhook !== undefined && !d.byoIntegrationsSecret;
  if (
    (keyToKeychain || hookToKeychain) &&
    k &&
    (await keychainUsable(k, entryName(d.deployment, KEY)).catch(() => false))
  ) {
    const what =
      keyToKeychain && hookToKeychain
        ? "private key and webhook secret"
        : keyToKeychain
          ? "private key"
          : "webhook secret";
    const yes = await resolver.confirm(
      `Save the App's ${what} to the system keychain for ${deploymentScope(d.deployment)}? [Y/n] `,
      { defaultYes: true },
    );
    if (yes) {
      // A save that fails (a locked keychain, a refused access, a value too
      // large) counts as not saved: the value then goes the other way, never lost.
      const save = async (name: string, value: string): Promise<boolean> => {
        try {
          await k.set(entryName(d.deployment, name), value);
        } catch (err) {
          log(`Saving ${name} to the system keychain failed: ${errorText(err)}`);
          return false;
        }
        // A keychain that switched itself off during `set` saved nothing.
        return !k.disabled;
      };
      if (keyToKeychain && fresh.key) fresh.savedKey = await save(KEY + suffix, fresh.key.pem);
      if (hookToKeychain && fresh.webhook) {
        fresh.savedWebhook = await save(HOOK_SECRET + suffix, fresh.webhook);
      }
    }
  }

  const ns = d.deployment.kind === "k8s" ? d.deployment.namespace : "";
  if (fresh.key && !fresh.savedKey) {
    const { path } = fresh.key;
    if (path) {
      if (tokens === "devbox") {
        log(
          d.byoKeySecret
            ? `Put the key from ${path} in Secret "${d.byoKeySecret}" (key private-key) in namespace ${ns}${once}`
            : `Set ${KEY_FILE}=${path} before ${d.applyCommand}${once}`,
        );
      }
    } else {
      const file = writeKeyFile(ctx, app, fresh.key.pem);
      fresh.keyFile = file;
      const saved = `Saved the App's private key to ${file}.`;
      if (tokens === "external") log(saved);
      else if (d.byoKeySecret) {
        log(
          `${saved} Put it in Secret "${d.byoKeySecret}" (key private-key) in namespace ${ns}${once}, then delete the file`,
        );
      } else {
        log(
          `${saved} Keep it somewhere safe and set ${KEY_FILE}=${file} before ${d.applyCommand}${once}`,
        );
      }
    }
  }

  if (fresh.webhook && !fresh.savedWebhook) {
    const where = d.byoIntegrationsSecret
      ? `put it in Secret "${d.byoIntegrationsSecret}" as ${HOOK_SECRET}${once}`
      : `set it as ${HOOK_SECRET} before ${d.applyCommand}${once}`;
    await deps.promptLine(`Press Enter to show the webhook secret (${where}) `);
    deps.show(fresh.webhook);
  }
}

// GitHub's manifest flow: the local page posts the manifest, GitHub
// redirects back with a code, and the code buys the App's credentials.
async function registerApp(ctx: Ctx): Promise<{ app: App; key: AppKey }> {
  const { opts, deps, publicUrl } = ctx;
  const state = deps.random(16);
  const listener = await deps.listen({
    state,
    timeoutMs: CALLBACK_TIMEOUT_MS,
    page: (port) =>
      formPage(
        manifestPostUrl(state, opts.org),
        githubManifest({
          name: opts.name,
          publicUrl,
          redirectUrl: `http://localhost:${port}/callback`,
        }),
      ),
  });
  let code: string;
  try {
    const local = `http://localhost:${listener.port}/`;
    deps.log(
      "Register the GitHub App: your browser opens GitHub's create page; review it and click Create.",
    );
    deps.log(`If it doesn't open, open ${local} in a browser on this machine.`);
    deps.openUrl(local);
    code = await listener.code;
  } finally {
    listener.close();
  }

  const made = await ctx.api.convertManifest(code);
  const app: App = { appId: made.id, slug: made.slug, htmlUrl: made.htmlUrl, owner: made.owner };
  const key = { appId: made.id, pem: made.pem };
  saveRegistered(ctx, app);
  ctx.fresh.key = { pem: made.pem };
  ctx.fresh.webhook = made.webhookSecret ?? ctx.deps.random(32);
  await storeSecrets(ctx, app);
  if (made.webhookSecret === null) {
    try {
      await ctx.api.updateHookConfig(key, { secret: ctx.fresh.webhook });
    } catch (err) {
      if (!(err instanceof GithubAppError)) throw err;
      throw new SetupError(
        `Setting the new App's webhook secret failed: ${err.message}. Run bun run github:setup${ctx.flag} --app-id ${app.appId} to set a new one`,
      );
    }
  }
  return { app, key };
}

// --app-id: an App made elsewhere. Its key is checked, its webhook URL and
// secret are set.
async function adoptApp(ctx: Ctx, appId: number): Promise<{ app: App; key: AppKey }> {
  const { opts, deps } = ctx;
  let pem: string;
  if (opts.privateKeyFile !== undefined) {
    const path = resolve(deps.cwd, opts.privateKeyFile);
    pem = readPrivateKeyFile(path, "--private-key-file");
    ctx.fresh.key = { pem, path };
  } else {
    const found = await resolvePrivateKey(deps.resolver);
    if (!found) {
      throw new SetupError(
        `No private key for App ${appId}: pass --private-key-file <path>, or set ${KEY_FILE}`,
      );
    }
    pem = found.pem;
  }
  const info = await verifyApp({ appId }, pem, deps.fetch, {
    rejected: (reason) =>
      `GitHub rejected the key for App ${appId}: ${reason}. Check --app-id, the private key and the system clock`,
    notFound: `GitHub has no App with id ${appId}: check --app-id (the App's settings page shows its App ID)`,
  });
  const app: App = { appId, ...info };
  const typed = (
    await deps.resolver.prompt(
      "The App's webhook secret (input hidden; press Enter to generate a new one): ",
    )
  ).trim();
  ctx.fresh.webhook = typed || deps.random(32);
  const key = { appId, pem };
  const url = hookUrl(ctx.publicUrl);
  await ctx.api.updateHookConfig(key, { url, secret: ctx.fresh.webhook });
  deps.log(
    `Set the App's webhook URL to ${url}. Check that the webhook is Active on the App's settings page: ${appSettingsUrl(app.slug, app.owner)}`,
  );
  saveRegistered(ctx, app);
  await storeSecrets(ctx, app);
  return { app, key };
}

// The pending App's key: the file setup wrote for it, else its keychain
// entry. The file is named after the App; the _PENDING entries are not, and
// may be left from an App dropped with --no-keychain, so they are used only
// when there is no file. What is found is recorded as this run's new
// secrets, so they move to the main names, or the old App's values still in
// force are named.
async function pendingKey(ctx: Ctx, pending: PendingGithubApp): Promise<string> {
  const { d, deps, fresh } = ctx;
  const read = (name: string) =>
    deps.resolver.keychain?.get(entryName(d.deployment, name)).catch(() => undefined);
  const file = join(deps.cwd, `${pending.slug}.private-key.pem`);
  if (existsSync(file)) {
    const pem = readPrivateKeyFile(file, "the new App's key file");
    deps.log(`The new App's private key: from ${file}`);
    fresh.key = { pem, path: file };
    fresh.keyFromPendingFile = true;
    // Its webhook secret was shown, not saved.
    fresh.webhookShown = true;
    if ((await read(KEY + PENDING)) || (await read(HOOK_SECRET + PENDING))) {
      const scope = deploymentScope(d.deployment);
      deps.log(
        `The saved ${KEY}${PENDING} and ${HOOK_SECRET}${PENDING} for ${scope} are from an earlier App: remove them with bun run secrets rm ${KEY}${PENDING}${ctx.flag} and bun run secrets rm ${HOOK_SECRET}${PENDING}${ctx.flag}`,
      );
    }
    return pem;
  }
  const webhook = await read(HOOK_SECRET + PENDING);
  if (webhook) {
    fresh.webhook = webhook;
    fresh.savedWebhook = true;
  } else fresh.webhookShown = true;
  const saved = await read(KEY + PENDING);
  if (saved) {
    deps.log(
      `The new App's private key: from the system keychain (${deploymentScope(d.deployment)})`,
    );
    fresh.key = { pem: saved };
    fresh.savedKey = true;
    return saved;
  }
  throw new SetupError(
    `No private key for the new App ${pending.slug} here (no ${KEY}${PENDING} in the system keychain, no ${file}): adopt it again with bun run github:setup${ctx.flag} --app-id ${pending.appId} --private-key-file <path>, or register another one with bun run github:setup${ctx.flag} --reregister`,
  );
}

// Puts the new App's saved secrets under the main names: only those this
// run saved or found saved for the App being installed, never another App's
// leftovers. All or nothing: a failure puts back what was set. Returns how to
// undo it (if writing the config fails next), how to finish it (removing the
// _PENDING entries), and which old values it replaced.
async function movePendingSecrets(
  ctx: Ctx,
  old: { slug: string; enabled: boolean },
): Promise<{ undo(): Promise<void>; finish(): Promise<void>; replaced: string[] }> {
  const { d, deps, fresh } = ctx;
  const k = deps.resolver.keychain;
  const none = { undo: async () => {}, finish: async () => {}, replaced: [] };
  if (!k) return none;
  const entry = (name: string) => entryName(d.deployment, name);
  const read = (name: string) => k.get(entry(name)).catch(() => undefined);
  const moves: { name: string; value: string; old: string | undefined }[] = [];
  if (fresh.savedKey && fresh.key) {
    moves.push({ name: KEY, value: fresh.key.pem, old: await read(KEY) });
  }
  if (fresh.savedWebhook && fresh.webhook) {
    moves.push({ name: HOOK_SECRET, value: fresh.webhook, old: await read(HOOK_SECRET) });
  }
  const done: typeof moves = [];
  const undo = async () => {
    for (const m of done) {
      try {
        if (m.old === undefined) await k.delete(entry(m.name));
        else await k.set(entry(m.name), m.old);
      } catch {
        // best effort; the caller's message says what is left
      }
    }
  };
  try {
    for (const m of moves) {
      await k.set(entry(m.name), m.value);
      done.push(m);
    }
  } catch (err) {
    await undo();
    throw new SetupError(
      `Moving the new App's secrets in the system keychain failed: ${errorText(err)}. Nothing changed: the App ${old.slug} ${old.enabled ? "keeps working" : "stays disabled"} and the new App's secrets stay saved as ${KEY}${PENDING} and ${HOOK_SECRET}${PENDING}; run bun run github:setup${ctx.flag} again to finish`,
    );
  }
  const finish = async () => {
    for (const m of moves) {
      try {
        await k.delete(entry(m.name + PENDING));
      } catch (err) {
        deps.log(
          `Removing ${m.name}${PENDING} from the system keychain failed: ${errorText(err)}; it is no longer used`,
        );
      }
    }
  };
  return { undo, finish, replaced: moves.filter((m) => m.old !== undefined).map((m) => m.name) };
}

// The saved secrets of a pending App that is being dropped, at the user's
// word. Returns whether any was removed.
async function dropPendingSecrets(d: GithubDeployment, deps: SetupDeps): Promise<boolean> {
  const k = deps.resolver.keychain;
  let removed = false;
  for (const name of [KEY + PENDING, HOOK_SECRET + PENDING]) {
    try {
      if (await k?.delete(entryName(d.deployment, name))) removed = true;
    } catch (err) {
      deps.log(`Removing ${name} from the system keychain failed: ${errorText(err)}`);
    }
  }
  return removed;
}

const deleteLink = (slug: string, org?: string): string =>
  `${appSettingsUrl(slug, org ? { login: org, type: "Organization" } : undefined)}/advanced`;

// One installation, the one configured, or the one whose account owns the
// repos; otherwise the user picks (with a terminal).
async function pickInstallation(
  ctx: Ctx,
  list: Installation[],
  preferred?: number,
): Promise<Installation> {
  const { d, deps } = ctx;
  const configured = list.find((i) => i.id === preferred);
  if (configured) return configured;
  if (list.length === 1 && list[0]) return list[0];
  const owners = new Set(d.repos.map((r) => r.owner.toLowerCase()));
  const owning = list.filter((i) => owners.has(i.account.login.toLowerCase()));
  if (owning.length === 1 && owning[0]) return owning[0];
  if (!deps.resolver.isTTY) {
    throw new SetupError(
      `The App is installed on several accounts (${list.map((i) => i.account.login).join(", ")}): run bun run github:setup${ctx.flag} in a terminal to choose one`,
    );
  }
  deps.log("The App is installed on several accounts:");
  list.forEach((i, n) => {
    deps.log(`  ${n + 1}. ${i.account.login} (${i.account.type}, installation ${i.id})`);
  });
  const answer = (await deps.promptLine(`Which one does devbox use? [1-${list.length}]: `)).trim();
  const choice = /^\d+$/.test(answer) ? list[Number(answer) - 1] : undefined;
  if (!choice) throw new SetupError("No installation chosen: run bun run github:setup again");
  return choice;
}

// Waits for the App's installation: listed every few seconds (sooner on
// Enter) for up to 15 minutes. A new App is shown its install page first.
async function findInstallation(
  ctx: Ctx,
  app: App,
  key: AppKey,
  isNew: boolean,
): Promise<Installation> {
  const { d, deps } = ctx;
  const keyFix = savedKeyFix(d.deployment.kind === "k8s" ? d.configPath : undefined);
  const list = () => callWithAppKey(() => ctx.api.listInstallations(key), keyFix);
  let found = isNew ? [] : await list();
  if (found.length === 0) {
    const url = `${app.htmlUrl}/installations/new`;
    deps.log("Install the App on the repos devbox works on:");
    deps.log(`  ${url}`);
    deps.openUrl(url);
    deps.log("Waiting for the installation (press Enter to check now)...");
    const enter = deps.enter();
    const start = deps.now().getTime();
    try {
      for (;;) {
        found = await list();
        if (found.length > 0) break;
        if (deps.now().getTime() - start >= INSTALL_WAIT_MS) {
          throw new SetupError(
            `The App isn't installed yet: install it from ${url}, then run bun run github:setup again`,
          );
        }
        await Promise.race([deps.sleep(POLL_MS), enter.next()]);
      }
    } finally {
      enter.stop();
    }
  }
  const preferred = d.githubApp?.appId === app.appId ? d.githubApp.installationId : undefined;
  const chosen = await pickInstallation(ctx, found, preferred);
  deps.log(`The App is installed on ${chosen.account.login} (installation ${chosen.id})`);
  return chosen;
}

// What env and the keychain will do with the App's secrets at the next apply.
// Compared in memory, never printed.
async function secretLines(ctx: Ctx, appId: number, installationId: number): Promise<string[]> {
  const { d, deps, fresh, tokens, flag } = ctx;
  const { env, keychain } = deps.resolver;
  const apply = d.applyCommand;
  const scope = deploymentScope(d.deployment);
  const earlier = (name: string) =>
    `The saved ${name} for ${scope} is from an earlier App or key: remove it with bun run secrets rm ${name}${flag}`;
  // A keychain that can't be read here holds nothing for these lines.
  const savedValue = (name: string) =>
    keychain?.get(entryName(d.deployment, name)).catch(() => undefined);
  const lines: string[] = [];
  if (tokens === "external" && fresh.keyFile) {
    lines.push(
      `Store this key where your token tooling reads it (for example the External Secrets GithubAccessToken generator: appID ${appId}, installID ${installationId}), then delete the file`,
    );
  }
  if (tokens === "devbox" && fresh.key && !d.byoKeySecret) {
    const file = env[KEY_FILE] || undefined;
    const sameFile = file !== undefined && fresh.key.path === resolve(deps.cwd, file);
    if (file === undefined && fresh.keyFromPendingFile && fresh.key.path) {
      // The run that wrote the file named it with "once the new App is
      // installed". The file wins over a GITHUB_APP_PRIVATE_KEY in env.
      lines.push(`Set ${KEY_FILE}=${fresh.key.path} before ${apply}`);
    } else if (file !== undefined && !sameFile) {
      lines.push(
        `${KEY_FILE} is set in your environment from before this setup: set it to the new key's path, or unset it, before ${apply}`,
      );
    } else if (file === undefined && env[KEY]) {
      lines.push(
        `${KEY} is set in your environment from before this setup: set it to the new key, or unset it, before ${apply}`,
      );
    }
    if (!fresh.savedKey && (await savedValue(KEY))) {
      lines.push(earlier(KEY));
    }
  }
  if (!d.byoIntegrationsSecret) {
    const value = env[HOOK_SECRET] || undefined;
    if (fresh.webhook !== undefined) {
      if (value !== undefined && value !== fresh.webhook) {
        lines.push(
          `${HOOK_SECRET} is set in your environment from before this setup: set it to the new value, or unset it, before ${apply}`,
        );
      }
      if (!fresh.savedWebhook && (await savedValue(HOOK_SECRET))) {
        lines.push(earlier(HOOK_SECRET));
      }
    } else if (fresh.webhookShown) {
      // The new App's secret was shown once; what is here is the old App's.
      if (value !== undefined) {
        lines.push(
          `${HOOK_SECRET} is set in your environment from before this setup: set it to the new value, or unset it, before ${apply}`,
        );
      } else if (await savedValue(HOOK_SECRET)) {
        lines.push(earlier(HOOK_SECRET));
      } else {
        lines.push(`Set ${HOOK_SECRET} in your environment before ${apply}, or it asks for it`);
      }
    } else if (value !== undefined) {
      lines.push(`${apply} will use ${HOOK_SECRET} from your environment`);
    } else if (!(await savedValue(HOOK_SECRET))) {
      lines.push(`Set ${HOOK_SECRET} in your environment before ${apply}, or it asks for it`);
    }
  }
  return lines;
}

export async function setup(
  d: GithubDeployment,
  opts: SetupOptions,
  deps: SetupDeps,
): Promise<void> {
  const { log, resolver } = deps;
  const flag = d.deployment.kind === "k8s" ? ` --target ${d.configPath}` : "";
  const existing = d.githubApp;
  // A new App waiting for its install, even if the block was disabled since:
  // a plain run installs it, with the public URL it was set up with.
  const pending = existing?.slug !== undefined ? existing.pending : undefined;
  const resuming = opts.appId === undefined && !opts.reregister && pending !== undefined;
  const publicUrl = await resolvePublicUrl(
    d,
    { publicUrl: opts.publicUrl ?? (resuming ? pending?.publicUrl : undefined) },
    deps,
  );

  // Headless: the URL-parameter link, then the adopt path.
  if (opts.printRegistrationLink) {
    log(registrationLink({ ...(opts.org ? { org: opts.org } : {}), name: opts.name, publicUrl }));
    log(
      `Create the App, generate a private key, then run: bun run github:setup${flag} --app-id <id> --private-key-file <path>`,
    );
    return;
  }
  log(`Public URL: ${publicUrl}`);

  const tokens = opts.externalTokens ? "external" : (existing?.tokens ?? "devbox");
  const adopting = opts.appId !== undefined;
  // A working App stays configured while its replacement waits for its install.
  const working = existing?.enabled === true && existing.slug !== undefined ? existing : undefined;
  // The App a new one replaces: the working one, or the one a pending App
  // was registered to replace.
  const replaced = working ?? (pending !== undefined ? existing : undefined);
  const registering =
    !adopting &&
    !resuming &&
    (existing?.appId === undefined || existing.slug === undefined || opts.reregister);
  // Adopting another App over the working one replaces it the same way.
  const adoptingAnother = adopting && replaced !== undefined && replaced.appId !== opts.appId;
  const replacing = (registering && working !== undefined) || resuming || adoptingAnother;
  // A new App would take the place of one already waiting for its install,
  // or the configured App is adopted again (a new key) in its place.
  const adoptingConfigured = adopting && !adoptingAnother;
  const dropping =
    pending !== undefined && (registering || (adopting && pending.appId !== opts.appId));
  if (pending && dropping) {
    const installUrl = `https://github.com/apps/${pending.slug}/installations/new`;
    if (!resolver.isTTY) {
      throw new SetupError(
        `A new App ${pending.slug} is already waiting for its install: install it from ${installUrl} and run bun run github:setup${flag}, or remove it with bun run github:disable${flag} --forget`,
      );
    }
    const another = await resolver.confirm(
      adoptingConfigured
        ? `A new App ${pending.slug} is waiting for its install; adopting App ${opts.appId} again drops it. Drop it? [y/N] `
        : `A new App ${pending.slug} is already waiting for its install. Replace it with another one? [y/N] `,
      { defaultYes: false },
    );
    if (!another) {
      throw new SetupError(
        `Nothing was changed: install ${pending.slug} from ${installUrl}, then run bun run github:setup${flag}`,
      );
    }
    log(
      `The App ${pending.slug} is no longer used: delete it on GitHub: ${deleteLink(pending.slug, pending.org)}`,
    );
    if (!resolver.keychain) {
      log(
        `--no-keychain left any saved secrets of the App ${pending.slug} in the system keychain: remove them with bun run secrets rm ${KEY}${PENDING}${flag} and bun run secrets rm ${HOOK_SECRET}${PENDING}${flag}`,
      );
    } else if (await dropPendingSecrets(d, deps)) {
      log(`Removed the saved secrets of the App ${pending.slug} from the system keychain`);
    }
    // Nothing else rewrites the block before the install when the configured
    // App is adopted again: the dropped App goes from the config now.
    if (adoptingConfigured) {
      writeConfigKeys(d.configPath, { "integrations.githubApp.pending": undefined });
    }
  }

  if ((registering || adopting) && !resolver.isTTY) {
    throw new SetupError(
      "registering or adopting a GitHub App needs a terminal: run bun run github:setup in one",
    );
  }
  const tokenFile =
    tokens === "external" && d.deployment.kind === "compose"
      ? (existing?.tokenFile ?? (await askTokenFile(d, deps)))
      : undefined;
  const ctx: Ctx = {
    d,
    opts,
    deps,
    api: appApi({ fetch: deps.fetch, apiBase: githubApiBaseUrl(), now: deps.now }),
    publicUrl,
    tokens,
    ...(tokenFile !== undefined ? { tokenFile } : {}),
    flag,
    fresh: {},
    replacing,
  };

  // The App, and its key when there is one here.
  let app: App;
  let key: AppKey | undefined;
  if (opts.appId !== undefined) {
    if (adoptingAnother && working) {
      log(`The App ${working.slug} keeps working until the new App is installed.`);
    }
    ({ app, key } = await adoptApp(ctx, opts.appId));
  } else if (registering) {
    if (working) log(`The App ${working.slug} keeps working until the new App is installed.`);
    ({ app, key } = await registerApp(ctx));
  } else if (pending) {
    // The new App's install, after an earlier run stopped waiting for it.
    const pem = await pendingKey(ctx, pending);
    key = { appId: pending.appId, pem };
    // GitHub's slug: the App may have been renamed before its install.
    const info = await verifyApp({ appId: pending.appId }, pem, deps.fetch, {
      target: flag ? d.configPath : undefined,
    });
    if (info.slug !== pending.slug) {
      log(
        `The new App was renamed on GitHub: its slug is now ${info.slug} (was ${pending.slug}); mention it as @${info.slug}`,
      );
    }
    app = { appId: pending.appId, ...info };
  } else {
    const appId = existing?.appId as number;
    const slug = existing?.slug as string;
    app = { appId, slug, htmlUrl: `https://github.com/apps/${slug}` };
    const found = await resolvePrivateKey(resolver);
    if (found) {
      key = { appId, pem: found.pem };
      // GitHub's slug, not the saved one: renaming the App changes it, and
      // this run is what records the new one.
      const info = await verifyApp({ appId }, found.pem, deps.fetch, {
        target: flag ? d.configPath : undefined,
      });
      if (info.slug !== slug) {
        log(
          `The App was renamed on GitHub: its slug is now ${info.slug} (was ${slug}); mention it as @${info.slug}`,
        );
      }
      app = { appId, ...info };
    }
  }
  const isNew = registering || adopting || resuming;
  const sameApp = existing?.appId === app.appId;

  // Install.
  let installationId: number;
  let account: AppAccount | undefined;
  if (key) {
    const found = await findInstallation(ctx, app, key, registering);
    installationId = found.id;
    account = found.account;
  } else {
    log(NO_KEY);
    if (!sameApp || existing?.installationId === undefined) {
      throw new SetupError(
        `The App isn't installed yet, and there is no private key for it here: set ${KEY_FILE} to its path, then run bun run github:setup again`,
      );
    }
    installationId = existing.installationId;
  }

  // The bot user, for the commit identity.
  const botUserId =
    sameApp && existing?.slug === app.slug && existing.botUserId !== undefined
      ? existing.botUserId
      : await ctx.api.getBotUserId(app.slug);

  // Repo coverage: named, not a failure.
  if (key) {
    const pem = key.pem;
    const keyFix = savedKeyFix(flag ? d.configPath : undefined);
    const uncovered = await callWithAppKey(
      () => checkCoverage({ appId: app.appId, installationId }, pem, d.repos, deps.fetch),
      keyFix,
    );
    const where = installationSettingsUrl({ slug: app.slug, installationId }, account);
    for (const repo of uncovered) {
      log(`${repo} is not in the App's installation: add it at ${where}`);
    }
  }

  // A new public URL: the App's webhook follows when setup holds the key.
  let hookUpdated = false;
  if (
    !isNew &&
    key &&
    tokens === "devbox" &&
    d.publicUrl !== undefined &&
    d.publicUrl !== publicUrl
  ) {
    try {
      await ctx.api.updateHookConfig(key, { url: hookUrl(publicUrl) });
      hookUpdated = true;
    } catch (err) {
      if (!(err instanceof GithubAppError)) throw err;
      log(`Updating the GitHub App's webhook URL failed: ${err.message}`);
    }
  }

  // Write. Without a key here GitHub was not asked, so the saved owner stands.
  const org = app.owner
    ? app.owner.type === "Organization"
      ? app.owner.login
      : undefined
    : sameApp
      ? existing?.org
      : undefined;
  const keys: Record<string, unknown> = {
    "integrations.githubApp": {
      enabled: true,
      appId: app.appId,
      slug: app.slug,
      installationId,
      botUserId,
      tokens,
      tokenScope: existing?.tokenScope ?? "repos",
      ciResults: existing?.ciResults ?? true,
      ...(tokenFile !== undefined ? { tokenFile } : {}),
      ...(org !== undefined ? { org } : {}),
    },
    publicUrl,
  };
  let trusted: string | undefined;
  if (account && d.trust.trustedOrgs.length === 0 && d.trust.trustedUsers.length === 0) {
    const list = account.type === "Organization" ? "trustedOrgs" : "trustedUsers";
    const parent = d.deployment.kind === "k8s" ? "values.github" : "github";
    keys[`${parent}.${list}`] = [account.login];
    trusted = `Trusted: ${account.login} (edit ${d.configPath} to change)`;
  }
  const moved =
    replacing && replaced
      ? await movePendingSecrets(ctx, {
          slug: replaced.slug as string,
          enabled: replaced.enabled,
        })
      : undefined;
  // The whole block is replaced: a pending App becomes the App.
  try {
    writeConfigKeys(d.configPath, keys);
  } catch (err) {
    await moved?.undo();
    throw err;
  }
  await moved?.finish();
  if (trusted) log(trusted);
  log(`Wrote integrations.githubApp to ${d.configPath}`);
  if (replacing && replaced) {
    log(
      `The App ${replaced.slug} is no longer used: delete it on GitHub: ${deleteLink(replaced.slug as string, replaced.org)}`,
    );
  }
  if (moved && moved.replaced.length > 0) {
    log(
      moved.replaced.length === 2
        ? "The old App's saved key and webhook secret were replaced by the new App's"
        : moved.replaced[0] === KEY
          ? "The old App's saved key was replaced by the new App's"
          : "The old App's saved webhook secret was replaced by the new App's",
    );
  }
  // A new or adopted App already has this URL.
  for (const line of publicUrlChangeLines(
    d.publicUrl,
    publicUrl,
    {
      linear: d.linear,
      ...(isNew
        ? {}
        : {
            githubApp: {
              tokens,
              slug: app.slug,
              hookUpdated,
              ...(org !== undefined ? { org } : {}),
            },
          }),
    },
    "github",
  )) {
    log(line);
  }

  // Secrets.
  for (const line of await secretLines(ctx, app.appId, installationId)) log(line);

  // Next step.
  log(`Next: ${d.applyCommand}`);
  if (d.deployment.kind === "k8s") {
    const v = "integrations.githubApp";
    const block = keys[v] as Record<string, unknown>;
    log(
      `With GitOps, set these chart values instead: ${[
        `${v}.enabled: true`,
        `${v}.appId: ${app.appId}`,
        `${v}.installationId: ${installationId}`,
        `${v}.botLogin: ${app.slug}`,
        `${v}.botUserId: ${botUserId}`,
        `${v}.tokens: ${tokens}`,
        `${v}.tokenScope: ${block.tokenScope}`,
        `${v}.ciResults: ${block.ciResults}`,
      ].join(", ")}`,
    );
  }
  log(`Then check GitHub with: ${d.statusCommand}`);
}
