// `bun run jira:setup`: gathers the Jira settings (the public URL, the site,
// the service account's email and when the API token expires), reads the
// token, finds the site's cloud id, asks Jira whose token it is and what the
// bot may do, proposes the statuses devbox moves issues to, records the
// settings in the deployment's config, optionally saves the secrets in the
// system keychain, and prints the admin webhook's settings. In a terminal it
// opens the Atlassian or Jira page a step needs; Jira takes nothing prefilled
// from a link, so it prints what to do there, and the link too. setup never
// applies and never touches the cluster.
// Re-running is safe: a configured setting is kept unless a flag changes it,
// and a newly entered token asks for its expiry again. The secrets are kept
// only from the environment or the keychain; otherwise they are asked for
// again.

import { writeConfigKeys } from "../lib/configFile";
import { isJiraDate, type JiraIntegration, jiraSiteOrigin } from "../lib/integrations";
import { deploymentScope, entryName, keychainUsable } from "../lib/keychain";
import { publicUrlChangeLines, resolvePublicUrl } from "../lib/publicUrl";
import {
  checkWithRetry,
  type Resolved,
  type ResolverDeps,
  resolveSecret,
  SecretError,
} from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import {
  checkJira,
  checkPermissions,
  cloudIdOf,
  SCOPES,
  tokenDaysLeft,
  tokenExpiryWarning,
} from "./check";
import type { JiraDeployment } from "./deployment";

export class SetupError extends Error {}

// The flags.
export type SetupOptions = {
  publicUrl?: string;
  site?: string;
  email?: string;
  tokenExpires?: string;
};

export type SetupDeps = {
  resolver: ResolverDeps;
  // Asks with echo; empty at EOF.
  promptLine: (q: string) => Promise<string>;
  fetch: Fetch;
  // `bytes` random bytes, as hex: a new webhook secret.
  random: (bytes: number) => string;
  // Shows a secret once, on the terminal, not the log.
  show: (secret: string) => void;
  // Opens a page in the browser, best effort.
  openUrl: (url: string) => void;
  now: () => Date;
  log: (line: string) => void;
};

type Ctx = { d: JiraDeployment; opts: SetupOptions; deps: SetupDeps; again: string };
type WebhookSecret = Resolved & { generated?: boolean };

// The HMAC is the only proof a delivery comes from Jira, so a typed webhook
// secret must be at least this long; a generated one has 64 characters.
// Jira's own "Generate secret" button makes 20 random characters; anything
// shorter is too easy to guess for the only proof a delivery comes from Jira.
const MIN_WEBHOOK_SECRET = 20;

// The link to a page a step needs, always printed; in a terminal, and unless
// `open` is false, the browser opens it too.
function page(ctx: Ctx, url: string, open = true): void {
  ctx.deps.log(`  ${url}`);
  if (open && ctx.deps.resolver.isTTY) ctx.deps.openUrl(url);
}

// A setting: its flag, else what is configured, else a prompt (terminal only).
async function setting(
  ctx: Ctx,
  s: { flag?: string; current?: string; question: string; what: string; flagName: string },
): Promise<string> {
  if (s.flag !== undefined) return s.flag.trim();
  if (s.current !== undefined) return s.current;
  if (!ctx.deps.resolver.isTTY) {
    throw new SetupError(`no ${s.what}: pass ${s.flagName}, or run \`${ctx.again}\` in a terminal`);
  }
  const answer = (await ctx.deps.promptLine(s.question)).trim();
  if (!answer) {
    throw new SetupError(
      `No ${s.what} entered: nothing was written. Run \`${ctx.again}\` again when you have it.`,
    );
  }
  return answer;
}

// The token from the environment or the keychain, without asking.
async function availableToken(resolver: ResolverDeps): Promise<Resolved | undefined> {
  try {
    return await resolveSecret("JIRA_API_TOKEN", resolver, { noPrompt: true });
  } catch (err) {
    if (!(err instanceof SecretError)) throw err;
    return undefined;
  }
}

// The token: `found` (availableToken's) from the environment as it is; with a
// terminal, a saved one is kept unless another one is pasted (rotation), and a
// missing one is asked for.
async function readToken(ctx: Ctx, found: Resolved | undefined): Promise<Resolved> {
  const { resolver } = ctx.deps;
  if (found && (found.source === "env" || !resolver.isTTY)) return found;
  if (!resolver.isTTY) {
    throw new SetupError(
      `no JIRA_API_TOKEN: run \`${ctx.again}\` in a terminal, or set JIRA_API_TOKEN`,
    );
  }
  const typed = (
    await resolver.prompt(
      found
        ? `Jira API token with ${SCOPES} (input hidden; press Enter to keep the saved one): `
        : `Jira API token with ${SCOPES} (input hidden): `,
    )
  ).trim();
  if (typed && typed !== found?.value) {
    return { name: "JIRA_API_TOKEN", value: typed, source: "prompt" };
  }
  if (found) return found;
  throw new SetupError(
    `No Jira API token entered: nothing was written. Run \`${ctx.again}\` again when you have it.`,
  );
}

// The token's expiry: --token-expires, else the configured one while the token
// is not new, else a prompt.
async function tokenExpiry(ctx: Ctx, newToken: boolean): Promise<string> {
  const { opts, d, deps } = ctx;
  const current = newToken ? undefined : d.jira?.tokenExpiresAt;
  const expires = await setting(ctx, {
    flag: opts.tokenExpires,
    current,
    question: "When the API token expires (YYYY-MM-DD, as Atlassian showed when you created it): ",
    what: "API token expiry date",
    flagName: "--token-expires <YYYY-MM-DD>",
  });
  if (!isJiraDate(expires)) {
    throw new SetupError("the token expiry must be a date such as 2027-01-31");
  }
  if (tokenDaysLeft(expires, deps.now()) < 0) {
    throw new SetupError(
      `the token expiry ${expires} is in the past: enter the date Atlassian showed for this token`,
    );
  }
  const warning = tokenExpiryWarning(expires, deps.now(), ctx.again);
  if (warning) deps.log(warning);
  return expires;
}

// The webhook's secret: from the environment or the keychain as it is, else
// typed (at least MIN_WEBHOOK_SECRET characters) or, on Enter, generated
// (terminal only).
async function webhookSecret(ctx: Ctx): Promise<WebhookSecret> {
  const { resolver } = ctx.deps;
  try {
    return await resolveSecret("JIRA_WEBHOOK_SECRET", resolver, { noPrompt: true });
  } catch (err) {
    if (!(err instanceof SecretError)) throw err;
  }
  if (!resolver.isTTY) {
    throw new SetupError(
      `no JIRA_WEBHOOK_SECRET: run \`${ctx.again}\` in a terminal to generate one, or set JIRA_WEBHOOK_SECRET to the secret of the webhook in Jira`,
    );
  }
  const typed = (
    await resolver.prompt(
      "Jira webhook secret (input hidden; paste the webhook's current one, or press Enter to generate a new one to set in Jira): ",
    )
  ).trim();
  if (typed && typed.length < MIN_WEBHOOK_SECRET) {
    throw new SetupError(
      `the webhook secret you entered has ${typed.length} characters; it needs at least ${MIN_WEBHOOK_SECRET}, as it is the only proof a delivery comes from Jira. Nothing was written: run \`${ctx.again}\` again and press Enter to generate one, then set it in Jira`,
    );
  }
  return typed
    ? { name: "JIRA_WEBHOOK_SECRET", value: typed, source: "prompt" }
    : {
        name: "JIRA_WEBHOOK_SECRET",
        value: ctx.deps.random(32),
        source: "prompt",
        generated: true,
      };
}

// With a terminal and a keychain that works, one offer to save what this run
// entered or generated. Returns the names saved.
async function saveSecrets(ctx: Ctx, fresh: Resolved[]): Promise<Set<string>> {
  const { d, deps } = ctx;
  const k = deps.resolver.keychain;
  if (fresh.length === 0 || !deps.resolver.isTTY || !k) return new Set();
  if (!(await keychainUsable(k, entryName(d.deployment, "JIRA_API_TOKEN")))) return new Set();
  const names = fresh.map((r) => r.name);
  const yes = await deps.resolver.confirm(
    `Save ${names.join(" and ")} to the system keychain for ${deploymentScope(d.deployment)}? [Y/n] `,
    { defaultYes: true },
  );
  if (!yes) return new Set();
  for (const r of fresh) await k.set(entryName(d.deployment, r.name), r.value);
  // A keychain that switched itself off during `set` saved nothing.
  return k.disabled ? new Set() : new Set(names);
}

export async function setup(d: JiraDeployment, opts: SetupOptions, deps: SetupDeps): Promise<void> {
  const { log, resolver } = deps;
  const ctx: Ctx = { d, opts, deps, again: `bun run jira:setup${d.flag}` };
  const cur: JiraIntegration | undefined = d.jira;
  const scope = deploymentScope(d.deployment);
  const byo = d.deployment.kind === "k8s" ? d.byoIntegrationsSecret : undefined;

  // 1. Where Jira sends webhooks, and which site and account devbox uses.
  const publicUrl = await resolvePublicUrl(d, opts, deps);
  log(`Public URL: ${publicUrl}`);
  const siteUrl = jiraSiteOrigin(
    await setting(ctx, {
      flag: opts.site,
      current: cur?.siteUrl,
      question: "Jira site URL (e.g. https://example.atlassian.net): ",
      what: "Jira site URL",
      flagName: "--site <https://…>",
    }),
  );
  if (!siteUrl) {
    throw new SetupError(
      "the Jira site URL must be an https origin such as https://example.atlassian.net",
    );
  }
  const cloudId = await cloudIdOf(siteUrl, deps.fetch);
  // Without a token, a new token is needed, and often the service account
  // too: say where before asking for its email.
  const found = await availableToken(resolver);
  if (!found && resolver.isTTY) {
    log(
      `Create the service account in Atlassian Administration (Directory → Service accounts) if it doesn't exist, give it access to Jira with the User role (not an admin role), and create an API token for it with exactly Jira's classic scopes ${SCOPES}:`,
    );
    page(ctx, "https://admin.atlassian.com/");
  }
  const botEmail = await setting(ctx, {
    flag: opts.email,
    current: cur?.botEmail,
    question: "The service account's email (shown on its page in Atlassian Administration): ",
    what: "service account email",
    flagName: "--email <address>",
  });
  if (!/^[^\s@]+@[^\s@]+$/.test(botEmail)) {
    throw new SetupError("the service account's email must be an email address");
  }

  // 2. Whose token it is: the bot's account id and name come from Jira.
  let token: Resolved;
  let bot: Awaited<ReturnType<typeof checkJira>>;
  try {
    // A 401 may mean the email is wrong, not the saved token: keep it.
    ({ resolved: token, result: bot } = await checkWithRetry(
      await readToken(ctx, found),
      resolver,
      (t) => checkJira({ cloudId, email: botEmail }, t, deps.fetch),
      { forgetRejected: false, label: `Jira API token with ${SCOPES}` },
    ));
  } catch (err) {
    // An empty answer at the re-ask: setup's own message, not up's env hint.
    if (err instanceof SecretError) {
      throw new SetupError(
        `No Jira API token entered: nothing was written. Run \`${ctx.again}\` again when you have it.`,
      );
    }
    throw err;
  }
  log(`devbox will act as ${bot.displayName} (account ${bot.accountId}) on ${siteUrl}`);

  // 3. What the bot may do, and the statuses it moves issues to. devbox works
  // in every project the service account can use.
  const warning = await checkPermissions({ cloudId, email: botEmail }, token.value, deps.fetch);
  if (warning) log(warning);
  // The statuses devbox moves issues to: the configured ones, else "In
  // Progress" when it starts work and none when it finishes, since devbox
  // ends with a draft PR that still needs review. A project without the
  // status is skipped, with a warning, when devbox moves an issue there.
  const statuses = ctx.d.jira?.statuses ?? { started: "In Progress" };

  // 4. The token's expiry and the webhook's secret.
  const tokenExpiresAt = await tokenExpiry(ctx, token.source === "prompt");
  const webhook = byo ? undefined : await webhookSecret(ctx);

  // 5. Save. The user's own integrations Secret holds the secrets; env is moot.
  const fresh = byo ? [] : [token, webhook].filter((r): r is Resolved => r?.source === "prompt");
  const saved = await saveSecrets(ctx, fresh);
  // A new token that wasn't saved: the saved one would still win over a
  // prompt at the next apply, while tokenExpiresAt now describes the new one.
  const k = resolver.keychain;
  if (
    !byo &&
    token.source === "prompt" &&
    !saved.has(token.name) &&
    k &&
    (await k.delete(entryName(d.deployment, token.name)))
  ) {
    log(
      `Removed the old ${token.name} saved in the system keychain for ${scope}, so that ${d.applyCommand} doesn't use it instead of the new one`,
    );
  }

  // 6. Write.
  writeConfigKeys(d.configPath, {
    "integrations.jira": {
      enabled: true,
      siteUrl,
      cloudId,
      botEmail,
      botAccountId: bot.accountId,
      botName: bot.displayName,
      statuses,
      tokenExpiresAt,
      ...(cur?.allowRestrictedIssues !== undefined
        ? { allowRestrictedIssues: cur.allowRestrictedIssues }
        : {}),
    },
    publicUrl,
  });
  log(`Wrote integrations.jira to ${d.configPath}`);
  for (const line of publicUrlChangeLines(
    d.publicUrl,
    publicUrl,
    { linear: d.linear, ...(d.githubApp ? { githubApp: d.githubApp } : {}) },
    "jira",
    d.flag,
  )) {
    log(line);
  }

  // 7. The admin webhook, every run: Jira has no API for it that the bot may use.
  const secretWhere = byo
    ? `JIRA_WEBHOOK_SECRET from Secret "${byo}"`
    : webhook?.source === "env"
      ? "JIRA_WEBHOOK_SECRET from your environment"
      : webhook?.source === "keychain"
        ? `the JIRA_WEBHOOK_SECRET saved in the system keychain for ${scope} (not shown; to replace it, run bun run secrets rm JIRA_WEBHOOK_SECRET${d.flag}, then ${ctx.again})`
        : webhook?.generated
          ? "the new secret shown below"
          : "the secret you entered";
  log("The webhook in Jira (a Jira admin creates it once: Settings → System → WebHooks):");
  // Opened when the webhook must be created or edited: on a first run, and
  // when this run generated a new secret or changed the public URL. Other
  // runs only print the link.
  page(
    ctx,
    `${siteUrl}/plugins/servlet/webhooks`,
    cur === undefined || webhook?.generated === true || d.publicUrl !== publicUrl,
  );
  log("Click Create there, or edit the webhook you have, and paste these values:");
  log(`  URL     ${publicUrl}/webhook/jira`);
  log(`  Secret  ${secretWhere}`);
  log("  Events  Issue: created, updated; Comment: created");
  // Quoted: keys such as GO, IF or NEXT are JQL reserved words.
  log(
    '  JQL     optional: leave it empty for every project, or limit devbox to some, e.g. project in ("ENG")',
  );
  if (webhook?.generated) {
    await deps.promptLine(
      "Press Enter to show the webhook secret, to paste into the webhook's Secret field ",
    );
    deps.show(webhook.value);
  }

  // 8. What the next apply does with each secret.
  const apply = d.applyCommand;
  if (byo) {
    log(
      `Put JIRA_API_TOKEN and JIRA_WEBHOOK_SECRET in Secret "${byo}" in namespace ${d.deployment.kind === "k8s" ? d.deployment.namespace : ""}.`,
    );
  } else {
    for (const r of [token, webhook]) {
      if (!r || r.source === "keychain" || saved.has(r.name)) continue;
      log(
        r.source === "env"
          ? `${apply} will use ${r.name} from your environment`
          : `Set ${r.name} in your environment before ${apply}; otherwise it asks for it in a terminal`,
      );
    }
  }

  // 9. Next step.
  log(`Next: ${apply} (setup applies nothing)`);
  if (d.deployment.kind === "k8s") {
    log(
      `With GitOps, set the chart values integrations.jira.* to the integrations.jira block in ${d.configPath} instead, with enabled: true`,
    );
  }
  log(`Then check Jira with: bun run jira:status${d.flag}`);
}
