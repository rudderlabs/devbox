// What the CLI touches outside itself, injected so tests run in-process with
// captured output and a frozen clock.
import type { ConfigFs } from "./configFile";

export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Promise<string>;
  env: Record<string, string | undefined>;
  // The CLI config file written by `bun run up`.
  configFs: ConfigFs;
  isTTY: boolean;
  now: () => number;
  // Aborted on Ctrl-C.
  interrupt: AbortSignal;
  // Undefined means the local time zone; tests pin "UTC".
  timeZone?: string;
};

export const colorEnabled = (io: Io): boolean => io.isTTY && !io.env.NO_COLOR;
