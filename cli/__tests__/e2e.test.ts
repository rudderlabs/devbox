// Both layers together against the Hono stub: the wiring the fakes skip.
import { describe, expect, it } from "bun:test";
import type { ApiEventEnvelope } from "../../control-plane/src/types/api";
import { ApiClient, type ClientConfig } from "../core/api";
import { bindCore } from "../core/ops";
import { testIo } from "../interface/__tests__/fakes";
import { render as renderTable } from "../interface/commands/ls";
import { render as renderDetail } from "../interface/commands/show";
import { runCli } from "../interface/main";
import { envelope, NOW, task } from "./fixtures";
import {
  apiError,
  createStub,
  frame,
  type Stub,
  serveEvents,
  serveLinearTask,
  serveStream,
  sse,
  stateFrame,
  TOKEN,
} from "./stub";

function realCore(stub: Stub, sleeps: number[] = []) {
  return (config: ClientConfig) =>
    bindCore(new ApiClient(config, stub.fetch), {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
}

describe("devbox end to end", () => {
  it("whoami sends the token from env and prints the name", async () => {
    const stub = createStub();
    stub.app.get("/api/me", (c) => c.json({ token: { id: "tok-1", name: "frodo" } }));
    const io = testIo();
    expect(await runCli(["whoami"], io, realCore(stub))).toBe(0);
    expect(io.stdout).toEqual(["frodo (token tok-1)"]);
    expect(stub.requests.map((r) => [r.method, r.path, r.authorization])).toEqual([
      ["GET", "/api/me", `Bearer ${TOKEN}`],
    ]);
  });

  // The token never reaches the output.
  it("whoami exits 10 with the API's message on 401", async () => {
    const stub = createStub();
    stub.app.get("/api/me", () => apiError(401, "unauthorized", "invalid or missing token"));
    const io = testIo();
    expect(await runCli(["whoami"], io, realCore(stub))).toBe(10);
    expect(io.stderr).toEqual(["devbox: invalid or missing token (401 unauthorized)"]);
    expect([...io.stdout, ...io.stderr].join("\n")).not.toContain("SECRET");
  });

  it("whoami exits 10 with one line when a login page answers instead of the API", async () => {
    const stub = createStub();
    stub.app.get(
      "/api/me",
      () =>
        new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const io = testIo();
    expect(await runCli(["whoami"], io, realCore(stub))).toBe(10);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual(["devbox: unexpected response from http://cp.test: not JSON"]);
  });

  it("ls --mine lists every page as one table", async () => {
    const stub = createStub();
    const first = task({ key: "DBX-API-8", id: "id-8" });
    const second = task();
    stub.app.get("/api/tasks", (c) =>
      c.json(
        c.req.query("before")
          ? { tasks: [second], next_before: null }
          : { tasks: [first], next_before: "id-8" },
      ),
    );
    const io = testIo();
    expect(await runCli(["ls", "--mine"], io, realCore(stub))).toBe(0);
    expect(io.stdout).toEqual([renderTable([first, second], NOW)]);
    expect(stub.requests.map((r) => r.path)).toEqual([
      "/api/tasks?created_by=me&limit=100",
      "/api/tasks?created_by=me&limit=100&before=id-8",
    ]);
  });

  it("show prints the task, and exits 10 with the API's message on 404", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks/DBX-API-7", (c) => c.json(task()));
    stub.app.get("/api/tasks/NOPE-1", () =>
      apiError(404, "task_not_found", 'no task matches "NOPE-1"'),
    );
    const io = testIo();
    expect(await runCli(["show", "DBX-API-7"], io, realCore(stub))).toBe(0);
    expect(io.stdout).toEqual([renderDetail(task(), NOW)]);

    const missing = testIo();
    expect(await runCli(["show", "NOPE-1"], missing, realCore(stub))).toBe(10);
    expect(missing.stderr).toEqual(['devbox: no task matches "NOPE-1" (404 task_not_found)']);
  });

  it("create reads stdin, posts, and prints the key", async () => {
    const stub = createStub();
    stub.app.post("/api/tasks", (c) => c.json(task(), 201));
    const io = testIo({ stdin: "From stdin." });
    expect(
      await runCli(["create", "Fix flaky test", "-", "--flag", "FOO"], io, realCore(stub)),
    ).toBe(0);
    expect(io.stdout).toEqual(["DBX-API-7"]);
    expect(stub.requests.map((r) => r.body)).toEqual([
      { title: "Fix flaky test", description: "From stdin.", experimental_flags: ["FOO"] },
    ]);
  });

  it("create --wait prints the key and the response", async () => {
    const created = envelope(1, "task_created", { title: "Fix flaky test" });
    const response = envelope(4, "agent_response", { body: "Done." });
    const completed = envelope(5, "completed", { status: "completed" });
    const stub = createStub();
    stub.app.post("/api/tasks", (c) => c.json(task(), 201));
    serveEvents(stub, "DBX-API-7", [created]);
    serveStream(stub, "DBX-API-7", [
      () => sse([frame(created), frame(response), frame(completed), stateFrame("idle")], "hang"),
    ]);
    const io = testIo();
    expect(await runCli(["create", "Fix flaky test", "--wait"], io, realCore(stub))).toBe(0);
    expect(io.stdout).toEqual(["DBX-API-7", "Done."]);
    expect(stub.requests.map((r) => [r.method, r.path, r.authorization, r.lastEventId])).toEqual([
      ["POST", "/api/tasks", `Bearer ${TOKEN}`, null],
      ["GET", "/api/tasks/DBX-API-7/events?after=0&limit=1000", `Bearer ${TOKEN}`, null],
      ["GET", "/api/tasks/DBX-API-7/events/stream", `Bearer ${TOKEN}`, "0"],
      // The drain before accepting the result.
      ["GET", "/api/tasks/DBX-API-7/events?after=5&limit=1000", `Bearer ${TOKEN}`, null],
    ]);
  });

  it("send exits 10 with the API's message for a Linear task", async () => {
    const stub = createStub();
    stub.app.post("/api/tasks/ABC-1/messages", () =>
      apiError(409, "not_api_task", "ABC-1 is a Linear task; steer it from Linear"),
    );
    const io = testIo();
    expect(await runCli(["send", "ABC-1", "hi"], io, realCore(stub))).toBe(10);
    expect(io.stderr).toEqual([
      "devbox: ABC-1 is a Linear task; steer it from Linear (409 not_api_task)",
    ]);
  });

  // Ctrl-C during logs -f exits 130 quietly.
  it("logs -f follows across a dropped connection until Ctrl-C", async () => {
    const created = envelope(1, "task_created", { title: "Fix flaky test" });
    const sandbox = envelope(2, "sandbox_started", { mode: "fresh" }, null);
    const action = envelope(3, "agent_action", { body: "Planning" });
    const stub = createStub();
    serveStream(stub, "DBX-API-7", [
      () => sse([frame(created), stateFrame("queued"), frame(sandbox)], "error"),
      () => sse([frame(action)], "hang"),
    ]);
    const sleeps: number[] = [];
    const io = testIo({ stopAfterLines: 3 });
    expect(await runCli(["logs", "DBX-API-7", "-f"], io, realCore(stub, sleeps))).toBe(130);
    expect(io.stdout).toEqual([
      "12:00:01  ✚ task created: Fix flaky test",
      "12:00:02  ▸ sandbox started (fresh)",
      "12:00:03  ⚙ Planning",
    ]);
    expect(io.stderr).toEqual([]);
    expect(stub.requests.map((r) => r.lastEventId)).toEqual(["0", "2"]);
    expect(sleeps).toEqual([1000]);
  });

  it("logs -w prints the log and ends with the round", async () => {
    const created = envelope(1, "task_created", { title: "Fix flaky test" });
    const response = envelope(2, "agent_response", { body: "Done." });
    const completed = envelope(3, "completed", { status: "completed" });
    const stub = createStub();
    serveEvents(stub, "DBX-API-7", [created]);
    serveStream(stub, "DBX-API-7", [
      () => sse([frame(response), frame(completed), stateFrame("idle")], "hang"),
    ]);
    const io = testIo();
    expect(await runCli(["logs", "DBX-API-7", "-w"], io, realCore(stub))).toBe(0);
    expect(io.stdout).toEqual([
      "12:00:01  ✚ task created: Fix flaky test",
      "12:00:02  ✉ Done.",
      "12:00:03  ✔ completed (completed)",
    ]);
  });

  // CP sends the task state after each batch of 500 events, before
  // the rest of the history.
  it("logs -w --json reads past an earlier round's end to the latest round", async () => {
    const log = [
      envelope(1, "task_created", { title: "Fix flaky test" }, "round-a"),
      ...Array.from({ length: 498 }, (_, i) =>
        envelope(i + 2, "agent_thought", { body: `step ${i + 2}` }, "round-a"),
      ),
      envelope(500, "completed", { status: "completed" }, "round-a"),
      envelope(501, "message_queued", { body: "also the docs" }, "round-b"),
      envelope(502, "completed", { status: "partial_failure" }, "round-b"),
    ];
    const stub = createStub();
    serveEvents(stub, "DBX-API-7", log);
    serveStream(stub, "DBX-API-7", [() => sse([stateFrame("idle")], "hang")]);
    const io = testIo();
    expect(await runCli(["logs", "DBX-API-7", "-w", "--json"], io, realCore(stub))).toBe(2);
    expect(io.stdout.map((line) => JSON.parse(line))).toEqual(log);
    expect(io.stderr).toEqual([]);
  });

  // A Linear task's stream sends its state before `logging`.
  it("logs -w exits 10 for a Linear task", async () => {
    const stub = createStub();
    serveLinearTask(stub, "ABC-1");
    const io = testIo();
    expect(await runCli(["logs", "ABC-1", "-w"], io, realCore(stub))).toBe(10);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual(["devbox: ABC-1 has no event log (only API tasks are logged)"]);
  });

  it("logs prints a notice for a Linear task and exits 0", async () => {
    const stub = createStub();
    serveLinearTask(stub, "ABC-1");
    const io = testIo();
    expect(await runCli(["logs", "ABC-1"], io, realCore(stub))).toBe(0);
    expect(io.stderr).toEqual(["devbox: ABC-1 has no event log (only API tasks are logged)"]);
  });

  it("wait catches up on the log, follows, and prints the final response", async () => {
    const created = envelope(1, "task_created", { title: "Fix flaky test" });
    const response = envelope(2, "agent_response", { body: "Done." });
    const completed = envelope(3, "completed", { status: "partial_failure" });
    const stub = createStub();
    serveEvents(stub, "DBX-API-7", [created]);
    serveStream(stub, "DBX-API-7", [
      () =>
        sse([stateFrame("running"), frame(response), frame(completed), stateFrame("idle")], "hang"),
    ]);
    const io = testIo();
    expect(await runCli(["wait", "DBX-API-7"], io, realCore(stub))).toBe(2);
    expect(io.stdout).toEqual(["Done."]);
    expect(stub.requests.map((r) => [r.path, r.lastEventId])).toEqual([
      ["/api/tasks/DBX-API-7/events?after=0&limit=1000", null],
      ["/api/tasks/DBX-API-7/events?after=1&limit=1000", null],
      ["/api/tasks/DBX-API-7/events/stream", "1"],
      // The drain before accepting the result.
      ["/api/tasks/DBX-API-7/events?after=3&limit=1000", null],
    ]);
  });

  // After a reconnect, CP replays the backlog in batches of up to
  // 500 events, each followed by the task's state. Scaled down: the
  // reconnect's batch is events 2-4, and events 2-7 are written while the
  // first connection is open, so the initial catch-up sees only event 1.
  function reconnectBacklog(): { stub: Stub; log: ApiEventEnvelope[] } {
    const log = [
      envelope(1, "task_created", { title: "Fix flaky test" }, "round-a"),
      envelope(2, "agent_action", { body: "Planning" }, "round-a"),
      envelope(3, "agent_response", { body: "Done." }, "round-a"),
      envelope(4, "completed", { status: "completed" }, "round-a"),
      envelope(5, "message_queued", { body: "also the docs" }, "round-b"),
      envelope(6, "agent_response", { body: "Docs updated." }, "round-b"),
      envelope(7, "completed", { status: "partial_failure" }, "round-b"),
    ];
    const served = log.slice(0, 1);
    const stub = createStub();
    serveEvents(stub, "DBX-API-7", served);
    serveStream(stub, "DBX-API-7", [
      () => {
        served.push(...log.slice(1));
        return sse([stateFrame("running")], "close");
      },
      () => sse([...log.slice(1, 4).map(frame), stateFrame("idle")], "hang"),
    ]);
    return { stub, log };
  }

  it("logs -w --json reads past a reconnect's first batch to the latest round", async () => {
    const { stub, log } = reconnectBacklog();
    const io = testIo();
    expect(await runCli(["logs", "DBX-API-7", "-w", "--json"], io, realCore(stub))).toBe(2);
    expect(io.stdout.map((line) => JSON.parse(line))).toEqual(log);
    expect(io.stderr).toEqual([]);
  });

  it("wait --json reads past a reconnect's first batch to the latest round", async () => {
    const { stub, log } = reconnectBacklog();
    const io = testIo();
    expect(await runCli(["wait", "DBX-API-7", "--json"], io, realCore(stub))).toBe(2);
    expect(io.stdout.map((line) => JSON.parse(line))).toEqual([log[5]]);
    expect(io.stderr).toEqual([]);
  });

  it("wait exits 10 for a Linear task", async () => {
    const stub = createStub();
    serveLinearTask(stub, "ABC-1");
    const io = testIo();
    expect(await runCli(["wait", "ABC-1"], io, realCore(stub))).toBe(10);
    expect(io.stderr).toEqual(["devbox: ABC-1 has no event log (only API tasks are logged)"]);
  });
});
