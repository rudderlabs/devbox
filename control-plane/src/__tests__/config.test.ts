import { expect, it } from "bun:test";

// config.ts reads process.env when it is first imported: only these settings,
// with GitHub's webhooks off.
const saved = process.env;
process.env = {
  GITHUB_TOKEN: "test-token",
  GITHUB_TRUSTED_ORGS: "acme, widgets",
  GITHUB_TRUSTED_USERS: "alice bob",
};
const { config } = await import("../config").finally(() => {
  process.env = saved;
});

it("reads the trust lists forwarded to the sandbox with GitHub's webhooks off", () => {
  expect(config.github).toMatchObject({
    trustedOrgs: ["acme", "widgets"],
    trustedUsers: ["alice", "bob"],
  });
});
