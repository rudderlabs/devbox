import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { pickForwardedEnv } from "../../../forwardedEnv";
import { parseJiraConfig } from "../config";

// Synthetic values throughout.
const JIRA_ENV = {
  JIRA_ENABLED: "true",
  JIRA_SITE_URL: "https://example.atlassian.net",
  JIRA_CLOUD_ID: "11111111-2222-4333-8444-555555555555",
  JIRA_BOT_EMAIL: "devbox-bot@example.com",
  JIRA_BOT_ACCOUNT_ID: "712020:00000000-0000-4000-8000-0000000000b0",
  JIRA_BOT_NAME: "devbox",
  JIRA_PROJECT_KEYS: "DEMO",
  JIRA_TOKEN_EXPIRES_AT: "2027-01-31",
  JIRA_API_TOKEN: "jira-test-token",
  JIRA_WEBHOOK_SECRET: "webhook-test-secret",
};

describe("parseJiraConfig", () => {
  it("JIRA: off ignores its settings", () => {
    const { JIRA_ENABLED: _e, ...settings } = JIRA_ENV;
    expect(parseJiraConfig(settings)).toBeUndefined();
    expect(parseJiraConfig({ ...settings, JIRA_ENABLED: "false" })).toBeUndefined();
  });

  it("JIRA: an invalid switch value", () => {
    for (const v of ["True", "yes", "1"]) {
      expect(() => parseJiraConfig({ ...JIRA_ENV, JIRA_ENABLED: v })).toThrow(
        new Error(`JIRA_ENABLED must be true or false, got "${v}"`),
      );
    }
  });

  it("JIRA: on with every setting", () => {
    expect(
      parseJiraConfig({
        ...JIRA_ENV,
        JIRA_SITE_URL: "https://example.atlassian.net/",
        JIRA_PROJECT_KEYS: "demo, OPS_2",
        JIRA_STATUS_STARTED: "In Progress",
        JIRA_STATUS_DONE: " In Review ",
        JIRA_TOKEN_EXPIRES_AT: "2027-01-31T12:00:00Z",
        JIRA_ALLOW_RESTRICTED_ISSUES: "true",
      }),
    ).toEqual({
      siteUrl: "https://example.atlassian.net",
      cloudId: "11111111-2222-4333-8444-555555555555",
      botEmail: "devbox-bot@example.com",
      botAccountId: "712020:00000000-0000-4000-8000-0000000000b0",
      botName: "devbox",
      projectKeys: ["DEMO", "OPS_2"],
      statuses: { started: "In Progress", done: "In Review", failed: undefined },
      tokenExpiresAt: new Date("2027-01-31T12:00:00Z"),
      allowRestrictedIssues: true,
      apiToken: "jira-test-token",
      webhookSecret: "webhook-test-secret",
    });
  });

  it("JIRA: optional settings default to no transitions and no restricted issues", () => {
    expect(parseJiraConfig(JIRA_ENV)).toMatchObject({
      statuses: { started: undefined, done: undefined, failed: undefined },
      allowRestrictedIssues: false,
    });
  });

  it("JIRA: on with settings missing, the secrets included", () => {
    expect(() => parseJiraConfig({ JIRA_ENABLED: "true" })).toThrow(
      new Error(
        "JIRA_ENABLED is true but these are missing: JIRA_SITE_URL, JIRA_CLOUD_ID, JIRA_BOT_EMAIL, JIRA_BOT_ACCOUNT_ID, JIRA_BOT_NAME, JIRA_PROJECT_KEYS, JIRA_TOKEN_EXPIRES_AT, JIRA_API_TOKEN, JIRA_WEBHOOK_SECRET",
      ),
    );
    const { JIRA_API_TOKEN: _t, JIRA_WEBHOOK_SECRET: _s, ...noSecrets } = JIRA_ENV;
    expect(() => parseJiraConfig({ ...noSecrets, JIRA_API_TOKEN: " " })).toThrow(
      new Error("JIRA_ENABLED is true but these are missing: JIRA_API_TOKEN, JIRA_WEBHOOK_SECRET"),
    );
  });

  it("JIRA: a project list of separators only counts as missing", () => {
    for (const keys of [",", " , ,"]) {
      expect(() => parseJiraConfig({ ...JIRA_ENV, JIRA_PROJECT_KEYS: keys })).toThrow(
        new Error("JIRA_ENABLED is true but these are missing: JIRA_PROJECT_KEYS"),
      );
    }
  });

  it.each([
    ["JIRA_SITE_URL", "http://example.atlassian.net", "JIRA_SITE_URL must be an https origin"],
    ["JIRA_SITE_URL", "https://example.atlassian.net/jira", "JIRA_SITE_URL must be an https"],
    ["JIRA_SITE_URL", "https://u:p@example.atlassian.net", "JIRA_SITE_URL must be an https"],
    ["JIRA_SITE_URL", "example.atlassian.net", "JIRA_SITE_URL must be an https origin"],
    ["JIRA_CLOUD_ID", "not-a-uuid", "JIRA_CLOUD_ID must be a UUID"],
    ["JIRA_BOT_ACCOUNT_ID", "bot@example.com", "JIRA_BOT_ACCOUNT_ID is not a Jira account id"],
    ["JIRA_PROJECT_KEYS", "DEMO, ../x", 'JIRA_PROJECT_KEYS: "../X" is not a Jira project key'],
    ["JIRA_TOKEN_EXPIRES_AT", "next year", "JIRA_TOKEN_EXPIRES_AT must be an ISO date"],
    ["JIRA_TOKEN_EXPIRES_AT", "2027-02-31x", "JIRA_TOKEN_EXPIRES_AT must be an ISO date"],
    ["JIRA_ALLOW_RESTRICTED_ISSUES", "yes", "JIRA_ALLOW_RESTRICTED_ISSUES must be true or false"],
  ])("JIRA: rejects %s=%p", (name, value, message) => {
    expect(() => parseJiraConfig({ ...JIRA_ENV, [name]: value })).toThrow(message);
  });

  it("JIRA: an error never echoes a secret, email or account id", () => {
    let message = "";
    try {
      parseJiraConfig({ ...JIRA_ENV, JIRA_BOT_ACCOUNT_ID: "bot@example.com" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("bot@example.com");
    expect(message).not.toContain("jira-test-token");
  });

  it("JIRA: no setting reaches a sandbox, secrets included", async () => {
    // Every JIRA_* name the parser reads.
    const source = await Bun.file(join(import.meta.dir, "../config.ts")).text();
    const names = [...new Set(source.match(/\bJIRA_[A-Z][A-Z_]*\b/g))];
    // A scan that finds nothing would pass vacuously.
    expect(names).toContain("JIRA_API_TOKEN");
    expect(names).toContain("JIRA_WEBHOOK_SECRET");
    expect(pickForwardedEnv(Object.fromEntries(names.map((name) => [name, "real"])))).toEqual({});
  });
});
