import { afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";

const { ReplyHolds } = await import("../replyHolds");
const { RetryableError } = await import("../../integrations/outbound");
const { logger } = await import("../../logger");

const T0 = new Date("2026-10-30T12:00:00Z").getTime();
const at = (ms: number) => setSystemTime(new Date(T0 + ms));
const event = (seq: number, inbox_id = "inbox-1") => ({ seq, inbox_id });

describe("ReplyHolds", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("without Retry-After the next attempt is the next tick; with it, after the delay", () => {
    const holds = new ReplyHolds();
    at(0);
    holds.hold("t1", event(1), "linear", new RetryableError("token fetch failed"));
    expect(holds.waiting("t1")).toBe(false);

    holds.hold("t2", event(1), "github", new RetryableError("HTTP 429", 30_000));
    expect(holds.waiting("t2")).toBe(true);
    at(29_999);
    expect(holds.waiting("t2")).toBe(true);
    at(30_000);
    expect(holds.waiting("t2")).toBe(false);
  });

  it("warns reply_held at most every 10 minutes per task; a new event starts a new hold", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const holds = new ReplyHolds();
      const err = new RetryableError("HTTP 429");
      at(0);
      holds.hold("t1", event(5), "github", err);
      at(9 * 60_000);
      holds.hold("t1", event(5), "github", err);
      at(10 * 60_000);
      holds.hold("t1", event(5), "github", err);
      expect(warn.mock.calls.map((c) => c[1])).toEqual([
        {
          event: "reply_held",
          taskId: "t1",
          integration: "github",
          heldForMin: 0,
          reason: "HTTP 429",
        },
        {
          event: "reply_held",
          taskId: "t1",
          integration: "github",
          heldForMin: 10,
          reason: "HTTP 429",
        },
      ]);
      // The same task held on another event is a new hold: its age restarts.
      at(15 * 60_000);
      holds.hold("t1", event(6), "github", err);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(holds.of("github")).toEqual({ heldTasks: 1, oldestHoldAgeMs: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it("reports held tasks and the oldest hold age per integration; release and retain drop holds", () => {
    const holds = new ReplyHolds();
    const err = new RetryableError("x");
    at(0);
    holds.hold("a", event(1), "linear", err);
    at(60_000);
    holds.hold("b", event(1), "linear", err);
    holds.hold("c", event(1), "github", err);
    at(120_000);
    expect(holds.of("linear")).toEqual({ heldTasks: 2, oldestHoldAgeMs: 120_000 });
    expect(holds.of("github")).toEqual({ heldTasks: 1, oldestHoldAgeMs: 60_000 });

    holds.release("a");
    holds.retain(new Set(["a", "b"]));
    expect(holds.of("linear")).toEqual({ heldTasks: 1, oldestHoldAgeMs: 60_000 });
    expect(holds.of("github")).toEqual({ heldTasks: 0, oldestHoldAgeMs: 0 });
  });
});
