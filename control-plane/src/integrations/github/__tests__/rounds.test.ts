import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Task } from "../../../db/schema";
import { logger } from "../../../logger";
import type { TaskService } from "../../../services/task.service";
import { enqueueCiCheckResult, enqueueCiResult, enqueueComment, enqueueReview } from "../rounds";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  source: "linear",
  externalId: "issue-1",
  key: "XYZ-1",
  createdBy: null,
  title: "t",
  externalUrl: "https://linear.app/x/issue/XYZ-1",
  metadata: {},
  ownerId: "pod-test",
  heartbeatAt: new Date(),
  sandboxId: "sbx-1",
  pvcName: "pvc-1",
  prUrls: [],
  lastObservedEventSeq: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// Each builder queues through GitHub's TaskService, which stamps the source
// and the task identity.
describe("GitHub rounds", () => {
  let enqueueRound: ReturnType<typeof mock>;
  let tasks: Pick<TaskService, "enqueueRound">;

  beforeEach(() => {
    enqueueRound = mock(() => Promise.resolve({ roundId: "inbox-new" }));
    tasks = { enqueueRound } as unknown as Pick<TaskService, "enqueueRound">;
  });

  describe("enqueueComment", () => {
    it("enqueues a comment round for the task's PR", async () => {
      await enqueueComment(tasks, {
        task: makeTask(),
        commentId: 555,
        body: "@harness fix this",
        spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 7, commentId: 555 },
        createdAt: "2026-04-23T10:00:00Z",
      });

      const arg = enqueueRound.mock.calls[0]?.[0] as {
        task: { id: string; key: string };
        kind: string;
        externalId: string;
        payload: { target_id: string; created_at: string };
        targets: Array<{ id: string }>;
        prUrl: string;
      };
      expect(arg.kind).toBe("comment");
      expect(arg.externalId).toBe("555");
      expect(arg.payload.target_id).toBe("555");
      // enqueueRound stamps task_id / task_key from the task.
      expect(arg.task).toMatchObject({ id: "task-1", key: "XYZ-1" });
      // The comment's created_at is carried into the payload for temporal scoping.
      expect(arg.payload.created_at).toBe("2026-04-23T10:00:00Z");
      expect(arg.targets[0]?.id).toBe("555");
      // Dropped as stale if a restart has since cleared the PR from the task.
      expect(arg.prUrl).toBe("https://github.com/o/r/pull/7");
    });
  });

  describe("enqueueReview", () => {
    it("appends a kind='review' row with N+1 reply targets", async () => {
      await enqueueReview(tasks, {
        task: makeTask(),
        reviewId: 999,
        reviewBody: "looks good overall",
        inlineComments: [
          { id: 11, path: "a.ts", line: 3, startLine: 1, body: "nit" },
          { id: 12, path: "b.ts", line: 9, body: "rename" },
        ],
        owner: "o",
        repo: "r",
        prNumber: 7,
        reviewerLogin: "reviewer",
        createdAt: "2026-04-23T10:00:00Z",
      });

      const arg = enqueueRound.mock.calls[0]?.[0] as {
        kind: string;
        payload: {
          created_at: string;
          reviewer_login?: string;
          pr: { owner?: string; repo: string; prNumber?: number; pr_url: string };
          inline_comments: Array<{
            target_id: string;
            path: string;
            line: number;
            start_line?: number;
            body: string;
          }>;
        };
        targets: Array<{
          id: string;
          spec: {
            kind: string;
            startLine?: number;
          };
        }>;
      };
      expect(arg.kind).toBe("review");
      // The review's submitted_at is carried into the payload for temporal scoping.
      expect(arg.payload.created_at).toBe("2026-04-23T10:00:00Z");
      expect(arg.payload.reviewer_login).toBe("reviewer");
      expect(arg.payload.pr).toEqual({
        owner: "o",
        repo: "r",
        prNumber: 7,
        pr_url: "https://github.com/o/r/pull/7",
      });
      // 2 inline + 1 review_body
      expect(arg.targets).toHaveLength(3);
      expect(arg.payload.inline_comments[0]).toMatchObject({
        target_id: "11",
        path: "a.ts",
        line: 3,
        start_line: 1,
      });
      expect(arg.payload.inline_comments[1]?.start_line).toBeUndefined();
      expect(arg.targets[0]).toMatchObject({
        id: "11",
        spec: { kind: "review_comment", startLine: 1 },
      });
      expect(arg.targets[1]?.spec.startLine).toBeUndefined();
    });
  });

  describe("enqueueCiResult", () => {
    const ciParams = {
      task: makeTask(),
      runId: 123456789,
      runAttempt: 2,
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      conclusion: "success",
      runUrl: "https://github.com/o/r/actions/runs/123456789",
      headSha: "abc123",
      headBranch: "devbox/XYZ-1234-fix",
      owner: "o",
      repo: "r",
      prNumber: 42,
      limit: 20,
    };

    it("appends a kind='ci_result' row with correct payload and reply target", async () => {
      await enqueueCiResult(tasks, ciParams, logger);

      const arg = enqueueRound.mock.calls[0]?.[0] as {
        task: { id: string; key: string };
        kind: string;
        externalId: string;
        payload: {
          target_id: string;
          workflow_name: string;
          workflow_path: string;
          conclusion: string;
          run_url: string;
          head_sha: string;
          head_branch: string;
          pr: { repo: string; pr_url: string };
        };
        targets: Array<{
          id: string;
          spec: { kind: string; owner: string; repo: string; prNumber: number; commentId: number };
        }>;
        limit: number;
      };
      expect(arg.kind).toBe("ci_result");
      expect(arg.externalId).toBe("workflow_run:123456789:2:42");
      expect(arg.payload.target_id).toBe("123456789");
      expect(arg.payload.workflow_name).toBe("CI");
      expect(arg.payload.workflow_path).toBe(".github/workflows/ci.yml");
      expect(arg.payload.conclusion).toBe("success");
      expect(arg.payload.run_url).toBe("https://github.com/o/r/actions/runs/123456789");
      expect(arg.payload.head_sha).toBe("abc123");
      expect(arg.payload.head_branch).toBe("devbox/XYZ-1234-fix");
      expect(arg.task).toMatchObject({ id: "task-1", key: "XYZ-1" });
      expect(arg.payload.pr).toEqual({
        repo: "r",
        pr_url: "https://github.com/o/r/pull/42",
      });
      expect(arg.targets).toHaveLength(1);
      expect(arg.targets[0]).toMatchObject({
        id: "123456789",
        spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 42, commentId: 0 },
      });
      // The loop breaker's cap.
      expect(arg.limit).toBe(20);
    });

    it("logs the loop-breaker line when the cap drops the round", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => logger);
      // seen is the rows already stored, which can exceed a lowered cap.
      enqueueRound.mockResolvedValueOnce({ dropped: "limit", count: 23 });
      await enqueueCiResult(tasks, ciParams, logger);
      expect(warn.mock.calls).toEqual([
        [
          "ci_result loop breaker tripped — dropping CI failure",
          { taskId: "task-1", seen: 23, max: 20, runId: 123456789, prNumber: 42 },
        ],
      ]);
      // Nothing for a round that went in or another drop.
      warn.mockClear();
      await enqueueCiResult(tasks, ciParams, logger);
      enqueueRound.mockResolvedValueOnce({ dropped: "duplicate" });
      await enqueueCiResult(tasks, ciParams, logger);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // enqueueRound stamps task_id and task_key from the task it is handed.
  describe("enqueue paths hand enqueueRound the task row", () => {
    const apiTask = makeTask({
      id: "task-api",
      source: "api",
      key: "DBX-API-7",
      externalUrl: "https://cp.example/api/tasks/DBX-API-7",
    });
    const spec = {
      kind: "issue_comment" as const,
      owner: "o",
      repo: "r",
      prNumber: 7,
      commentId: 555,
    };

    it("enqueueComment", async () => {
      await enqueueComment(tasks, {
        task: apiTask,
        commentId: 555,
        body: "@harness fix",
        spec,
        createdAt: "2026-10-07T12:00:00Z",
      });
      expect(enqueueRound).toHaveBeenCalledWith({
        task: apiTask,
        kind: "comment",
        externalId: "555",
        payload: {
          target_id: "555",
          body: "@harness fix",
          pr: { repo: "r", pr_url: "https://github.com/o/r/pull/7" },
          created_at: "2026-10-07T12:00:00Z",
        },
        targets: [{ id: "555", spec }],
        prUrl: "https://github.com/o/r/pull/7",
      });
    });

    it("enqueueReview", async () => {
      await enqueueReview(tasks, {
        task: apiTask,
        reviewId: 88,
        reviewBody: "@harness",
        inlineComments: [{ id: 11, path: "a.ts", line: 3, body: "nit" }],
        owner: "o",
        repo: "r",
        prNumber: 7,
        reviewerLogin: "rev",
        createdAt: "2026-10-07T12:00:00Z",
      });
      expect(enqueueRound).toHaveBeenCalledWith({
        task: apiTask,
        kind: "review",
        externalId: "88",
        payload: {
          review_body: { target_id: "88", body: "@harness" },
          inline_comments: [
            { target_id: "11", path: "a.ts", line: 3, start_line: undefined, body: "nit" },
          ],
          pr: { owner: "o", repo: "r", prNumber: 7, pr_url: "https://github.com/o/r/pull/7" },
          reviewer_login: "rev",
          created_at: "2026-10-07T12:00:00Z",
        },
        prUrl: "https://github.com/o/r/pull/7",
        targets: [
          {
            id: "11",
            spec: {
              kind: "review_comment",
              owner: "o",
              repo: "r",
              prNumber: 7,
              commentId: 11,
              inReplyTo: 11,
              path: "a.ts",
              line: 3,
              startLine: undefined,
            },
          },
          {
            id: "88",
            spec: { kind: "review_body", owner: "o", repo: "r", prNumber: 7, reviewId: 88 },
          },
        ],
      });
    });

    it("enqueueCiResult", async () => {
      await enqueueCiResult(
        tasks,
        {
          task: apiTask,
          runId: 9,
          runAttempt: 1,
          workflowName: "CI",
          workflowPath: ".github/workflows/ci.yml",
          conclusion: "failure",
          runUrl: "https://github.com/o/r/actions/runs/9",
          headSha: "abc",
          headBranch: "devbox/DBX-API-7-x",
          owner: "o",
          repo: "r",
          prNumber: 7,
          limit: 20,
        },
        logger,
      );
      expect(enqueueRound).toHaveBeenCalledWith({
        task: apiTask,
        kind: "ci_result",
        externalId: "workflow_run:9:1:7",
        payload: {
          target_id: "9",
          workflow_name: "CI",
          workflow_path: ".github/workflows/ci.yml",
          conclusion: "failure",
          run_url: "https://github.com/o/r/actions/runs/9",
          head_sha: "abc",
          head_branch: "devbox/DBX-API-7-x",
          pr: { repo: "r", pr_url: "https://github.com/o/r/pull/7" },
        },
        prUrl: "https://github.com/o/r/pull/7",
        targets: [
          {
            id: "9",
            spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 7, commentId: 0 },
          },
        ],
        limit: 20,
      });
    });

    const checkParams = (check: Parameters<typeof enqueueCiCheckResult>[1]["check"]) => ({
      task: apiTask,
      check,
      name: check.source === "status" ? check.context : "ci/circleci: test",
      conclusion: "failure",
      runUrl: "https://github.com/o/r/runs/555",
      detailsUrl: "https://circleci.com/gh/o/r/77",
      summary: "2 tests failed",
      headSha: "abc",
      headBranch: "devbox/DBX-API-7-x",
      owner: "o",
      repo: "r",
      prNumber: 7,
      limit: 20,
    });

    it("enqueueCiCheckResult for a check run", async () => {
      await enqueueCiCheckResult(
        tasks,
        checkParams({ source: "check_run", checkRunId: 555 }),
        logger,
      );
      expect(enqueueRound).toHaveBeenCalledWith({
        task: apiTask,
        kind: "ci_result",
        externalId: "check_run:555:7",
        payload: {
          target_id: "555",
          ci_source: "check_run",
          workflow_name: "ci/circleci: test",
          workflow_path: "",
          conclusion: "failure",
          run_url: "https://github.com/o/r/runs/555",
          details_url: "https://circleci.com/gh/o/r/77",
          summary: "2 tests failed",
          head_sha: "abc",
          head_branch: "devbox/DBX-API-7-x",
          pr: { repo: "r", pr_url: "https://github.com/o/r/pull/7" },
        },
        prUrl: "https://github.com/o/r/pull/7",
        targets: [
          {
            id: "555",
            spec: { kind: "issue_comment", owner: "o", repo: "r", prNumber: 7, commentId: 0 },
          },
        ],
        limit: 20,
      });
    });

    it("enqueueCiCheckResult keys a status by repo, commit and context", async () => {
      await enqueueCiCheckResult(
        tasks,
        checkParams({ source: "status", statusId: 9001, context: "ci/jenkins" }),
        logger,
      );
      const arg = enqueueRound.mock.calls[0]?.[0] as {
        externalId: string;
        payload: Record<string, unknown>;
        targets: Array<{ id: string }>;
      };
      expect(arg.externalId).toBe("status:o/r:abc:ci/jenkins:7");
      expect(arg.payload).toMatchObject({ target_id: "9001", ci_source: "status" });
      expect(arg.targets[0]?.id).toBe("9001");
    });

    it("enqueueCiCheckResult logs the loop-breaker line when the cap drops the round", async () => {
      enqueueRound.mockResolvedValue({ dropped: "limit", count: 20 });
      const warn = spyOn(logger, "warn").mockImplementation(() => logger);
      await enqueueCiCheckResult(
        tasks,
        checkParams({ source: "check_run", checkRunId: 555 }),
        logger,
      );
      expect(warn).toHaveBeenCalledWith("ci_result loop breaker tripped — dropping CI failure", {
        taskId: "task-api",
        seen: 20,
        max: 20,
        externalId: "check_run:555:7",
      });
      warn.mockRestore();
    });
  });
});
