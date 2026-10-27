// The shapes every devbox command shares. Each command lives in its own
// module under commands/: it registers itself with commander and hands back
// its parsed arguments bound to its run(); parsing never runs anything.
import type { Command } from "commander";
import type { CoreOps } from "../core/ops";
import type { Io } from "./io";

export { UsageError } from "./usageError";

// Where a command's free text comes from; input.ts reads it.
export type TextSource =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string }
  | { kind: "stdin" };

export type Connection = { url?: string; token?: string; profile?: string };
export type FollowFlags = { follow: boolean; wait: boolean; timeoutMs?: number };
export type CommonArgs = { connection: Connection; json: boolean };

// A parsed command: its name, the arguments commander collected, and its run()
// bound to them.
export type ParsedCommand = {
  kind: "command";
  name: string;
  args: CommonArgs & Record<string, unknown>;
  run: (ops: CoreOps, io: Io) => Promise<number>;
};
export type HelpRequest = { kind: "help"; text: string };

// A command that runs without a control plane (devbox profile …): main runs
// it before resolving a URL or token.
export type LocalCommand = { kind: "local"; name: string; run: (io: Io) => Promise<number> };

// One devbox command. register() adds it to the program; the command's action
// hands `parsed` the result.
export type CommandModule = {
  register(program: Command, parsed: (command: ParsedCommand | LocalCommand) => void): void;
};
