// The follow loop shared by `logs -f`/`-w`, `wait`, `--follow` and `--wait`: stream a
// task's events, print them, stop on Ctrl-C.
import type { ApiEventEnvelope } from "../../control-plane/src/types/api";
import { type From, NoEventLog } from "../core/events";
import type { CoreOps } from "../core/ops";
import type { FollowFlags } from "./command";
import { EXIT, exitCodeFor } from "./exit";
import { colorEnabled, type Io } from "./io";
import { renderEvent } from "./logLine";

export type FollowPlan = {
  ref: string;
  from: From;
  json: boolean;
  quiet?: boolean;
  untilDone?: boolean;
  timeoutMs?: number;
};

export function printEvent(io: Io, event: ApiEventEnvelope, json: boolean): void {
  io.out(
    json
      ? JSON.stringify(event)
      : renderEvent(event, { color: colorEnabled(io), timeZone: io.timeZone }),
  );
}

export async function follow(ops: CoreOps, io: Io, plan: FollowPlan): Promise<number> {
  try {
    for await (const item of ops.followTask({
      ref: plan.ref,
      from: plan.from,
      untilDone: plan.untilDone,
      timeoutMs: plan.timeoutMs,
      signal: io.interrupt,
    })) {
      if (item.kind === "event") {
        if (!plan.quiet) printEvent(io, item.event, plan.json);
      } else if (item.kind === "timeout") {
        io.err(`devbox: timed out waiting for ${plan.ref}`);
        return EXIT.timeout;
      } else {
        const { result } = item;
        if (plan.quiet) {
          const body = (result.response?.data as { body?: unknown } | undefined)?.body;
          if (result.response && plan.json) io.out(JSON.stringify(result.response));
          else if (typeof body === "string") io.out(body);
        }
        if (result.failed) io.err(`devbox: ${plan.ref} failed: ${result.reason}`);
        return exitCodeFor(result);
      }
    }
  } catch (err) {
    if (err instanceof NoEventLog && !plan.untilDone) {
      io.err(`devbox: ${err.message}`);
      return EXIT.ok;
    }
    throw err;
  }
  return EXIT.interrupted;
}

// A write's resource as --json prints it: on one line when the write is
// followed, so every line of the output is one JSON value.
export const writtenJson = (value: unknown, afterWrite: FollowFlags): string =>
  afterWrite.follow || afterWrite.wait ? JSON.stringify(value) : JSON.stringify(value, null, 2);

// Follows the round a write created, as its flags ask: --follow prints the log,
// --wait ends with the round and prints its response.
export async function followAfterWrite(
  ops: CoreOps,
  io: Io,
  args: { afterWrite: FollowFlags; json: boolean },
  ref: string,
  from: From,
): Promise<number> {
  const { follow: live, wait, timeoutMs } = args.afterWrite;
  if (!live && !wait) return EXIT.ok;
  return follow(ops, io, { ref, from, json: args.json, quiet: !live, untilDone: wait, timeoutMs });
}
