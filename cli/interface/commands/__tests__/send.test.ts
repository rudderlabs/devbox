import { describe, expect, it } from "bun:test";
import { envelope } from "../../../__tests__/fixtures";
import { asJson, conn, done, ev, FROM, fakeOps, items, testIo } from "../../__tests__/fakes";
import { base, parsed, still, usage } from "../../__tests__/parsing";
import { run } from "../send";

describe("send: parsing", () => {
  it.each([
    [
      ["send", "DBX-API-1", "hello"],
      { ...base, ref: "DBX-API-1", message: { kind: "text", text: "hello" }, afterWrite: still },
    ],
    [
      ["send", "DBX-API-1", "-"],
      { ...base, ref: "DBX-API-1", message: { kind: "stdin" }, afterWrite: still },
    ],
    [
      ["send", "DBX-API-1", "-i", "m.md"],
      { ...base, ref: "DBX-API-1", message: { kind: "file", path: "m.md" }, afterWrite: still },
    ],
    [
      ["send", "DBX-API-1", "hi", "--follow"],
      {
        ...base,
        ref: "DBX-API-1",
        message: { kind: "text", text: "hi" },
        afterWrite: { follow: true, wait: false },
      },
    ],
  ])("%p", (argv, args) => {
    expect(parsed(argv)).toEqual({ name: "send", args });
  });

  it.each([
    [["send", "DBX-API-1"], "send needs a MESSAGE, -i FILE or -"],
    [["send", "DBX-API-1", "msg", "-i", "x"], "give the text only once: inline, -i FILE or -"],
  ])("rejects %p", (argv, message) => {
    expect(usage(argv)).toEqual({ message, command: "send" });
  });
});

describe("send: run", () => {
  it("sends the text and prints the round id", async () => {
    const { ops, calls } = fakeOps({
      sendMessage: async () => ({ message: { round_id: "round-2" }, from: FROM }),
    });
    const io = testIo();
    expect(
      await run(
        {
          ...conn,
          ref: "DBX-API-7",
          message: { kind: "text", text: "also the docs" },
          afterWrite: still,
        },
        ops,
        io,
      ),
    ).toBe(0);
    expect(calls).toEqual([
      { op: "sendMessage", arg: { ref: "DBX-API-7", body: "also the docs" } },
    ]);
    expect(io.stdout).toEqual(["round-2"]);
  });

  it("reads the message from stdin and prints the response as JSON", async () => {
    const { ops, calls } = fakeOps({
      sendMessage: async () => ({ message: { round_id: "round-2" }, from: FROM }),
    });
    const io = testIo({ stdin: "piped" });
    expect(
      await run(
        { ...asJson, ref: "DBX-API-7", message: { kind: "stdin" }, afterWrite: still },
        ops,
        io,
      ),
    ).toBe(0);
    expect(calls).toEqual([{ op: "sendMessage", arg: { ref: "DBX-API-7", body: "piped" } }]);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({ round_id: "round-2" });
  });

  it("--follow --wait prints the log once and exits with the outcome", async () => {
    const queued = envelope(6, "message_queued", { body: "also the docs" }, "round-2");
    const answer = envelope(7, "agent_response", { body: "Docs updated." }, "round-2");
    const end = envelope(8, "completed", { status: "partial_failure" }, "round-2");
    const { ops, calls } = fakeOps({
      sendMessage: async () => ({ message: { round_id: "round-2" }, from: FROM }),
      followTask: () =>
        items(
          ev(queued),
          ev(answer),
          ev(end),
          done({ outcome: "partial_failure", failed: false, response: answer }),
        ),
    });
    const io = testIo();
    const code = await run(
      {
        ...conn,
        ref: "dbx-api-7",
        message: { kind: "text", text: "also the docs" },
        afterWrite: { follow: true, wait: true },
      },
      ops,
      io,
    );
    expect(code).toBe(2);
    expect(calls).toEqual([
      { op: "sendMessage", arg: { ref: "dbx-api-7", body: "also the docs" } },
      {
        op: "followTask",
        arg: {
          ref: "dbx-api-7",
          from: FROM,
          untilDone: true,
          timeoutMs: undefined,
          signal: io.interrupt,
        },
      },
    ]);
    expect(io.stdout).toEqual([
      "round-2",
      "12:00:06  → also the docs",
      "12:00:07  ✉ Docs updated.",
      "12:00:08  ✔ completed (partial_failure)",
    ]);
  });

  // With --json, every line of a followed write is one JSON value.
  it("--json --follow --wait prints one JSON value per line", async () => {
    const queued = envelope(6, "message_queued", { body: "also the docs" }, "round-2");
    const { ops } = fakeOps({
      sendMessage: async () => ({ message: { round_id: "round-2" }, from: FROM }),
      followTask: () => items(ev(queued), done({ outcome: "completed", failed: false })),
    });
    const io = testIo();
    const code = await run(
      {
        ...asJson,
        ref: "dbx-api-7",
        message: { kind: "text", text: "also the docs" },
        afterWrite: { follow: true, wait: true },
      },
      ops,
      io,
    );
    expect(code).toBe(0);
    const lines = io.stdout.join("\n").split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ round_id: "round-2" }, queued]);
  });

  it("--follow --wait prints the reason a round failed", async () => {
    const queued = envelope(6, "message_queued", { body: "also the docs" }, "round-2");
    const { ops } = fakeOps({
      sendMessage: async () => ({ message: { round_id: "round-2" }, from: FROM }),
      followTask: () =>
        items(ev(queued), done({ outcome: null, failed: true, reason: "superseded by a restart" })),
    });
    const io = testIo();
    const code = await run(
      {
        ...conn,
        ref: "dbx-api-7",
        message: { kind: "text", text: "also the docs" },
        afterWrite: { follow: true, wait: true },
      },
      ops,
      io,
    );
    expect(code).toBe(1);
    expect(io.stdout).toEqual(["round-2", "12:00:06  → also the docs"]);
    expect(io.stderr).toEqual(["devbox: dbx-api-7 failed: superseded by a restart"]);
  });
});
