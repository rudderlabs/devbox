import { afterEach, describe, expect, it } from "bun:test";
import { colorWanted, good, setColor } from "./style";

afterEach(() => setColor(false));

describe("colorWanted", () => {
  it("colors a terminal only", () => {
    expect(colorWanted(true, {})).toBe(true);
    expect(colorWanted(false, {})).toBe(false);
  });

  it("follows NO_COLOR, TERM=dumb and FORCE_COLOR", () => {
    expect(colorWanted(true, { NO_COLOR: "1" })).toBe(false);
    expect(colorWanted(true, { NO_COLOR: "" })).toBe(true);
    expect(colorWanted(true, { TERM: "dumb" })).toBe(false);
    expect(colorWanted(false, { FORCE_COLOR: "1" })).toBe(true);
    expect(colorWanted(true, { FORCE_COLOR: "0" })).toBe(true);
    expect(colorWanted(true, { FORCE_COLOR: "1", NO_COLOR: "1" })).toBe(true);
  });
});

describe("paint", () => {
  it("is plain text until color is on", () => {
    expect(good("ok")).toBe("ok");
    setColor(true);
    expect(good("ok")).toBe("\u001b[32mok\u001b[39m");
  });
});
