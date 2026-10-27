// devbox ls: list tasks, newest first.
import { Option } from "commander";
import type { ApiTask, ApiTaskSource, ApiTaskState } from "../../../control-plane/src/types/api";
import type { CoreOps } from "../../core/ops";
import type { CommandModule, CommonArgs } from "../command";
import { age, oneLine, paint, STATE_TONE, type Tone } from "../format";
import { colorEnabled, type Io } from "../io";
import { common, commonArgs, integer, type Opts } from "../options";

export type LsArgs = CommonArgs & {
  source?: ApiTaskSource;
  mine: boolean;
  state?: ApiTaskState;
  limit?: number;
};

const HEADER = ["KEY", "STATE", "TITLE", "DESCRIPTION", "CREATOR", "AGE"];

export function render(
  tasks: ApiTask[],
  now: number,
  o: { color: boolean } = { color: false },
): string {
  const rows = [
    HEADER,
    ...tasks.map((t) => [
      t.key,
      t.state,
      oneLine(t.title, 40),
      t.description === null ? "-" : oneLine(t.description, 40),
      t.created_by?.name ?? "-",
      age(t.created_at, now),
    ]),
  ];
  const widths = HEADER.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[], tone: (i: number) => Tone | null): string =>
    r
      .map((c, i) => {
        const cell = i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0);
        return paint(cell, tone(i), o.color);
      })
      .join("  ");
  const [head = HEADER, ...body] = rows;
  return [
    paint(
      line(head, () => null),
      "dim",
      o.color,
    ),
    ...body.map((r) =>
      line(r, (i) => (i === 0 ? "bold" : i === 1 ? STATE_TONE[r[1] as ApiTaskState] : null)),
    ),
  ].join("\n");
}

export async function run(args: LsArgs, ops: CoreOps, io: Io): Promise<number> {
  const tasks = await ops.listTasks({
    source: args.source,
    mine: args.mine,
    state: args.state,
    limit: args.limit,
  });
  if (args.json) io.out(JSON.stringify(tasks, null, 2));
  else
    io.out(tasks.length === 0 ? "No tasks." : render(tasks, io.now(), { color: colorEnabled(io) }));
  return 0;
}

export const ls: CommandModule = {
  register(program, parsed) {
    common(
      program
        .command("ls")
        .description("List tasks, newest first")
        .addOption(
          new Option("--source <source>", "only tasks from this source").choices(["api", "linear"]),
        )
        .option("--mine", "only tasks created with your token")
        .addOption(
          new Option("--state <state>", "only tasks in this state").choices([
            "queued",
            "running",
            "idle",
            "failed",
          ]),
        )
        .option("--limit <n>", "list at most n tasks (default: all)", integer(1)),
    ).action((o: Opts) => {
      const args: LsArgs = {
        ...commonArgs(o),
        source: o.source,
        mine: o.mine === true,
        state: o.state,
        limit: o.limit,
      };
      parsed({ kind: "command", name: "ls", args, run: (ops, io) => run(args, ops, io) });
    });
  },
};
