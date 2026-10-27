import { describe, expect, it } from "bun:test";
import { parseDuration } from "../duration";

describe("parseDuration", () => {
  it.each([
    ["45s", 45_000],
    ["30m", 1_800_000],
    ["2h", 7_200_000],
    ["1h30m", 5_400_000],
    ["1h0m5s", 3_605_000],
  ])("%s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["", "600", "1.5h", "0s", "5x", "m", "30m1h", " 5m"])("rejects %p", (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});
