import { describe, expect, it } from "bun:test";
import { task } from "../../../__tests__/fixtures";
import { asJson, conn, done, FROM, fakeOps, items, testIo } from "../../__tests__/fakes";
import { base, helpText, parsed, still, usage } from "../../__tests__/parsing";
import { run } from "../restart";

describe("restart: parsing", () => {
  it.each([
    [["restart", "DBX-API-1"], { ...base, ref: "DBX-API-1", afterWrite: still }],
    [
      ["restart", "DBX-API-1", "--title", "T", "-d", "D", "--flag", "X"],
      {
        ...base,
        ref: "DBX-API-1",
        title: "T",
        description: { kind: "text", text: "D" },
        experimentalFlags: ["X"],
        afterWrite: still,
      },
    ],
  ])("%p", (argv, args) => {
    expect(parsed(argv)).toEqual({ name: "restart", args });
  });

  it("rejects - (no stdin for restart)", () => {
    expect(usage(["restart", "DBX-API-1", "-"])).toEqual({
      message: "too many arguments for 'restart'. Expected 1 argument but got 2: DBX-API-1, -.",
      command: "restart",
    });
  });

  it("describes --timeout", () => {
    expect(helpText(["restart", "--help"]).split("\n")).toContain(
      "  -t, --timeout <duration>  with --wait: give up after (e.g. 45s, 1h30m)",
    );
  });

  it("says --flag replaces the list", () => {
    expect(helpText(["restart", "--help"]).split("\n")).toContain(
      "  --flag <name>             an experimental flag; repeatable; replaces the list",
    );
  });
});

describe("restart: run", () => {
  it("passes overrides through and prints the key", async () => {
    const { ops, calls } = fakeOps({ restartTask: async () => ({ task: task(), from: FROM }) });
    const io = testIo();
    expect(
      await run(
        {
          ...conn,
          ref: "dbx-api-7",
          description: { kind: "text", text: "New" },
          afterWrite: still,
        },
        ops,
        io,
      ),
    ).toBe(0);
    expect(calls).toEqual([
      {
        op: "restartTask",
        arg: {
          ref: "dbx-api-7",
          title: undefined,
          description: "New",
          experimentalFlags: undefined,
        },
      },
    ]);
    expect(io.stdout).toEqual(["DBX-API-7"]);
  });

  it("--wait follows the restarted task by its key", async () => {
    const { ops, calls } = fakeOps({
      restartTask: async () => ({ task: task(), from: FROM }),
      followTask: () => items(done({ outcome: "completed", failed: false })),
    });
    const io = testIo();
    const code = await run(
      { ...conn, ref: "dbx-api-7", afterWrite: { follow: false, wait: true } },
      ops,
      io,
    );
    expect(code).toBe(0);
    expect(calls[1]).toEqual({
      op: "followTask",
      arg: {
        ref: "DBX-API-7",
        from: FROM,
        untilDone: true,
        timeoutMs: undefined,
        signal: io.interrupt,
      },
    });
    expect(io.stdout).toEqual(["DBX-API-7"]);
  });

  // With --json, every line of a followed write is one JSON value.
  it("--json --wait prints the task on one line", async () => {
    const { ops } = fakeOps({
      restartTask: async () => ({ task: task(), from: FROM }),
      followTask: () => items(done({ outcome: "completed", failed: false })),
    });
    const io = testIo();
    const code = await run(
      { ...asJson, ref: "dbx-api-7", afterWrite: { follow: false, wait: true } },
      ops,
      io,
    );
    expect(code).toBe(0);
    expect(io.stdout).toEqual([JSON.stringify(task())]);
  });
});
