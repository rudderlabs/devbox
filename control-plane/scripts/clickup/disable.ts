// `bun run clickup:disable [--forget]`. Plain, it switches ClickUp off and
// keeps everything needed to switch it back on, the webhook in ClickUp
// included. --forget also deletes that webhook through ClickUp's API when the
// bot's token is at hand, then the block and the saved ClickUp secrets,
// after the one destructive confirmation. Neither applies anything: both
// name the command that does. Either way the open ClickUp tasks keep running.

import { writeConfigKeys } from "../lib/configFile";
import { confirmDestructive } from "../lib/destructive";
import { deploymentScope, entryName } from "../lib/keychain";
import { errorMessage } from "../lib/knownError";
import type { ResolverDeps } from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import { type ClickupWebhook, clickupCall, isDevboxWebhook, webhooksOf } from "./check";
import type { ClickupDeployment } from "./deployment";

export type DisableDeps = { resolver: ResolverDeps; fetch: Fetch; log: (line: string) => void };
export type DisableOpts = { forget: boolean; yes: boolean };

const CLICKUP_SECRETS = ["CLICKUP_API_TOKEN", "CLICKUP_WEBHOOK_SECRET"] as const;
const LIST = "bun run devbox ls --source clickup";
// A task that isn't failed is open: queued, running, or idle awaiting a follow-up.
const OPEN_STATES = ["queued", "running", "idle"];

// The number of open ClickUp tasks, through the deployment's API; undefined
// when it can't be read. "100+" for a state with more than one page.
async function openTasks(d: ClickupDeployment): Promise<string | undefined> {
  try {
    let count = 0;
    let more = false;
    for (const state of OPEN_STATES) {
      const res = await d.api(`/api/tasks?source=clickup&state=${state}&limit=100`);
      if (!res.ok) return undefined;
      const body = (await res.json()) as { tasks?: unknown[]; next_before?: string | null };
      count += body.tasks?.length ?? 0;
      more ||= Boolean(body.next_before);
    }
    return `${count}${more ? "+" : ""}`;
  } catch {
    return undefined;
  }
}

async function afterLines(d: ClickupDeployment, log: (line: string) => void): Promise<void> {
  const open = await openTasks(d);
  log(
    open === undefined
      ? `Open ClickUp tasks (${LIST}) keep running; their results will not reach ClickUp.`
      : `${open} open ClickUp task(s) (${LIST}): these keep running; their results will not reach ClickUp.`,
  );
}

export async function disable(
  d: ClickupDeployment,
  opts: DisableOpts,
  deps: DisableDeps,
): Promise<void> {
  const { log, resolver } = deps;
  const scope = deploymentScope(d.deployment);
  const flag = d.flag;
  if (!d.clickup) {
    log(`ClickUp is not configured for ${scope}. Nothing to disable.`);
    return;
  }

  if (!opts.forget) {
    if (!d.clickup.enabled) {
      log(`ClickUp is already disabled for ${scope}.`);
      return;
    }
    writeConfigKeys(d.configPath, { "integrations.clickup": { ...d.clickup, enabled: false } });
    log(`Disabled ClickUp in ${d.configPath}.`);
    await afterLines(d, log);
    log(
      `The webhook in ClickUp stays: with ClickUp off its deliveries fail, and ClickUp suspends it after 100 failures; bun run clickup:setup${flag} reactivates it.`,
    );
    log(`Next: ${d.applyCommand}`);
    return;
  }

  const k = resolver.keychain && !resolver.keychain.disabled ? resolver.keychain : undefined;
  const saved: (typeof CLICKUP_SECRETS)[number][] = [];
  for (const name of CLICKUP_SECRETS) {
    if (k && (await k.get(entryName(d.deployment, name))) !== undefined) saved.push(name);
  }

  // The devbox webhooks, listed with the token from the environment or the
  // keychain; none to delete when either is missing or ClickUp can't list them.
  const token =
    resolver.env.CLICKUP_API_TOKEN || (await k?.get(entryName(d.deployment, "CLICKUP_API_TOKEN")));
  const teamId = d.clickup.teamId;
  let hooks: ClickupWebhook[] = [];
  if (!token || !teamId) {
    log(
      "No CLICKUP_API_TOKEN in your environment or the system keychain, so the webhook in ClickUp stays: to delete it too, run this with CLICKUP_API_TOKEN set to the bot's token. Removing the bot from the workspace also stops it.",
    );
  } else {
    try {
      hooks = (await webhooksOf(token, teamId, deps.fetch)).filter(isDevboxWebhook);
    } catch (err) {
      log(`Can't list the webhooks in ClickUp (${errorMessage(err)}): they stay.`);
    }
  }

  const proceed = await confirmDestructive(
    {
      command: "clickup:disable --forget",
      items: [
        ...hooks.map((h) => `webhook ${h.id} in ClickUp workspace ${teamId} (${h.endpoint})`),
        `integrations.clickup in ${d.configPath}`,
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

  // The webhook first, with the saved token; then the keychain: if a delete
  // fails, the block is still there to list on a retry.
  for (const h of hooks) {
    await clickupCall(token as string, deps.fetch, "DELETE", `/webhook/${h.id}`);
    log(`Deleted webhook ${h.id} in ClickUp.`);
  }
  for (const name of saved) await k?.delete(entryName(d.deployment, name));
  writeConfigKeys(d.configPath, { "integrations.clickup": undefined });
  await afterLines(d, log);
  log("The bot's ClickUp account and its API token are yours to remove.");
  log(`Next: ${d.applyCommand}`);
}
