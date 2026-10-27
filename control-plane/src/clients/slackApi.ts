// Slack Web API wrapper (chat.postMessage). Plain function export, mirrors
// clients/githubApi.ts. This is the IMPLEMENTATION module; production code and
// service tests import it through the ../clients/slack barrel. slackApi.test.ts
// imports it directly because this specifier is never mock.module'd — see
// slack.ts and control-plane/README.md (Conventions) for why that matters.
//
// Auth: a bearer bot token from config.slack.botToken (an xoxb-… bot token). Optional — an empty token means Slack notifications
// are disabled; callers (SlackNotifierService) gate on that before ever calling
// here, so a call with an empty token is a bug and Slack will answer not_authed.
//
// Never log the token. Error paths surface a body snippet only.

import { config } from "../config";

const API_BASE = process.env.SLACK_API_BASE_URL ?? "https://slack.com/api";

function slackToken(): string {
  // Some test suites module-mock config with partial shapes; tolerate a missing
  // slack group here the same way githubApi tolerates a missing github group.
  return (config as { slack?: { botToken?: string } }).slack?.botToken ?? "";
}

export type PostSlackMessageParams = {
  channel: string;
  // Omit to post a top-level message in the channel.
  threadTs?: string;
  text: string;
  // Optional Block Kit blocks; `text` stays the fallback/notification string.
  blocks?: unknown[];
};

// POST /chat.postMessage into a channel, or into a thread when threadTs is set. IMPORTANT: Slack returns HTTP 200 even
// on a logical failure (bad token, channel_not_found, …) — the JSON `ok` field
// is the real status, so we throw on `!ok` as well as on a non-2xx transport
// error. Returns the posted message ts.
export async function postSlackMessage(params: PostSlackMessageParams): Promise<{ ts: string }> {
  const resp = await fetch(`${API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: params.channel,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      text: params.text,
      ...(params.blocks ? { blocks: params.blocks } : {}),
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Slack chat.postMessage failed: HTTP ${resp.status} ${text.slice(0, 300)}`);
  }
  let data: { ok?: boolean; error?: string; ts?: string };
  try {
    data = JSON.parse(text) as { ok?: boolean; error?: string; ts?: string };
  } catch {
    throw new Error(`Slack chat.postMessage: non-JSON response ${text.slice(0, 300)}`);
  }
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage returned not-ok: ${data.error ?? "unknown_error"}`);
  }
  return { ts: String(data.ts ?? "") };
}

// GET /users.lookupByEmail — Slack user id for a workspace member's email, used
// to @-mention them (`<@U…>`). Returns null on any logical miss (users_not_found,
// or missing_scope when the bot lacks `users:read.email`) — the caller's mention
// degrades to a plain name, never worth failing a message over. Throws only on
// a transport-level error, matching postSlackMessage.
export async function lookupSlackUserIdByEmail(email: string): Promise<string | null> {
  const resp = await fetch(`${API_BASE}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${slackToken()}` },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Slack users.lookupByEmail failed: HTTP ${resp.status} ${text.slice(0, 300)}`);
  }
  let data: { ok?: boolean; user?: { id?: string } };
  try {
    data = JSON.parse(text) as { ok?: boolean; user?: { id?: string } };
  } catch {
    return null;
  }
  if (!data.ok || !data.user?.id) return null;
  return data.user.id;
}
