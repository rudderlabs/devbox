// devbox logs: print a task's event log, follow it live with -f, or follow it
// until the latest round is done with -w.
import { NoEventLog } from "../../core/events";
import type { CoreOps } from "../../core/ops";
import { type CommandModule, type CommonArgs, UsageError } from "../command";
import { EXIT } from "../exit";
import { follow, printEvent } from "../follow";
import type { Io } from "../io";
import { common, commonArgs, integer, type Opts, timeout } from "../options";

export type LogsArgs = CommonArgs & {
  ref: string;
  follow: boolean;
  wait: boolean;
  timeoutMs?: number;
  after: number;
};

export async function run(args: LogsArgs, ops: CoreOps, io: Io): Promise<number> {
  if (args.follow) {
    return follow(ops, io, {
      ref: args.ref,
      from: { after: args.after },
      json: args.json,
      untilDone: args.wait,
      timeoutMs: args.timeoutMs,
    });
  }
  try {
    for await (const event of ops.taskHistory({ ref: args.ref, after: args.after })) {
      printEvent(io, event, args.json);
    }
  } catch (err) {
    if (!(err instanceof NoEventLog)) throw err;
    io.err(`devbox: ${err.message}`);
  }
  return EXIT.ok;
}

export const logs: CommandModule = {
  register(program, parsed) {
    common(
      program
        .command("logs")
        .description("Print a task's event log")
        .argument("<ref>", "task key or id")
        .option("-f, --follow", "keep following the log live")
        .option("-w, --wait", "follow until the task's latest round is done (implies --follow)")
        .option("-t, --timeout <duration>", "with --wait: give up after (e.g. 45s, 1h30m)", timeout)
        .option("--after <id>", "start after this event id", integer(0)),
    ).action((ref: string, o: Opts) => {
      if (o.timeout !== undefined && o.wait !== true) {
        throw new UsageError("--timeout needs --wait", "logs");
      }
      const args: LogsArgs = {
        ...commonArgs(o),
        ref,
        follow: o.follow === true || o.wait === true,
        wait: o.wait === true,
        timeoutMs: o.timeout,
        after: o.after ?? 0,
      };
      parsed({ kind: "command", name: "logs", args, run: (ops, io) => run(args, ops, io) });
    });
  },
};
