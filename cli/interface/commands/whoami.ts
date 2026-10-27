// devbox whoami: show the token the API sees.
import type { MeResponse } from "../../../control-plane/src/types/api";
import type { CoreOps } from "../../core/ops";
import type { CommandModule, CommonArgs } from "../command";
import type { Io } from "../io";
import { common, commonArgs, type Opts } from "../options";

export type WhoamiArgs = CommonArgs;

export function render(me: MeResponse): string {
  return me.token ? `${me.token.name} (token ${me.token.id})` : "auth is disabled on this server";
}

export async function run(args: WhoamiArgs, ops: CoreOps, io: Io): Promise<number> {
  const me = await ops.whoami();
  io.out(args.json ? JSON.stringify(me, null, 2) : render(me));
  return 0;
}

export const whoami: CommandModule = {
  register(program, parsed) {
    common(program.command("whoami").description("Show the token the API sees")).action(
      (o: Opts) => {
        const args: WhoamiArgs = commonArgs(o);
        parsed({ kind: "command", name: "whoami", args, run: (ops, io) => run(args, ops, io) });
      },
    );
  },
};
