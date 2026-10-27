import { describe, expect, it } from "bun:test";
import { envelope, task } from "../../../__tests__/fixtures";
import {
  asJson,
  conn,
  done,
  ev,
  FROM,
  fakeOps,
  items,
  testIo,
  thenHang,
} from "../../__tests__/fakes";
import { base, helpText, parsed, still, usage } from "../../__tests__/parsing";
import { InputError } from "../../input";
import { run } from "../create";

const CREATE_HELP = `Usage: devbox create [options] <title> [input]

Create a task and print its key

Arguments:
  title                     the task title
  input                     - reads the description from stdin

Options:
  -d, --description <text>  the task description
  -i, --input <path>        read the description from a file
  --flag <name>             an experimental flag; repeat for more
  -f, --follow              then print the task's log as it happens
  -w, --wait                then wait until the task is idle or failed and print
                            the response
  -t, --timeout <duration>  with --wait: give up after (e.g. 45s, 1h30m)
  --url <url>               API base URL (default: $DEVBOX_CLI_URL or config)
  --token <token>           API token (default: $DEVBOX_CLI_TOKEN or config)
  --profile <name>          profile from the config file (default:
                            $DEVBOX_CLI_PROFILE or the current one)
  --json                    print JSON instead of text
  -h, --help                display help for command`;

describe("create: parsing", () => {
  it("has its own help", () => {
    expect(helpText(["create", "--help"])).toBe(CREATE_HELP);
    expect(helpText(["help", "create"])).toBe(CREATE_HELP);
  });

  it.each([
    [["create", "Fix it"], { ...base, title: "Fix it", experimentalFlags: [], afterWrite: still }],
    [
      ["create", "Fix it", "-d", "details", "--flag", "A", "--flag", "B"],
      {
        ...base,
        title: "Fix it",
        description: { kind: "text", text: "details" },
        experimentalFlags: ["A", "B"],
        afterWrite: still,
      },
    ],
    [
      ["create", "Fix it", "-"],
      {
        ...base,
        title: "Fix it",
        description: { kind: "stdin" },
        experimentalFlags: [],
        afterWrite: still,
      },
    ],
    [
      ["create", "Fix it", "-i", "plan.md", "--json"],
      {
        ...base,
        json: true,
        title: "Fix it",
        description: { kind: "file", path: "plan.md" },
        experimentalFlags: [],
        afterWrite: still,
      },
    ],
    [
      ["create", "T", "-fwt", "45s"],
      {
        ...base,
        title: "T",
        experimentalFlags: [],
        afterWrite: { follow: true, wait: true, timeoutMs: 45_000 },
      },
    ],
    [
      ["create", "Fix it", "--follow", "--wait", "--timeout", "1h30m"],
      {
        ...base,
        title: "Fix it",
        experimentalFlags: [],
        afterWrite: { follow: true, wait: true, timeoutMs: 5_400_000 },
      },
    ],
  ])("%p", (argv, args) => {
    expect(parsed(argv)).toEqual({ name: "create", args });
  });

  it.each([
    [["create"], "missing required argument 'title'"],
    [["create", "t", "extra"], 'unexpected argument "extra"'],
    [["create", "t", "-d", "x", "-i", "y"], "give the text only once: inline, -i FILE or -"],
    [["create", "t", "-d", "x", "-"], "give the text only once: inline, -i FILE or -"],
    [["create", "t", "--timeout", "5m"], "--timeout needs --wait"],
    [
      ["create", "t", "--wait", "--timeout", "600"],
      "option '-t, --timeout <duration>' argument '600' is invalid. Use e.g. 45s, 30m, 2h or 1h30m.",
    ],
    [
      ["create", "t", "--wait", "--timeout", "597h"],
      "option '-t, --timeout <duration>' argument '597h' is invalid. The longest timeout is 596h.",
    ],
  ])("rejects %p", (argv, message) => {
    expect(usage(argv)).toEqual({ message, command: "create" });
  });
});

describe("create: run", () => {
  it("reads the description file, creates, and prints the key", async () => {
    const { ops, calls } = fakeOps({ createTask: async () => ({ task: task(), from: FROM }) });
    const io = testIo({ files: { "plan.md": "Do it.\n" } });
    const code = await run(
      {
        ...conn,
        title: "Fix flaky test",
        description: { kind: "file", path: "plan.md" },
        experimentalFlags: ["FOO"],
        afterWrite: still,
      },
      ops,
      io,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        op: "createTask",
        arg: { title: "Fix flaky test", description: "Do it.\n", experimentalFlags: ["FOO"] },
      },
    ]);
    expect(io.stdout).toEqual(["DBX-API-7"]);
  });

  it("reads stdin for - and prints the task as JSON", async () => {
    const { ops, calls } = fakeOps({ createTask: async () => ({ task: task(), from: FROM }) });
    const io = testIo({ stdin: "from stdin" });
    await run(
      {
        ...asJson,
        title: "T",
        description: { kind: "stdin" },
        experimentalFlags: [],
        afterWrite: still,
      },
      ops,
      io,
    );
    expect(calls[0]?.arg).toEqual({ title: "T", description: "from stdin", experimentalFlags: [] });
    expect(JSON.parse(io.stdout.join("\n"))).toEqual(task());
  });

  it("throws InputError for an unreadable file, before calling core", async () => {
    const { ops, calls } = fakeOps({});
    const err = await run(
      {
        ...conn,
        title: "T",
        description: { kind: "file", path: "missing.md" },
        experimentalFlags: [],
        afterWrite: still,
      },
      ops,
      testIo(),
    ).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(InputError);
    expect((err as Error).message).toBe(
      "cannot read missing.md: ENOENT: no such file 'missing.md'",
    );
    expect(calls).toEqual([]);
  });

  it("--wait follows the new round and prints its response", async () => {
    const reply = envelope(4, "agent_response", { body: "Done.\nAll green." });
    const { ops, calls } = fakeOps({
      createTask: async () => ({ task: task(), from: FROM }),
      followTask: () =>
        items(ev(reply), done({ outcome: "completed", failed: false, response: reply })),
    });
    const io = testIo();
    const code = await run(
      {
        ...conn,
        title: "T",
        experimentalFlags: [],
        afterWrite: { follow: false, wait: true, timeoutMs: 60_000 },
      },
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
        timeoutMs: 60_000,
        signal: io.interrupt,
      },
    });
    expect(io.stdout).toEqual(["DBX-API-7", "Done.\nAll green."]);
  });

  // With --json, every line of a followed write is one JSON value.
  it("--json --wait prints the task on one line", async () => {
    const reply = envelope(4, "agent_response", { body: "Done." });
    const { ops } = fakeOps({
      createTask: async () => ({ task: task(), from: FROM }),
      followTask: () =>
        items(ev(reply), done({ outcome: "completed", failed: false, response: reply })),
    });
    const io = testIo();
    const code = await run(
      { ...asJson, title: "T", experimentalFlags: [], afterWrite: { follow: false, wait: true } },
      ops,
      io,
    );
    expect(code).toBe(0);
    expect(io.stdout).toEqual([JSON.stringify(task()), JSON.stringify(reply)]);
  });

  // Ctrl-C exits 130 quietly.
  it("--follow prints the log until Ctrl-C", async () => {
    const created = envelope(1, "task_created", { title: "Fix flaky test" });
    const sandbox = envelope(2, "sandbox_started", { mode: "fresh" }, null);
    const { ops, calls } = fakeOps({
      createTask: async () => ({ task: task(), from: FROM }),
      followTask: (o) => thenHang(o.signal, ev(created), ev(sandbox)),
    });
    const io = testIo({ stopAfterLines: 3 });
    const code = await run(
      { ...conn, title: "T", experimentalFlags: [], afterWrite: { follow: true, wait: false } },
      ops,
      io,
    );
    expect(code).toBe(130);
    expect(io.stdout).toEqual([
      "DBX-API-7",
      "12:00:01  ✚ task created: Fix flaky test",
      "12:00:02  ▸ sandbox started (fresh)",
    ]);
    expect(io.stderr).toEqual([]);
    expect(calls[1]).toEqual({
      op: "followTask",
      arg: {
        ref: "DBX-API-7",
        from: FROM,
        untilDone: false,
        timeoutMs: undefined,
        signal: io.interrupt,
      },
    });
  });
});
