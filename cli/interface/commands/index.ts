// Every devbox command, in the order the root help lists them.
import type { CommandModule } from "../command";
import { create } from "./create";
import { logs } from "./logs";
import { ls } from "./ls";
import { profile } from "./profile";
import { restart } from "./restart";
import { send } from "./send";
import { show } from "./show";
import { wait } from "./wait";
import { whoami } from "./whoami";

export const COMMANDS: CommandModule[] = [
  whoami,
  create,
  ls,
  show,
  send,
  restart,
  logs,
  wait,
  profile,
];
