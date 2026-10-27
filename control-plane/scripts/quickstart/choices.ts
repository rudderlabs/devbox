// The quickstart's three choices: where devbox runs, and whether to set up
// the GitHub App and Linear. A flag decides; an omitted flag is asked, never
// taken as "no". Without a terminal every undecided choice fails at once,
// naming the flags to pass.

import { dim } from "./style";

export type Platform = "compose" | "kind";
export type Choices = { platform: Platform; githubApp: boolean; linear: boolean };

// The parsed flags; parseArgs with allowNegative gives false for --no-<flag>.
export type ChoiceFlags = {
  compose?: boolean;
  kind?: boolean;
  "github-app"?: boolean;
  linear?: boolean;
};

// Which integrations the deployment already has on.
export type Enabled = { githubApp: boolean; linear: boolean };

export type ChoiceDeps = {
  isTTY: boolean;
  // Asks with echo; empty at EOF.
  promptLine: (q: string) => Promise<string>;
  confirm: (q: string, opts: { defaultYes: boolean }) => Promise<boolean>;
  log: (line: string) => void;
};

export class ChoiceError extends Error {}

const platformQuestion = () =>
  `Run devbox with Docker Compose or on a local kind cluster? ${dim("[compose/kind]")} `;

// The platform from the flags, or undefined when they leave it open.
export function platformFlag(flags: ChoiceFlags): Platform | undefined {
  if (flags.compose === false || flags.kind === false) {
    throw new ChoiceError("--no-compose and --no-kind are not flags: pass --compose or --kind");
  }
  if (flags.compose && flags.kind) throw new ChoiceError("--compose and --kind exclude each other");
  return flags.compose ? "compose" : flags.kind ? "kind" : undefined;
}

// Without a terminal, the flags that would have to be asked for.
export function undecidedFlags(flags: ChoiceFlags): string[] {
  const missing: string[] = [];
  if (platformFlag(flags) === undefined) missing.push("--compose or --kind");
  if (flags["github-app"] === undefined) missing.push("--github-app or --no-github-app");
  if (flags.linear === undefined) missing.push("--linear or --no-linear");
  return missing;
}

export function requireDecidable(flags: ChoiceFlags, isTTY: boolean): void {
  const missing = undecidedFlags(flags);
  if (isTTY || missing.length === 0) return;
  throw new ChoiceError(`no terminal to ask in: pass ${missing.join(", ")}`);
}

export async function choosePlatform(flags: ChoiceFlags, deps: ChoiceDeps): Promise<Platform> {
  const flagged = platformFlag(flags);
  if (flagged) return flagged;
  for (;;) {
    const a = (await deps.promptLine(platformQuestion())).trim().toLowerCase();
    if (a === "compose" || a === "kind") return a;
    deps.log('Answer "compose" or "kind".');
  }
}

const WHAT = {
  githubApp: {
    flag: "github-app",
    name: "the GitHub App",
    gives:
      "Pull requests then come from the App's bot, and @mentions, reviews and failed CI runs reach the agent.",
  },
  linear: {
    flag: "linear",
    name: "Linear",
    gives: "Delegating a Linear issue to the agent, or @mentioning it, then starts a task.",
  },
} as const;

// One integration: the flag, else a question. Already on, Enter re-runs its
// setup (safe: it reuses what is configured); off, Enter skips it.
export async function chooseIntegration(
  which: keyof typeof WHAT,
  flags: ChoiceFlags,
  enabled: Enabled,
  deps: ChoiceDeps,
): Promise<boolean> {
  const w = WHAT[which];
  const flagged = flags[w.flag];
  if (flagged !== undefined) return flagged;
  if (enabled[which]) {
    const name = w.name[0]?.toUpperCase() + w.name.slice(1);
    return deps.confirm(`${name} is already set up. Run its setup again? ${dim("[Y/n]")} `, {
      defaultYes: true,
    });
  }
  deps.log(`\n${w.gives} It needs a public HTTPS URL, such as a tunnel.`);
  return deps.confirm(`Set up ${w.name}? ${dim("[y/N]")} `, { defaultYes: false });
}
