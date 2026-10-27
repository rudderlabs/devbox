import { describe, expect, it } from "bun:test";
import { NOW, task } from "../../../__tests__/fixtures";
import { asJson, conn, fakeOps, testIo } from "../../__tests__/fakes";
import { base, parsed, usage } from "../../__tests__/parsing";
import { render, run } from "../show";

describe("show: parsing", () => {
  it("takes a ref", () => {
    expect(parsed(["show", "ABC-1"])).toEqual({ name: "show", args: { ...base, ref: "ABC-1" } });
  });

  it("needs a ref", () => {
    expect(usage(["show"])).toEqual({
      message: "missing required argument 'ref'",
      command: "show",
    });
  });
});

describe("show: render", () => {
  const t = task({
    state: "running",
    sandbox_live: true,
    experimental_flags: ["FOO", "BAR"],
    prs: [
      {
        repo: "rudderlabs/rudder-server",
        url: "https://github.com/rudderlabs/rudder-server/pull/1234",
        branch: "devbox/DBX-API-7-fix",
      },
    ],
    rounds: [
      {
        id: "round-2",
        source: "api",
        kind: "comment",
        status: "delivered",
        outcome: null,
        failure_reason: null,
        created_at: "2026-10-12T12:20:00.000Z",
      },
      {
        id: "round-1",
        source: "api",
        kind: "assignment",
        status: "failed",
        outcome: null,
        failure_reason: "The sandbox could not start.",
        created_at: "2026-10-12T12:00:00.000Z",
      },
    ],
  });

  it("renders the detail view", () => {
    expect(render(t, NOW)).toBe(
      [
        "DBX-API-7  running  Fix flaky test",
        "  id       0192f000-0000-7000-8000-000000000007",
        "  source   api",
        "  creator  frodo",
        "  flags    FOO, BAR",
        "  sandbox  live",
        "  url      https://cp.internal/api/tasks/DBX-API-7",
        "  created  30m ago",
        "  prs      https://github.com/rudderlabs/rudder-server/pull/1234 (devbox/DBX-API-7-fix)",
        "  rounds   comment · delivered · 10m ago",
        "           assignment · failed · 30m ago · The sandbox could not start.",
      ].join("\n"),
    );
  });

  it("colours key, state, labels and links when asked", () => {
    expect(render(t, NOW, { color: true })).toBe(
      [
        "\x1b[1mDBX-API-7\x1b[0m  \x1b[36mrunning\x1b[0m  Fix flaky test",
        "  \x1b[2mid       \x1b[0m0192f000-0000-7000-8000-000000000007",
        "  \x1b[2msource   \x1b[0mapi",
        "  \x1b[2mcreator  \x1b[0mfrodo",
        "  \x1b[2mflags    \x1b[0mFOO, BAR",
        "  \x1b[2msandbox  \x1b[0mlive",
        "  \x1b[2murl      \x1b[0m\x1b[36mhttps://cp.internal/api/tasks/DBX-API-7\x1b[0m",
        "  \x1b[2mcreated  \x1b[0m30m ago",
        "  \x1b[2mprs      \x1b[0m\x1b[36mhttps://github.com/rudderlabs/rudder-server/pull/1234\x1b[0m (devbox/DBX-API-7-fix)",
        "  \x1b[2mrounds   \x1b[0mcomment · delivered · 10m ago",
        "           assignment · failed · 30m ago · The sandbox could not start.",
      ].join("\n"),
    );
  });

  it("renders empty fields as -", () => {
    expect(render(task({ created_by: null }), NOW)).toBe(
      [
        "DBX-API-7  queued  Fix flaky test",
        "  id       0192f000-0000-7000-8000-000000000007",
        "  source   api",
        "  creator  -",
        "  flags    -",
        "  sandbox  none",
        "  url      https://cp.internal/api/tasks/DBX-API-7",
        "  created  30m ago",
        "  prs      -",
        "  rounds   -",
      ].join("\n"),
    );
  });
});

describe("show: run", () => {
  it("prints the detail view, or JSON", async () => {
    const { ops, calls } = fakeOps({ showTask: async () => task() });
    const io = testIo();
    expect(await run({ ...conn, ref: "DBX-API-7" }, ops, io)).toBe(0);
    expect(calls).toEqual([{ op: "showTask", arg: "DBX-API-7" }]);
    expect(io.stdout).toEqual([render(task(), NOW)]);

    const json = testIo();
    await run({ ...asJson, ref: "DBX-API-7" }, ops, json);
    expect(JSON.parse(json.stdout.join("\n"))).toEqual(task());
  });
});
