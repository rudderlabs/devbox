// devbox restart: restart a task from a clean slate.
import type { CoreOps } from "../../core/ops";
import type { CommandModule, CommonArgs, FollowFlags, TextSource } from "../command";
import { followAfterWrite, writtenJson } from "../follow";
import { readOptional } from "../input";
import type { Io } from "../io";
import {
  common,
  commonArgs,
  definition,
  followFlags,
  following,
  type Opts,
  oneSource,
} from "../options";

export type RestartArgs = CommonArgs & {
  ref: string;
  title?: string;
  description?: TextSource;
  experimentalFlags?: string[];
  afterWrite: FollowFlags;
};

export async function run(args: RestartArgs, ops: CoreOps, io: Io): Promise<number> {
  const { task, from } = await ops.restartTask({
    ref: args.ref,
    title: args.title,
    description: await readOptional(args.description, io),
    experimentalFlags: args.experimentalFlags,
  });
  io.out(args.json ? writtenJson(task, args.afterWrite) : task.key);
  return followAfterWrite(ops, io, args, task.key, from);
}

export const restart: CommandModule = {
  register(program, parsed) {
    common(
      following(
        definition(
          program
            .command("restart")
            .description("Restart a task from a clean slate")
            .argument("<ref>", "task key or id")
            .option("--title <title>", "a new title"),
          "an experimental flag; repeatable; replaces the list",
        ),
      ),
    ).action((ref: string, o: Opts) => {
      const args: RestartArgs = {
        ...commonArgs(o),
        ref,
        title: o.title,
        description: oneSource("restart", [
          o.description === undefined ? undefined : { kind: "text", text: o.description },
          o.input === undefined ? undefined : { kind: "file", path: o.input },
        ]),
        experimentalFlags: o.flag,
        afterWrite: followFlags(o, "restart"),
      };
      parsed({ kind: "command", name: "restart", args, run: (ops, io) => run(args, ops, io) });
    });
  },
};
