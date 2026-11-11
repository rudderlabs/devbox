import { describe, expect, it } from "bun:test";
import { preflightMode } from "./up";

describe("preflightMode", () => {
  for (const flag of ["skip-jira-check", "skip-clickup-check"] as const) {
    it(`${flag}: none without the integration, whatever the flags`, () => {
      expect(preflightMode(false, {}, flag)).toBeUndefined();
      expect(preflightMode(false, { "skip-checks": true, [flag]: true }, flag)).toBeUndefined();
    });

    it(`${flag}: checks the token by default`, () => {
      expect(preflightMode(true, {}, flag)).toBe("checked");
    });

    it(`--skip-checks and --${flag} each leave it unchecked`, () => {
      expect(preflightMode(true, { "skip-checks": true }, flag)).toBe("unchecked");
      expect(preflightMode(true, { [flag]: true }, flag)).toBe("unchecked");
    });
  }

  it("one integration's flag leaves the other checked", () => {
    expect(preflightMode(true, { "skip-jira-check": true }, "skip-clickup-check")).toBe("checked");
    expect(preflightMode(true, { "skip-clickup-check": true }, "skip-jira-check")).toBe("checked");
  });
});
