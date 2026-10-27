import { describe, expect, it } from "bun:test";
import { envelope } from "../../../__tests__/fixtures";
import { type FollowItem, NoEventLog } from "../../../core/events";
import { conn, done, ev, failing, fakeOps, items, testIo, thenHang } from "../../__tests__/fakes";
import { base, helpText, parsed, usage } from "../../__tests__/parsing";
import { run } from "../wait";

describe("wait: parsing", () => {
  it.each([
    [["wait", "DBX-API-1", "-t", "45s"], { ...base, ref: "DBX-API-1", timeoutMs: 45_000 }],
    [["wait", "DBX-API-1", "--timeout", "45s"], { ...base, ref: "DBX-API-1", timeoutMs: 45_000 }],
    [["wait", "DBX-API-1"], { ...base, ref: "DBX-API-1" }],
    [
      ["wait", "DBX-API-1", "--timeout", "596h"],
      { ...base, ref: "DBX-API-1", timeoutMs: 2_145_600_000 },
    ],
  ])("%p", (argv, args) => {
    expect(parsed(argv)).toEqual({ name: "wait", args });
  });

  it.each([
    [
      ["wait", "DBX-API-1", "--timeout", "soon"],
      "option '-t, --timeout <duration>' argument 'soon' is invalid. Use e.g. 45s, 30m, 2h or 1h30m.",
    ],
    [
      ["wait", "DBX-API-1", "--timeout", "600"],
      "option '-t, --timeout <duration>' argument '600' is invalid. Use e.g. 45s, 30m, 2h or 1h30m.",
    ],
    [
      ["wait", "DBX-API-1", "--timeout", "597h"],
      "option '-t, --timeout <duration>' argument '597h' is invalid. The longest timeout is 596h.",
    ],
  ])("rejects %p", (argv, message) => {
    expect(usage(argv)).toEqual({ message, command: "wait" });
  });

  it("describes --timeout", () => {
    expect(helpText(["wait", "--help"]).split("\n")).toContain(
      "  -t, --timeout <duration>  give up after this long (e.g. 45s, 1h30m)",
    );
  });
});

describe("wait: run", () => {
  const reply = envelope(4, "agent_response", { body: "Done.\nAll green." });
  const waitWith = (
    followTask: () => AsyncGenerator<FollowItem>,
    json = false,
    timeoutMs?: number,
  ) => {
    const { ops, calls } = fakeOps({ followTask });
    const io = testIo();
    const code = run({ connection: {}, json, ref: "DBX-API-7", timeoutMs }, ops, io);
    return { code, io, calls };
  };

  it("follows from the latest round and prints the response", async () => {
    const { code, io, calls } = waitWith(
      () => items(ev(reply), done({ outcome: "completed", failed: false, response: reply })),
      false,
      45_000,
    );
    expect(await code).toBe(0);
    expect(io.stdout).toEqual(["Done.\nAll green."]);
    expect(calls[0]?.arg).toEqual({
      ref: "DBX-API-7",
      from: "latest",
      untilDone: true,
      timeoutMs: 45_000,
      signal: io.interrupt,
    });
  });

  it("exits 2 on partial failure", async () => {
    expect(
      await waitWith(() => items(done({ outcome: "partial_failure", failed: false }))).code,
    ).toBe(2);
  });

  it("exits 1 on failure with the reason on stderr", async () => {
    const { code, io } = waitWith(() =>
      items(done({ outcome: null, failed: true, reason: "The sandbox could not start." })),
    );
    expect(await code).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual(["devbox: DBX-API-7 failed: The sandbox could not start."]);
  });

  it("exits 3 on timeout", async () => {
    const { code, io } = waitWith(() => items<FollowItem>({ kind: "timeout" }));
    expect(await code).toBe(3);
    expect(io.stderr).toEqual(["devbox: timed out waiting for DBX-API-7"]);
  });

  it("exits 130 when interrupted", async () => {
    const { ops } = fakeOps({ followTask: (o) => thenHang<FollowItem>(o.signal) });
    const io = testIo();
    setTimeout(() => io.abort(), 0);
    expect(await run({ ...conn, ref: "DBX-API-7" }, ops, io)).toBe(130);
  });

  it("prints the response envelope with --json", async () => {
    const { code, io } = waitWith(
      () => items(done({ outcome: "completed", failed: false, response: reply })),
      true,
    );
    expect(await code).toBe(0);
    expect(io.stdout.map((l) => JSON.parse(l))).toEqual([reply]);
  });

  it("prints nothing for a response without a body", async () => {
    const bare = envelope(4, "agent_response", {});
    const { code, io } = waitWith(() =>
      items(done({ outcome: "completed", failed: false, response: bare })),
    );
    expect(await code).toBe(0);
    expect(io.stdout).toEqual([]);
  });

  it("prints a body-less response envelope with --json", async () => {
    const bare = envelope(4, "agent_response", {});
    const { code, io } = waitWith(
      () => items(done({ outcome: "completed", failed: false, response: bare })),
      true,
    );
    expect(await code).toBe(0);
    expect(io.stdout.map((l) => JSON.parse(l))).toEqual([bare]);
  });

  it("lets NoEventLog propagate", async () => {
    const { code } = waitWith(() => failing(new NoEventLog("ABC-1")));
    expect(await code.catch((x: unknown) => x)).toBeInstanceOf(NoEventLog);
  });
});
