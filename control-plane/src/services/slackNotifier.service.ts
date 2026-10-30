import { lookupSlackUserIdByEmail, postSlackMessage } from "../clients/slack";
import type { Task } from "../db/schema";
import { SEND_TIMEOUT_MS, withTimeout } from "../integrations/http";
import type { TaskSource } from "../integrations/types";
import type { TaskRepository } from "../repositories/task.repository";
import type { IntegrationHooks } from "./integrationHooks";

// Terminal-state granularity. `completed | partial_failure | no_action` come
// from the sandbox `completed` event's status field; `failed` is used by both
// the event status "failed" (a soft daemon failure) and the control-plane hard
// failure path (failTask).
export type TerminalStatus = "completed" | "partial_failure" | "no_action" | "failed";

type PrUrlEntry = { repo: string; url: string };

// Posts a single task-completion update to the configured Slack channel (a
// message per task whose source is opted in). Disabled unless both a bot token
// and a channel are configured.
//
// Best-effort by contract: callers detach it (IntegrationHooks.detach logs a
// failure). A Slack outage or a missing thread must never affect task dispatch
// or teardown.
export class SlackNotifierService {
  constructor(
    private readonly taskRepo: TaskRepository,
    // config.slack.botToken in production. Empty ⇒ Slack disabled (no-op).
    // Injected (not read from config) so the notifier is testable without
    // mocking the config module.
    private readonly botToken: string,
    // config.slack.channel in production. Empty ⇒ Slack disabled (no-op).
    private readonly channel: string,
    // config.slack.notifySources (SLACK_NOTIFY_SOURCES): the task sources
    // whose tasks post.
    private readonly notifySources: readonly TaskSource[],
    // The owner integration's assignee(), for the connect-GitHub nudge.
    private readonly hooks: Pick<IntegrationHooks, "assignee">,
    // Injected for testability; default to the real implementations.
    private readonly post: typeof postSlackMessage = postSlackMessage,
    private readonly lookupSlackUser: typeof lookupSlackUserIdByEmail = lookupSlackUserIdByEmail,
  ) {}

  // Common gate for every Slack post: a token and a channel are provisioned
  // and the source is opted in. Callers check it before notifyTerminal.
  notifies(source: TaskSource): boolean {
    return Boolean(this.botToken && this.channel) && this.notifySources.includes(source);
  }

  async notifyTerminal(task: Task, status: TerminalStatus, message?: string): Promise<void> {
    if (!this.notifies(task.source)) return;

    // Re-read for the freshest pr_urls — the in-memory task handed in from the
    // reconcile loop can predate the pr_opened write that appended the PR. This
    // is only an optimization: on a DB blip (getById rejects) degrade to the
    // in-memory task.prUrls rather than dropping the whole best-effort post —
    // the thread is already resolved and the PR data is in hand.
    const fresh = await this.taskRepo.getById(task.id).catch(() => null);
    const t = fresh ?? task;
    const prUrls = parsePrUrls(t.prUrls);
    // Nudge shown alongside PR links when a Linear ticket's human assignee
    // hasn't connected GitHub in Linear — the PR couldn't be assigned to them
    // (eventDispatcher's pr_opened mirror skipped with no_github_mapping) and
    // self-service is the only fix. Re-checked lazily here so a user who
    // connected mid-run isn't nagged. Skipped for no_action, whose message
    // renders no PR section for the nudge to ride on.
    const wantsNudge = t.source === "linear" && status !== "no_action" && prUrls.length > 0;
    const connectNote = wantsNudge ? await this.connectGitHubNote(t) : "";

    const text = buildMessage(status, t, prUrls, connectNote, message);
    await withTimeout(SEND_TIMEOUT_MS, (signal) =>
      this.post({ channel: this.channel, text, signal }),
    );
  }

  // "" when there is nothing to nag about: no human assignee, already mapped,
  // or the lookup failed (IntegrationHooks logs it; never blocks the post).
  private async connectGitHubNote(task: Task): Promise<string> {
    const person = await this.hooks.assignee(task, null, { purpose: "slack_nudge" });
    if (person?.codeHost !== "unlinked") return "";
    // @-mention the assignee so the nudge notifies them (Slack only pings
    // members of the channel — a non-member renders un-notified). Linear and
    // Slack share the org email, so lookupByEmail is reliable here (it's only
    // GitHub where personal emails diverge — the whole reason for this nudge).
    // Degrades to the plain display name on any lookup miss (users_not_found,
    // bot missing the users:read.email scope, transport error). displayName
    // is member-editable — escape it so it can't inject mrkdwn (<!channel>,
    // forged <@mentions>, disguised links) into a trusted bot message.
    const email = person.email;
    const slackId = email
      ? await withTimeout(SEND_TIMEOUT_MS, (signal) => this.lookupSlackUser(email, signal)).catch(
          () => null,
        )
      : null;
    const mention = slackId ? `<@${slackId}>` : escapeMrkdwn(person.displayName);
    return (
      `\n⚠️ ${mention}: I couldn't assign the PR to you — your GitHub account ` +
      "isn't connected in Linear. Connect it under *Linear → Settings → Connected accounts* " +
      "and future PRs will be assigned to you automatically."
    );
  }
}

// ──────────────────── module-private helpers ────────────────────

// pr_urls is an untyped jsonb array of {repo, url, branch, commit_sha}. Defend
// against a malformed shape — a notification is never worth throwing over.
function parsePrUrls(raw: unknown): PrUrlEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PrUrlEntry[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url : "";
      if (!url) continue;
      const repo = typeof rec.repo === "string" && rec.repo ? rec.repo : url;
      out.push({ repo, url });
    }
  }
  return out;
}

// Escape a user-controlled string for Slack mrkdwn: &, <, > are the only
// control characters (Slack's own escaping rules).
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Slack mrkdwn link. Slack escapes &, <, > inside link text.
function link(url: string, label: string): string {
  return `<${url}|${escapeMrkdwn(label)}>`;
}

// Link display text for a PR: "repo#<number>" (e.g. "example-org/example-repo
// #9999"), falling back to just the repo when no PR number is parseable from the
// URL. Matches GitHub's /pull/<n> and a trailing /<n> (e.g. GitLab MRs).
function prLabel(p: PrUrlEntry): string {
  const num = (p.url.match(/\/pull\/(\d+)/) ?? p.url.match(/\/(\d+)\/?$/))?.[1];
  return num ? `${p.repo}#${num}` : p.repo;
}

// The PR section appended to a message. Empty when there are no PRs; a single PR
// reads inline ("Here is the PR for review: <link>") with no bullet; multiple PRs
// become a bulleted list ("Here are the PRs for review:\n• …\n• …").
function prSection(prUrls: PrUrlEntry[]): string {
  if (prUrls.length === 0) return "";
  const [first] = prUrls;
  if (prUrls.length === 1 && first) {
    return `\nHere is the PR for review: ${link(first.url, prLabel(first))}`;
  }
  const list = prUrls.map((p) => `• ${link(p.url, prLabel(p))}`).join("\n");
  return `\nHere are the PRs for review:\n${list}`;
}

// The task's link fragment shared by every message ("<url|title>", or the
// bare title when the task has no external URL). An untitled task is labelled
// "Linear ticket" on Linear and by its key elsewhere.
function ticketLink(task: Task): string {
  const label = task.title || (task.source === "linear" ? "Linear ticket" : task.key);
  return task.externalUrl ? link(task.externalUrl, label) : task.title;
}

function buildMessage(
  status: TerminalStatus,
  task: Task,
  prUrls: PrUrlEntry[],
  connectNote: string,
  message?: string,
): string {
  const ticket = ticketLink(task);
  // The connect-GitHub nudge rides with the PR list — it only makes sense next
  // to the PRs it couldn't assign (callers pass "" when there are no PRs).
  const prs = prSection(prUrls) + connectNote;

  switch (status) {
    case "completed":
      return `✅ *devbox completed* for ${ticket}${prs}`;
    case "partial_failure":
      return `⚠️ *devbox finished with issues* for ${ticket}${prs}`;
    case "no_action":
      return `💤 *devbox made no changes* for ${ticket}`;
    case "failed": {
      const reason = message ? `\n${message}` : "";
      return `❌ *devbox failed* for ${ticket}${reason}${prs}`;
    }
  }
}
