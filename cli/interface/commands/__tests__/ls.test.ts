import { describe, expect, it } from "bun:test";
import { NOW, task } from "../../../__tests__/fixtures";
import { asJson, conn, fakeOps, testIo } from "../../__tests__/fakes";
import { base, parsed, usage } from "../../__tests__/parsing";
import { render, run } from "../ls";

describe("ls: parsing", () => {
  it.each([
    [["ls"], { ...base, mine: false }],
    [
      ["ls", "--source", "linear", "--mine", "--state", "idle", "--limit", "250"],
      { ...base, source: "linear", mine: true, state: "idle", limit: 250 },
    ],
  ])("%p", (argv, args) => {
    expect(parsed(argv)).toEqual({ name: "ls", args });
  });

  it.each([
    [
      ["ls", "--source", "github"],
      "option '--source <source>' argument 'github' is invalid. Allowed choices are api, linear.",
    ],
    [
      ["ls", "--state", "done"],
      "option '--state <state>' argument 'done' is invalid. Allowed choices are queued, running, idle, failed.",
    ],
    [
      ["ls", "--limit", "0"],
      "option '--limit <n>' argument '0' is invalid. Expected an integer >= 1.",
    ],
    [
      ["ls", "--limit", "ten"],
      "option '--limit <n>' argument 'ten' is invalid. Expected an integer >= 1.",
    ],
    [
      ["ls", "--limit", "99999999999999999999"],
      "option '--limit <n>' argument '99999999999999999999' is invalid. Expected an integer >= 1.",
    ],
  ])("rejects %p", (argv, message) => {
    expect(usage(argv)).toEqual({ message, command: "ls" });
  });
});

describe("ls: render", () => {
  it("renders aligned columns", () => {
    const tasks = [
      task({ state: "running", created_at: "2026-10-12T12:25:00.000Z" }),
      task({
        key: "ABC-1234",
        source: "linear",
        state: "idle",
        title: "Port the docs",
        description: null,
        created_by: null,
        created_at: "2026-10-10T12:30:00.000Z",
      }),
    ];
    expect(render(tasks, NOW)).toBe(
      [
        "KEY        STATE    TITLE           DESCRIPTION            CREATOR  AGE",
        "DBX-API-7  running  Fix flaky test  The test fails on CI.  frodo    5m",
        "ABC-1234   idle     Port the docs   -                      -        2d",
      ].join("\n"),
    );
  });

  it("truncates long titles and descriptions to 40 characters and flattens newlines", () => {
    const [, row = ""] = render(
      [task({ title: `${"a".repeat(70)}\nmore`, description: `${"b".repeat(70)}\nmore` })],
      NOW,
    ).split("\n");
    expect(row).toContain(`${"a".repeat(39)}…`);
    expect(row).toContain(`${"b".repeat(39)}…`);
    expect(row).not.toContain("more");
  });

  it("colours the header, key and state when asked", () => {
    const tasks = [task({ state: "running", created_at: "2026-10-12T12:25:00.000Z" })];
    expect(render(tasks, NOW, { color: true })).toBe(
      [
        "\x1b[2mKEY        STATE    TITLE           DESCRIPTION            CREATOR  AGE\x1b[0m",
        "\x1b[1mDBX-API-7\x1b[0m  \x1b[36mrunning\x1b[0m  Fix flaky test  The test fails on CI.  frodo    5m",
      ].join("\n"),
    );
  });
});

describe("ls: run", () => {
  it("passes the filters and prints the table", async () => {
    const tasks = [task({ created_at: "2026-10-12T12:25:00.000Z" })];
    const { ops, calls } = fakeOps({ listTasks: async () => tasks });
    const io = testIo();
    expect(
      await run({ ...conn, source: "api", mine: true, state: "idle", limit: 5 }, ops, io),
    ).toBe(0);
    expect(calls).toEqual([
      { op: "listTasks", arg: { source: "api", mine: true, state: "idle", limit: 5 } },
    ]);
    expect(io.stdout).toEqual([render(tasks, NOW)]);
  });

  it("says so when there are no tasks, and prints an array with --json", async () => {
    const { ops } = fakeOps({ listTasks: async () => [] });
    const io = testIo();
    await run({ ...conn, mine: false }, ops, io);
    expect(io.stdout).toEqual(["No tasks."]);

    const json = testIo();
    await run({ ...asJson, mine: false }, ops, json);
    expect(JSON.parse(json.stdout.join("\n"))).toEqual([]);
  });

  it("colours output only on a TTY without NO_COLOR", async () => {
    const tasks = [task({ created_at: "2026-10-12T12:25:00.000Z" })];
    const { ops } = fakeOps({ listTasks: async () => tasks });
    const tty = testIo({ isTTY: true, env: {} });
    await run({ ...conn, mine: false }, ops, tty);
    expect(tty.stdout).toEqual([render(tasks, NOW, { color: true })]);

    const noColor = testIo({ isTTY: true, env: { NO_COLOR: "1" } });
    await run({ ...conn, mine: false }, ops, noColor);
    expect(noColor.stdout).toEqual([render(tasks, NOW)]);
  });
});
