// Colors for the quickstart's own output, with node:util's styleText (no
// dependency). Whether to color is decided here: off until the entry point
// turns it on, which keeps tests on plain text. validateStream is off because
// Bun 1.4.4, like Node, otherwise drops colors when stdout is not a terminal.
import { styleText } from "node:util";

type Format = Parameters<typeof styleText>[0];

let enabled = false;

// A terminal, unless NO_COLOR is set or TERM is dumb; FORCE_COLOR wins.
export function colorWanted(isTTY: boolean, env: Record<string, string | undefined>): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return isTTY && env.TERM !== "dumb";
}

export function setColor(on: boolean): void {
  enabled = on;
}

const paint =
  (format: Format) =>
  (text: string): string =>
    enabled ? styleText(format, text, { validateStream: false }) : text;

export const heading = paint(["bold", "cyan"]);
export const bold = paint("bold");
export const dim = paint("dim");
export const good = paint("green");
export const warn = paint("yellow");
export const bad = paint("red");
export const cmd = paint("cyan");
