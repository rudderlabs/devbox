import { describe, expect, it } from "bun:test";
import type { ApiEventEnvelope } from "../../../control-plane/src/types/api";
import { envelope } from "../../__tests__/fixtures";
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
  stubApi,
} from "../../__tests__/stub";
import { ApiFailure } from "../api";
import {
  type FollowItem,
  type FollowOptions,
  followTask,
  NoEventLog,
  type RoundResult,
  roundStart,
  taskHistory,
} from "../events";
import { MAX_TIMEOUT_MS } from "../limits";

const REF = "DBX-API-7";
const created = envelope(1, "task_created", { title: "Fix flaky test" });
const sandbox = envelope(2, "sandbox_started", { mode: "fresh" }, null);
const action = envelope(3, "agent_action", { body: "Planning" });
const response = envelope(4, "agent_response", { body: "Done." });
const completed = (status?: string, id = 5, round = "round-1") =>
  envelope(id, "completed", status ? { status } : {}, round);

const ev = (event: ApiEventEnvelope): FollowItem => ({ kind: "event", event });
const done = (result: RoundResult): FollowItem => ({ kind: "done", result });

// Runs followTask to its end. `stopAfter` aborts the signal once that many
// items arrived, as Ctrl-C would.
async function run(stub: Stub, o: Omit<FollowOptions, "signal">, stopAfter?: number) {
  const ctrl = new AbortController();
  const sleeps: number[] = [];
  const items: FollowItem[] = [];
  const deps = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  for await (const item of followTask(stubApi(stub), { ...o, signal: ctrl.signal }, deps)) {
    items.push(item);
    if (items.length === stopAfter) ctrl.abort();
  }
  const streams = stub.requests.filter((r) => r.path.endsWith("/events/stream"));
  return { items, sleeps, lastEventIds: streams.map((r) => r.lastEventId) };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
}

describe("taskHistory", () => {
  it("pages the log after a cursor", async () => {
    const stub = createStub();
    serveEvents(stub, REF, [created, sandbox, action]);
    const seen: ApiEventEnvelope[] = [];
    for await (const e of taskHistory(stubApi(stub), { ref: REF, after: 1 })) seen.push(e);
    expect(seen).toEqual([sandbox, action]);
    expect(stub.requests.map((r) => r.path)).toEqual([
      `/api/tasks/${REF}/events?after=1&limit=1000`,
      `/api/tasks/${REF}/events?after=3&limit=1000`,
    ]);
  });

  it("throws NoEventLog for a Linear task", async () => {
    const stub = createStub();
    serveLinearTask(stub, "ABC-1");
    const err = await rejection(taskHistory(stubApi(stub), { ref: "ABC-1", after: 0 }).next());
    expect(err).toBeInstanceOf(NoEventLog);
    expect((err as Error).message).toBe("ABC-1 has no event log (only API tasks are logged)");
  });
});

describe("followTask from a cursor", () => {
  it("follows across a dropped connection until interrupted", async () => {
    const stub = createStub();
    serveStream(stub, REF, [
      () => sse([frame(created), stateFrame("queued"), frame(sandbox)], "error"),
      () => sse([frame(action)], "hang"),
    ]);
    const r = await run(stub, { ref: REF, from: { after: 0 } }, 3);
    expect(r.items).toEqual([ev(created), ev(sandbox), ev(action)]);
    expect(r.lastEventIds).toEqual(["0", "2"]);
    expect(r.sleeps).toEqual([1000]);
  });

  it("keeps following past idle", async () => {
    const stub = createStub();
    serveStream(stub, REF, [
      () =>
        sse(
          [frame(created), frame(response), frame(completed("completed")), stateFrame("idle")],
          "hang",
        ),
    ]);
    const r = await run(stub, { ref: REF, from: { after: 0 } }, 3);
    expect(r.items).toEqual([ev(created), ev(response), ev(completed("completed"))]);
  });

  it("throws NoEventLog when the stream reports no logging", async () => {
    const stub = createStub();
    serveLinearTask(stub, "ABC-1");
    const err = await rejection(run(stub, { ref: "ABC-1", from: { after: 0 } }));
    expect(err).toBeInstanceOf(NoEventLog);
  });

  it("throws ApiFailure on a 404", async () => {
    const stub = createStub();
    serveStream(stub, "X-1", [() => apiError(404, "task_not_found", 'no task matches "X-1"')]);
    const err = await rejection(run(stub, { ref: "X-1", from: { after: 0 } }));
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).status).toBe(404);
  });
});

describe("followTask until done, from the latest round", () => {
  function latest(history: ApiEventEnvelope[], live: string[]): Stub {
    const stub = createStub();
    serveEvents(stub, REF, history);
    serveStream(stub, REF, [() => sse(live, "hang")]);
    return stub;
  }

  it.each([
    ["completed", "completed"],
    ["no_action", "no_action"],
    [undefined, null],
    ["partial_failure", "partial_failure"],
  ] as const)("status %p gives outcome %p", async (status, outcome) => {
    const stub = latest(
      [created, action],
      [stateFrame("running"), frame(response), frame(completed(status)), stateFrame("idle")],
    );
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true });
    expect(r.items).toEqual([
      ev(response),
      ev(completed(status)),
      done({ outcome, failed: false, response }),
    ]);
    expect(r.lastEventIds).toEqual(["3"]);
  });

  it("reports a failed round with its reason", async () => {
    const failed = envelope(5, "round_failed", { reason: "The sandbox could not start." });
    const stub = latest([created], [frame(failed), stateFrame("failed")]);
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true });
    expect(r.items).toEqual([
      ev(failed),
      done({ outcome: null, failed: true, reason: "The sandbox could not start." }),
    ]);
  });

  it("reports a failed round without a reason", async () => {
    const failed = envelope(5, "round_failed", {});
    const stub = latest([created], [frame(failed), stateFrame("failed")]);
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true });
    expect(r.items).toEqual([
      ev(failed),
      done({ outcome: null, failed: true, reason: "the round failed" }),
    ]);
  });

  it("reports a completed(failed) round with its agent_error text", async () => {
    const error = envelope(4, "agent_error", { body: "Tool crashed" });
    const stub = latest(
      [created],
      [frame(error), frame(completed("failed")), stateFrame("failed")],
    );
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true });
    expect(r.items.at(-1)).toEqual(
      done({ outcome: "failed", failed: true, reason: "Tool crashed" }),
    );
  });

  it("returns at once for a task that is already idle", async () => {
    const stub = latest([created, action, response, completed("completed")], [stateFrame("idle")]);
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true });
    expect(r.items).toEqual([done({ outcome: "completed", failed: false, response })]);
  });

  // CP can mark the round responded before it logs `completed`.
  it("keeps following when idle arrives before the completed event", async () => {
    const stub = latest(
      [created, action, response],
      [stateFrame("idle"), frame(completed("partial_failure"))],
    );
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true });
    expect(r.items).toEqual([
      ev(completed("partial_failure")),
      done({ outcome: "partial_failure", failed: false, response }),
    ]);
  });

  it("yields timeout when timeoutMs passes first", async () => {
    const stub = latest([created], [stateFrame("running")]);
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true, timeoutMs: 50 });
    expect(r.items).toEqual([{ kind: "timeout" }]);
  });

  it("rejects a timeout above MAX_TIMEOUT_MS before any request", async () => {
    const stub = createStub();
    const err = await rejection(
      run(stub, { ref: REF, from: "latest", untilDone: true, timeoutMs: MAX_TIMEOUT_MS + 1 }),
    );
    expect(err).toBeInstanceOf(RangeError);
    expect(stub.requests).toEqual([]);
  });

  it("throws NoEventLog for a Linear task", async () => {
    const stub = createStub();
    serveLinearTask(stub, "ABC-1");
    const err = await rejection(run(stub, { ref: "ABC-1", from: "latest", untilDone: true }));
    expect(err).toBeInstanceOf(NoEventLog);
  });
});

describe("followTask from a write's round", () => {
  const old = [created, action, response, completed("completed")];
  const queued = envelope(6, "message_queued", { body: "also the docs" }, "round-2");
  const reply = envelope(7, "agent_response", { body: "Docs updated." }, "round-2");
  const done2 = completed(undefined, 8, "round-2");

  function write(log: ApiEventEnvelope[], live: string[]): Stub {
    const stub = createStub();
    serveEvents(stub, REF, log);
    serveStream(stub, REF, [() => sse(live, "hang")]);
    return stub;
  }

  it("starts at the message's round and reports that round", async () => {
    const stub = write(
      [...old, queued],
      [frame(queued), stateFrame("running"), frame(reply), frame(done2), stateFrame("idle")],
    );
    const r = await run(stub, {
      ref: REF,
      from: { round: roundStart.message("round-2") },
      untilDone: true,
    });
    expect(r.items).toEqual([
      ev(queued),
      ev(reply),
      ev(done2),
      done({ outcome: null, failed: false, response: reply }),
    ]);
    expect(r.lastEventIds).toEqual(["5"]);
  });

  // Someone else's restart supersedes the follow-up.
  it("reports a round a restart superseded as failed", async () => {
    const restarted = envelope(
      7,
      "task_restarted",
      { title: "T", superseded_round_ids: ["round-2"] },
      "round-3",
    );
    const done3 = completed("completed", 9, "round-3");
    const stub = write(
      [...old, queued],
      [frame(queued), frame(restarted), frame(done3), stateFrame("idle")],
    );
    const r = await run(stub, {
      ref: REF,
      from: { round: roundStart.message("round-2") },
      untilDone: true,
    });
    expect(r.items).toEqual([
      ev(queued),
      ev(restarted),
      done({ outcome: null, failed: true, reason: "superseded by a restart" }),
    ]);
  });

  it("ends a waited-on assignment round when the task is restarted", async () => {
    const restarted = envelope(
      6,
      "task_restarted",
      { title: "T", superseded_round_ids: [] },
      "round-2",
    );
    const stub = write(
      [created],
      [
        frame(created),
        frame(restarted),
        frame(completed("completed", 7, "round-2")),
        stateFrame("idle"),
      ],
    );
    const r = await run(stub, { ref: REF, from: { round: roundStart.created() }, untilDone: true });
    expect(r.items).toEqual([
      ev(created),
      ev(restarted),
      done({ outcome: null, failed: true, reason: "superseded by a restart" }),
    ]);
  });

  it("starts at the last task_restarted for a restart", async () => {
    const r1 = envelope(6, "task_restarted", { title: "T", superseded_round_ids: [] }, "round-a");
    const r2 = envelope(7, "task_restarted", { title: "T", superseded_round_ids: [] }, "round-b");
    const answer = envelope(8, "agent_response", { body: "Again." }, "round-b");
    const end = completed("completed", 9, "round-b");
    const stub = write(
      [...old, r1, r2],
      [frame(r2), frame(answer), frame(end), stateFrame("idle")],
    );
    const r = await run(stub, {
      ref: REF,
      from: { round: roundStart.restarted() },
      untilDone: true,
    });
    expect(r.items.at(-1)).toEqual(done({ outcome: "completed", failed: false, response: answer }));
    expect(r.lastEventIds).toEqual(["6"]);
  });

  it("starts at task_created for a create", async () => {
    const stub = write(
      [created],
      [frame(created), frame(response), frame(completed("completed")), stateFrame("idle")],
    );
    const r = await run(stub, { ref: REF, from: { round: roundStart.created() }, untilDone: true });
    expect(r.items.at(-1)).toEqual(done({ outcome: "completed", failed: false, response }));
    expect(r.lastEventIds).toEqual(["0"]);
  });

  it("fails when the write's event is not in the log", async () => {
    const stub = write(old, []);
    const err = await rejection(
      run(stub, { ref: REF, from: { round: roundStart.message("round-9") }, untilDone: true }),
    );
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).code).toBe("event_not_found");
    expect((err as Error).message).toBe(`no message_queued event in the log of ${REF}`);
  });
});

describe("followTask without a round to report", () => {
  // The task state alone never ends a wait.
  it("keeps waiting when the task failed before any round event", async () => {
    const stub = createStub();
    serveEvents(stub, REF, []);
    serveStream(stub, REF, [() => sse([stateFrame("failed")], "hang")]);
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true, timeoutMs: 50 });
    expect(r.items).toEqual([{ kind: "timeout" }]);
  });
});

// CP sends the task state after every batch of history, so a
// wait from a cursor must read the whole log before it can end.
describe("followTask until done, from a cursor", () => {
  const first = envelope(1, "task_created", { title: "Fix flaky test" });
  const answer = envelope(2, "agent_response", { body: "Done." });
  const end1 = completed("completed", 3, "round-1");
  const queued = envelope(6, "message_queued", { body: "also the docs" }, "round-2");
  const end2 = completed("partial_failure", 7, "round-2");
  const log = [first, answer, end1, queued, end2];

  function cursor(): Stub {
    const stub = createStub();
    serveEvents(stub, REF, log);
    serveStream(stub, REF, [() => sse([stateFrame("idle")], "hang")]);
    return stub;
  }

  it("prints the whole log and ends with the latest round", async () => {
    const stub = cursor();
    const r = await run(stub, { ref: REF, from: { after: 0 }, untilDone: true });
    expect(r.items).toEqual([
      ev(first),
      ev(answer),
      ev(end1),
      ev(queued),
      ev(end2),
      done({ outcome: "partial_failure", failed: false }),
    ]);
    expect(r.lastEventIds).toEqual(["7"]);
  });

  it("reads the rounds before the cursor without printing them", async () => {
    const stub = cursor();
    const r = await run(stub, { ref: REF, from: { after: 3 }, untilDone: true });
    expect(r.items).toEqual([
      ev(queued),
      ev(end2),
      done({ outcome: "partial_failure", failed: false }),
    ]);
    expect(r.lastEventIds).toEqual(["7"]);
  });

  it("streams from the cursor when it is past the log's end", async () => {
    const stub = cursor();
    const r = await run(stub, { ref: REF, from: { after: 9 }, untilDone: true });
    expect(r.items).toEqual([done({ outcome: "partial_failure", failed: false })]);
    expect(r.lastEventIds).toEqual(["9"]);
  });
});

// A status-less `completed` with no other round event isn't a work
// round.
describe("followTask past a round that did no work", () => {
  it("reports the last work round", async () => {
    const stub = createStub();
    serveEvents(stub, REF, [
      created,
      response,
      completed("partial_failure", 5, "round-1"),
      envelope(6, "completed", {}, "round-2"),
    ]);
    serveStream(stub, REF, [() => sse([stateFrame("idle")], "hang")]);
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true });
    expect(r.items).toEqual([done({ outcome: "partial_failure", failed: false, response })]);
  });
});

// The timeout and Ctrl-C also cover reading the history.
describe("followTask while the history is slow", () => {
  function slow(): Stub {
    const stub = createStub();
    serveEvents(stub, REF, [created], 200);
    serveStream(stub, REF, [() => sse([stateFrame("running")], "hang")]);
    return stub;
  }

  async function timed(stub: Stub, o: Omit<FollowOptions, "signal">, abortAfterMs?: number) {
    const ctrl = new AbortController();
    if (abortAfterMs !== undefined) setTimeout(() => ctrl.abort(), abortAfterMs);
    const items: FollowItem[] = [];
    const start = performance.now();
    for await (const item of followTask(
      stubApi(stub),
      { ...o, signal: ctrl.signal },
      { sleep: async () => {} },
    )) {
      items.push(item);
    }
    return { items, ms: performance.now() - start };
  }

  it("times out while reading the history", async () => {
    const r = await timed(slow(), { ref: REF, from: "latest", untilDone: true, timeoutMs: 50 });
    expect(r.items).toEqual([{ kind: "timeout" }]);
    expect(r.ms).toBeLessThan(150);
  });

  it("stops quietly when interrupted while reading the history", async () => {
    const r = await timed(slow(), { ref: REF, from: "latest", untilDone: true }, 20);
    expect(r.items).toEqual([]);
    expect(r.ms).toBeLessThan(150);
  });

  it("times out while looking for the write's round", async () => {
    const r = await timed(slow(), {
      ref: REF,
      from: { round: roundStart.created() },
      untilDone: true,
      timeoutMs: 50,
    });
    expect(r.items).toEqual([{ kind: "timeout" }]);
    expect(r.ms).toBeLessThan(150);
  });

  it("stops quietly when interrupted while catching up from a cursor", async () => {
    const r = await timed(slow(), { ref: REF, from: { after: 0 }, untilDone: true }, 20);
    expect(r.items).toEqual([]);
    expect(r.ms).toBeLessThan(150);
  });
});

// CP sends the task state after each batch of up to 500 events,
// also on a reconnect, so a reconnect's first batch can end with a terminal
// state while later batches hold a newer round. Scaled down: the batch is
// events 2-4. The log starts as event 1 alone and the rest is appended when
// the first connection opens, as if written while the stream was closed, so
// the initial catch-up sees only event 1.
describe("followTask until done, across a reconnect", () => {
  const a1 = envelope(1, "task_created", { title: "Fix flaky test" }, "round-a");
  const a2 = envelope(2, "agent_action", { body: "Planning" }, "round-a");
  const a3 = envelope(3, "agent_response", { body: "Done." }, "round-a");
  const a4 = completed("completed", 4, "round-a");
  const b5 = envelope(5, "message_queued", { body: "also the docs" }, "round-b");
  const b6 = envelope(6, "agent_response", { body: "Docs updated." }, "round-b");
  const b7 = completed("partial_failure", 7, "round-b");

  // `later` is written while the first connection is open; `second` is what
  // the reconnect sends before it hangs.
  function reconnect(later: ApiEventEnvelope[], second: string[]): Stub {
    const stub = createStub();
    const log = [a1];
    serveEvents(stub, REF, log);
    serveStream(stub, REF, [
      () => {
        log.push(...later);
        return sse([stateFrame("running")], "close");
      },
      () => sse(second, "hang"),
    ]);
    return stub;
  }

  const backlog = () =>
    reconnect([a2, a3, a4, b5, b6, b7], [frame(a2), frame(a3), frame(a4), stateFrame("idle")]);
  const requests = (stub: Stub) => stub.requests.map((r) => [r.path, r.lastEventId]);

  it("reads the rest of the log before ending, from a cursor", async () => {
    const stub = backlog();
    const r = await run(stub, { ref: REF, from: { after: 0 }, untilDone: true });
    expect(r.items).toEqual([
      ev(a1),
      ev(a2),
      ev(a3),
      ev(a4),
      ev(b5),
      ev(b6),
      ev(b7),
      done({ outcome: "partial_failure", failed: false, response: b6 }),
    ]);
    expect(r.sleeps).toEqual([1000]);
    expect(requests(stub)).toEqual([
      [`/api/tasks/${REF}/events?after=0&limit=1000`, null],
      [`/api/tasks/${REF}/events?after=1&limit=1000`, null],
      [`/api/tasks/${REF}/events/stream`, "1"],
      [`/api/tasks/${REF}/events/stream`, "1"],
      [`/api/tasks/${REF}/events?after=4&limit=1000`, null],
      [`/api/tasks/${REF}/events?after=7&limit=1000`, null],
    ]);
  });

  it("reads the rest of the log before ending, from the latest round", async () => {
    const stub = backlog();
    const r = await run(stub, { ref: REF, from: "latest", untilDone: true });
    expect(r.items).toEqual([
      ev(a2),
      ev(a3),
      ev(a4),
      ev(b5),
      ev(b6),
      ev(b7),
      done({ outcome: "partial_failure", failed: false, response: b6 }),
    ]);
  });

  // The write's round is fixed, so it still reports round A, after printing
  // everything from the round's start.
  it("reads the rest of the log before ending, from a write's round", async () => {
    const stub = backlog();
    const r = await run(stub, { ref: REF, from: { round: roundStart.created() }, untilDone: true });
    expect(r.items).toEqual([
      ev(a2),
      ev(a3),
      ev(a4),
      ev(b5),
      ev(b6),
      ev(b7),
      done({ outcome: "completed", failed: false, response: a3 }),
    ]);
  });

  it("skips the events it read when the stream sends them again", async () => {
    const stub = reconnect(
      [a2, a3, a4, b5, b6],
      [
        frame(a2),
        frame(a3),
        frame(a4),
        stateFrame("idle"),
        frame(b5),
        frame(b6),
        frame(b7),
        stateFrame("idle"),
      ],
    );
    const r = await run(stub, { ref: REF, from: { after: 0 }, untilDone: true });
    expect(r.items).toEqual([
      ev(a1),
      ev(a2),
      ev(a3),
      ev(a4),
      ev(b5),
      ev(b6),
      ev(b7),
      done({ outcome: "partial_failure", failed: false, response: b6 }),
    ]);
  });

  it("times out while reading the rest of the log", async () => {
    const stub = createStub();
    let calls = 0;
    stub.app.get(`/api/tasks/${REF}/events`, async (c) => {
      calls++;
      // The initial catch-up's two pages answer at once; the drain hangs.
      if (calls > 2) await new Promise(() => {});
      const events = c.req.query("after") === "0" ? [a1] : [];
      return c.json({ events, next_after: events.at(-1)?.id ?? 1, logging: "available" });
    });
    serveStream(stub, REF, [
      () => sse([frame(a2), frame(a3), frame(a4), stateFrame("idle")], "hang"),
    ]);
    const r = await run(stub, { ref: REF, from: { after: 0 }, untilDone: true, timeoutMs: 50 });
    expect(r.items).toEqual([ev(a1), ev(a2), ev(a3), ev(a4), { kind: "timeout" }]);
  });
});
