import type { Context } from "hono";
import {
  awardNoteEmoji,
  findDiscussionIdForNote,
  gitlabTokenState,
  postDiscussionNote,
  postMrNote,
} from "../../clients/gitlab";
import type { GitlabTokenState } from "../../clients/gitlabToken";
import type { GitlabWebhookController } from "../../controllers/gitlabWebhook.controller";
import type { InboxRow, ReplyTarget, ReplyTargetSpec } from "../../repositories/inbox.repository";
import { WORKSPACE_MISSING_MESSAGE } from "../../services/inbox.service";
import { retryable } from "../http";
import type { Outbound, SendCtx } from "../outbound";
import type { Integration } from "../types";

type GitlabSpec = Extract<ReplyTargetSpec, { kind: "mr_note" | "mr_diff_note" }>;

export type GitlabStatus = {
  token: GitlabTokenState;
  webhooks: { enabled: boolean; lastWebhookAt: string | null; ciResults: boolean };
};

// GitLab rounds (notes and CI results) post on the merge request. A merge
// request shows no live progress and may be public: a failure's raw detail
// never goes there. GitLab creates no tasks: its rounds come only from its
// webhooks, so it is enabled exactly when they are.
export class GitlabIntegration implements Integration<GitlabStatus> {
  readonly name = "gitlab";
  // Today's webhook controller; app.ts attaches it afterwards (only when enabled).
  controller?: Pick<GitlabWebhookController, "handleWebhook" | "lastWebhookAt">;

  constructor(
    // GITLAB_WEBHOOKS_ENABLED.
    readonly enabled: boolean,
    private readonly settings: { ciResults: boolean; botUsername: string | undefined },
  ) {}

  async webhook(c: Context): Promise<Response> {
    if (!this.controller) return c.notFound();
    return this.controller.handleWebhook(c);
  }

  async status(): Promise<GitlabStatus> {
    return {
      token: gitlabTokenState(),
      webhooks: this.enabled
        ? {
            enabled: true,
            lastWebhookAt: this.controller?.lastWebhookAt() ?? null,
            ciResults: this.settings.ciResults,
          }
        : { enabled: false, lastWebhookAt: null, ciResults: false },
    };
  }

  async deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void> {
    const spec = target.spec;
    if (spec.kind !== "mr_note" && spec.kind !== "mr_diff_note") {
      throw new Error(`gitlab cannot deliver to a ${spec.kind} target`);
    }
    switch (message.type) {
      case "reply":
        await post(ctx, spec, message.body);
        return;
      case "progress":
        return;
      case "failure":
        await this.deliverFailure(ctx, spec, message);
        return;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  private async deliverFailure(
    ctx: SendCtx,
    spec: GitlabSpec,
    message: Extract<Outbound, { type: "failure" }>,
  ): Promise<void> {
    const { round } = message;
    switch (message.cause) {
      case "task_failed":
        // failTask's message is control-plane-generated and scrubbed: public-safe.
        if (message.summary) await post(ctx, spec, message.summary);
        return;
      case "round_failed": {
        // A failed CI-fix round stays silent.
        if (round.kind === "ci_result") return;
        const bot = this.settings.botUsername;
        if (!bot) return;
        await post(
          ctx,
          spec,
          `⚠️ Something went wrong while working on this. Mention @${bot} in a new comment to retry.`,
        );
        return;
      }
      case "workspace_missing":
        await workspaceMissing(ctx, spec, round);
        return;
    }
  }
}

// One notice per round: a note gets a reply plus 😕. A CI result is
// informational and dead-lettered silently.
async function workspaceMissing(ctx: SendCtx, spec: GitlabSpec, round: InboxRow): Promise<void> {
  if (round.kind !== "comment") return;
  try {
    await post(ctx, spec, WORKSPACE_MISSING_MESSAGE);
  } finally {
    // The reaction is independent of the reply: try it even if the reply failed.
    if (spec.noteId > 0) {
      await awardNoteEmoji(spec.projectId, spec.mrIid, spec.noteId, "confused", ctx.signal).catch(
        (err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          ctx.log.error("workspace_missing award failed", { message: e.message, stack: e.stack });
        },
      );
    }
  }
}

// Posts `body` verbatim on the merge request: in the note's thread when the
// note has one (looked up when the webhook did not say), else as a new
// top-level note. noteId 0 (a CI result) always posts a new note. The thread
// lookup is a read, so a retryable failure before the write still means
// nothing was posted.
async function post(ctx: SendCtx, spec: GitlabSpec, body: string): Promise<void> {
  const { signal } = ctx;
  try {
    if (spec.noteId === 0) {
      await postMrNote(spec.projectId, spec.mrIid, body, signal);
      return;
    }
    const discussionId =
      spec.discussionId ??
      (await findDiscussionIdForNote(spec.projectId, spec.mrIid, spec.noteId, signal));
    if (discussionId) {
      await postDiscussionNote(spec.projectId, spec.mrIid, discussionId, body, signal);
    } else {
      ctx.log.warn("gitlab note has no discussion; posting a top-level note", {
        project: spec.project,
        mrIid: spec.mrIid,
        noteId: spec.noteId,
      });
      await postMrNote(spec.projectId, spec.mrIid, body, signal);
    }
  } catch (err) {
    throw retryable(err) ?? err;
  }
}
