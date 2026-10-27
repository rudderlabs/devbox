import { describe, expect, it } from "bun:test";
import { parseCpu, parseMemory } from "./quantity";

describe("quantities", () => {
  it.each([
    ["2", 2],
    ["500m", 0.5],
    ["1.5", 1.5],
  ])("cpu %s", (q, n) => expect(parseCpu(q)).toBe(n));
  it.each([
    ["8Gi", 8 * 2 ** 30],
    ["8G", 8e9],
    ["16303308Ki", 16303308 * 1024],
    ["512Mi", 512 * 2 ** 20],
    ["1073741824", 2 ** 30],
  ])("memory %s", (q, n) => expect(parseMemory(q)).toBe(n));
  it("rejects garbage", () => {
    expect(() => parseMemory("8 GB")).toThrow('bad quantity "8 GB"');
  });
});
