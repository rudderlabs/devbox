import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { InboxRow, ReplyTarget } from "../../../repositories/inbox.repository";
import type { SendCtx } from "../../outbound";

mock.module("../../../config", () => ({ config: { gitlab: {} } }));

const postMrNote = mock(() => Promise.resolve({ id: 1 }));
const postDiscussionNote = mock(() => Promise.resolve({ id: 2 }));
const findDiscussionIdForNote = mock(() => Promise.resolve(null as string | null));
const awardNoteEmoji = mock(() => Promise.resolve());
mock.module("../../../clients/gitlab", () => ({
  postMrNote,
  postDiscussionNote,
  findDiscussionIdForNote,
  awardNoteEmoji,
  gitlabTokenState: () => ({ configured: false, source: null, readAt: null, lastError: null }),
  fetchGroupMembers: mock(() => Promise.resolve(new Set())),
  getUserIdByUsername: mock(() => Promise.resolve(null)),
  listOpenMergeRequestsForBranch: mock(() => Promise.resolve([])),
  mrWebUrl: (u: string, i: number) => `${u}/-/merge_requests/${i}`,
  parseMrUrl: () => null,
}));

const { GitlabIntegration } = await import("../index");
const { WORKSPACE_MISSING_MESSAGE } = await import("../../../services/inbox.service");
const { HttpError } = await import("../../http");
const { RetryableError } = await import("../../outbound");

const ctx: SendCtx = {
  signal: new AbortController().signal,
  log: { info() {}, warn() {}, error() {}, debug() {} } as never,
};
const noteTarget = (over: Record<string, unknown> = {}): ReplyTarget => ({
  id: "901",
  spec: { kind: "mr_note", projectId: 55, project: "platform/api", mrIid: 3, noteId: 901, ...over },
});
const row = (kind: InboxRow["kind"], targets: ReplyTarget[]): InboxRow =>
  ({ id: "row-1", source: "gitlab", kind, reply_targets: targets }) as unknown as InboxRow;

describe("GitlabIntegration.deliver", () => {
  const gitlab = new GitlabIntegration(true, { ciResults: true, botUsername: "devbox-bot" });

  beforeEach(() => {
    for (const m of [postMrNote, postDiscussionNote, findDiscussionIdForNote, awardNoteEmoji]) {
      m.mockReset();
    }
    postMrNote.mockResolvedValue({ id: 1 });
    postDiscussionNote.mockResolvedValue({ id: 2 });
    findDiscussionIdForNote.mockResolvedValue(null);
    awardNoteEmoji.mockResolvedValue(undefined);
  });

  it("replies inside the note's discussion when the webhook named it", async () => {
    await gitlab.deliver(ctx, noteTarget({ discussionId: "d1" }), { type: "reply", body: "done" });
    expect(postDiscussionNote).toHaveBeenCalledWith(55, 3, "d1", "done", ctx.signal);
    expect(findDiscussionIdForNote).not.toHaveBeenCalled();
    expect(postMrNote).not.toHaveBeenCalled();
  });

  it("looks the discussion up when the webhook did not name it, and falls back to a new note", async () => {
    findDiscussionIdForNote.mockResolvedValue("d9");
    await gitlab.deliver(ctx, noteTarget(), { type: "reply", body: "done" });
    expect(findDiscussionIdForNote).toHaveBeenCalledWith(55, 3, 901, ctx.signal);
    expect(postDiscussionNote).toHaveBeenCalledWith(55, 3, "d9", "done", ctx.signal);

    findDiscussionIdForNote.mockResolvedValue(null);
    await gitlab.deliver(ctx, noteTarget(), { type: "reply", body: "again" });
    expect(postMrNote).toHaveBeenCalledWith(55, 3, "again", ctx.signal);
  });

  it("a diff note's reply threads under its discussion", async () => {
    const target: ReplyTarget = {
      id: "902",
      spec: {
        kind: "mr_diff_note",
        projectId: 55,
        project: "platform/api",
        mrIid: 3,
        noteId: 902,
        discussionId: "diff-1",
        path: "app.py",
        line: 4,
      },
    };
    await gitlab.deliver(ctx, target, { type: "reply", body: "fixed" });
    expect(postDiscussionNote).toHaveBeenCalledWith(55, 3, "diff-1", "fixed", ctx.signal);
  });

  it("a CI result's target (noteId 0) posts a new top-level note", async () => {
    await gitlab.deliver(
      ctx,
      { id: "7001", spec: { ...noteTarget().spec, noteId: 0 } as never },
      {
        type: "reply",
        body: "ci fixed",
      },
    );
    expect(postMrNote).toHaveBeenCalledWith(55, 3, "ci fixed", ctx.signal);
    expect(findDiscussionIdForNote).not.toHaveBeenCalled();
  });

  it("drops progress", async () => {
    await gitlab.deliver(ctx, noteTarget(), { type: "progress", kind: "thought", body: "hmm" });
    expect(postMrNote).not.toHaveBeenCalled();
    expect(postDiscussionNote).not.toHaveBeenCalled();
  });

  it("a crashed comment round posts the retry hint; a crashed CI round stays silent", async () => {
    const target = noteTarget({ discussionId: "d1" });
    await gitlab.deliver(ctx, target, {
      type: "failure",
      cause: "round_failed",
      round: row("comment", [target]),
      detail: "Traceback …",
    });
    expect(postDiscussionNote).toHaveBeenCalledWith(
      55,
      3,
      "d1",
      "⚠️ Something went wrong while working on this. Mention @devbox-bot in a new comment to retry.",
      ctx.signal,
    );
    postDiscussionNote.mockClear();
    const ci: ReplyTarget = { id: "7001", spec: { ...noteTarget().spec, noteId: 0 } as never };
    await gitlab.deliver(ctx, ci, {
      type: "failure",
      cause: "round_failed",
      round: row("ci_result", [ci]),
      detail: "x",
    });
    expect(postMrNote).not.toHaveBeenCalled();
    expect(postDiscussionNote).not.toHaveBeenCalled();
  });

  it("a failed task posts its user-safe summary", async () => {
    const target = noteTarget({ discussionId: "d1" });
    await gitlab.deliver(ctx, target, {
      type: "failure",
      cause: "task_failed",
      round: row("comment", [target]),
      summary: "The task failed: tests did not pass.",
    });
    expect(postDiscussionNote).toHaveBeenCalledWith(
      55,
      3,
      "d1",
      "The task failed: tests did not pass.",
      ctx.signal,
    );
  });

  it("a missing workspace answers a note with the message and 😕, a CI result silently", async () => {
    const target = noteTarget({ discussionId: "d1" });
    await gitlab.deliver(ctx, target, {
      type: "failure",
      cause: "workspace_missing",
      round: row("comment", [target]),
    });
    expect(postDiscussionNote).toHaveBeenCalledWith(
      55,
      3,
      "d1",
      WORKSPACE_MISSING_MESSAGE,
      ctx.signal,
    );
    expect(awardNoteEmoji).toHaveBeenCalledWith(55, 3, 901, "confused", ctx.signal);
    awardNoteEmoji.mockClear();
    postMrNote.mockClear();
    const ci: ReplyTarget = { id: "7001", spec: { ...noteTarget().spec, noteId: 0 } as never };
    await gitlab.deliver(ctx, ci, {
      type: "failure",
      cause: "workspace_missing",
      round: row("ci_result", [ci]),
    });
    expect(postMrNote).not.toHaveBeenCalled();
    expect(awardNoteEmoji).not.toHaveBeenCalled();
  });

  it("a rate limit before anything was posted is a RetryableError", async () => {
    postDiscussionNote.mockRejectedValue(new HttpError("GitLab POST failed: HTTP 429", 429, 5000));
    await expect(
      gitlab.deliver(ctx, noteTarget({ discussionId: "d1" }), { type: "reply", body: "x" }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it("refuses another integration's target", async () => {
    await expect(
      gitlab.deliver(
        ctx,
        { id: "x", spec: { kind: "linear_session" } },
        { type: "reply", body: "x" },
      ),
    ).rejects.toThrow("gitlab cannot deliver to a linear_session target");
  });
});

describe("GitlabIntegration.status", () => {
  it("reports webhooks off without a controller, on with its last delivery", async () => {
    const off = new GitlabIntegration(false, { ciResults: false, botUsername: undefined });
    expect(await off.status()).toEqual({
      token: { configured: false, source: null, readAt: null, lastError: null },
      webhooks: { enabled: false, lastWebhookAt: null, ciResults: false },
    });
    const on = new GitlabIntegration(true, { ciResults: true, botUsername: "devbox-bot" });
    on.controller = {
      handleWebhook: async () => new Response(),
      lastWebhookAt: () => "2026-11-03T00:00:00.000Z",
    };
    expect((await on.status()).webhooks).toEqual({
      enabled: true,
      lastWebhookAt: "2026-11-03T00:00:00.000Z",
      ciResults: true,
    });
  });
});
