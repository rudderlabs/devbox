import { describe, expect, it } from "bun:test";
import { parseGithubConfig } from "../config";

const WEBHOOK_ENV = {
  GITHUB_WEBHOOK_SECRET: "hook",
  GITHUB_BOT_LOGIN: "my-bot",
  GITHUB_BOT_USER_ID: "42",
  GITHUB_TRUSTED_USERS: "alice",
};
const ON = { ...WEBHOOK_ENV, GITHUB_WEBHOOKS_ENABLED: "true" };

describe("parseGithubConfig", () => {
  it("is off when nothing is set", () => {
    expect(parseGithubConfig({})).toBeUndefined();
  });

  it("GITHUB: on with every setting", () => {
    expect(parseGithubConfig({ ...ON, GITHUB_TRUSTED_ORGS: "acme" })).toEqual({
      secret: "hook",
      botLogin: "my-bot",
      botUserId: 42,
      trustedOrgs: ["acme"],
      trustedUsers: ["alice"],
      ciReporters: [],
      ciResultEnabled: false,
      ciResultMaxPerTask: 20,
    });
  });

  it("reads the CI reporters as a list of logins", () => {
    const out = parseGithubConfig({
      ...ON,
      GITHUB_CI_REPORTERS: "circleci-checks[bot], jenkins-ci",
    });
    expect(out?.ciReporters).toEqual(["circleci-checks[bot]", "jenkins-ci"]);
  });

  it("GITHUB: accepts users alone or orgs alone as the trust setting", () => {
    const { GITHUB_TRUSTED_USERS: _u, ...noUsers } = ON;
    expect(parseGithubConfig({ ...noUsers, GITHUB_TRUSTED_ORGS: "acme" })).toBeDefined();
    expect(parseGithubConfig(ON)).toBeDefined();
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
    const all = { ...WEBHOOK_ENV, GITHUB_TRUSTED_ORGS: "acme", GITHUB_CI_RESULT_ENABLED: "true" };
    expect(parseGithubConfig(all)).toBeUndefined();
    expect(parseGithubConfig({ ...all, GITHUB_WEBHOOKS_ENABLED: "" })).toBeUndefined();
    expect(parseGithubConfig({ ...all, GITHUB_WEBHOOKS_ENABLED: "false" })).toBeUndefined();
  });

  it("GITHUB: an invalid switch value", () => {
    for (const v of ["True", "yes", "1"]) {
      expect(() => parseGithubConfig({ ...WEBHOOK_ENV, GITHUB_WEBHOOKS_ENABLED: v })).toThrow(
        new Error(`GITHUB_WEBHOOKS_ENABLED must be true or false, got "${v}"`),
      );
    }
  });

  it("rejects a non-numeric bot user id", () => {
    expect(() => parseGithubConfig({ ...ON, GITHUB_BOT_USER_ID: "abc" })).toThrow(
      new Error("GITHUB_BOT_USER_ID must be a number"),
    );
  });

  it("reads the CI result switch and cap; 0 turns the cap off", () => {
    const ci = (env: Record<string, string>) => {
      const cfg = parseGithubConfig({ ...ON, ...env });
      return cfg && { enabled: cfg.ciResultEnabled, max: cfg.ciResultMaxPerTask };
    };
    expect(ci({})).toEqual({ enabled: false, max: 20 });
    expect(ci({ GITHUB_CI_RESULT_ENABLED: "true", GITHUB_CI_RESULT_MAX_PER_TASK: "5" })).toEqual({
      enabled: true,
      max: 5,
    });
    expect(ci({ GITHUB_CI_RESULT_MAX_PER_TASK: "0" })).toEqual({ enabled: false, max: 0 });
    expect(ci({ GITHUB_CI_RESULT_MAX_PER_TASK: " " })).toEqual({ enabled: false, max: 20 });
  });

  it("a cap that is not a number fails with webhooks on or off", () => {
    const bad = { GITHUB_CI_RESULT_MAX_PER_TASK: "abc" };
    const error = new Error("Env var GITHUB_CI_RESULT_MAX_PER_TASK must be a number");
    expect(() => parseGithubConfig({ ...ON, ...bad })).toThrow(error);
    expect(() => parseGithubConfig(bad)).toThrow(error);
  });
});
