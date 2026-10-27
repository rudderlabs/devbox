import { describe, expect, it, mock, spyOn } from "bun:test";
import type { Clock } from "../../clock";
import { ApiError } from "../../errors";
import { logger } from "../../logger";
import { createApiRoutes } from "../../routes/api";
import type { ApiEventEnvelope, SseStateData } from "../../types/api";
import { ApiController, type ApiTaskServicePort } from "../api.controller";

const ID = "0192f000-0000-7000-8000-000000000001";
const env = (id: number, type = "agent_action"): ApiEventEnvelope => ({
  id,
  task_id: ID,
  origin: "daemon",
  type,
  round_id: "r-1",
  seq: id,
  created_at: "2026-10-07T12:00:00.000Z",
  data: { body: `e${id}` },
});
const frame = (e: ApiEventEnvelope) =>
  `event: ${e.type}\ndata: ${JSON.stringify(e)}\nid: ${e.id}\n\n`;
const stateFrame = (s: SseStateData) => `event: state\ndata: ${JSON.stringify(s)}\n\n`;

// Virtual-time clock: every sleep() registers a timer and schedules a macrotask
// that jumps time to the earliest pending timer, so poll sleeps run instantly
// and the max-duration timer fires once time reaches it. The macrotask also
// lets a client cancel be observed between iterations. Aborting a sleep's
// signal resolves it without moving time.
function fakeClock(): Clock & { t: number } {
  const waiters = new Set<{ at: number; resolve: () => void }>();
  const c = {
    t: 0,
    now: () => c.t,
    sleep: (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const w = { at: c.t + ms, resolve };
        const abort = () => {
          waiters.delete(w);
          resolve();
        };
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", abort, { once: true });
        waiters.add(w);
        setTimeout(() => {
          const next = [...waiters].sort((x, y) => x.at - y.at)[0];
          if (!next) return;
          c.t = Math.max(c.t, next.at);
          for (const x of [...waiters]) {
            if (x.at <= c.t) {
              waiters.delete(x);
              x.resolve();
            }
          }
        }, 0);
      }),
  };
  return c;
}

// Clock whose time only moves when the test says so.
function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  const waiters = new Set<{ at: number; resolve: () => void }>();
  return {
    now: () => t,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const w = { at: t + ms, resolve };
        if (signal.aborted) return resolve();
        signal.addEventListener(
          "abort",
          () => {
            waiters.delete(w);
            resolve();
          },
          { once: true },
        );
        waiters.add(w);
      }),
    advance(ms) {
      t += ms;
      for (const w of [...waiters]) {
        if (w.at <= t) {
          waiters.delete(w);
          w.resolve();
        }
      }
    },
  };
}

function setup(o: {
  source?: "api" | "linear";
  batches?: ApiEventEnvelope[][];
  states?: SseStateData[];
  maxMs?: number;
  pollMs?: number;
  clock?: Clock & { t?: number };
}) {
  const batches = [...(o.batches ?? [])];
  const states = [...(o.states ?? [])];
  let lastState: SseStateData = { state: "running", sandbox_live: true };
  const service = {
    streamTarget: mock(() => Promise.resolve({ id: ID, source: o.source ?? "api" })),
    eventsAfter: mock((_id: string, _after: number, _limit: number) =>
      Promise.resolve(batches.shift() ?? []),
    ),
    streamState: mock(() => {
      lastState = states.shift() ?? lastState;
      return Promise.resolve(lastState);
    }),
  };
  const clock = o.clock ?? fakeClock();
  const controller = new ApiController(service as unknown as ApiTaskServicePort, {
    authEnabled: false,
    ssePollMs: o.pollMs ?? 1000,
    sseMaxDurationMs: o.maxMs ?? 3000,
    clock,
  });
  const app = createApiRoutes(
    controller,
    { authenticate: async () => null },
    {
      authEnabled: false,
      allowedHosts: [],
      linearStatus: async () => ({ configured: false }),
      githubStatus: () => ({
        token: { source: "env", expiresAt: null, readAt: null, lastError: null },
        webhooks: { enabled: false, lastWebhookAt: null, ciResults: false },
      }),
    },
  );
  return { app, service, controller, clock };
}

const RUNNING: SseStateData = { state: "running", sandbox_live: true };

describe("GET /api/tasks/:ref/events/stream", () => {
  it("replays from Last-Event-ID, then sends state without an id, then closes at max duration", async () => {
    const { app, service } = setup({ batches: [[env(6), env(7)]], states: [RUNNING] });
    const res = await app.request(`/api/tasks/${ID}/events/stream`, {
      headers: { "last-event-id": "5" },
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(frame(env(6)) + frame(env(7)) + stateFrame(RUNNING));
    expect(service.eventsAfter.mock.calls).toEqual([
      [ID, 5, 500],
      [ID, 7, 500],
      [ID, 7, 500],
    ]);
  });

  it("starts from ?after= when there is no Last-Event-ID, and from 0 with neither", async () => {
    const a = setup({});
    await (await a.app.request(`/api/tasks/${ID}/events/stream?after=12`)).text();
    expect(a.service.eventsAfter.mock.calls[0]).toEqual([ID, 12, 500]);
    const b = setup({});
    await (await b.app.request(`/api/tasks/${ID}/events/stream`)).text();
    expect(b.service.eventsAfter.mock.calls[0]).toEqual([ID, 0, 500]);
  });

  it("Last-Event-ID wins over ?after=", async () => {
    const { app, service } = setup({});
    await (
      await app.request(`/api/tasks/${ID}/events/stream?after=12`, {
        headers: { "last-event-id": "3" },
      })
    ).text();
    expect(service.eventsAfter.mock.calls[0]).toEqual([ID, 3, 500]);
  });

  it("sends state again only when it changes", async () => {
    const queued: SseStateData = { state: "queued", sandbox_live: false };
    const idle: SseStateData = { state: "idle", sandbox_live: true };
    const { app } = setup({ states: [queued, queued, idle] });
    expect(await (await app.request(`/api/tasks/${ID}/events/stream`)).text()).toBe(
      stateFrame(queued) + stateFrame(idle),
    );
  });

  it("writes a keepalive after 15s with nothing written", async () => {
    const { app } = setup({ maxMs: 17_000 });
    expect(await (await app.request(`/api/tasks/${ID}/events/stream`)).text()).toBe(
      `${stateFrame(RUNNING)}: keepalive\n\n`,
    );
  });

  it("closes after the max duration (one poll per interval)", async () => {
    const { app, service } = setup({ maxMs: 5000, pollMs: 1000 });
    await (await app.request(`/api/tasks/${ID}/events/stream`)).text();
    expect(service.eventsAfter).toHaveBeenCalledTimes(5);
  });

  it("Linear task: one state, logging unavailable, then close; never reads the log", async () => {
    const { app, service } = setup({
      source: "linear",
      states: [{ state: "idle", sandbox_live: false }],
    });
    expect(await (await app.request(`/api/tasks/ABC-1/events/stream`)).text()).toBe(
      `${stateFrame({ state: "idle", sandbox_live: false })}event: logging\ndata: {"logging":"unavailable"}\n\n`,
    );
    expect(service.eventsAfter).not.toHaveBeenCalled();
  });

  it("disables Bun's idle timeout for the stream", async () => {
    const { app } = setup({});
    const timeout = mock(() => {});
    await (await app.request(`/api/tasks/${ID}/events/stream`, {}, { timeout })).text();
    expect(timeout).toHaveBeenCalledTimes(1);
    expect((timeout.mock.calls[0] as unknown[])[1]).toBe(0);
  });

  it("client disconnect stops polling", async () => {
    const { app, service, clock } = setup({ maxMs: 600_000 });
    const res = await app.request(`/api/tasks/${ID}/events/stream`);
    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    const calls = service.eventsAfter.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(service.eventsAfter.mock.calls.length).toBe(calls);
    // Not the deadline that ended it.
    expect(clock.t).toBeLessThan(600_000);
  });

  it("closeStreams ends open streams (shutdown)", async () => {
    // pollMs 1: fake time advances 1ms per iteration, so no keepalive can fire
    // within the few real milliseconds this test runs.
    const { app, controller, clock } = setup({ maxMs: 600_000, pollMs: 1 });
    const res = await app.request(`/api/tasks/${ID}/events/stream`);
    const text = res.text();
    await new Promise((r) => setTimeout(r, 5));
    controller.closeStreams();
    expect(await text).toBe(stateFrame(RUNNING));
    // Not the deadline that ended it.
    expect(clock.t).toBeLessThan(600_000);
  });

  it("an abort while the events were being read skips the state query", async () => {
    const { app, controller, service } = setup({ maxMs: 600_000 });
    service.eventsAfter.mockImplementationOnce(() => {
      controller.closeStreams();
      return Promise.resolve([]);
    });
    expect(await (await app.request(`/api/tasks/${ID}/events/stream`)).text()).toBe("");
    expect(service.streamState).not.toHaveBeenCalled();
  });

  it("closeStreams before the stream opens ends it at once", async () => {
    const { app, controller, service } = setup({ maxMs: 600_000, batches: [[env(1)]] });
    controller.closeStreams();
    const res = await app.request(`/api/tasks/${ID}/events/stream`);
    const text = await Promise.race([
      res.text(),
      new Promise<string>((r) => setTimeout(() => r("body still open"), 1000)),
    ]);
    expect(text).toBe("");
    expect(service.eventsAfter).not.toHaveBeenCalled();
  });

  it("errors before streaming are JSON: bad Last-Event-ID 400, unknown task 404", async () => {
    const { app, service } = setup({});
    const bad = await app.request(`/api/tasks/${ID}/events/stream`, {
      headers: { "last-event-id": "x" },
    });
    expect({ status: bad.status, body: await bad.json() }).toEqual({
      status: 400,
      body: {
        error: { code: "invalid_request", message: "Last-Event-ID must be a non-negative integer" },
      },
    });
    service.streamTarget.mockRejectedValueOnce(
      new ApiError(404, "task_not_found", "Task not found"),
    );
    const nf = await app.request(`/api/tasks/NOPE-1/events/stream`);
    expect({ status: nf.status, body: await nf.json() }).toEqual({
      status: 404,
      body: { error: { code: "task_not_found", message: "Task not found" } },
    });
  });

  it("an error mid-stream closes it without leaking the message, and logs it", async () => {
    const { app, service } = setup({});
    const err = new Error("db password=x");
    service.eventsAfter.mockRejectedValueOnce(err);
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    // Another file's mock.module stub of the logger may be shared here.
    error.mockClear();
    try {
      expect(await (await app.request(`/api/tasks/${ID}/events/stream`)).text()).toBe("");
      expect(error.mock.calls).toEqual([
        ["api event stream failed", { taskId: ID, message: "db password=x", stack: err.stack }],
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it("a failure after the stream aborted (disconnect, shutdown) is not an error log", async () => {
    const { app, service, controller } = setup({});
    service.eventsAfter.mockImplementationOnce(() => {
      controller.closeStreams();
      return Promise.reject(new Error("write after close"));
    });
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    // Another file's mock.module stub of the logger may be shared here.
    error.mockClear();
    try {
      expect(await (await app.request(`/api/tasks/${ID}/events/stream`)).text()).toBe("");
      expect(error.mock.calls).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("removes its shutdown listener when a stream ends", async () => {
    const { app, controller } = setup({ maxMs: 3000 });
    const shutdown = (controller as unknown as { shutdown: AbortController }).shutdown.signal;
    const live = new Set<unknown>();
    const add = shutdown.addEventListener.bind(shutdown);
    const remove = shutdown.removeEventListener.bind(shutdown);
    shutdown.addEventListener = ((type: string, fn: unknown, opts?: unknown) => {
      live.add(fn);
      add(type, fn as EventListener, opts as AddEventListenerOptions);
    }) as typeof shutdown.addEventListener;
    shutdown.removeEventListener = ((type: string, fn: unknown, opts?: unknown) => {
      live.delete(fn);
      remove(type, fn as EventListener, opts as EventListenerOptions);
    }) as typeof shutdown.removeEventListener;
    await (await app.request(`/api/tasks/${ID}/events/stream`)).text();
    expect(live.size).toBe(0);
  });

  describe("a client that never reads the response body", () => {
    // Eight events fill the stream's buffers, so a write blocks on backpressure.
    const BATCH = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => env(i));

    async function until(cond: () => boolean): Promise<void> {
      for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
    }

    // Opens the stream, never reads, and returns once the handler is blocked
    // in a write with the batch only partly written.
    async function openStuck(maxMs: number) {
      const clock = manualClock();
      const s = setup({ batches: [BATCH], maxMs, pollMs: 5, clock });
      const shutdown = (s.controller as unknown as { shutdown: AbortController }).shutdown.signal;
      const live = new Set<unknown>();
      const add = shutdown.addEventListener.bind(shutdown);
      const remove = shutdown.removeEventListener.bind(shutdown);
      shutdown.addEventListener = ((type: string, fn: unknown, opts?: unknown) => {
        live.add(fn);
        add(type, fn as EventListener, opts as AddEventListenerOptions);
      }) as typeof shutdown.addEventListener;
      shutdown.removeEventListener = ((type: string, fn: unknown, opts?: unknown) => {
        live.delete(fn);
        remove(type, fn as EventListener, opts as EventListenerOptions);
      }) as typeof shutdown.removeEventListener;
      const res = await s.app.request(`/api/tasks/${ID}/events/stream`);
      await new Promise((r) => setTimeout(r, 20));
      // Blocked mid-batch: no state read yet, one batch fetched.
      expect({
        batches: s.service.eventsAfter.mock.calls.length,
        states: s.service.streamState.mock.calls.length,
        listeners: live.size,
      }).toEqual({ batches: 1, states: 0, listeners: 1 });
      return { ...s, clock, res, live };
    }

    async function expectEnded(s: Awaited<ReturnType<typeof openStuck>>) {
      await until(() => s.live.size === 0);
      expect(s.live.size).toBe(0);
      // The response body closes: reading it to the end finishes.
      const text = await Promise.race([
        s.res.text(),
        new Promise<string>((r) => setTimeout(() => r("body still open"), 1000)),
      ]);
      expect(text).not.toBe("body still open");
      // Polling stays stopped.
      const calls = s.service.eventsAfter.mock.calls.length;
      await new Promise((r) => setTimeout(r, 20));
      expect(s.service.eventsAfter.mock.calls.length).toBe(calls);
    }

    it("the max duration ends the handler and closes the body", async () => {
      const s = await openStuck(3000);
      s.clock.advance(3000);
      await expectEnded(s);
    });

    it("closeStreams ends the handler and closes the body", async () => {
      const s = await openStuck(600_000);
      s.controller.closeStreams();
      await expectEnded(s);
    });
  });
});
