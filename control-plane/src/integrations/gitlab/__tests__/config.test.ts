import { describe, expect, it } from "bun:test";
import { parseGitlabConfig } from "../config";

const ENV = {
  GITLAB_BASE_URL: "https://gitlab.example.com",
  GITLAB_WEBHOOK_SIGNING_TOKEN: "whsec_c2VjcmV0",
  GITLAB_BOT_USERNAME: "devbox-bot",
  GITLAB_BOT_USER_ID: "42",
  GITLAB_TRUSTED_USERS: "alice",
};
const ON = { ...ENV, GITLAB_WEBHOOKS_ENABLED: "true" };

describe("parseGitlabConfig", () => {
  it("is off by default and with the switch false, whatever else is set", () => {
    expect(parseGitlabConfig({})).toBeUndefined();
    expect(parseGitlabConfig(ENV)).toBeUndefined();
    expect(parseGitlabConfig({ ...ENV, GITLAB_WEBHOOKS_ENABLED: "false" })).toBeUndefined();
  });

  it("on with every setting", () => {
    expect(
      parseGitlabConfig({
        ...ON,
        GITLAB_WEBHOOK_SECRET: "legacy",
        GITLAB_TRUSTED_GROUPS: "platform/backend",
        GITLAB_CI_RESULT_ENABLED: "true",
        GITLAB_CI_RESULT_MAX_PER_TASK: "5",
      }),
    ).toEqual({
      signingToken: "whsec_c2VjcmV0",
      secretToken: "legacy",
      botUserId: 42,
      botUsername: "devbox-bot",
      trustedGroups: ["platform/backend"],
      trustedUsers: ["alice"],
      ciResultEnabled: true,
      ciResultMaxPerTask: 5,
    });
  });

  it("either webhook token is enough; CI results are off and capped at 20 by default", () => {
    const { GITLAB_WEBHOOK_SIGNING_TOKEN: _s, ...noSigning } = ON;
    expect(parseGitlabConfig({ ...noSigning, GITLAB_WEBHOOK_SECRET: "legacy" })).toMatchObject({
      signingToken: undefined,
      secretToken: "legacy",
    });
    expect(parseGitlabConfig(ON)).toMatchObject({
      signingToken: "whsec_c2VjcmV0",
      secretToken: undefined,
      ciResultEnabled: false,
      ciResultMaxPerTask: 20,
    });
  });

  it("on with a setting missing names every missing one", () => {
    expect(() => parseGitlabConfig({ GITLAB_WEBHOOKS_ENABLED: "true" })).toThrow(
      new Error(
        "GITLAB_WEBHOOKS_ENABLED is true but these are missing: GITLAB_BASE_URL, GITLAB_WEBHOOK_SIGNING_TOKEN or GITLAB_WEBHOOK_SECRET, GITLAB_BOT_USERNAME, GITLAB_BOT_USER_ID, GITLAB_TRUSTED_GROUPS or GITLAB_TRUSTED_USERS",
      ),
    );
  });

  it("rejects a signing token without the whsec_ prefix and a bad bot id", () => {
    expect(() => parseGitlabConfig({ ...ON, GITLAB_WEBHOOK_SIGNING_TOKEN: "c2VjcmV0" })).toThrow(
      new Error("GITLAB_WEBHOOK_SIGNING_TOKEN must start with whsec_"),
    );
    expect(() => parseGitlabConfig({ ...ON, GITLAB_BOT_USER_ID: "abc" })).toThrow(
      new Error("GITLAB_BOT_USER_ID must be a positive number"),
    );
  });

  it("a bad CI cap fails boot with webhooks off too", () => {
    expect(() => parseGitlabConfig({ GITLAB_CI_RESULT_MAX_PER_TASK: "lots" })).toThrow(
      new Error("Env var GITLAB_CI_RESULT_MAX_PER_TASK must be a number"),
    );
  });
});
