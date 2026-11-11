import { describe, expect, it } from "bun:test";
import { jiraPreflightMode } from "./up";

describe("jiraPreflightMode", () => {
  it("none without Jira, whatever the flags", () => {
    expect(jiraPreflightMode(false, {})).toBeUndefined();
    expect(jiraPreflightMode(false, { "skip-checks": true })).toBeUndefined();
  });

  it("checks the token by default", () => {
    expect(jiraPreflightMode(true, {})).toBe("checked");
  });

  it("--skip-checks and --skip-jira-check each leave it unchecked", () => {
    expect(jiraPreflightMode(true, { "skip-checks": true })).toBe("unchecked");
    expect(jiraPreflightMode(true, { "skip-jira-check": true })).toBe("unchecked");
  });
});
