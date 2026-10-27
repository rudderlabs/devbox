import { describe, expect, it } from "bun:test";
import { NOW } from "../../__tests__/fixtures";
import { age, oneLine, paint } from "../format";

describe("age", () => {
  it.each([
    ["2026-10-12T12:29:55.000Z", "5s"],
    ["2026-10-12T12:25:00.000Z", "5m"],
    ["2026-10-12T09:30:00.000Z", "3h"],
    ["2026-10-10T12:30:00.000Z", "2d"],
    ["2026-10-12T12:31:00.000Z", "0s"],
  ])("%s", (iso, expected) => {
    expect(age(iso, NOW)).toBe(expected);
  });
});

describe("paint", () => {
  it("wraps text only when colour is on, and never empty text", () => {
    expect(paint("x", "red", true)).toBe("\x1b[31mx\x1b[0m");
    expect(paint("x", "red", false)).toBe("x");
    expect(paint("x", null, true)).toBe("x");
    expect(paint("", "red", true)).toBe("");
  });
});

describe("oneLine", () => {
  it("flattens whitespace and truncates with an ellipsis", () => {
    expect(oneLine("  a\n b\tc ", 10)).toBe("a b c");
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
  });
});
