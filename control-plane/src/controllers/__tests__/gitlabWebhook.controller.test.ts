import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { Task } from "../../db/schema";
import type { TaskIntake } from "../../integrations/intake";
import type { GitlabWebhooksConfig } from "../../integrationsConfig";
import type { InboxService } from "../../services/inbox.service";

mock.module("../../config", () => ({
  config: { podId: "pod-test", github: {}, gitlab: { baseUrl: "https://gitlab.example.com" } },
}));

// The signing token GitLab shows once: whsec_ + base64 key.
const KEY = Buffer.from("gitlab-test-signing-key");
const SIGNING_TOKEN = `whsec_${KEY.toString("base64")}`;
const SECRET_TOKEN = "legacy-secret";

const SETTINGS: GitlabWebhooksConfig = {
  signingToken: SIGNING_TOKEN,
  secretToken: undefined,
  botUserId: 7,
  botUsername: "devbox-bot",
  trustedGroups: ["platform"],
  trustedUsers: [],
};

const fetchGroupMembers = mock(() => Promise.resolve(new Set([1, 2, 3])));
const getUserIdByUsername = mock((_u: string) => Promise.resolve(null as number | null));
const awardNoteEmoji = mock(() => Promise.resolve());
const listOpenMergeRequestsForBranch = mock(() =>
  Promise.resolve([] as Array<{ iid: number; webUrl: string }>),
);
// The whole barrel, as the GitHub controller test does; the suite runs with
// --isolate so this cannot leak.
mock.module("../../clients/gitlab", () => ({
  fetchGroupMembers,
  getUserIdByUsername,
  awardNoteEmoji,
  listOpenMergeRequestsForBranch,
  mrWebUrl: (webUrl: string, iid: number) => `${webUrl}/-/merge_requests/${iid}`,
  postMrNote: mock(() => Promise.resolve({ id: 1 })),
  postDiscussionNote: mock(() => Promise.resolve({ id: 1 })),
  findDiscussionIdForNote: mock(() => Promise.resolve(null)),
  gitlabTokenState: () => ({ configured: true }),
  parseMrUrl: () => null,
}));

const { GitlabWebhookController, parseGitlabEvent, verifyGitlabSignature, SIGNATURE_TOLERANCE_MS } =
  await import("../gitlabWebhook.controller");
const { mentionRegex } = await import("../githubWebhook.controller");

const parse = (event: string | undefined, payload: unknown) =>
  parseGitlabEvent(event, payload, mentionRegex(SETTINGS.botUsername));

const PROJECT = {
  id: 55,
  path_with_namespace: "platform/backend/api",
  web_url: "https://gitlab.example.com/platform/backend/api",
};
const MR_URL = "https://gitlab.example.com/platform/backend/api/-/merge_requests/3";

const notePayload = (
  over: {
    user?: { id: number; username: string };
    note?: Record<string, unknown>;
    mergeRequest?: Record<string, unknown>;
  } = {},
) => ({
  object_kind: "note",
  event_type: "note",
  user: over.user ?? { id: 1, username: "alice" },
  project: PROJECT,
  object_attributes: {
    id: 901,
    note: "@devbox-bot please fix this",
    noteable_type: "MergeRequest",
    author_id: over.user?.id ?? 1,
    created_at: "2026-11-03T10:00:00Z",
    action: "create",
    ...over.note,
  },
  merge_request: { id: 500, iid: 3, author_id: 7, source_branch: "devbox/x", ...over.mergeRequest },
});

const pipelinePayload = (
  over: Record<string, unknown> = {},
  mergeRequest: unknown = undefined,
) => ({
  object_kind: "pipeline",
  user: { id: 7, username: "devbox-bot" },
  project: PROJECT,
  object_attributes: {
    id: 7001,
    iid: 12,
    ref: "devbox/x",
    sha: "abc123",
    source: "merge_request_event",
    status: "failed",
    url: "https://gitlab.example.com/platform/backend/api/-/pipelines/7001",
    ...over,
  },
  ...(mergeRequest !== undefined ? { merge_request: mergeRequest } : {}),
  builds: [{ id: 1, name: "test", stage: "test", status: "failed" }],
});

describe("parseGitlabEvent", () => {
  it("a merge request note mentioning the bot → comment on the note's thread", () => {
    const parsed = parse("Note Hook", notePayload({ note: { discussion_id: "d1" } }));
    expect(parsed).toEqual({
      kind: "comment",
      userId: 1,
      username: "alice",
      project: { id: 55, path: "platform/backend/api", webUrl: PROJECT.web_url },
      mrIid: 3,
      mrAuthorId: 7,
      mrUrl: MR_URL,
      noteId: 901,
      body: "@devbox-bot please fix this",
      createdAt: "2026-11-03T10:00:00Z",
      spec: {
        kind: "mr_note",
        projectId: 55,
        project: "platform/backend/api",
        mrIid: 3,
        noteId: 901,
        discussionId: "d1",
      },
    });
  });

  it("a diff note keeps its file and line", () => {
    const parsed = parse(
      "Note Hook",
      notePayload({
        note: {
          type: "DiffNote",
          discussion_id: "d2",
          position: { new_path: "app.py", old_path: "app.py", new_line: 12, old_line: null },
        },
      }),
    );
    expect(parsed?.kind === "comment" && parsed.spec).toEqual({
      kind: "mr_diff_note",
      projectId: 55,
      project: "platform/backend/api",
      mrIid: 3,
      noteId: 901,
      discussionId: "d2",
      path: "app.py",
      line: 12,
    });
  });

  it("drops notes without a mention, edits, system notes and notes on other objects", () => {
    expect(parse("Note Hook", notePayload({ note: { note: "looks good" } }))).toBeNull();
    expect(parse("Note Hook", notePayload({ note: { action: "update" } }))).toBeNull();
    expect(parse("Note Hook", notePayload({ note: { system: true } }))).toBeNull();
    expect(parse("Note Hook", notePayload({ note: { noteable_type: "Issue" } }))).toBeNull();
  });

  it("does not trigger on a longer username that starts with the bot's", () => {
    expect(parse("Note Hook", notePayload({ note: { note: "@devbox-bot2 fix" } }))).toBeNull();
  });

  it("a failed pipeline for a merge request → pipeline", () => {
    const parsed = parse(
      "Pipeline Hook",
      pipelinePayload({}, { iid: 3, source_branch: "devbox/x" }),
    );
    expect(parsed).toEqual({
      kind: "pipeline",
      userId: 7,
      project: { id: 55, path: "platform/backend/api", webUrl: PROJECT.web_url },
      pipelineId: 7001,
      pipelineIid: 12,
      name: "Pipeline #12",
      status: "failed",
      ref: "devbox/x",
      sha: "abc123",
      url: "https://gitlab.example.com/platform/backend/api/-/pipelines/7001",
      mrIid: 3,
    });
  });

  it("a failed branch pipeline names no merge request; a passing one is noise", () => {
    const parsed = parse("Pipeline Hook", pipelinePayload({ source: "push" }));
    expect(parsed?.kind === "pipeline" && parsed.mrIid).toBeNull();
    expect(parse("Pipeline Hook", pipelinePayload({ status: "success" }))).toBeNull();
  });

  it("ignores merge request and unknown events", () => {
    expect(parse("Merge Request Hook", { project: PROJECT, object_attributes: {} })).toBeNull();
    expect(parse("Push Hook", { project: PROJECT })).toBeNull();
    expect(parse(undefined, notePayload())).toBeNull();
  });
});

describe("verifyGitlabSignature", () => {
  const now = 1_700_000_000_000;
  const sign = (id: string, ts: string, body: string, key = KEY) =>
    `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
  const ts = String(Math.floor(now / 1000));

  it("accepts a valid v1 signature over id.timestamp.body", () => {
    const body = '{"a":1}';
    expect(
      verifyGitlabSignature(
        body,
        { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) },
        SIGNING_TOKEN,
        now,
      ),
    ).toBe("ok");
  });

  it("accepts any one of several space-separated signatures", () => {
    const body = "{}";
    const other = sign("msg_1", ts, body, Buffer.from("rotated-away"));
    const good = sign("msg_1", ts, body);
    expect(
      verifyGitlabSignature(
        body,
        { id: "msg_1", timestamp: ts, signature: `${other} ${good}` },
        SIGNING_TOKEN,
        now,
      ),
    ).toBe("ok");
  });

  it("rejects a tampered body, a wrong key, a stale timestamp and missing headers", () => {
    const body = "{}";
    const good = sign("msg_1", ts, body);
    expect(
      verifyGitlabSignature(
        "{ }",
        { id: "msg_1", timestamp: ts, signature: good },
        SIGNING_TOKEN,
        now,
      ),
    ).toBe("mismatch");
    expect(
      verifyGitlabSignature(
        body,
        { id: "msg_1", timestamp: ts, signature: good },
        `whsec_${Buffer.from("other").toString("base64")}`,
        now,
      ),
    ).toBe("mismatch");
    const old = String(Math.floor((now - SIGNATURE_TOLERANCE_MS - 1000) / 1000));
    expect(
      verifyGitlabSignature(
        body,
        { id: "msg_1", timestamp: old, signature: sign("msg_1", old, body) },
        SIGNING_TOKEN,
        now,
      ),
    ).toBe("stale");
    expect(
      verifyGitlabSignature(
        body,
        { id: undefined, timestamp: ts, signature: good },
        SIGNING_TOKEN,
        now,
      ),
    ).toBe("missing");
  });
});

describe("GitlabWebhookController.handleWebhook", () => {
  const task = { id: "task-1", key: "XYZ-1", source: "api" } as unknown as Task;
  let enqueueGitlabComment: ReturnType<typeof mock>;
  let enqueueGitlabCiResult: ReturnType<typeof mock>;
  let findTaskByPrUrl: ReturnType<typeof mock>;
  let app: Hono;
  const now = 1_700_000_000_000;

  const build = (settings = SETTINGS, ciResultEnabled = true) => {
    enqueueGitlabComment = mock(() => Promise.resolve());
    enqueueGitlabCiResult = mock(() => Promise.resolve());
    findTaskByPrUrl = mock(() => Promise.resolve(task));
    fetchGroupMembers.mockReset();
    fetchGroupMembers.mockResolvedValue(new Set([1, 2, 3]));
    getUserIdByUsername.mockReset();
    getUserIdByUsername.mockResolvedValue(null);
    awardNoteEmoji.mockReset();
    awardNoteEmoji.mockResolvedValue(undefined);
    listOpenMergeRequestsForBranch.mockReset();
    listOpenMergeRequestsForBranch.mockResolvedValue([]);
    const controller = new GitlabWebhookController(
      { enqueueGitlabComment, enqueueGitlabCiResult } as unknown as InboxService,
      { findTaskByPrUrl } as unknown as TaskIntake,
      settings,
      { ciResultEnabled },
      () => now,
    );
    const a = new Hono();
    a.post("/webhook/gitlab", (c) => controller.handleWebhook(c));
    return { a, controller };
  };

  beforeEach(() => {
    app = build().a;
  });

  const signed = (body: string, key = KEY) => {
    const ts = String(Math.floor(now / 1000));
    return {
      "webhook-id": "msg_1",
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${createHmac("sha256", key).update(`msg_1.${ts}.${body}`).digest("base64")}`,
    };
  };
  const post = (payload: unknown, event: string, headers: Record<string, string>) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return app.request("/webhook/gitlab", {
      method: "POST",
      headers: { "x-gitlab-event": event, "content-type": "application/json", ...headers },
      body,
    });
  };
  const postSigned = (payload: unknown, event = "Note Hook") => {
    const body = JSON.stringify(payload);
    return post(body, event, signed(body));
  };

  it("returns 401 on a missing or bad signature", async () => {
    expect((await post(notePayload(), "Note Hook", {})).status).toBe(401);
    const body = JSON.stringify(notePayload());
    expect((await post(body, "Note Hook", signed(body, Buffer.from("wrong")))).status).toBe(401);
    expect(enqueueGitlabComment).not.toHaveBeenCalled();
  });

  it("with only a legacy secret token, compares X-Gitlab-Token", async () => {
    app = build({ ...SETTINGS, signingToken: undefined, secretToken: SECRET_TOKEN }).a;
    expect((await post(notePayload(), "Note Hook", { "x-gitlab-token": "nope" })).status).toBe(401);
    const ok = await post(notePayload(), "Note Hook", { "x-gitlab-token": SECRET_TOKEN });
    expect(ok.status).toBe(200);
    expect(enqueueGitlabComment).toHaveBeenCalledTimes(1);
  });

  it("with both tokens, a signed delivery must verify; an unsigned one falls back to the secret", async () => {
    app = build({ ...SETTINGS, secretToken: SECRET_TOKEN }).a;
    const body = JSON.stringify(notePayload());
    // A signature is present but wrong: the secret token does not rescue it.
    expect(
      (
        await post(body, "Note Hook", {
          ...signed(body, Buffer.from("wrong")),
          "x-gitlab-token": SECRET_TOKEN,
        })
      ).status,
    ).toBe(401);
    expect((await post(body, "Note Hook", { "x-gitlab-token": SECRET_TOKEN })).status).toBe(200);
  });

  it("returns 400 on invalid JSON", async () => {
    const body = "{not json";
    expect((await post(body, "Note Hook", signed(body))).status).toBe(400);
  });

  it("enqueues a mentioning note from a trusted group member and awards 👀", async () => {
    const res = await postSigned(notePayload({ note: { discussion_id: "d1" } }));
    expect(res.status).toBe(200);
    expect(findTaskByPrUrl).toHaveBeenCalledWith(MR_URL);
    expect(enqueueGitlabComment).toHaveBeenCalledWith({
      task,
      noteId: 901,
      body: "@devbox-bot please fix this",
      spec: {
        kind: "mr_note",
        projectId: 55,
        project: "platform/backend/api",
        mrIid: 3,
        noteId: 901,
        discussionId: "d1",
      },
      project: "platform/backend/api",
      prUrl: MR_URL,
      createdAt: "2026-11-03T10:00:00Z",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(awardNoteEmoji).toHaveBeenCalledWith(55, 3, 901, "eyes");
  });

  it("rejects a note from a user outside the trusted set with 403", async () => {
    const res = await postSigned(notePayload({ user: { id: 99, username: "outsider" } }));
    expect(res.status).toBe(403);
    expect(enqueueGitlabComment).not.toHaveBeenCalled();
  });

  it("trusts a configured username by its resolved id", async () => {
    app = build({ ...SETTINGS, trustedGroups: [], trustedUsers: ["carol"] }).a;
    getUserIdByUsername.mockResolvedValue(42);
    expect((await postSigned(notePayload({ user: { id: 42, username: "carol" } }))).status).toBe(
      200,
    );
    expect((await postSigned(notePayload({ user: { id: 1, username: "alice" } }))).status).toBe(
      403,
    );
  });

  it("returns 503 when the trusted set cannot be fetched, and retries on the next delivery", async () => {
    fetchGroupMembers.mockRejectedValueOnce(new Error("boom"));
    expect((await postSigned(notePayload())).status).toBe(503);
    expect((await postSigned(notePayload())).status).toBe(200);
    expect(fetchGroupMembers).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a trusted group has no members", async () => {
    fetchGroupMembers.mockResolvedValue(new Set<number>());
    expect((await postSigned(notePayload())).status).toBe(503);
  });

  it("ignores the bot's own notes and notes on merge requests it did not open, before trust or DB work", async () => {
    const self = await postSigned(notePayload({ user: { id: 7, username: "devbox-bot" } }));
    expect(self.status).toBe(200);
    expect(await self.json()).toEqual({ status: "ignored", reason: "bot self-event" });
    const human = await postSigned(notePayload({ mergeRequest: { author_id: 1 } }));
    expect(await human.json()).toEqual({
      status: "ignored",
      reason: "merge request not opened by bot",
    });
    expect(fetchGroupMembers).not.toHaveBeenCalled();
    expect(findTaskByPrUrl).not.toHaveBeenCalled();
  });

  it("ignores a note whose merge request maps to no task", async () => {
    findTaskByPrUrl.mockResolvedValue(null);
    expect(await (await postSigned(notePayload())).json()).toEqual({ status: "ignored" });
    expect(enqueueGitlabComment).not.toHaveBeenCalled();
  });

  it("ignores unhandled events and notes without a mention", async () => {
    expect(await (await postSigned({ project: PROJECT }, "Merge Request Hook")).json()).toEqual({
      status: "ignored",
    });
    expect(await (await postSigned(notePayload({ note: { note: "nice" } }))).json()).toEqual({
      status: "ignored",
    });
  });

  it("enqueues a ci_result for a failed merge request pipeline, the bot's own push allowed", async () => {
    const res = await postSigned(
      pipelinePayload({}, { iid: 3, source_branch: "devbox/x" }),
      "Pipeline Hook",
    );
    expect(res.status).toBe(200);
    expect(fetchGroupMembers).not.toHaveBeenCalled();
    expect(findTaskByPrUrl).toHaveBeenCalledWith(MR_URL);
    expect(enqueueGitlabCiResult).toHaveBeenCalledWith({
      task,
      pipelineId: 7001,
      name: "Pipeline #12",
      status: "failed",
      url: "https://gitlab.example.com/platform/backend/api/-/pipelines/7001",
      sha: "abc123",
      ref: "devbox/x",
      projectId: 55,
      project: "platform/backend/api",
      mrIid: 3,
      prUrl: MR_URL,
    });
  });

  it("a branch pipeline is matched to the open merge requests of its branch", async () => {
    listOpenMergeRequestsForBranch.mockResolvedValue([{ iid: 3, webUrl: MR_URL }]);
    const res = await postSigned(pipelinePayload({ source: "push" }), "Pipeline Hook");
    expect(res.status).toBe(200);
    expect(listOpenMergeRequestsForBranch).toHaveBeenCalledWith(55, "devbox/x");
    expect(enqueueGitlabCiResult).toHaveBeenCalledTimes(1);
    expect((enqueueGitlabCiResult.mock.calls[0] as unknown[])[0]).toMatchObject({ mrIid: 3 });
  });

  it("a pipeline run by an untrusted user is rejected; ci_result off ignores it", async () => {
    const outsider = {
      ...pipelinePayload({}, { iid: 3 }),
      user: { id: 99, username: "outsider" },
    };
    expect((await postSigned(outsider, "Pipeline Hook")).status).toBe(403);
    app = build(SETTINGS, false).a;
    expect(
      await (await postSigned(pipelinePayload({}, { iid: 3 }), "Pipeline Hook")).json(),
    ).toEqual({ status: "ignored", reason: "ci_result disabled" });
    expect(enqueueGitlabCiResult).not.toHaveBeenCalled();
  });

  it("returns 500 when the enqueue fails", async () => {
    enqueueGitlabComment.mockRejectedValue(new Error("db down"));
    expect((await postSigned(notePayload())).status).toBe(500);
  });

  it("records the time of the last verified delivery", async () => {
    const { a, controller } = build();
    app = a;
    expect(controller.lastWebhookAt()).toBeNull();
    await postSigned(notePayload());
    expect(controller.lastWebhookAt()).toBe(new Date(now).toISOString());
  });
});
