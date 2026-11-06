// `bun run jira:setup`: gathers the Jira settings (the public URL, the site,
// the service account's email, the project keys, who is trusted and when the
// API token expires), reads the token, finds the site's cloud id, asks Jira
// whose token it is and what the bot may do in each project, proposes the
// statuses devbox moves issues to, records the settings in the deployment's
// config, optionally saves the secrets in the system keychain, and prints the
// admin webhook's settings. In a terminal it opens the Atlassian or Jira page
// a step needs; Jira takes nothing prefilled from a link, so it prints what to
// do there, and the link too. setup never applies and never touches the
// cluster.
// Re-running is safe: a configured setting is kept unless a flag changes it,
// and a newly entered token asks for its expiry again. The secrets are kept
// only from the environment or the keychain; otherwise they are asked for
// again.

import { writeConfigKeys } from "../lib/configFile";
import {
  isJiraDate,
  JIRA_ACCOUNT_ID,
  JIRA_PROJECT_KEY,
  type JiraIntegration,
  type JiraStatuses,
  jiraSiteOrigin,
} from "../lib/integrations";
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
  checkGroupsPermission,
  checkJira,
  checkProjects,
  cloudIdOf,
  GROUPS_PERMISSION_MISSING,
  type ProjectCheck,
  permissionList,
  SCOPES,
  tokenDaysLeft,
  tokenExpiryWarning,
  UNSEEN_PROJECT,
} from "./check";
import type { JiraDeployment } from "./deployment";

export class SetupError extends Error {}

// The flags; a comma-separated list for each list.
export type SetupOptions = {
  publicUrl?: string;
  site?: string;
  email?: string;
  projects?: string;
  trustedGroups?: string;
  trustedUsers?: string;
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

const STATUS_ROLES = [
  { key: "started", proposal: "In Progress", when: "when it starts work" },
  { key: "done", proposal: "Done", when: "when it finishes" },
] as const;

const list = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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

// The project keys, upper-cased and checked.
async function projectKeys(ctx: Ctx): Promise<string[]> {
  const raw = await setting(ctx, {
    flag: ctx.opts.projects,
    current: ctx.d.jira?.projectKeys?.join(","),
    question:
      "Jira project keys devbox works in, comma-separated (the key of each space, e.g. ENG): ",
    what: "Jira project keys",
    flagName: "--projects <KEY,…>",
  });
  const keys = [...new Set(list(raw).map((k) => k.toUpperCase()))];
  const bad = keys.find((k) => !JIRA_PROJECT_KEY.test(k));
  if (bad !== undefined || keys.length === 0) {
    throw new SetupError(
      `${bad === undefined ? "no project key given" : `"${bad}" is not a project key`}: use the key of each space, e.g. ENG`,
    );
  }
  return keys;
}

// The statuses devbox moves issues to. Proposed only while the config has
// none: a status every readable project has, "In Progress" when it starts
// and "Done" when it finishes, which a terminal may change ("-" for none).
async function chooseStatuses(ctx: Ctx, checks: ProjectCheck[]): Promise<JiraStatuses> {
  const { deps, d } = ctx;
  const readable = checks.flatMap((c) => ("error" in c ? [] : [c]));
  const current = d.jira?.statuses;
  const out: JiraStatuses = { ...current };
  if (current === undefined) {
    const common = (readable[0]?.statuses ?? []).filter((name) =>
      readable.every((c) => c.statuses.some((s) => sameName(s, name))),
    );
    if (deps.resolver.isTTY && common.length > 0) {
      deps.log(`Statuses every project has: ${common.join(", ")}`);
    }
    for (const role of STATUS_ROLES) {
      const proposal = common.find((s) => sameName(s, role.proposal));
      let chosen = proposal;
      if (deps.resolver.isTTY) {
        const q = `Status devbox moves an issue to ${role.when}`;
        const answer = (
          await deps.promptLine(
            proposal ? `${q} [${proposal}] (- for none): ` : `${q} (Enter for none): `,
          )
        ).trim();
        chosen = answer === "-" ? undefined : answer || proposal;
      }
      if (chosen) out[role.key] = chosen;
    }
  }
  for (const role of STATUS_ROLES) {
    if (!out[role.key]) {
      deps.log(
        `warning: no ${role.key} status: devbox won't move issues ${role.when}. Set integrations.jira.statuses.${role.key} in ${d.configPath} to a status every project has`,
      );
    }
  }
  for (const [key, name] of Object.entries(out)) {
    for (const c of readable) {
      if (!c.statuses.some((s) => sameName(s, name))) {
        deps.log(`warning: project ${c.key} has no status "${name}" (statuses.${key})`);
      }
    }
  }
  return out;
}

// Who may assign issues to devbox and ask it to follow up: the groups and
// account ids from the flags, else the configured ones. With none, every
// person with access to the site. A first run in a terminal asks, and Enter
// keeps that default.
async function chooseTrust(ctx: Ctx): Promise<{ groups: string[]; users: string[] }> {
  const { opts, d, deps } = ctx;
  let groups =
    opts.trustedGroups !== undefined ? list(opts.trustedGroups) : (d.jira?.trustedGroups ?? []);
  let users =
    opts.trustedUsers !== undefined ? list(opts.trustedUsers) : (d.jira?.trustedUsers ?? []);
  const flagged = opts.trustedGroups !== undefined || opts.trustedUsers !== undefined;
  if (!flagged && d.jira === undefined && deps.resolver.isTTY) {
    const everyone = "Enter for everyone with access to the site";
    groups = list(
      await deps.promptLine(
        `Jira groups whose members may assign issues to devbox, comma-separated (${everyone}): `,
      ),
    );
    users = list(
      await deps.promptLine(
        groups.length > 0
          ? "Account ids of other people who may, comma-separated (Enter for none): "
          : `Account ids of the only people who may, comma-separated (${everyone}): `,
      ),
    );
  }
  const bad = users.find((u) => !JIRA_ACCOUNT_ID.test(u));
  if (bad !== undefined) {
    throw new SetupError(
      `"${bad}" is not a Jira account id: use the id at the end of the person's profile URL in Jira`,
    );
  }
  if (groups.length === 0 && users.length === 0) {
    deps.log(
      "Trust: everyone with access to the site (narrow it with --trusted-groups or --trusted-users)",
    );
  }
  return { groups, users };
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

  // 3. Projects: what the bot may do there, and their statuses.
  const keys = await projectKeys(ctx);
  const checks = await checkProjects({ cloudId, email: botEmail }, token.value, keys, deps.fetch);
  // Each failing project's permissions page; only the first one opens.
  let opened = false;
  for (const c of checks) {
    if ("error" in c) log(`warning: project ${c.key}: ${c.error}`);
    else if (c.missingPermissions.length > 0) {
      log(
        `warning: the bot lacks ${permissionList(c.missingPermissions)} in project ${c.key}: give the service account a role there that has them`,
      );
    }
    if ("error" in c ? c.error === UNSEEN_PROJECT : c.missingPermissions.length > 0) {
      const key = encodeURIComponent(c.key);
      page(ctx, `${siteUrl}/plugins/servlet/project-config/${key}/permissions`, !opened);
      opened = true;
    }
  }
  const statuses = await chooseStatuses(ctx, checks);

  // 4. Trust, the token's expiry and the webhook's secret.
  const trust = await chooseTrust(ctx);
  if (trust.groups.length > 0) {
    const warning = await checkGroupsPermission(
      { cloudId, email: botEmail },
      token.value,
      deps.fetch,
    );
    if (warning) log(warning);
    if (warning === GROUPS_PERMISSION_MISSING) {
      page(ctx, `${siteUrl}/secure/admin/GlobalPermissions!default.jspa`);
    }
  }
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
      projectKeys: keys,
      ...(trust.groups.length > 0 ? { trustedGroups: trust.groups } : {}),
      ...(trust.users.length > 0 ? { trustedUsers: trust.users } : {}),
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
  // Quoted: keys such as GO, IF or NEXT are JQL reserved words. A key is
  // letters, digits and underscores, so quoting is safe.
  log(`  JQL     project in (${keys.map((key) => `"${key}"`).join(", ")})`);
  log("Update the webhook's JQL whenever the project keys change.");
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
