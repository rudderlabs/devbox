// The GitHub App's manifest: its name, webhook, permissions and events.
// GitHub takes a manifest only as a browser form POST, so `github:setup`
// serves a page that posts it (formPage). A machine without a local browser
// uses the URL-parameter link instead (registrationLink), which carries the
// same settings but no redirect, so GitHub returns no credentials from it.

const DEVBOX_URL = "https://github.com/rudderlabs/devbox";
const DESCRIPTION = "devbox coding agent";

// From the calls devbox makes: push and contents, PRs and their reviews,
// issue comments and reactions, CI jobs, logs and re-runs, and the trusted
// org members.
const PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  actions: "write",
  metadata: "read",
  members: "read",
} as const;

// Exactly the events devbox's webhook handles.
const EVENTS = [
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "workflow_run",
] as const;

export function githubManifest(opts: {
  name: string;
  publicUrl: string;
  redirectUrl: string;
}): object {
  return {
    name: opts.name,
    url: DEVBOX_URL,
    description: DESCRIPTION,
    public: false,
    redirect_url: opts.redirectUrl,
    hook_attributes: { url: `${opts.publicUrl}/webhook/github`, active: true },
    default_permissions: { ...PERMISSIONS },
    default_events: [...EVENTS],
  };
}

// GitHub's "create App" page, under the user's account or an organization.
const createPage = (org?: string): string =>
  org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";

// Where the form posts the manifest; GitHub sends `state` back with the code.
export const manifestPostUrl = (state: string, org?: string): string =>
  `${createPage(org)}?state=${encodeURIComponent(state)}`;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

// A page that posts the manifest to GitHub as soon as it loads, with a
// button for a browser that blocks scripts.
export function formPage(postUrl: string, manifest: object): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>devbox: create the GitHub App</title></head>',
    "<body>",
    `<form method="post" action="${escapeHtml(postUrl)}">`,
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">`,
    "<p>Opening GitHub's page to create the App...</p>",
    '<button type="submit">Continue to GitHub</button>',
    "</form>",
    "<script>document.forms[0].submit();</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// GitHub's URL-parameter registration: the same settings, as a link to open
// anywhere. `events[]` repeats; each permission is `<name>=<level>`.
export function registrationLink(opts: { org?: string; name: string; publicUrl: string }): string {
  const e = encodeURIComponent;
  const params = [
    `name=${e(opts.name)}`,
    `description=${e(DESCRIPTION)}`,
    `url=${e(DEVBOX_URL)}`,
    "public=false",
    "webhook_active=true",
    `webhook_url=${e(`${opts.publicUrl}/webhook/github`)}`,
    ...EVENTS.map((ev) => `events[]=${ev}`),
    ...Object.entries(PERMISSIONS).map(([perm, level]) => `${perm}=${level}`),
  ];
  return `${createPage(opts.org)}?${params.join("&")}`;
}
