// devbox send: send a follow-up message.
import type { SendMessageResponse } from "../../../control-plane/src/types/api";
import type { CoreOps } from "../../core/ops";
import {
  type CommandModule,
  type CommonArgs,
  type FollowFlags,
  type TextSource,
  UsageError,
} from "../command";
import { followAfterWrite, writtenJson } from "../follow";
import { readText } from "../input";
import type { Io } from "../io";
import { common, commonArgs, followFlags, following, type Opts, oneSource } from "../options";

export type SendArgs = CommonArgs & {
  ref: string;
  message: TextSource;
  afterWrite: FollowFlags;
};

export const render = (message: SendMessageResponse): string => message.round_id;

export async function run(args: SendArgs, ops: CoreOps, io: Io): Promise<number> {
  const { message, from } = await ops.sendMessage({
    ref: args.ref,
    body: await readText(args.message, io),
  });
  io.out(args.json ? writtenJson(message, args.afterWrite) : render(message));
  return followAfterWrite(ops, io, args, args.ref, from);
}

export const send: CommandModule = {
  register(program, parsed) {
    common(
      following(
        program
          .command("send")
          .description("Send a follow-up message")
          .argument("<ref>", "task key or id")
          .argument("[message]", "the message, or - to read it from stdin")
          .option("-i, --input <path>", "read the message from a file"),
      ),
    ).action((ref: string, text: string | undefined, o: Opts) => {
      const message = oneSource("send", [
        text === undefined ? undefined : text === "-" ? { kind: "stdin" } : { kind: "text", text },
        o.input === undefined ? undefined : { kind: "file", path: o.input },
      ]);
      if (!message) throw new UsageError("send needs a MESSAGE, -i FILE or -", "send");
      const args: SendArgs = { ...commonArgs(o), ref, message, afterWrite: followFlags(o, "send") };
      parsed({ kind: "command", name: "send", args, run: (ops, io) => run(args, ops, io) });
    });
  },
};
