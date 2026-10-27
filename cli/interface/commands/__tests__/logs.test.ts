import { describe, expect, it } from "bun:test";
import { envelope } from "../../../__tests__/fixtures";
import { type FollowItem, NoEventLog } from "../../../core/events";
import {
  asJson,
  conn,
  done,
  failing,
  fakeOps,
  items,
  testIo,
  thenHang,
} from "../../__tests__/fakes";
import { base, helpText, parsed, usage } from "../../__tests__/parsing";
import { run } from "../logs";

describe("logs: parsing", () => {
  it.each([
    [
      ["logs", "DBX-API-1", "-f", "--after", "42"],
      { ...base, ref: "DBX-API-1", follow: true, wait: false, after: 42 },
    ],
    [["logs", "DBX-API-1"], { ...base, ref: "DBX-API-1", follow: false, wait: false, after: 0 }],
    [["logs", "X", "-f"], { ...base, ref: "X", follow: true, wait: false, after: 0 }],
    [["logs", "X", "-w"], { ...base, ref: "X", follow: true, wait: true, after: 0 }],
    [
      ["logs", "X", "-wt", "1m"],
      { ...base, ref: "X", follow: true, wait: true, timeoutMs: 60_000, after: 0 },
    ],
  ])("%p", (argv, args) => {
    expect(parsed(argv)).toEqual({ name: "logs", args });
  });

  it.each([
    [
      ["logs", "DBX-API-1", "--after", "-1"],
      "option '--after <id>' argument '-1' is invalid. Expected an integer >= 0.",
    ],
    [["logs", "DBX-API-1", "--after"], "option '--after <id>' argument missing"],
    [
      ["logs", "DBX-API-1", "--after", "99999999999999999999"],
      "option '--after <id>' argument '99999999999999999999' is invalid. Expected an integer >= 0.",
    ],
    [["logs", "X", "-t", "1m"], "--timeout needs --wait"],
  ])("rejects %p", (argv, message) => {
    expect(usage(argv)).toEqual({ message, command: "logs" });
  });
});

const HELP = `Usage: devbox logs [options] <ref>

Print a task's event log

Arguments:
  ref                       task key or id

Options:
  -f, --follow              keep following the log live
  -w, --wait                follow until the task's latest round is done
                            (implies --follow)
  -t, --timeout <duration>  with --wait: give up after (e.g. 45s, 1h30m)
  --after <id>              start after this event id
  --url <url>               API base URL (default: $DEVBOX_CLI_URL or config)
  --token <token>           API token (default: $DEVBOX_CLI_TOKEN or config)
  --profile <name>          profile from the config file (default:
                            $DEVBOX_CLI_PROFILE or the current one)
  --json                    print JSON instead of text
  -h, --help                display help for command`;

describe("logs: help", () => {
  it("has its own help", () => {
    expect(helpText(["logs", "--help"]).trimEnd()).toBe(HELP);
  });
});

describe("logs: run", () => {
  const created = envelope(1, "task_created", { title: "Fix flaky test" });
  const sandbox = envelope(2, "sandbox_started", { mode: "fresh" }, null);
  const history = { ref: "DBX-API-7", follow: false, wait: false, after: 0 };
  const ev = (event: typeof created): FollowItem => ({ kind: "event", event });

  it("prints the history from --after", async () => {
    const { ops, calls } = fakeOps({ taskHistory: () => items(created, sandbox) });
    const io = testIo();
    expect(await run({ ...conn, ...history }, ops, io)).toBe(0);
    expect(calls).toEqual([{ op: "taskHistory", arg: { ref: "DBX-API-7", after: 0 } }]);
    expect(io.stdout).toEqual([
      "12:00:01  ✚ task created: Fix flaky test",
      "12:00:02  ▸ sandbox started (fresh)",
    ]);
  });

  it("prints NDJSON with --json, and colour only on a TTY without NO_COLOR", async () => {
    const { ops } = fakeOps({ taskHistory: () => items(created) });
    const json = testIo();
    await run({ ...asJson, ...history }, ops, json);
    expect(json.stdout.map((l) => JSON.parse(l))).toEqual([created]);

    const tty = testIo({ isTTY: true, env: {} });
    await run({ ...conn, ...history }, ops, tty);
    expect(tty.stdout).toEqual(["12:00:01  \x1b[1m✚ task created: Fix flaky test\x1b[0m"]);

    const noColor = testIo({ isTTY: true, env: { NO_COLOR: "1" } });
    await run({ ...conn, ...history }, ops, noColor);
    expect(noColor.stdout).toEqual(["12:00:01  ✚ task created: Fix flaky test"]);
  });

  it("prints a notice for a Linear task and exits 0", async () => {
    const { ops } = fakeOps({ taskHistory: () => failing(new NoEventLog("ABC-1")) });
    const io = testIo();
    expect(await run({ ...conn, ...history, ref: "ABC-1" }, ops, io)).toBe(0);
    expect(io.stderr).toEqual(["devbox: ABC-1 has no event log (only API tasks are logged)"]);
  });

  // Ctrl-C exits 130 quietly.
  it("-f follows from --after until Ctrl-C", async () => {
    const { ops, calls } = fakeOps({ followTask: (o) => thenHang(o.signal, ev(created)) });
    const io = testIo({ stopAfterLines: 1 });
    expect(
      await run({ ...conn, ref: "DBX-API-7", follow: true, wait: false, after: 5 }, ops, io),
    ).toBe(130);
    expect(calls).toEqual([
      {
        op: "followTask",
        arg: {
          ref: "DBX-API-7",
          from: { after: 5 },
          untilDone: false,
          timeoutMs: undefined,
          signal: io.interrupt,
        },
      },
    ]);
    expect(io.stdout).toEqual(["12:00:01  ✚ task created: Fix flaky test"]);
    expect(io.stderr).toEqual([]);
  });

  it("-f prints a notice for a Linear task and exits 0", async () => {
    const { ops } = fakeOps({ followTask: () => failing(new NoEventLog("ABC-1")) });
    const io = testIo();
    expect(await run({ ...conn, ref: "ABC-1", follow: true, wait: false, after: 0 }, ops, io)).toBe(
      0,
    );
    expect(io.stderr).toEqual(["devbox: ABC-1 has no event log (only API tasks are logged)"]);
  });

  const waiting = { ...conn, ref: "DBX-API-7", follow: true, wait: true, after: 0 };

  it("-fw prints the log, ends with the round and exits with its outcome", async () => {
    const { ops, calls } = fakeOps({
      followTask: () => items(ev(created), done({ outcome: "partial_failure", failed: false })),
    });
    const io = testIo();
    expect(await run(waiting, ops, io)).toBe(2);
    expect(calls).toEqual([
      {
        op: "followTask",
        arg: {
          ref: "DBX-API-7",
          from: { after: 0 },
          untilDone: true,
          timeoutMs: undefined,
          signal: io.interrupt,
        },
      },
    ]);
    expect(io.stdout).toEqual(["12:00:01  ✚ task created: Fix flaky test"]);
  });

  it("-w prints the reason a round failed", async () => {
    const { ops } = fakeOps({
      followTask: () => items(done({ outcome: "failed", failed: true, reason: "x" })),
    });
    const io = testIo();
    expect(await run(waiting, ops, io)).toBe(1);
    expect(io.stderr).toEqual(["devbox: DBX-API-7 failed: x"]);
  });

  it("-w propagates NoEventLog for a Linear task", async () => {
    const { ops } = fakeOps({ followTask: () => failing(new NoEventLog("ABC-1")) });
    await expect(run({ ...waiting, ref: "ABC-1" }, ops, testIo())).rejects.toBeInstanceOf(
      NoEventLog,
    );
  });
});
