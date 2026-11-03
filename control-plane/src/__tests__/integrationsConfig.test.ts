import { describe, expect, it } from "bun:test";
import {
  parseGithubConfig,
  parseLinearConfig,
  parseSlackConfig,
  parseSwitch,
  parseTrustList,
} from "../integrationsConfig";

const LINEAR_ENV = {
  LINEAR_CLIENT_ID: "cid",
  LINEAR_CLIENT_SECRET: "csecret",
  LINEAR_WEBHOOK_SECRET: "wsecret",
};

const SLACK_ENV = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_CHANNEL_ID: "C123",
};

const WEBHOOK_ENV = {
  GITHUB_WEBHOOK_SECRET: "hook",
  GITHUB_BOT_LOGIN: "my-bot",
  GITHUB_BOT_USER_ID: "42",
  GITHUB_TRUSTED_USERS: "alice",
};

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

const BAD_SWITCH_VALUES = ["True", "yes", "1"];

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
    for (const v of BAD_SWITCH_VALUES) {
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

describe("parseGithubConfig", () => {
  it("has no webhooks and empty trust lists when nothing is set", () => {
    expect(parseGithubConfig({})).toEqual({
      webhooks: undefined,
      trustedOrgs: [],
      trustedUsers: [],
    });
  });

  it("GITHUB: on with every setting", () => {
    expect(
      parseGithubConfig({
        ...WEBHOOK_ENV,
        GITHUB_WEBHOOKS_ENABLED: "true",
        GITHUB_TRUSTED_ORGS: "acme",
      }),
    ).toEqual({
      webhooks: {
        secret: "hook",
        botLogin: "my-bot",
        botUserId: 42,
        trustedOrgs: ["acme"],
        trustedUsers: ["alice"],
      },
      trustedOrgs: ["acme"],
      trustedUsers: ["alice"],
    });
  });

  it("GITHUB: accepts users alone or orgs alone as the trust setting", () => {
    const { GITHUB_TRUSTED_USERS: _u, ...noUsers } = WEBHOOK_ENV;
    const on = { GITHUB_WEBHOOKS_ENABLED: "true" };
    expect(
      parseGithubConfig({ ...on, ...noUsers, GITHUB_TRUSTED_ORGS: "acme" }).webhooks,
    ).toBeDefined();
    expect(parseGithubConfig({ ...on, ...WEBHOOK_ENV }).webhooks).toBeDefined();
  });

  it("GITHUB: on with a setting missing", () => {
    expect(() => parseGithubConfig({ GITHUB_WEBHOOKS_ENABLED: "true" })).toThrow(
      new Error(
        "GITHUB_WEBHOOKS_ENABLED is true but these are missing: GITHUB_WEBHOOK_SECRET, GITHUB_BOT_LOGIN, GITHUB_BOT_USER_ID, GITHUB_TRUSTED_ORGS or GITHUB_TRUSTED_USERS",
      ),
    );
    expect(() =>
      parseGithubConfig({
        GITHUB_WEBHOOKS_ENABLED: "true",
        GITHUB_WEBHOOK_SECRET: "hook",
        GITHUB_BOT_LOGIN: "my-bot",
        GITHUB_BOT_USER_ID: "42",
      }),
    ).toThrow(
      new Error(
        "GITHUB_WEBHOOKS_ENABLED is true but these are missing: GITHUB_TRUSTED_ORGS or GITHUB_TRUSTED_USERS",
      ),
    );
  });

  it("GITHUB: off ignores its settings", () => {
    const all = { ...WEBHOOK_ENV, GITHUB_TRUSTED_ORGS: "acme" };
    const expected = { webhooks: undefined, trustedOrgs: ["acme"], trustedUsers: ["alice"] };
    expect(parseGithubConfig(all)).toEqual(expected);
    expect(parseGithubConfig({ ...all, GITHUB_WEBHOOKS_ENABLED: "" })).toEqual(expected);
    expect(parseGithubConfig({ ...all, GITHUB_WEBHOOKS_ENABLED: "false" })).toEqual(expected);
  });

  it("GITHUB: an invalid switch value", () => {
    for (const v of BAD_SWITCH_VALUES) {
      expect(() => parseGithubConfig({ ...WEBHOOK_ENV, GITHUB_WEBHOOKS_ENABLED: v })).toThrow(
        new Error(`GITHUB_WEBHOOKS_ENABLED must be true or false, got "${v}"`),
      );
    }
  });

  it("trust lists are read with webhooks off", () => {
    const out = parseGithubConfig({
      GITHUB_TRUSTED_ORGS: "acme, widgets",
      GITHUB_TRUSTED_USERS: "alice bob",
    });
    expect(out).toEqual({
      webhooks: undefined,
      trustedOrgs: ["acme", "widgets"],
      trustedUsers: ["alice", "bob"],
    });
  });

  it("rejects a non-numeric bot user id", () => {
    expect(() =>
      parseGithubConfig({
        ...WEBHOOK_ENV,
        GITHUB_WEBHOOKS_ENABLED: "true",
        GITHUB_BOT_USER_ID: "abc",
      }),
    ).toThrow(new Error("GITHUB_BOT_USER_ID must be a number"));
  });
});
