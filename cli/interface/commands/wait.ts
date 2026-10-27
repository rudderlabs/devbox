// devbox wait: block until a task is done and print its final response.
import type { CoreOps } from "../../core/ops";
import type { CommandModule, CommonArgs } from "../command";
import { follow } from "../follow";
import type { Io } from "../io";
import { common, commonArgs, type Opts, timeout } from "../options";

export type WaitArgs = CommonArgs & { ref: string; timeoutMs?: number };

export function run(args: WaitArgs, ops: CoreOps, io: Io): Promise<number> {
  return follow(ops, io, {
    ref: args.ref,
    from: "latest",
    quiet: true,
    untilDone: true,
    timeoutMs: args.timeoutMs,
    json: args.json,
  });
}

export const wait: CommandModule = {
  register(program, parsed) {
    common(
      program
        .command("wait")
        .description("Wait for a task to finish and print its final response")
        .argument("<ref>", "task key or id")
        .option("-t, --timeout <duration>", "give up after this long (e.g. 45s, 1h30m)", timeout),
    ).action((ref: string, o: Opts) => {
      const args: WaitArgs = { ...commonArgs(o), ref, timeoutMs: o.timeout };
      parsed({ kind: "command", name: "wait", args, run: (ops, io) => run(args, ops, io) });
    });
  },
};
