// Option definitions and value parsers shared by the command modules.
import { type Command, InvalidArgumentError } from "commander";
import type { ApiTaskSource, ApiTaskState } from "../../control-plane/src/types/api";
import { MAX_TIMEOUT_MS } from "../core/limits";
import { type CommonArgs, type FollowFlags, type TextSource, UsageError } from "./command";
import { parseDuration } from "./duration";

// Option values as commander hands them to an action.
export type Opts = {
  url?: string;
  token?: string;
  profile?: string;
  json?: boolean;
  source?: ApiTaskSource;
  mine?: boolean;
  state?: ApiTaskState;
  limit?: number;
  description?: string;
  input?: string;
  flag?: string[];
  title?: string;
  follow?: boolean;
  wait?: boolean;
  after?: number;
  timeout?: number;
};

// Options every command takes, listed last in each command's help.
export function common(c: Command): Command {
  return c
    .allowExcessArguments(false)
    .option("--url <url>", "API base URL (default: $DEVBOX_CLI_URL or config)")
    .option("--token <token>", "API token (default: $DEVBOX_CLI_TOKEN or config)")
    .option(
      "--profile <name>",
      "profile from the config file (default: $DEVBOX_CLI_PROFILE or the current one)",
    )
    .option("--json", "print JSON instead of text");
}

export const commonArgs = (o: Opts): CommonArgs => ({
  connection: { url: o.url, token: o.token, profile: o.profile },
  json: o.json === true,
});

export const integer =
  (min: number) =>
  (value: string): number => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) {
      throw new InvalidArgumentError(`Expected an integer >= ${min}.`);
    }
    return n;
  };

export function timeout(value: string): number {
  const ms = parseDuration(value);
  if (ms === null) throw new InvalidArgumentError("Use e.g. 45s, 30m, 2h or 1h30m.");
  if (ms > MAX_TIMEOUT_MS) {
    throw new InvalidArgumentError(
      `The longest timeout is ${Math.floor(MAX_TIMEOUT_MS / 3_600_000)}h.`,
    );
  }
  return ms;
}

// The description options shared by create and restart.
export function definition(c: Command, flagHelp: string): Command {
  return c
    .option("-d, --description <text>", "the task description")
    .option("-i, --input <path>", "read the description from a file")
    .option("--flag <name>", flagHelp, (value: string, previous: string[] = []) => [
      ...previous,
      value,
    ]);
}

// The flags that follow a write's round, listed after the command's own options.
export function following(c: Command): Command {
  return c
    .option("-f, --follow", "then print the task's log as it happens")
    .option("-w, --wait", "then wait until the task is idle or failed and print the response")
    .option("-t, --timeout <duration>", "with --wait: give up after (e.g. 45s, 1h30m)", timeout);
}

export function followFlags(o: Opts, command: string): FollowFlags {
  if (o.timeout !== undefined && o.wait !== true) {
    throw new UsageError("--timeout needs --wait", command);
  }
  return { follow: o.follow === true, wait: o.wait === true, timeoutMs: o.timeout };
}

// The one text source a command was given, or undefined for none.
export function oneSource(
  command: string,
  sources: Array<TextSource | undefined>,
): TextSource | undefined {
  const given = sources.filter((s): s is TextSource => s !== undefined);
  if (given.length > 1) {
    throw new UsageError("give the text only once: inline, -i FILE or -", command);
  }
  return given[0];
}
