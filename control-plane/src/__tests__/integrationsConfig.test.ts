import { describe, expect, it } from "bun:test";
import { parseSlackConfig } from "../integrationsConfig";

const SLACK_ENV = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_CHANNEL_ID: "C123",
};

const BAD_SWITCH_VALUES = ["True", "yes", "1"];

describe("parseSlackConfig", () => {
  it("SLACK: on with every setting", () => {
    expect(parseSlackConfig({ ...SLACK_ENV, SLACK_ENABLED: "true" })).toEqual({
      botToken: "xoxb-test",
      channel: "C123",
    });
  });

  it("SLACK: on with a setting missing", () => {
    expect(() => parseSlackConfig({ SLACK_ENABLED: "true" })).toThrow(
      new Error("SLACK_ENABLED is true but these are missing: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID"),
    );
    expect(() => parseSlackConfig({ SLACK_ENABLED: "true", SLACK_BOT_TOKEN: "x" })).toThrow(
      new Error("SLACK_ENABLED is true but these are missing: SLACK_CHANNEL_ID"),
    );
  });

  it("SLACK: off ignores its settings", () => {
    expect(parseSlackConfig({ ...SLACK_ENV })).toBeUndefined();
    expect(parseSlackConfig({ ...SLACK_ENV, SLACK_ENABLED: "" })).toBeUndefined();
    expect(parseSlackConfig({ ...SLACK_ENV, SLACK_ENABLED: "false" })).toBeUndefined();
  });

  it("SLACK: an invalid switch value", () => {
    for (const v of BAD_SWITCH_VALUES) {
      expect(() => parseSlackConfig({ ...SLACK_ENV, SLACK_ENABLED: v })).toThrow(
        new Error(`SLACK_ENABLED must be true or false, got "${v}"`),
      );
    }
  });
});
