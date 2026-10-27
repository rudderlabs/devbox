// Formatting shared by several commands (ls, show, log lines): ages, PR
// references, one-line truncation and ANSI colour.
import type { ApiTaskState } from "../../control-plane/src/types/api";

export function prRef(repo: string, url: string): string {
  const n = /\/pull\/(\d+)/.exec(url)?.[1];
  return n && repo ? `${repo}#${n}` : url;
}

export function age(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export type Tone = "dim" | "bold" | "red" | "green" | "yellow" | "cyan";

const ANSI: Record<Tone, string> = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

// Wraps text in an ANSI colour when `color` is on. Empty text stays empty.
export const paint = (text: string, tone: Tone | null, color: boolean): string =>
  color && tone && text !== "" ? `${ANSI[tone]}${text}\x1b[0m` : text;

export const STATE_TONE: Record<ApiTaskState, Tone> = {
  queued: "yellow",
  running: "cyan",
  idle: "green",
  failed: "red",
};

// One line of at most `max` characters: whitespace runs collapse to a space,
// and longer text ends in "…".
export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
