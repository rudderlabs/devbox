// Helpers for parsing tests: a parsed command's name and args, a help text,
// or the usage error.
import { UsageError } from "../command";
import { parse } from "../program";

export const base = { connection: {}, json: false };
export const still = { follow: false, wait: false };

export function parsed(argv: string[]): { name: string; args: unknown } {
  const result = parse(argv);
  if (result.kind !== "command") throw new Error(`expected a command for: ${argv.join(" ")}`);
  return { name: result.name, args: result.args };
}

export function helpText(argv: string[]): string {
  const result = parse(argv);
  if (result.kind !== "help") throw new Error(`expected help for: ${argv.join(" ")}`);
  return result.text;
}

export function usage(argv: string[]): { message: string; command?: string } {
  try {
    parse(argv);
  } catch (err) {
    if (err instanceof UsageError) return { message: err.message, command: err.command };
    throw err;
  }
  throw new Error(`expected a UsageError for: ${argv.join(" ")}`);
}
