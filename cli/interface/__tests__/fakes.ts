// Fakes for interface tests: a CoreOps that records calls, async-iterable
// helpers, and an Io that captures output with a frozen clock.
import type { ApiEventEnvelope } from "../../../control-plane/src/types/api";
import { NOW } from "../../__tests__/fixtures";
import type { FollowItem, From, RoundResult } from "../../core/events";
import type { CoreOps } from "../../core/ops";
import type { ConfigFs } from "../configFile";
import type { Io } from "../io";

export const conn = { connection: {}, json: false };
export const asJson = { connection: {}, json: true };

export const FROM: From = { after: 41 }; // any From: commands pass it through untouched
export const ev = (event: ApiEventEnvelope): FollowItem => ({ kind: "event", event });
export const done = (result: RoundResult): FollowItem => ({ kind: "done", result });

export type Call = { op: string; arg: unknown };

// A CoreOps whose operations come from `impl`. Every call is recorded with its
// argument; calling an operation `impl` doesn't provide throws.
export function fakeOps(impl: Partial<CoreOps>): { ops: CoreOps; calls: Call[] } {
  const calls: Call[] = [];
  const ops = new Proxy({} as CoreOps, {
    get: (_target, op) => (arg?: unknown) => {
      calls.push({ op: String(op), arg });
      const fn = (impl as Record<string, ((arg?: unknown) => unknown) | undefined>)[String(op)];
      if (!fn) throw new Error(`unexpected call: ${String(op)}`);
      return fn(arg);
    },
  });
  return { ops, calls };
}

export async function* items<T>(...values: T[]): AsyncGenerator<T> {
  yield* values;
}

// Yields `values`, then stays open until `signal` aborts, like a live stream.
export async function* thenHang<T>(signal: AbortSignal, ...values: T[]): AsyncGenerator<T> {
  yield* values;
  await new Promise<void>((resolve) => {
    // The signal may already be aborted (testIo aborts inside io.out), and an
    // abort listener added afterwards never fires.
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function* failing<T>(err: Error): AsyncGenerator<T> {
  yield* [];
  throw err;
}

export type TestIo = Io & { stdout: string[]; stderr: string[]; abort: () => void };

// `stopAfterLines` fires the Ctrl-C signal once stdout holds that many lines.
export function testIo(
  opts: {
    stdin?: string;
    files?: Record<string, string>;
    stopAfterLines?: number;
    env?: Record<string, string | undefined>;
    isTTY?: boolean;
    configFiles?: MemFiles;
  } = {},
): TestIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const interrupt = new AbortController();
  return {
    out: (line) => {
      stdout.push(line);
      if (stdout.length === opts.stopAfterLines) interrupt.abort();
    },
    err: (line) => {
      stderr.push(line);
    },
    readStdin: async () => opts.stdin ?? "",
    readFile: async (path) => {
      const text = opts.files?.[path];
      if (text === undefined) throw new Error(`ENOENT: no such file '${path}'`);
      return text;
    },
    env: opts.env ?? { DEVBOX_CLI_URL: "http://cp.test", DEVBOX_CLI_TOKEN: "dbx_tok_SECRET" },
    isTTY: opts.isTTY ?? false,
    configFs: memFs(opts.configFiles ?? {}),
    now: () => NOW,
    interrupt: interrupt.signal,
    timeZone: "UTC",
    stdout,
    stderr,
    abort: () => interrupt.abort(),
  };
}

// An in-memory ConfigFs: a file's text and mode, or the error reading it throws.
type MemFiles = Record<string, { text: string; mode?: number } | { error: string }>;

export function memFs(files: MemFiles): ConfigFs & { files: MemFiles } {
  const get = (path: string) => {
    const f = files[path];
    if (!f) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    if ("error" in f) throw Object.assign(new Error(`${f.error}: ${path}`), { code: f.error });
    return f;
  };
  return {
    home: () => "/home/me",
    read: (path) => get(path).text,
    mode: (path) => get(path).mode ?? 0o600,
    write: (path, text) => {
      files[path] = { text, mode: 0o600 };
    },
    files,
  };
}
