import type { Context } from "hono";
import {
  awardNoteEmoji,
  findDiscussionIdForNote,
  gitlabTokenState,
  parseMrUrl,
  postDiscussionNote,
  postMrNote,
} from "../../clients/gitlab";
import type { Task } from "../../db/schema";
import { retryable } from "../http";
import type { Outbound, SendCtx } from "../outbound";
import type {
  Integration,
  IntegrationDefinition,
  PrOpenedCtx,
  PrRef,
  ReplyTarget,
  Round,
} from "../types";
import { type GitlabConfig, parseGitlabConfig } from "./config";
import { type GitlabSpec, isGitlabSpec } from "./rounds";
import { type GitlabStatus, GitlabStatusService } from "./status";
import { GitlabWebhookController } from "./webhook";

// GitLab creates no tasks: its rounds come only from its webhooks, so it is
// enabled exactly when they are, and disabling them skips open rounds' replies.
// Its status always reports the control plane's own GitLab token.
export const gitlab: IntegrationDefinition<GitlabConfig> = {
  name: "gitlab",
  createsTasks: false,
  parseConfig: parseGitlabConfig,
  create(core, cfg) {
    const controller = new GitlabWebhookController(core.tasks, cfg, core.log);
    const status = new GitlabStatusService(gitlabTokenState, {
      enabled: true,
      ciResults: cfg.ciResultEnabled,
      lastWebhookAt: () => controller.lastWebhookAt(),
    });
    return new GitlabIntegration(cfg, status, controller);
  },
  disabledStatus: () =>
    new GitlabStatusService(gitlabTokenState, {
      enabled: false,
      ciResults: false,
      lastWebhookAt: () => null,
    }).status(),
};

// GitLab rounds (notes and CI results) post on the merge request. A merge
// request shows no live progress and may be public: a failure's raw detail
// never goes there.
export class GitlabIntegration implements Integration {
  // Its webhooks turn @-mentions of the bot into rounds.
  private readonly botUsername: string;

  constructor(
    cfg: Pick<GitlabConfig, "botUsername">,
    private statusService: Pick<GitlabStatusService, "status">,
    private controller: Pick<GitlabWebhookController, "handleWebhook">,
  ) {
    this.botUsername = cfg.botUsername;
  }

  // Today's responses: 401 for a bad signature, 403 for untrusted actors, 503
  // when the trusted set can't be fetched. The controller holds its TaskService.
  webhook(c: Context): Promise<Response> {
    return this.controller.handleWebhook(c);
  }

  async status(): Promise<GitlabStatus> {
    return this.statusService.status();
  }

  // Merge requests on the configured instance are GitLab's: core hands it
  // each new one.
  hostsPr(url: string): boolean {
    return parseMrUrl(url) !== null;
  }

  // The agent opened a merge request on the instance (core calls this as the
  // merge request's code host's integration, once per merge request): the
  // onboarding note. This runs only while GitLab is on, which is while its
  // webhooks take @-mentions. The project goes by its path, all a merge
  // request URL carries. A failure is the registry's to log.
  //
  // No assignee: nothing links the task's person to a GitLab account (Linear
  // links GitHub accounts only), so ctx.person() is not asked.
  async onPrOpened(ctx: PrOpenedCtx, task: Task, pr: PrRef): Promise<void> {
    if (!ctx.firstTime) return;
    const mr = parseMrUrl(pr.url);
    if (!mr) return;
    await postMrNote(
      mr.project,
      mr.mrIid,
      onboardingNoteBody(this.botUsername, task.key),
      ctx.signal,
    );
  }

  async deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void> {
    // Anything else isn't a GitLab target (a malformed or foreign row): the
    // error is logged and the send dropped.
    const spec = target.spec;
    if (!isGitlabSpec(spec)) throw new Error("not a GitLab merge request target");
    switch (message.type) {
      case "reply":
        await post(ctx, spec, message.body);
        return;
      case "progress":
        return;
      case "failure":
        await deliverFailure(ctx, spec, message, this.botUsername);
        return;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }
}

// GitLab delivers each note on its own (there is no review summary), so the
// text asks for one note that says everything.
function onboardingNoteBody(botUsername: string, taskKey: string): string {
  return [
    `👋 I'm **${botUsername}**. I opened this merge request from task \`${taskKey}\`.`,
    "",
    `Mention \`@${botUsername}\` in a comment here or on a line of the diff and I'll act on it.`,
    "Each comment is handled on its own, so put everything into one. Without a mention I won't see it.",
  ].join("\n");
}

async function deliverFailure(
  ctx: SendCtx,
  spec: GitlabSpec,
  message: Extract<Outbound, { type: "failure" }>,
  botUsername: string,
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
      // The retry hint is an @-mention, which the webhooks turn into a round.
      await post(
        ctx,
        spec,
        `⚠️ Something went wrong while working on this. Mention @${botUsername} in a new comment to retry.`,
      );
      return;
    }
    case "workspace_missing":
      if (message.summary) await workspaceMissing(ctx, spec, round, message.summary);
      return;
  }
}

// One notice per round: a note gets a reply plus 😕. A CI result is
// informational and dead-lettered silently.
async function workspaceMissing(
  ctx: SendCtx,
  spec: GitlabSpec,
  round: Round,
  text: string,
): Promise<void> {
  if (round.kind !== "comment") return;
  try {
    await post(ctx, spec, text);
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
