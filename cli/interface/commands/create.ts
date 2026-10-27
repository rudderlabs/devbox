// devbox create: create a task and print its key.
import type { CoreOps } from "../../core/ops";
import {
  type CommandModule,
  type CommonArgs,
  type FollowFlags,
  type TextSource,
  UsageError,
} from "../command";
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

export type CreateArgs = CommonArgs & {
  title: string;
  description?: TextSource;
  experimentalFlags: string[];
  afterWrite: FollowFlags;
};

export async function run(args: CreateArgs, ops: CoreOps, io: Io): Promise<number> {
  const { task, from } = await ops.createTask({
    title: args.title,
    description: await readOptional(args.description, io),
    experimentalFlags: args.experimentalFlags,
  });
  io.out(args.json ? writtenJson(task, args.afterWrite) : task.key);
  return followAfterWrite(ops, io, args, task.key, from);
}

export const create: CommandModule = {
  register(program, parsed) {
    common(
      following(
        definition(
          program
            .command("create")
            .description("Create a task and print its key")
            .argument("<title>", "the task title")
            .argument("[input]", "- reads the description from stdin"),
          "an experimental flag; repeat for more",
        ),
      ),
    ).action((title: string, input: string | undefined, o: Opts) => {
      if (input !== undefined && input !== "-") {
        throw new UsageError(`unexpected argument "${input}"`, "create");
      }
      const args: CreateArgs = {
        ...commonArgs(o),
        title,
        description: oneSource("create", [
          o.description === undefined ? undefined : { kind: "text", text: o.description },
          o.input === undefined ? undefined : { kind: "file", path: o.input },
          input === "-" ? { kind: "stdin" } : undefined,
        ]),
        experimentalFlags: o.flag ?? [],
        afterWrite: followFlags(o, "create"),
      };
      parsed({ kind: "command", name: "create", args, run: (ops, io) => run(args, ops, io) });
    });
  },
};
