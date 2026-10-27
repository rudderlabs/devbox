// devbox show: a task's state, sandbox, PRs and rounds.
import type { ApiRound, ApiTask } from "../../../control-plane/src/types/api";
import type { CoreOps } from "../../core/ops";
import type { CommandModule, CommonArgs } from "../command";
import { age, paint, STATE_TONE } from "../format";
import { colorEnabled, type Io } from "../io";
import { common, commonArgs, type Opts } from "../options";

export type ShowArgs = CommonArgs & { ref: string };

type Color = { color: boolean };

// A labelled value; further values continue on indented lines.
const field = (label: string, values: string[], color: boolean): string[] => {
  const [first = "-", ...rest] = values.length > 0 ? values : ["-"];
  return [
    `  ${paint(label.padEnd(9), "dim", color)}${first}`,
    ...rest.map((v) => `${" ".repeat(11)}${v}`),
  ];
};

const round = (r: ApiRound, now: number): string =>
  [r.kind, r.status, r.outcome, `${age(r.created_at, now)} ago`, r.failure_reason]
    .filter((x): x is string => typeof x === "string" && x !== "")
    .join(" · ");

export function render(t: ApiTask, now: number, o: Color = { color: false }): string {
  const { color } = o;
  const link = (url: string): string => paint(url, "cyan", color);
  return [
    `${paint(t.key, "bold", color)}  ${paint(t.state, STATE_TONE[t.state], color)}  ${t.title}`,
    ...field("id", [t.id], color),
    ...field("source", [t.source], color),
    ...field("creator", t.created_by ? [t.created_by.name] : [], color),
    ...field(
      "flags",
      t.experimental_flags.length > 0 ? [t.experimental_flags.join(", ")] : [],
      color,
    ),
    ...field("sandbox", [t.sandbox_live ? "live" : "none"], color),
    ...field("url", [link(t.external_url)], color),
    ...field("created", [`${age(t.created_at, now)} ago`], color),
    ...field(
      "prs",
      t.prs.map((p) => `${link(p.url)} (${p.branch})`),
      color,
    ),
    ...field(
      "rounds",
      t.rounds.slice(0, 5).map((r) => round(r, now)),
      color,
    ),
  ].join("\n");
}

export async function run(args: ShowArgs, ops: CoreOps, io: Io): Promise<number> {
  const task = await ops.showTask(args.ref);
  io.out(
    args.json ? JSON.stringify(task, null, 2) : render(task, io.now(), { color: colorEnabled(io) }),
  );
  return 0;
}

export const show: CommandModule = {
  register(program, parsed) {
    common(
      program
        .command("show")
        .description("Show a task's state, sandbox, PRs and rounds")
        .argument("<ref>", "task key or id"),
    ).action((ref: string, o: Opts) => {
      const args: ShowArgs = { ...commonArgs(o), ref };
      parsed({ kind: "command", name: "show", args, run: (ops, io) => run(args, ops, io) });
    });
  },
};
