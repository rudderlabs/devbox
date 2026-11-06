// `bun run jira:disable [--forget]`. Plain, it switches Jira off and
// keeps everything needed to switch it back on. --forget removes the block
// and the saved Jira secrets, after the one destructive confirmation.
// Neither applies anything: both name the command that does. Either way the
// open Jira tasks keep running, and the webhook in Jira is the user's to
// switch off.

import { writeConfigKeys } from "../lib/configFile";
import { confirmDestructive } from "../lib/destructive";
import { deploymentScope, entryName } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import type { JiraDeployment } from "./deployment";

export type DisableDeps = { resolver: ResolverDeps; log: (line: string) => void };
export type DisableOpts = { forget: boolean; yes: boolean };

const JIRA_SECRETS = ["JIRA_API_TOKEN", "JIRA_WEBHOOK_SECRET"] as const;
const LIST = "bun run devbox ls --source jira";
// A task that isn't failed is open: queued, running, or idle awaiting a follow-up.
const OPEN_STATES = ["queued", "running", "idle"];

// The number of open Jira tasks, through the deployment's API; undefined when
// it can't be read. "100+" for a state with more than one page.
async function openTasks(d: JiraDeployment): Promise<string | undefined> {
  try {
    let count = 0;
    let more = false;
    for (const state of OPEN_STATES) {
      const res = await d.api(`/api/tasks?source=jira&state=${state}&limit=100`);
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

async function afterLines(d: JiraDeployment, log: (line: string) => void): Promise<void> {
  const open = await openTasks(d);
  log(
    open === undefined
      ? `Open Jira tasks (${LIST}) keep running; their results will not reach Jira.`
      : `${open} open Jira task(s) (${LIST}): these keep running; their results will not reach Jira.`,
  );
}

export async function disable(
  d: JiraDeployment,
  opts: DisableOpts,
  deps: DisableDeps,
): Promise<void> {
  const { log, resolver } = deps;
  const scope = deploymentScope(d.deployment);
  if (!d.jira) {
    log(`Jira is not configured for ${scope}. Nothing to disable.`);
    return;
  }

  if (!opts.forget) {
    if (!d.jira.enabled) {
      log(`Jira is already disabled for ${scope}.`);
      return;
    }
    writeConfigKeys(d.configPath, { "integrations.jira": { ...d.jira, enabled: false } });
    log(`Disabled Jira in ${d.configPath}.`);
    await afterLines(d, log);
    log("Disable the webhook in Jira (Settings → System → WebHooks).");
    log(`Next: ${d.applyCommand}`);
    return;
  }

  const k = resolver.keychain && !resolver.keychain.disabled ? resolver.keychain : undefined;
  const saved: (typeof JIRA_SECRETS)[number][] = [];
  for (const name of JIRA_SECRETS) {
    if (k && (await k.get(entryName(d.deployment, name))) !== undefined) saved.push(name);
  }
  const proceed = await confirmDestructive(
    {
      command: "jira:disable --forget",
      items: [
        `integrations.jira in ${d.configPath}`,
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
  writeConfigKeys(d.configPath, { "integrations.jira": undefined });
  await afterLines(d, log);
  log(
    "Delete the webhook in Jira (Settings → System → WebHooks); the service account and its API token are yours to remove.",
  );
  log(`Next: ${d.applyCommand}`);
}
