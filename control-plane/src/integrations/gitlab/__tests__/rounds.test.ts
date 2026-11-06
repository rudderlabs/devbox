import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Task } from "../../../db/schema";
import { logger } from "../../../logger";
import type { TaskService } from "../../../services/task.service";
import { enqueueCiResult, enqueueComment, isGitlabSpec } from "../rounds";

const task = { id: "task-1", key: "XYZ-1" } as Pick<Task, "id" | "key">;
const MR_URL = "https://gitlab.example.com/platform/backend/api/-/merge_requests/3";

// Each builder queues through GitLab's TaskService, which stamps the source
// and the task identity.
describe("GitLab rounds", () => {
  let enqueueRound: ReturnType<typeof mock>;
  let tasks: Pick<TaskService, "enqueueRound">;

  beforeEach(() => {
    enqueueRound = mock(() => Promise.resolve({ roundId: "inbox-new" }));
    tasks = { enqueueRound } as unknown as Pick<TaskService, "enqueueRound">;
  });

  it("queues a comment round routed to the note's thread, with a diff note's anchor", async () => {
    const spec = {
      kind: "mr_diff_note" as const,
      projectId: 55,
      project: "platform/backend/api",
      mrIid: 3,
      noteId: 901,
      discussionId: "abc",
      path: "app.py",
      line: 12,
    };
    await enqueueComment(tasks, {
      task,
      noteId: 901,
      body: "@devbox-bot fix this",
      spec,
      project: "platform/backend/api",
      prUrl: MR_URL,
      createdAt: "2026-11-03T10:00:00Z",
    });
    expect(enqueueRound).toHaveBeenCalledWith({
      task,
      kind: "comment",
      externalId: "901",
      payload: {
        target_id: "901",
        body: "@devbox-bot fix this",
        // The checkout directory is the project name, not its namespace path.
        pr: { repo: "api", pr_url: MR_URL },
        created_at: "2026-11-03T10:00:00Z",
        // The diff note's anchor travels with the comment: the harness shows it.
        path: "app.py",
        line: 12,
      },
      targets: [{ id: "901", spec }],
      prUrl: MR_URL,
    });
  });

  it("a plain note carries no anchor", async () => {
    await enqueueComment(tasks, {
      task,
      noteId: 902,
      body: "@devbox-bot hello",
      spec: {
        kind: "mr_note",
        projectId: 55,
        project: "platform/backend/api",
        mrIid: 3,
        noteId: 902,
      },
      project: "platform/backend/api",
      prUrl: MR_URL,
      createdAt: "",
    });
    const draft = enqueueRound.mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect("path" in draft.payload).toBe(false);
    expect("line" in draft.payload).toBe(false);
  });

  const pipeline = {
    task,
    pipelineId: 7001,
    finishedAt: "2026-04-23T10:05:00Z",
    name: "Pipeline #12",
    status: "failed",
    url: "https://gitlab.example.com/platform/api/-/pipelines/7001",
    sha: "abc123",
    ref: "devbox/XYZ-1-fix",
    projectId: 55,
    project: "platform/api",
    mrIid: 3,
    prUrl: "https://gitlab.example.com/platform/api/-/merge_requests/3",
    limit: 20,
  };

  it("queues a ci_result round whose target posts a new note, capped by the limit", async () => {
    await enqueueCiResult(tasks, pipeline, logger);
    expect(enqueueRound).toHaveBeenCalledWith({
      task,
      kind: "ci_result",
      // The finish time tells a retry inside the same pipeline from the first failure.
      externalId: "pipeline:7001:3:2026-04-23T10:05:00Z",
      payload: {
        target_id: "7001",
        workflow_name: "Pipeline #12",
        workflow_path: ".gitlab-ci.yml",
        conclusion: "failure",
        run_url: "https://gitlab.example.com/platform/api/-/pipelines/7001",
        head_sha: "abc123",
        head_branch: "devbox/XYZ-1-fix",
        pr: { repo: "api", pr_url: "https://gitlab.example.com/platform/api/-/merge_requests/3" },
      },
      targets: [
        {
          id: "7001",
          spec: { kind: "mr_note", projectId: 55, project: "platform/api", mrIid: 3, noteId: 0 },
        },
      ],
      prUrl: "https://gitlab.example.com/platform/api/-/merge_requests/3",
      limit: 20,
    });
  });

  it("logs a dropped CI failure once the task has reached the limit", async () => {
    enqueueRound.mockResolvedValue({ dropped: "limit", count: 20 });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    await enqueueCiResult(tasks, pipeline, logger);
    expect(warn).toHaveBeenCalledWith(
      "ci_result loop breaker tripped — dropping CI failure",
      expect.objectContaining({ taskId: "task-1", seen: 20, max: 20, pipelineId: 7001, mrIid: 3 }),
    );
    warn.mockRestore();
  });

  it("recognises only its own reply targets", () => {
    expect(isGitlabSpec({ kind: "mr_note", projectId: 55, mrIid: 3, noteId: 0 })).toBe(true);
    expect(isGitlabSpec({ kind: "issue_comment", owner: "o", repo: "r", prNumber: 1 })).toBe(false);
    expect(isGitlabSpec({ kind: "mr_note", projectId: "55", mrIid: 3, noteId: 1 })).toBe(false);
    expect(isGitlabSpec(null)).toBe(false);
  });
});
