import { describe, expect, it } from "bun:test";
import { formPage, githubManifest, manifestPostUrl, registrationLink } from "./manifest";

const PUBLIC = "https://hooks.example.com";
const REDIRECT = "http://localhost:4567/callback";

const MANIFEST = {
  name: "devbox",
  url: "https://github.com/rudderlabs/devbox",
  description: "devbox coding agent",
  public: false,
  redirect_url: REDIRECT,
  hook_attributes: { url: `${PUBLIC}/webhook/github`, active: true },
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    actions: "write",
    metadata: "read",
    members: "read",
  },
  default_events: [
    "issue_comment",
    "pull_request_review",
    "pull_request_review_comment",
    "workflow_run",
  ],
};

describe("githubManifest", () => {
  it("the manifest in full", () => {
    expect(githubManifest({ name: "devbox", publicUrl: PUBLIC, redirectUrl: REDIRECT })).toEqual(
      MANIFEST,
    );
  });

  it("takes the App's name", () => {
    expect(
      githubManifest({ name: "example-devbox", publicUrl: PUBLIC, redirectUrl: REDIRECT }),
    ).toEqual({ ...MANIFEST, name: "example-devbox" });
  });
});

describe("manifestPostUrl", () => {
  it("the user's account", () => {
    expect(manifestPostUrl("s1")).toBe("https://github.com/settings/apps/new?state=s1");
  });

  it("an organization", () => {
    expect(manifestPostUrl("s1", "example-org")).toBe(
      "https://github.com/organizations/example-org/settings/apps/new?state=s1",
    );
  });
});

describe("formPage", () => {
  it("posts the manifest, HTML-escaped, and submits itself", () => {
    const manifest = { name: `a"b<c>&'d` };
    expect(formPage("https://github.com/settings/apps/new?state=s1", manifest)).toBe(
      [
        "<!doctype html>",
        '<html lang="en">',
        '<head><meta charset="utf-8"><title>devbox: create the GitHub App</title></head>',
        "<body>",
        '<form method="post" action="https://github.com/settings/apps/new?state=s1">',
        '<input type="hidden" name="manifest" value="{&quot;name&quot;:&quot;a\\&quot;b&lt;c&gt;&amp;&#39;d&quot;}">',
        "<p>Opening GitHub's page to create the App...</p>",
        '<button type="submit">Continue to GitHub</button>',
        "</form>",
        "<script>document.forms[0].submit();</script>",
        "</body>",
        "</html>",
        "",
      ].join("\n"),
    );
  });

  it("an organization's create page", () => {
    const page = formPage(manifestPostUrl("s2", "example-org"), MANIFEST);
    expect(page).toContain(
      '<form method="post" action="https://github.com/organizations/example-org/settings/apps/new?state=s2">',
    );
  });
});

describe("registrationLink", () => {
  const QUERY = [
    "name=devbox",
    "description=devbox%20coding%20agent",
    "url=https%3A%2F%2Fgithub.com%2Frudderlabs%2Fdevbox",
    "public=false",
    "webhook_active=true",
    "webhook_url=https%3A%2F%2Fhooks.example.com%2Fwebhook%2Fgithub",
    "events[]=issue_comment",
    "events[]=pull_request_review",
    "events[]=pull_request_review_comment",
    "events[]=workflow_run",
    "contents=write",
    "pull_requests=write",
    "issues=write",
    "actions=write",
    "metadata=read",
    "members=read",
  ].join("&");

  it("the user's account", () => {
    expect(registrationLink({ name: "devbox", publicUrl: PUBLIC })).toBe(
      `https://github.com/settings/apps/new?${QUERY}`,
    );
  });

  it("an organization, and a name that needs encoding", () => {
    expect(registrationLink({ org: "example-org", name: "devbox & co", publicUrl: PUBLIC })).toBe(
      `https://github.com/organizations/example-org/settings/apps/new?${QUERY.replace("name=devbox", "name=devbox%20%26%20co")}`,
    );
  });
});
