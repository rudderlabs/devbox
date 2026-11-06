import { describe, expect, it } from "bun:test";
import { parseLinearConfig } from "../config";

const LINEAR_ENV = {
  LINEAR_CLIENT_ID: "cid",
  LINEAR_CLIENT_SECRET: "csecret",
  LINEAR_WEBHOOK_SECRET: "wsecret",
};

describe("parseLinearConfig", () => {
  it("LINEAR: on with every setting", () => {
    expect(parseLinearConfig({ ...LINEAR_ENV, LINEAR_ENABLED: "true" })).toEqual({
      clientId: "cid",
      clientSecret: "csecret",
      webhookSecret: "wsecret",
    });
  });

  it("LINEAR: on with a setting missing", () => {
    expect(() =>
      parseLinearConfig({
        LINEAR_ENABLED: "true",
        LINEAR_CLIENT_ID: "cid",
        LINEAR_CLIENT_SECRET: " ",
      }),
    ).toThrow(
      new Error(
        "LINEAR_ENABLED is true but these are missing: LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET",
      ),
    );
  });

  it("LINEAR: off ignores its settings", () => {
    expect(parseLinearConfig({ ...LINEAR_ENV })).toBeUndefined();
    expect(parseLinearConfig({ ...LINEAR_ENV, LINEAR_ENABLED: "" })).toBeUndefined();
    expect(parseLinearConfig({ ...LINEAR_ENV, LINEAR_ENABLED: "false" })).toBeUndefined();
  });

  it("LINEAR: an invalid switch value", () => {
    for (const v of ["True", "yes", "1"]) {
      expect(() => parseLinearConfig({ ...LINEAR_ENV, LINEAR_ENABLED: v })).toThrow(
        new Error(`LINEAR_ENABLED must be true or false, got "${v}"`),
      );
    }
  });

  it("LINEAR_REDIRECT_URI is ignored", () => {
    const LINEAR_REDIRECT_URI = "http://localhost:3000/oauth/callback";
    expect(parseLinearConfig({ LINEAR_REDIRECT_URI })).toBeUndefined();
    expect(
      parseLinearConfig({ ...LINEAR_ENV, LINEAR_ENABLED: "true", LINEAR_REDIRECT_URI }),
    ).toEqual({ clientId: "cid", clientSecret: "csecret", webhookSecret: "wsecret" });
  });
});
