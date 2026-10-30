import type { LinearClient } from "@linear/sdk";
import {
  addPrAssignees,
  getUserById,
  parsePrUrl,
  postIssueComment,
  requestReviewers,
} from "../clients/github";
import { attachUrlToIssue, getIssueHumanAssignee, uploadIssueAttachment } from "../clients/linear";
import { config } from "../config";
import type { Task } from "../db/schema";
import { SEND_TIMEOUT_MS, withTimeout } from "../integrations/http";
import { type Outbound, RetryableError } from "../integrations/outbound";
import type { Integration, IntegrationName } from "../integrations/types";
import { logger } from "../logger";
import type { InboxRepository, InboxRow } from "../repositories/inbox.repository";
import type { TaskRepository } from "../repositories/task.repository";
import type { AgentEmit, HarnessEvent } from "../types/harnessEvent";
import type { LinearTokenProvider } from "./linearTokenProvider";
import type { ReplyHolds } from "./replyHolds";
import type { SandboxManager } from "./sandboxManager.service";
import type { SlackNotifierService } from "./slackNotifier.service";

// Outcome of dispatching a single event.
// - `ok`: handled; reconcileOne advances the cursor and goes on.
// - `dropped`: the event's send timed out or failed for good. reconcileOne
//   advances past it, then stops this task's events for the tick, so a slow
//   or failing platform can't eat the tick (§4 I14).
// - `hold`: a send failed before anything went out (RetryableError); the hold
//   is recorded in ReplyHolds. reconcileOne stops this task's events BEFORE
//   advancing the cursor, so the event is retried until it is sent or fails
//   for good.
// - `self_evict`: an owner-guarded write returned 0 rows — the lease was taken
//   over mid-tick — so reconcileOne must stop processing this task BEFORE
//   advancing the cursor (matching recordEventCursor's 0-row return).
// - `abort`: a DURABLE event (pr_opened) carried an inbox_id this task does not
//   own — a cross-task leak (a sibling's event in our stream, or our own daemon
//   emitting a foreign id). reconcileOne halts this task's stream WITHOUT
//   advancing the cursor and WITHOUT applying the side effect. We deliberately
//   stop-and-alarm rather than skip-and-continue, so a foreign event is visible
//   and cannot trigger a side effect.
export type DispatchResult = "ok" | "dropped" | "hold" | "self_evict" | "abort";

// One-time onboarding comment posted on every PR harness opens — comment
// interactivity is invisible unless users know it exists. Built per-call from
// the configured bot login so the displayed name and the `@mention` example
// always match the actual GitHub App identity (config.github.webhooks.botLogin).
function onboardingCommentBody(botLogin: string, taskKey: string): string {
  return [
    `👋 I'm **${botLogin}**. I opened this PR from task \`${taskKey}\`.`,
    "",
    `Mention \`@${botLogin}\` and I'll act on it — on a top-level PR comment,`,
    "in a review summary, or on an inline comment on the diff. Without a mention I won't see it.",
  ].join("\n");
}

// Replaces taskState.service.ts + taskStateHandlers.ts. Flat switch on
// event.type — each case applies a side effect the same way the old handlers
// did, just driven by events instead of state transitions.
//
// At-least-once dispatch semantics: the cursor advances AFTER handle()
// completes. A crash between a side-effect and the cursor commit re-fires the
// event on the next reconcile tick — all side-effects are idempotent.
export class EventDispatcher {
  constructor(
    private taskRepo: TaskRepository,
    private inboxRepo: InboxRepository,
    private sandboxManager: SandboxManager,
    private linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">,
    private slackNotifier: SlackNotifierService,
    private integrations: Record<IntegrationName, Integration>,
    private holds: ReplyHolds,
  ) {}

  async handle(event: HarnessEvent, task: Task): Promise<DispatchResult> {
    try {
      return await this.apply(event, task);
    } catch (err) {
      // A task-scoped call (the Linear client on pr_opened / completed) failed
      // before anything was sent: hold on the task's own integration. deliver
      // holds on the round's integration itself.
      if (!(err instanceof RetryableError)) throw err;
      this.holds.hold(task.id, event, task.source, err);
      return "hold";
    }
  }

  private async apply(event: HarnessEvent, task: Task): Promise<DispatchResult> {
    // event.inbox_id is sandbox-written; resolve it task-scoped. A null row
    // means this task's event stream is carrying an event whose inbox row it
    // does NOT own — a cross-task LEAK (a sibling's event in our stream, our own
    // daemon emitting a foreign id, or a PVC hydrated from a snapshot that still
    // held another task's `.harness`). Halt the whole reconcile (return "abort")
    // instead of dropping-this-event-and-continuing: we must never apply a
    // foreign side effect (for example, appending another task's PR URL). The task
    // intentionally halts and re-logs each tick until an operator investigates.
    // Pair this record with `crossed_sandbox_binding` using taskId and sandboxId
    // to determine how the streams crossed.
    let inboxRow: InboxRow | null = null;
    if (event.inbox_id) {
      inboxRow = await this.inboxRepo.getByIdForTask(event.inbox_id, task.id);
      if (!inboxRow) {
        logger.error("cross_task_leak_detected: event.inbox_id does not belong to this task", {
          event: "cross_task_leak_detected",
          taskId: task.id,
          taskExternalId: task.externalId,
          sandboxId: task.sandboxId,
          podId: config.podId,
          foreignInboxId: event.inbox_id,
          seq: event.seq,
          eventType: event.type,
          // PR coordinates when the leaked event is the durable pr_opened.
          ...(event.type === "pr_opened"
            ? { repo: event.repo, prUrl: event.pr_url, branch: event.branch }
            : {}),
        });
        return "abort";
      }
    }
    switch (event.type) {
      // Agent emits → labelled, then delivered by the round's integration
      // (routed by round.source, not task.source) to the target named by
      // event.target_id. A Linear outage therefore holds only Linear rounds'
      // messages, never a GitHub round's.
      case "agent_thought":
      case "agent_action":
      case "agent_response":
      case "agent_error":
        return this.deliver(event, inboxRow, task);

      case "pr_opened": {
        // The Linear attach and assignee mirror below need a client. Fetched
        // first, so a Linear token failure holds the event before any side
        // effect.
        const linearClient = await this.linearClientFor(task);
        // appendPrUrl is owner-guarded; a 0-row return means the lease was
        // taken over (stale-lease takeover). Self-evict BEFORE attachUrlToIssue
        // and before the cursor advance — a sibling pod now owns this task.
        const appended = await this.taskRepo.appendPrUrl({
          taskId: task.id,
          ownerId: config.podId,
          prUrl: event.pr_url,
          repo: event.repo,
          branch: event.branch,
          commitSha: event.commit_sha,
        });
        if (appended.length === 0) {
          logger.warn("appendPrUrl returned 0 rows (lease lost); self-evicting", {
            taskId: task.id,
            prUrl: event.pr_url,
          });
          return "self_evict";
        }
        if (linearClient) {
          try {
            await attachUrlToIssue(linearClient, task.externalId, event.pr_url, event.repo);
          } catch (err) {
            logErr(`attachUrlToIssue failed for ${event.repo}`, err);
          }
        }
        // Onboarding comment so users discover they can drive harness with
        // @harness comments + reviews. Best-effort, no dedupe: at-least-once
        // dispatch can re-fire on cursor-replay → duplicate help comments are
        // possible. Acceptable: it's a help message, not load-bearing.
        await this.postOnboardingComment(event, task);
        // Mirror the Linear ticket's human assignee onto the PR. Detached
        // (not awaited): up to 4 unbounded upstream round-trips (2× Linear,
        // 2× GitHub) must not stall tick() toward the lease window — the same
        // hazard reconcileFilesTimeoutMs exists for. Nothing downstream reads
        // the result, and the method never rejects (see its contract).
        void this.assignPrToLinearAssignee(event, task, linearClient);
        break;
      }

      case "completed": {
        // The Slack notify below needs a Linear client for a Linear task's
        // assignment round. Fetched before marking, so a Linear token failure
        // holds the event with the row still open.
        const linearClient =
          inboxRow?.kind === "assignment" ? await this.linearClientFor(task) : null;
        // Bare terminal marker — the user-facing message already went out via
        // the preceding agent_response / agent_error emit. Mark the inbox row
        // responded so the reaper guard clears and the sandbox can be freed.
        // No inbox row → nothing to mark. `marked` is true only on the FIRST
        // transition (a re-fire on cursor-replay returns false), which gates
        // at-most-once completion side effects below.
        const marked = inboxRow
          ? await this.markInboxResponded(inboxRow, event.status ?? null)
          : false;
        // Kind-specific side effect: assignment rounds upload a run archive to
        // the Linear issue while the sandbox is still alive (it lives until
        // the idle reaper). Fire-and-forget — the dispatch loop must not
        // block on an in-sandbox archive command (~tens of seconds).
        if (inboxRow?.kind === "assignment") {
          void this.attachRunArchiveToLinearIssue(task);
          // Slack completion update to the configured channel.
          // Assignment-only (the top-level task, not comment/review rounds) and
          // gated on the first inbox transition so a cursor-replay can't double-
          // post. Fire-and-forget: a Slack outage must not stall the dispatch
          // loop. The notifier no-ops when Slack is disabled.
          if (marked && linearClient) {
            void this.slackNotifier
              .notifyTerminal(linearClient, task, event.status ?? "completed")
              .catch((err) => logErr("slack completion notify failed", err));
          }
        }
        if (marked && inboxRow?.kind === "review") {
          this.requestReviewFromOriginalReviewer(inboxRow, task);
        }
        break;
      }

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        logger.warn("Unknown event type", {
          taskId: task.id,
          eventType: (event as { type: string }).type,
        });
      }
    }
    return "ok";
  }

  // Nothing has been sent when the token fetch fails, so handle() holds.
  private async linearClientFor(task: Task): Promise<LinearClient | null> {
    if (task.source !== "linear") return null;
    try {
      return await this.linearTokenProvider.getAuthorizedLinearClient();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RetryableError(`Linear token fetch failed: ${msg}`);
    }
  }

  // Delivers one agent emit to one thread: looks up the target on the inbox
  // row's reply_targets[] by target_id, labels the emit, and hands both to the
  // round's integration, which decides where (or whether) it shows up. Core
  // never checks what an integration can show. The send runs under
  // SEND_TIMEOUT_MS. A RetryableError (nothing was sent) holds the event on
  // the round's integration; a timeout or any other failure is logged and the
  // event dropped.
  private async deliver(
    event: AgentEmit,
    inboxRow: InboxRow | null,
    task: Task,
  ): Promise<DispatchResult> {
    if (!inboxRow) {
      logger.warn(`${event.type} references missing inbox row`, {
        taskId: task.id,
        inboxId: event.inbox_id,
      });
      return "ok";
    }
    const target = inboxRow.reply_targets.find((t) => t.id === event.target_id);
    if (!target) {
      logger.warn(`${event.type} target_id not in reply_targets`, {
        taskId: task.id,
        inboxId: inboxRow.id,
        targetId: event.target_id,
      });
      return "ok"; // cursor still advances — drop
    }

    try {
      await withTimeout(SEND_TIMEOUT_MS, (signal) =>
        this.integrations[inboxRow.source].deliver(
          { signal, log: logger },
          target,
          labelAgentEmit(event, inboxRow),
        ),
      );
      return "ok";
    } catch (err) {
      if (err instanceof RetryableError) {
        this.holds.hold(task.id, event, inboxRow.source, err);
        return "hold";
      }
      logErr(`deliver ${event.type} failed for target ${target.id}`, err);
      return "dropped";
    }
  }

  // Marks the inbox row's round done (status → 'responded') for the
  // completed terminal event, so the reaper guard clears and the
  // sandbox can be freed. Idempotent: an already-responded row is skipped, and
  // markResponded's owner + status guards make a re-fire / stale-lease takeover
  // a 0-row no-op.
  //
  // This never posts to Linear — the user-visible message already went out on
  // the preceding agent_response / agent_error generic emit. It only advances
  // CP's own state.
  // Returns true iff THIS call transitioned the row to 'responded' (0-row
  // no-ops and already-responded re-fires return false). Callers use the
  // return as a first-transition gate for at-most-once side effects (the
  // Slack completion notify).
  private async markInboxResponded(inboxRow: InboxRow, outcome: string | null): Promise<boolean> {
    if (inboxRow.status === "responded") return false; // already done — idempotent re-fire
    try {
      const marked = await this.inboxRepo.markResponded({
        inboxId: inboxRow.id,
        ownerId: config.podId,
        outcome,
      });
      if (marked.length === 0) {
        // 0 rows = owner mismatch (lease lost mid-tick). status stays
        // pre-'responded'; the reaper guard keeps the sandbox pinned until a
        // sibling pod re-fires the event.
        logger.warn("markResponded returned 0 rows: lease lost; inbox row not advanced", {
          inboxId: inboxRow.id,
        });
        return false;
      }
      return true;
    } catch (err) {
      logErr("markResponded failed", err);
      // status stays pre-'responded'; the reaper guard keeps the sandbox alive.
      // User-recoverable via a follow-up comment.
      return false;
    }
  }

  private requestReviewFromOriginalReviewer(
    inboxRow: Extract<InboxRow, { kind: "review" }>,
    task: Task,
  ): void {
    const payload = inboxRow.payload as Record<string, unknown> | null | undefined;
    const reviewerLoginRaw = payload?.reviewer_login;
    const reviewerLogin = typeof reviewerLoginRaw === "string" ? reviewerLoginRaw.trim() : "";
    if (!reviewerLogin) {
      logger.info("review re-request skipped", {
        event: "review_rerequest.result",
        status: "skipped",
        reason: "missing_reviewer_login",
        taskId: task.id,
        inboxId: inboxRow.id,
      });
      return;
    }

    const pr = reviewPrCoordinates(inboxRow);
    if (!pr) {
      logger.warn("review re-request skipped", {
        event: "review_rerequest.result",
        status: "skipped",
        reason: "missing_pr_coordinates",
        taskId: task.id,
        inboxId: inboxRow.id,
        reviewerLogin,
      });
      return;
    }

    void requestReviewers(pr.owner, pr.repo, pr.prNumber, [reviewerLogin]).catch((err) =>
      logErr("request reviewers failed", err, {
        taskId: task.id,
        inboxId: inboxRow.id,
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.prNumber,
        reviewerLogin,
      }),
    );
  }

  private async postOnboardingComment(
    event: Extract<HarnessEvent, { type: "pr_opened" }>,
    task: Task,
  ): Promise<void> {
    // The comment explains @-mentions, which only work with webhooks on.
    const webhooks = config.github.webhooks;
    if (!webhooks) return;
    const pr = parsePrUrl(event.pr_url);
    if (!pr) return; // not a github.com PR URL — skip
    await postIssueComment(
      pr.owner,
      pr.repo,
      pr.prNumber,
      onboardingCommentBody(webhooks.botLogin, task.key),
    ).catch((err) => logErr("onboarding comment post failed", err));
  }

  // Mirrors the Linear ticket's human assignee onto the GitHub PR as assignee.
  // Assignee is the right primitive here: harness PRs open as DRAFTS and GitHub
  // rejects requested_reviewers on drafts. Identity comes from Linear's own
  // user↔GitHub mapping (User.gitHubUserId, populated when a member connects
  // GitHub under Linear Settings → Connected accounts) — never email matching.
  //
  // Best-effort by contract: never throws, a failure must not block dispatch or
  // the cursor. Idempotent on cursor-replay (POST assignees re-add is a GitHub
  // no-op) — with the accepted quirk that a human who manually unassigned
  // themselves gets re-added on a rare replay.
  private async assignPrToLinearAssignee(
    event: Extract<HarnessEvent, { type: "pr_opened" }>,
    task: Task,
    linearClient: LinearClient | null,
  ): Promise<void> {
    if (!linearClient) return; // GH-sourced task — no Linear identity to mirror.
    const pr = parsePrUrl(event.pr_url);
    if (!pr) return; // not a github.com PR URL — skip
    try {
      const human = await getIssueHumanAssignee(linearClient, task.externalId);
      if (!human) {
        logger.info("PR assignee mirror skipped", {
          event: "pr_assignee.result",
          status: "skipped",
          reason: "no_human_assignee",
          taskId: task.id,
          prUrl: event.pr_url,
        });
        return;
      }
      if (!human.gitHubUserId) {
        // Fix path: the member connects GitHub in Linear Settings → Connected
        // accounts. Log id + displayName, not email.
        logger.info("PR assignee mirror skipped", {
          event: "pr_assignee.result",
          status: "skipped",
          reason: "no_github_mapping",
          taskId: task.id,
          prUrl: event.pr_url,
          linearUserId: human.id,
          linearDisplayName: human.displayName,
        });
        return;
      }
      // Defensive about the field's format: numeric → GitHub account id
      // (resolve to the current login), anything else → already a login.
      const login = /^\d+$/.test(human.gitHubUserId)
        ? (await getUserById(human.gitHubUserId)).login
        : human.gitHubUserId;
      if (!login) {
        // getUserById normalizes a malformed 2xx body to login: "" — don't POST
        // an empty assignee and misreport it as no_push_access.
        logger.warn("PR assignee mirror skipped", {
          event: "pr_assignee.result",
          status: "skipped",
          reason: "unresolved_login",
          taskId: task.id,
          prUrl: event.pr_url,
          linearUserId: human.id,
        });
        return;
      }
      const { assigned } = await addPrAssignees(pr.owner, pr.repo, pr.prNumber, [login]);
      // GitHub logins are case-insensitive but the response echoes canonical
      // casing — compare case-folded so a cased mapping isn't a false drop.
      if (!assigned.some((a) => a.toLowerCase() === login.toLowerCase())) {
        // GitHub silently drops logins without push access (201 regardless).
        logger.warn("PR assignee silently dropped by GitHub", {
          event: "pr_assignee.result",
          status: "silently_dropped",
          reason: "no_push_access",
          taskId: task.id,
          prUrl: event.pr_url,
          requested: login,
          assigned,
        });
        return;
      }
      logger.info("PR assignee mirrored", {
        event: "pr_assignee.result",
        status: "assigned",
        taskId: task.id,
        prUrl: event.pr_url,
        requested: login,
        assigned,
      });
    } catch (err) {
      logErr("assignPrToLinearAssignee failed", err, { taskId: task.id, prUrl: event.pr_url });
    }
  }

  // Best-effort run-archive upload. Runs the harness's `archive` command in the
  // still-live sandbox, then uploads the tar.gz to the Linear issue as an
  // attachment. Fully swallowed — the archive is a forensic nicety, never
  // load-bearing; a failure must not affect dispatch. GH-source tasks have no
  // Linear issue to attach to, so they are skipped.
  private async attachRunArchiveToLinearIssue(task: Task): Promise<void> {
    if (!task.sandboxId || task.source !== "linear") return;
    try {
      const bytes = await this.sandboxManager.extractArchive(task.sandboxId);
      if (!bytes || bytes.byteLength === 0) return;
      const client = await this.linearTokenProvider.getAuthorizedLinearClient();
      await uploadIssueAttachment(client, {
        issueId: task.externalId,
        title: "Harness run archive",
        subtitle: `Task ${task.id}`,
        filename: `harness-run-${task.id}.tar.gz`,
        contentType: "application/gzip",
        bytes,
        metadata: { taskId: task.id },
      });
    } catch (err) {
      logErr(`attachRunArchiveToLinearIssue failed for task ${task.id}`, err);
    }
  }
}

// What an agent emit is, as the integration sees it. A non-retryable
// agent_error relies on the harness contract: on an assignment its body is the
// user-safe summary (_format_completion_body); on a comment, review or CI round
// it carries exception text (_emit_round_failure). Neither marks the row failed
// nor writes a task_event: the following `completed` marks it responded.
function labelAgentEmit(event: AgentEmit, round: InboxRow): Outbound {
  switch (event.type) {
    case "agent_response":
      return { type: "reply", body: event.body };
    case "agent_thought":
      return { type: "progress", kind: "thought", body: event.body };
    case "agent_action":
      return { type: "progress", kind: "action", body: event.body };
    case "agent_error":
      // A retried assignment attempt; the final failure arrives through failTask.
      if (event.retryable_assignment_failure) {
        return { type: "progress", kind: "error", body: event.body };
      }
      return round.kind === "assignment"
        ? { type: "failure", cause: "round_failed", round, summary: event.body }
        : { type: "failure", cause: "round_failed", round, detail: event.body };
  }
}

function reviewPrCoordinates(
  inboxRow: Extract<InboxRow, { kind: "review" }>,
): { owner: string; repo: string; prNumber: number } | null {
  const pr = inboxRow.payload.pr as Record<string, unknown> | undefined;
  const owner = typeof pr?.owner === "string" ? pr.owner : "";
  const repo = typeof pr?.repo === "string" ? pr.repo : "";
  const prNumber = typeof pr?.prNumber === "number" ? pr.prNumber : Number.NaN;
  if (owner && repo && Number.isFinite(prNumber)) {
    return { owner, repo, prNumber };
  }

  const target = inboxRow.reply_targets.find(
    (t) => t.spec.kind === "review_body" || t.spec.kind === "review_comment",
  );
  if (target && "owner" in target.spec) {
    return { owner: target.spec.owner, repo: target.spec.repo, prNumber: target.spec.prNumber };
  }

  const prUrl = typeof pr?.pr_url === "string" ? pr.pr_url : "";
  return prUrl ? parsePrUrl(prUrl) : null;
}

// Untrusted values (e.g. sandbox-written pr_url) belong in `meta`, never in
// `msg`: metadata is JSON-stringified by the logger while the message is
// emitted raw, so a newline in an interpolated message would forge log lines.
function logErr(msg: string, err: unknown, meta: Record<string, unknown> = {}): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(msg, { ...meta, message: e.message, stack: e.stack });
}
