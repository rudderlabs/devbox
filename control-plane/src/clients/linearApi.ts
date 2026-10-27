import type { LinearClient } from "@linear/sdk";

// Linear SDK wrappers and issue helpers. This is the IMPLEMENTATION module;
// production code and boundary tests import it through the ../clients/linear
// barrel. linear.test.ts imports it directly because this specifier is never
// mock.module'd. See linear.ts and control-plane/README.md (Conventions).

type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | { type: "action"; action: string; parameter: string };

const ACTIVITY_PREFIX = {
  action: "⚡",
  error: "⚠️",
  thought: "💭",
} as const;

async function emitActivity(
  client: LinearClient,
  agentSessionId: string,
  content: ActivityContent,
): Promise<void> {
  await client.createAgentActivity({ agentSessionId, content });
}

export const emitThought = (client: LinearClient, sessionId: string, body: string) =>
  emitActivity(client, sessionId, {
    type: "thought",
    body: `${ACTIVITY_PREFIX.thought} ${body}`,
  });

export const emitResponse = (client: LinearClient, sessionId: string, body: string) =>
  emitActivity(client, sessionId, { type: "response", body });

export const emitError = (client: LinearClient, sessionId: string, body: string) =>
  emitActivity(client, sessionId, {
    type: "error",
    body: `${ACTIVITY_PREFIX.error} ${body}`,
  });

export const emitAction = (
  client: LinearClient,
  sessionId: string,
  action: string,
  parameter: string,
) =>
  emitActivity(client, sessionId, {
    type: "action",
    action: `${ACTIVITY_PREFIX.action} ${action}`,
    parameter,
  });

// Links a URL to a Linear issue as an attachment. Linear auto-detects known
// providers (GitHub PR, Slack, Zendesk) and renders a rich card; unknown URLs
// fall through to a basic attachment. Idempotent on (issueId, url) — re-calling
// updates the existing attachment instead of duplicating.
export const attachUrlToIssue = (
  client: LinearClient,
  issueId: string,
  url: string,
  title?: string,
) => client.attachmentLinkURL(issueId, url, title ? { title } : undefined);

type UploadIssueAttachmentParams = {
  issueId: string;
  title: string;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  subtitle?: string;
  metadata?: Record<string, string | number>;
};

// Uploads bytes to Linear-managed object storage, then attaches the uploaded
// asset URL to the issue as a first-class attachment card.
export async function uploadIssueAttachment(
  client: LinearClient,
  params: UploadIssueAttachmentParams,
): Promise<void> {
  const uploadPayload = await client.fileUpload(
    params.contentType,
    params.filename,
    params.bytes.byteLength,
  );
  const uploadFile = uploadPayload.uploadFile;
  if (!uploadPayload.success || !uploadFile?.uploadUrl || !uploadFile.assetUrl) {
    throw new Error("Linear fileUpload rejected or returned no upload target");
  }

  // Linear/GCS presigned PUTs sign content-type; omitting it yields MalformedSecurityHeader 400.
  // See https://linear.app/developers/how-to-upload-a-file-to-linear
  const uploadHeaders: Record<string, string> = {
    "Content-Type": params.contentType,
    "Cache-Control": "public, max-age=31536000",
  };
  for (const header of uploadFile.headers ?? []) {
    uploadHeaders[header.key] = header.value;
  }

  const uploadResp = await fetch(uploadFile.uploadUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: params.bytes,
  });
  if (!uploadResp.ok) {
    const responseBody = (await uploadResp.text().catch(() => "")).slice(0, 500);
    const detail = responseBody ? `: ${responseBody}` : "";
    throw new Error(
      `Linear artifact upload failed: HTTP ${uploadResp.status} ${uploadResp.statusText}${detail}`,
    );
  }

  await client.createAttachment({
    issueId: params.issueId,
    title: params.title,
    subtitle: params.subtitle,
    url: uploadFile.assetUrl,
    metadata: params.metadata,
  });
}

// Pulls the human identifier (e.g. "ABC-123") from a Linear issue URL like
// https://linear.app/<org>/issue/ABC-123/<slug>. Used to surface the
// identifier (not the UUID) to downstream systems so GitHub PR bodies can use
// "resolve ABC-123" to auto-link the issue. Source is always Linear's
// webhook payload, so the segment after /issue/ is trusted to be the identifier.
export function parseLinearIssueIdentifier(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/issue\/([^/?#]+)/);
  return match?.[1] ? match[1].toUpperCase() : null;
}

// Strict variant — throws when the URL does not look like a Linear issue URL.
// Use at boundaries where the task is known to be Linear-sourced and the
// identifier is required (inbox enqueue paths).
export function requireLinearTicketId(url: string | null | undefined): string {
  const id = parseLinearIssueIdentifier(url);
  if (!id) throw new Error(`expected Linear issue URL, got ${JSON.stringify(url)}`);
  return id;
}

// Minimal human-identity projection used by the PR-assignee flow.
// gitHubUserId is Linear's own user↔GitHub mapping — populated when a member
// connects their personal GitHub account (Linear Settings → Connected
// accounts), null otherwise.
export type LinearHumanUser = {
  id: string;
  name: string;
  displayName: string;
  // Org email — assumed to match the member's Slack email (used for @-mentions).
  email: string;
  gitHubUserId: string | null;
};

// The issue's assignee IF it is a human — null when unassigned or when the
// assignee is an app/agent user. With actor=app + app:assignable the harness
// app itself can be the Linear assignee; `isMe` (the authenticated app user)
// and `app` (any agent user) filter that out.
export async function getIssueHumanAssignee(
  client: LinearClient,
  issueId: string,
): Promise<LinearHumanUser | null> {
  const issue = await client.issue(issueId);
  const assignee = await issue.assignee;
  if (!assignee || assignee.app || assignee.isMe) return null;
  return {
    id: assignee.id,
    name: assignee.name,
    displayName: assignee.displayName,
    email: assignee.email,
    gitHubUserId: assignee.gitHubUserId ?? null,
  };
}

// teamId → stateId of the team's first "started" workflow state. Workflow
// states are stable per team, safe to cache for the process lifetime; on
// upstream delete the updateIssue call 4xxs and the caller logs + moves on.
const stateIdCache = new Map<string, string>();

export async function setIssueStarted(client: LinearClient, issueId: string): Promise<void> {
  const issue = await client.issue(issueId);
  const team = await issue.team;
  if (!team) throw new Error(`Issue ${issueId} has no team`);

  let stateId = stateIdCache.get(team.id);
  if (!stateId) {
    const states = await client.workflowStates({
      filter: { team: { id: { eq: team.id } }, type: { eq: "started" } },
      first: 50,
    });
    const first = [...states.nodes].sort((a, b) => a.position - b.position)[0];
    if (!first) throw new Error(`No workflow state of type "started" for team ${team.id}`);
    stateId = first.id;
    stateIdCache.set(team.id, stateId);
  }

  await client.updateIssue(issueId, { stateId });
}
