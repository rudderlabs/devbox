import { describe, expect, it } from "bun:test";
import type { GithubAppIntegration, Integrations } from "./lib/integrations";
import { publicUrlChangeLines } from "./webhooks";

const OLD = "https://old.example.com";
const NEXT = "https://hooks.example.com";
const LINEAR_LINE = `Update the webhook URL in the Linear app to ${NEXT}/webhook/linear`;
const EXTERNAL_LINE = `Update the webhook URL in the GitHub App to ${NEXT}/webhook/github: https://github.com/settings/apps/example-devbox`;
const RUN_GITHUB = "Run bun run github:setup to update the GitHub App's webhook URL";
const JIRA_LINE = `Update the webhook URL in Jira (Settings → System → WebHooks) to ${NEXT}/webhook/jira`;
const GITLAB_LINE = `Update the URL of the devbox webhook on each GitLab project (Settings → Webhooks) to ${NEXT}/webhook/gitlab`;
const CLICKUP_LINE = "Run bun run clickup:setup to update the ClickUp webhook's URL";
const OWN = "the setup's own line";

const LINEAR: Integrations = { linear: { enabled: true, clientId: "c" } };
const JIRA: Integrations = { jira: { enabled: true } };
const CLICKUP: Integrations = { clickup: { enabled: true } };
const GITLAB_BLOCK = {
  enabled: true,
  botUsername: "devbox",
  botUserId: 2,
  ciResults: true,
  webhookAuth: "signing" as const,
};
const GITLAB: Integrations = { gitlab: GITLAB_BLOCK };
const app = (tokens: "devbox" | "external", extra: Partial<GithubAppIntegration> = {}) => ({
  githubApp: {
    enabled: true,
    appId: 1,
    slug: "example-devbox",
    installationId: 2,
    botUserId: 3,
    tokens,
    tokenScope: "repos" as const,
    ciResults: true,
    ...extra,
  },
});

describe("publicUrlChangeLines", () => {
  const table: Array<[string, Integrations, { name: string; line?: string }, string[]]> = [
    ["nothing on", {}, { name: "linear" }, []],
    ["Linear, from another setup", LINEAR, { name: "github" }, [LINEAR_LINE]],
    ["Linear, from its own setup: its own line", LINEAR, { name: "linear", line: OWN }, [OWN]],
    ["Linear, from its own setup without a line", LINEAR, { name: "linear" }, []],
    ["devbox App: points at github:setup", app("devbox"), { name: "linear" }, [RUN_GITHUB]],
    ["external App: by hand", app("external"), { name: "jira" }, [EXTERNAL_LINE]],
    ["Jira, from another setup", JIRA, { name: "linear" }, [JIRA_LINE]],
    ["GitLab, from another setup", GITLAB, { name: "jira" }, [GITLAB_LINE]],
    ["GitLab, from its own setup, which prints its own webhooks", GITLAB, { name: "gitlab" }, []],
    ["ClickUp, from another setup", CLICKUP, { name: "jira" }, [CLICKUP_LINE]],
    ["ClickUp, from its own setup, which updates its webhook", CLICKUP, { name: "clickup" }, []],
    [
      "everything on: Linear, GitHub, GitLab, Jira, ClickUp",
      { ...LINEAR, ...app("devbox"), ...GITLAB, ...JIRA, ...CLICKUP },
      { name: "linear", line: LINEAR_LINE },
      [LINEAR_LINE, RUN_GITHUB, GITLAB_LINE, JIRA_LINE, CLICKUP_LINE],
    ],
    [
      "the own line keeps its place",
      { ...LINEAR, ...app("devbox"), ...JIRA },
      { name: "github", line: OWN },
      [LINEAR_LINE, OWN, JIRA_LINE],
    ],
    [
      "from Jira's setup, which prints its own webhook",
      { ...LINEAR, ...app("devbox"), ...JIRA },
      { name: "jira" },
      [LINEAR_LINE, RUN_GITHUB],
    ],
    [
      "integrations that are off: nothing",
      {
        linear: { enabled: false, clientId: "c" },
        githubApp: { ...app("devbox").githubApp, enabled: false },
        jira: { enabled: false },
        gitlab: { ...GITLAB_BLOCK, enabled: false },
        clickup: { enabled: false },
      },
      { name: "linear" },
      [],
    ],
  ];
  for (const [what, integrations, self, lines] of table) {
    it(what, () => {
      expect(publicUrlChangeLines(OLD, NEXT, integrations, self)).toEqual(lines);
    });
  }

  it("on k8s, the github:setup and clickup:setup lines name the target file", () => {
    expect(
      publicUrlChangeLines(
        OLD,
        NEXT,
        { ...app("devbox"), ...CLICKUP },
        { name: "linear" },
        " --target /t.json",
      ),
    ).toEqual([
      "Run bun run github:setup --target /t.json to update the GitHub App's webhook URL",
      "Run bun run clickup:setup --target /t.json to update the ClickUp webhook's URL",
    ]);
  });

  it("an organization's App: its settings link is the organization's", () => {
    expect(
      publicUrlChangeLines(OLD, NEXT, app("external", { org: "example-org" }), { name: "linear" }),
    ).toEqual([
      `Update the webhook URL in the GitHub App to ${NEXT}/webhook/github: https://github.com/organizations/example-org/settings/apps/example-devbox`,
    ]);
  });

  it("no lines when the URL is new or unchanged", () => {
    const all = { ...LINEAR, ...app("external"), ...JIRA };
    expect(publicUrlChangeLines(undefined, NEXT, all, { name: "linear", line: OWN })).toEqual([]);
    expect(publicUrlChangeLines(NEXT, NEXT, all, { name: "github", line: OWN })).toEqual([]);
  });
});
