// `bun run clickup:setup`: resolves the public URL, reads the bot's personal
// API token and asks ClickUp whose it is, picks the workspace and checks that
// the bot is a member there, creates or updates the devbox webhook through
// ClickUp's API (ClickUp makes its secret), records the settings in the
// deployment's config, optionally saves both secrets in the system keychain,
// and names the command that applies them. setup never applies and never
// touches the cluster; its network calls go only to ClickUp.
// Re-running is safe: the webhook is updated in place, never deleted and
// recreated, which would change its secret; a configured setting is kept
// unless a flag changes it; a saved secret is never removed.

import { writeConfigKeys } from "../lib/configFile";
import type { ClickupIntegration } from "../lib/integrations";
import { deploymentScope, entryName, keychainUsable } from "../lib/keychain";
import { resolvePublicUrl } from "../lib/publicUrl";
import {
  checkWithRetry,
  type Resolved,
  type ResolverDeps,
  resolveSecret,
  SecretError,
  type SecretName,
} from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import { publicUrlChangeLines } from "../webhooks";
import {
  type ClickupTeam,
  type ClickupWebhook,
  checkClickup,
  clickupCall,
  EVENTS,
  isDevboxWebhook,
  TOKEN_LABEL,
  teamsOf,
  WEBHOOK_PATH,
  webhooksOf,
} from "./check";
import type { ClickupDeployment } from "./deployment";

export class SetupError extends Error {}

// The flags.
export type SetupOptions = { publicUrl?: string; team?: string };

export type SetupDeps = {
  resolver: ResolverDeps;
  // Asks with echo; empty at EOF.
  promptLine: (q: string) => Promise<string>;
  fetch: Fetch;
  // Shows a secret once, on the terminal, not the log.
  show: (secret: string) => void;
  log: (line: string) => void;
};

type Ctx = { d: ClickupDeployment; opts: SetupOptions; deps: SetupDeps; again: string };

// What a first run moves a task to when devbox starts work; nothing when it
// finishes, since devbox ends with a draft PR that still needs review.
const FIRST_STATUSES = { started: "in progress" };
const ROLES: Record<number, string> = { 1: "owner", 2: "admin", 3: "member" };
const GUEST = 4;

// A secret from the environment or the keychain, without asking.
async function stored(name: SecretName, resolver: ResolverDeps): Promise<Resolved | undefined> {
  try {
    return await resolveSecret(name, resolver, { noPrompt: true });
  } catch (err) {
    if (!(err instanceof SecretError)) throw err;
    return undefined;
  }
}

// The token: `found` from the environment as it is; with a terminal, a saved
// one is kept unless another one is pasted (rotation), and a missing one is
// asked for.
async function readToken(ctx: Ctx, found: Resolved | undefined): Promise<Resolved> {
  const { resolver } = ctx.deps;
  if (found && (found.source === "env" || !resolver.isTTY)) return found;
  if (!resolver.isTTY) {
    throw new SetupError(
      `no CLICKUP_API_TOKEN: run \`${ctx.again}\` in a terminal, or set CLICKUP_API_TOKEN`,
    );
  }
  const typed = (
    await resolver.prompt(
      found
        ? `${TOKEN_LABEL} (input hidden; press Enter to keep the saved one): `
        : `${TOKEN_LABEL} (input hidden): `,
    )
  ).trim();
  if (typed && typed !== found?.value) {
    return { name: "CLICKUP_API_TOKEN", value: typed, source: "prompt" };
  }
  if (found) return found;
  throw new SetupError(
    `No ClickUp API token entered: nothing was written. Run \`${ctx.again}\` again when you have it.`,
  );
}

// The workspace: --team, else the configured one, else the bot's only one,
// else a choice in a terminal.
async function pickTeam(ctx: Ctx, teams: ClickupTeam[]): Promise<ClickupTeam> {
  const { log, resolver } = ctx.deps;
  const list = teams.map((t) => `${t.name} (${t.id})`).join(", ");
  const want = ctx.opts.team?.trim() ?? ctx.d.clickup?.teamId;
  if (want !== undefined) {
    if (!/^[0-9]+$/.test(want)) {
      throw new SetupError("--team must be a ClickUp workspace id, digits only");
    }
    const team = teams.find((t) => String(t.id) === want);
    if (team) return team;
    throw new SetupError(
      `the bot is not in ClickUp workspace ${want}: invite it there as a member${teams.length ? `, or pass --team with one of its workspaces: ${list}` : ""}`,
    );
  }
  const [only] = teams;
  if (teams.length === 1 && only) return only;
  if (!only) {
    throw new SetupError(
      `the bot is in no ClickUp workspace: invite it to yours as a member, then run \`${ctx.again}\` again`,
    );
  }
  if (!resolver.isTTY) {
    throw new SetupError(
      `the bot is in ${teams.length} ClickUp workspaces: pass --team <id> with one of ${list}`,
    );
  }
  log("The bot is in several ClickUp workspaces:");
  for (const [i, t] of teams.entries()) log(`  ${i + 1}. ${t.name} (${t.id})`);
  const answer = (
    await ctx.deps.promptLine("The workspace devbox works in (number or id): ")
  ).trim();
  const team = teams[Number(answer) - 1] ?? teams.find((t) => String(t.id) === answer);
  if (!team) {
    throw new SetupError(
      `no workspace ${JSON.stringify(answer)}: nothing was written. Run \`${ctx.again}\` again, or pass --team <id>.`,
    );
  }
  return team;
}

// The devbox webhook for `hookUrl`: the one already there (at this URL, else
// at an older public URL) updated in place, which also reactivates a
// suspended one; otherwise a new one. ClickUp answers with its secret.
async function registerWebhook(
  ctx: Ctx,
  token: string,
  teamId: string,
  hookUrl: string,
): Promise<{ hook: ClickupWebhook; created: boolean }> {
  const { fetch, log } = ctx.deps;
  const hooks = await webhooksOf(token, teamId, fetch);
  const existing = hooks.find((h) => h.endpoint === hookUrl) ?? hooks.find(isDevboxWebhook);
  if (!existing) {
    const res = await clickupCall<{ id?: string; webhook?: ClickupWebhook }>(
      token,
      fetch,
      "POST",
      `/team/${teamId}/webhook`,
      { endpoint: hookUrl, events: EVENTS },
    );
    const id = res.webhook?.id ?? res.id ?? "?";
    log(`Webhook ${id} in ClickUp: created for ${hookUrl} (${EVENTS.join(", ")})`);
    return { hook: { endpoint: hookUrl, ...res.webhook, id }, created: true };
  }
  const res = await clickupCall<{ webhook?: ClickupWebhook }>(
    token,
    fetch,
    "PUT",
    `/webhook/${existing.id}`,
    { endpoint: hookUrl, events: EVENTS, status: "active" },
  );
  const moved = existing.endpoint !== hookUrl ? ` (it pointed at ${existing.endpoint})` : "";
  const was = existing.health?.status;
  const revived = was && was !== "active" ? `; reactivated (it was ${was})` : "";
  log(`Webhook ${existing.id} in ClickUp: updated for ${hookUrl}${moved}${revived}`);
  // The secret from the answer, else the listing's: an update keeps it.
  const secret = res.webhook?.secret || existing.secret;
  return {
    hook: { ...existing, endpoint: hookUrl, ...(secret ? { secret } : {}) },
    created: false,
  };
}

// The webhook's secret: ClickUp's (from creating or listing the webhook),
// compared with what the environment or the keychain hold. Undefined when
// the user's own Secret holds it.
async function webhookSecret(
  ctx: Ctx,
  hook: ClickupWebhook,
  created: boolean,
): Promise<Resolved | undefined> {
  const { d, deps, again } = ctx;
  const byo = d.deployment.kind === "k8s" ? d.byoIntegrationsSecret : undefined;
  const local = byo ? undefined : await stored("CLICKUP_WEBHOOK_SECRET", deps.resolver);
  const remote = hook.secret || undefined;
  if (!remote) {
    if (created) {
      throw new SetupError(
        `ClickUp created webhook ${hook.id} but returned no secret: run \`${again}\` again, which reads it from the webhook`,
      );
    }
    if (byo || local) return local;
    throw new SetupError(
      `ClickUp didn't return the secret of webhook ${hook.id}, and none is in your environment or the keychain: set CLICKUP_WEBHOOK_SECRET to it and run \`${again}\` again. If it is lost, bun run clickup:disable --forget${d.flag} deletes the webhook (and the ClickUp settings); setup then creates a new one.`,
    );
  }
  if (local?.value === remote) return local;
  if (local?.source === "env") {
    throw new SetupError(
      `CLICKUP_WEBHOOK_SECRET in your environment is not the secret of webhook ${hook.id}: unset it, or set it to the webhook's, and run \`${again}\` again. Nothing was written.`,
    );
  }
  if (local) {
    deps.log(
      `The CLICKUP_WEBHOOK_SECRET saved in the system keychain for ${deploymentScope(d.deployment)} is not webhook ${hook.id}'s secret: using ClickUp's`,
    );
  }
  return { name: "CLICKUP_WEBHOOK_SECRET", value: remote, source: "prompt" };
}

// With a terminal and a keychain that works, one offer to save what this run
// entered or got from ClickUp. Returns the names saved.
async function saveSecrets(ctx: Ctx, fresh: Resolved[]): Promise<Set<string>> {
  const { d, deps } = ctx;
  const k = deps.resolver.keychain;
  if (fresh.length === 0 || !deps.resolver.isTTY || !k) return new Set();
  if (!(await keychainUsable(k, entryName(d.deployment, "CLICKUP_API_TOKEN")))) return new Set();
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

export async function setup(
  d: ClickupDeployment,
  opts: SetupOptions,
  deps: SetupDeps,
): Promise<void> {
  const { log, resolver } = deps;
  const ctx: Ctx = { d, opts, deps, again: `bun run clickup:setup${d.flag}` };
  const cur: ClickupIntegration | undefined = d.clickup;
  const scope = deploymentScope(d.deployment);
  const byo = d.deployment.kind === "k8s" ? d.byoIntegrationsSecret : undefined;

  // 1. Where ClickUp sends webhooks.
  const publicUrl = await resolvePublicUrl(d, opts, deps);
  log(`Public URL: ${publicUrl}`);
  const hookUrl = `${publicUrl}${WEBHOOK_PATH}`;

  // 2. The bot: whose token it is, its workspace and its role there. A blank
  // line before each part of the output: the bot, the webhook, and what was
  // saved and written.
  log("");
  const found = await stored("CLICKUP_API_TOKEN", resolver);
  if (!found && resolver.isTTY) {
    log("The bot, the ClickUp account devbox acts as:");
    log("  1. Invite it to your workspace as a member (not a guest), if it isn't there.");
    log("  2. Signed in as the bot, generate its personal API token under Settings → Apps:");
    log("  https://app.clickup.com/settings/apps");
  }
  let token: Resolved;
  let bot: Awaited<ReturnType<typeof checkClickup>>;
  try {
    // A saved token ClickUp rejects is kept: only the user removes it.
    ({ resolved: token, result: bot } = await checkWithRetry(
      await readToken(ctx, found),
      resolver,
      (t) => checkClickup(t, deps.fetch),
      { forgetRejected: false, label: TOKEN_LABEL },
    ));
  } catch (err) {
    // An empty answer at the re-ask: setup's own message, not up's env hint.
    if (err instanceof SecretError) {
      throw new SetupError(
        `No ClickUp API token entered: nothing was written. Run \`${ctx.again}\` again when you have it.`,
      );
    }
    throw err;
  }
  const team = await pickTeam(ctx, await teamsOf(token.value, deps.fetch));
  const teamId = String(team.id);
  const role = team.members?.find((m) => m.user?.id === bot.id)?.user.role;
  if (role === GUEST) {
    throw new SetupError(
      `${bot.username} is a guest in workspace ${team.name}: a guest sees only what is shared with it and may not manage the workspace's webhooks, so devbox needs a member (or an admin or owner). Make it a member in ClickUp (Settings → People), then run \`${ctx.again}\` again.`,
    );
  }
  const roleName = typeof role === "number" ? ROLES[role] : undefined;
  if (!roleName) {
    throw new SetupError(
      `can't tell ${bot.username}'s role in workspace ${team.name}: it must be a member, an admin or the owner there`,
    );
  }
  log(
    `devbox will act as ${bot.username} (user ${bot.id}), a ${roleName} of workspace ${team.name} (${teamId})`,
  );

  // 3. The webhook, through ClickUp's API with the bot's token.
  log("");
  const { hook, created } = await registerWebhook(ctx, token.value, teamId, hookUrl);
  const webhook = await webhookSecret(ctx, hook, created);

  // 4. Save, and show a new secret that wasn't saved. The user's own
  // integrations Secret holds the secrets; env and the keychain are moot.
  log("");
  const fresh = [token, webhook].filter((r): r is Resolved => r?.source === "prompt");
  const saved = byo ? new Set<string>() : await saveSecrets(ctx, fresh);
  if (webhook?.source === "prompt" && !saved.has(webhook.name)) {
    if (resolver.isTTY) {
      await deps.promptLine(
        `Press Enter to show the webhook secret, to set as CLICKUP_WEBHOOK_SECRET${byo ? ` in Secret "${byo}"` : ""} `,
      );
      deps.show(webhook.value);
    } else {
      log(
        `The webhook secret is not shown without a terminal: run \`${ctx.again}\` in a terminal to save or see it`,
      );
    }
  }

  // 5. Write. A first run sets the statuses; a re-run keeps what is there.
  const statuses = cur ? cur.statuses : FIRST_STATUSES;
  writeConfigKeys(d.configPath, {
    "integrations.clickup": {
      enabled: true,
      teamId,
      botUserId: bot.id,
      botName: bot.username,
      ...(statuses !== undefined ? { statuses } : {}),
    },
    publicUrl,
  });
  log(`Wrote integrations.clickup to ${d.configPath}`);
  // ClickUp's own webhook was updated above.
  for (const line of publicUrlChangeLines(
    d.publicUrl,
    publicUrl,
    d.integrations,
    { name: "clickup" },
    d.flag,
  )) {
    log(line);
  }

  // 6. What the next apply does with each secret. A saved one is never
  // removed: one that a new value didn't replace still wins at the next
  // apply, unless the environment sets it.
  const apply = d.applyCommand;
  const k = resolver.keychain;
  if (byo) {
    log(
      `Put CLICKUP_API_TOKEN and CLICKUP_WEBHOOK_SECRET in Secret "${byo}" in namespace ${d.deployment.kind === "k8s" ? d.deployment.namespace : ""}.`,
    );
  } else {
    for (const r of [token, webhook]) {
      if (!r || r.source === "keychain" || saved.has(r.name)) continue;
      if (r.source === "env") log(`${apply} will use ${r.name} from your environment`);
      else if (k && !k.disabled && (await k.get(entryName(d.deployment, r.name))) !== undefined) {
        log(
          `The old ${r.name} saved in the system keychain for ${scope} stays, and ${apply} would use it: set ${r.name} in your environment, which wins, or remove the old one with bun run secrets rm ${r.name}${d.flag}`,
        );
      } else {
        log(
          `Set ${r.name} in your environment before ${apply}; otherwise it asks for it in a terminal`,
        );
      }
    }
  }

  // 7. Next step.
  log(`Next: ${apply} (setup applies nothing)`);
  if (d.deployment.kind === "k8s") {
    log(
      `With GitOps, set the chart values integrations.clickup.* to the integrations.clickup block in ${d.configPath} instead, with enabled: true`,
    );
  }
  log(`Then check ClickUp with: bun run clickup:status${d.flag}`);
}
