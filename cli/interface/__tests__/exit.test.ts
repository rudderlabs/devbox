import { describe, expect, it } from "bun:test";
import { EXIT, exitCodeFor } from "../exit";

describe("EXIT", () => {
  it("defines each command exit code", () => {
    expect(EXIT).toEqual({ ok: 0, failed: 1, partial: 2, timeout: 3, error: 10, interrupted: 130 });
  });
});

describe("exitCodeFor", () => {
  it.each([
    [{ outcome: "completed", failed: false }, EXIT.ok],
    [{ outcome: "no_action", failed: false }, EXIT.ok],
    [{ outcome: null, failed: false }, EXIT.ok],
    [{ outcome: "partial_failure", failed: false }, EXIT.partial],
    [{ outcome: "failed", failed: true, reason: "x" }, EXIT.failed],
    [{ outcome: null, failed: true, reason: "x" }, EXIT.failed],
  ] as const)("%p → %i", (result, code) => {
    expect(exitCodeFor(result)).toBe(code);
  });
});
