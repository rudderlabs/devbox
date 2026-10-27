import { describe, expect, it } from "bun:test";
import { envelope } from "../../__tests__/fixtures";
import {
  apiError,
  createStub,
  frame,
  type Stub,
  serveStream,
  sse,
  stateFrame,
  stubApi,
} from "../../__tests__/stub";
import { ApiFailure, isFatal } from "../api";
import { Backoff, followStream, type SseMessage, SseParser } from "../sse";

describe("SseParser", () => {
  it("parses event, multi-line data and id; skips comments", () => {
    expect(
      new SseParser().push(
        ": keepalive\n\nevent: agent_response\ndata: line one\ndata: line two\nid: 7\n\n",
      ),
    ).toEqual([{ event: "agent_response", data: "line one\nline two", id: "7" }]);
  });

  it("defaults the event name; messages without id have no id", () => {
    expect(new SseParser().push('data: {"x":1}\n\n')).toEqual([
      { event: "message", data: '{"x":1}' },
    ]);
  });

  it("handles CRLF and CR line endings, including a CRLF split across chunks", () => {
    const p = new SseParser();
    expect(p.push("event: a\r\ndata: 1\r")).toEqual([]);
    expect(p.push("\n\r\nevent: b\rdata: 2\r\r\n")).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("strips only one leading space and accepts fields without a colon", () => {
    expect(new SseParser().push("data:  two spaces\ndata\n\n")).toEqual([
      { event: "message", data: " two spaces\n" },
    ]);
  });

  it("does not dispatch a block cut off before its blank line", () => {
    expect(new SseParser().push("event: x\ndata: 1\nid: 9\n")).toEqual([]);
  });

  it("ignores blocks without data", () => {
    expect(new SseParser().push("event: x\nid: 3\n\n")).toEqual([]);
  });
});

describe("Backoff", () => {
  it("doubles from 1s to a 30s cap and resets", () => {
    const b = new Backoff();
    expect([1, 2, 3, 4, 5, 6, 7].map(() => b.delay())).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    b.reset();
    expect(b.delay()).toBe(1000);
  });
});

// Runs followStream against the stub until `count` messages arrived.
async function collect(stub: Stub, count: number, start?: string) {
  const api = stubApi(stub);
  const sleeps: number[] = [];
  const messages: SseMessage[] = [];
  for await (const m of followStream({
    open: (id, signal) => api.openStream("DBX-API-7", id, signal),
    lastEventId: start,
    signal: new AbortController().signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    isFatal,
  })) {
    messages.push(m);
    if (messages.length === count) break;
  }
  return { messages, sleeps, lastEventIds: stub.requests.map((r) => r.lastEventId) };
}

const e = (id: number) => envelope(id, "agent_action", { body: `step ${id}` });

describe("followStream", () => {
  it("resumes after the last dispatched id; a state event does not move it", async () => {
    const stub = createStub();
    serveStream(stub, "DBX-API-7", [
      () => sse([frame(e(1)), stateFrame("running")], "close"),
      // Dropped mid-block: id 3 was never dispatched.
      () => sse([frame(e(2)), "event: agent_action\ndata: {}\nid: 3\n"], "error"),
      () => sse([frame(e(3))], "hang"),
    ]);

    const { messages, lastEventIds } = await collect(stub, 4, "0");
    expect(messages.map((m) => m.id ?? m.event)).toEqual(["1", "state", "2", "3"]);
    expect(lastEventIds).toEqual(["0", "1", "2"]);
  });

  it("backs off on failures and resets after an event", async () => {
    const stub = createStub();
    serveStream(stub, "DBX-API-7", [
      () => apiError(503, "internal", "down"),
      () => new Response("bad gateway", { status: 502 }),
      () => sse([frame(e(1))], "close"),
      () => sse([], "close"),
      () => sse([frame(e(2))], "hang"),
    ]);

    const { sleeps } = await collect(stub, 2);
    expect(sleeps).toEqual([1000, 2000, 1000, 2000]);
  });

  it.each([
    [401, "unauthorized"],
    [404, "task_not_found"],
    [409, "not_api_task"],
  ])("does not retry %i", async (status, code) => {
    const stub = createStub();
    serveStream(stub, "DBX-API-7", [() => apiError(status, code, "no")]);
    const err = await collect(stub, 1).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).status).toBe(status);
    expect(stub.requests.length).toBe(1);
  });

  // A multi-byte character can be split across two chunks.
  it("decodes UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode(
      frame(envelope(1, "agent_response", { body: "✉ done" })),
    );
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte "✉"
    const stub = createStub();
    serveStream(stub, "DBX-API-7", [() => sse([bytes.slice(0, cut), bytes.slice(cut)], "hang")]);

    const { messages } = await collect(stub, 1);
    expect(JSON.parse(messages[0]?.data ?? "{}").data).toEqual({ body: "✉ done" });
  });

  it("ends when the signal aborts, also while a read is pending", async () => {
    const stub = createStub();
    serveStream(stub, "DBX-API-7", [() => sse([frame(e(1))], "hang")]);
    const api = stubApi(stub);
    const ctrl = new AbortController();
    const seen: string[] = [];
    for await (const m of followStream({
      open: (id, signal) => api.openStream("DBX-API-7", id, signal),
      signal: ctrl.signal,
      sleep: async () => {},
      isFatal,
    })) {
      seen.push(m.id ?? "");
      setTimeout(() => ctrl.abort(), 0);
    }
    expect(seen).toEqual(["1"]);
  });
});
