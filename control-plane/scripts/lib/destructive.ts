// Destructive commands share one confirmation: list what goes, then ask with a
// default of no. Without a terminal nothing can answer, so
// the command refuses unless --yes was given.
import type { ResolverDeps } from "./secrets";

export class DestructiveRefused extends Error {}

export type DestructiveDeps = {
  yes: boolean;
  isTTY: boolean;
  confirm: ResolverDeps["confirm"];
  log: (line: string) => void;
};

// True to go ahead. On false the caller prints "Nothing was removed." and exits 0.
export async function confirmDestructive(
  p: { command: string; items: string[]; question: string },
  deps: DestructiveDeps,
): Promise<boolean> {
  if (deps.yes) return true;
  if (!deps.isTTY) {
    throw new DestructiveRefused(
      `${p.command} deletes data: pass --yes to confirm without a terminal`,
    );
  }
  deps.log("This deletes:");
  for (const item of p.items) deps.log(`  - ${item}`);
  return deps.confirm(p.question, { defaultYes: false });
}
