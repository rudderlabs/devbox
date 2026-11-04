import { describe, expect, it } from "bun:test";
import { optionalNumber, parseSwitch, parseTrustList } from "../env";

describe("parseTrustList", () => {
  it("splits on commas and whitespace and drops empties", () => {
    expect(parseTrustList(" acme, widgets  foo,,\tbar\n")).toEqual([
      "acme",
      "widgets",
      "foo",
      "bar",
    ]);
  });

  it("returns an empty list for unset or blank input", () => {
    expect(parseTrustList(undefined)).toEqual([]);
    expect(parseTrustList("  ")).toEqual([]);
  });
});

describe("parseSwitch", () => {
  it("is true only for exactly true, trimmed", () => {
    expect(parseSwitch({ LINEAR_ENABLED: " true " }, "LINEAR_ENABLED")).toBe(true);
  });

  it("is false when unset, empty, blank or false", () => {
    expect(parseSwitch({}, "SLACK_ENABLED")).toBe(false);
    expect(parseSwitch({ SLACK_ENABLED: "" }, "SLACK_ENABLED")).toBe(false);
    expect(parseSwitch({ SLACK_ENABLED: "  " }, "SLACK_ENABLED")).toBe(false);
    expect(parseSwitch({ SLACK_ENABLED: "false" }, "SLACK_ENABLED")).toBe(false);
  });
});

describe("optionalNumber", () => {
  it("uses the default when unset or blank, and passes 0 and negatives through", () => {
    expect(optionalNumber({}, "N", 20)).toBe(20);
    expect(optionalNumber({ N: " " }, "N", 20)).toBe(20);
    expect(optionalNumber({ N: "0" }, "N", 20)).toBe(0);
    expect(optionalNumber({ N: "-1" }, "N", 20)).toBe(-1);
  });

  it("rejects a present value that is not a finite number", () => {
    for (const v of ["abc", "Infinity"]) {
      expect(() => optionalNumber({ N: v }, "N", 20)).toThrow(
        new Error("Env var N must be a number"),
      );
    }
  });
});
