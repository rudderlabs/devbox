import type { Task } from "../../db/schema";
import type { Logger, ReplyTarget, TaskService } from "../types";

// GitHub's follow-up rounds (comment, review, CI result), built from its
// webhooks and queued through GitHub's TaskService.

// A GitHub reply target's spec: the PR thread a reply goes to. The JSON is
// stored with the round and read back by GitHub's deliver.
export type GithubSpec =
  | { kind: "issue_comment"; owner: string; repo: string; prNumber: number; commentId: number }
  | {
      kind: "review_comment";
      owner: string;
      repo: string;
      prNumber: number;
      commentId: number;
      inReplyTo: number;
      path: string;
      line: number;
      startLine?: number;
    }
  | { kind: "review_body"; owner: string; repo: string; prNumber: number; reviewId: number };
export type CommentSpec = Extract<GithubSpec, { kind: "issue_comment" | "review_comment" }>;

const SPEC_KINDS: readonly unknown[] = [
  "issue_comment",
  "review_comment",
  "review_body",
] satisfies GithubSpec["kind"][];

// True for a spec GitHub can post to: one of its kinds, on a PR.
export function isGithubSpec(spec: unknown): spec is GithubSpec {
  const s = spec as Record<string, unknown> | null;
  return (
    SPEC_KINDS.includes(s?.kind) &&
    typeof s?.owner === "string" &&
    typeof s.repo === "string" &&
    typeof s.prNumber === "number"
  );
}

// GitHub @harness comment (solo issue_comment or standalone review_comment).
export async function enqueueComment(
  tasks: Pick<TaskService, "enqueueRound">,
  params: {
    task: Pick<Task, "id" | "key">;
    commentId: number;
    body: string;
    spec: CommentSpec;
    // ISO-8601 creation time of the comment; "" when unknown.
    createdAt: string;
  },
): Promise<void> {
  const externalId = String(params.commentId);
  const prUrl = `https://github.com/${params.spec.owner}/${params.spec.repo}/pull/${params.spec.prNumber}`;
  await tasks.enqueueRound({
    task: params.task,
    kind: "comment",
    externalId,
    payload: {
      target_id: externalId, // matches reply_targets[0].id
      body: params.body,
      pr: { repo: params.spec.repo, pr_url: prUrl },
      created_at: params.createdAt,
    },
    targets: [{ id: externalId, spec: params.spec }],
    prUrl,
  });
}

// GitHub submitted review — the review body + every inline comment batched
// into ONE inbox row with N+1 reply targets.
export async function enqueueReview(
  tasks: Pick<TaskService, "enqueueRound">,
  params: {
    task: Pick<Task, "id" | "key">;
    reviewId: number;
    reviewBody: string;
    inlineComments: Array<{
      id: number;
      path: string;
      line: number;
      startLine?: number;
      body: string;
    }>;
    owner: string;
    repo: string;
    prNumber: number;
    reviewerLogin: string;
    // ISO-8601 submission time of the review; "" when unknown.
    createdAt: string;
  },
): Promise<void> {
  const reviewIdStr = String(params.reviewId);
  const prUrl = `https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}`;

  const payload = {
    review_body: { target_id: reviewIdStr, body: params.reviewBody },
    inline_comments: params.inlineComments.map((c) => ({
      target_id: String(c.id),
      path: c.path,
      line: c.line,
      start_line: c.startLine,
      body: c.body,
    })),
    pr: { owner: params.owner, repo: params.repo, prNumber: params.prNumber, pr_url: prUrl },
    reviewer_login: params.reviewerLogin,
    created_at: params.createdAt,
  };

  // reply_targets carry the routing spec. target.id MUST equal the
  // corresponding payload.*.target_id so a targeted agent_response routes
  // to the right thread.
  const replyTargets: ReplyTarget[] = [
    ...params.inlineComments.map((c) => ({
      id: String(c.id),
      spec: {
        kind: "review_comment",
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        commentId: c.id,
        inReplyTo: c.id,
        path: c.path,
        line: c.line,
        startLine: c.startLine,
      } satisfies GithubSpec,
    })),
    {
      id: reviewIdStr,
      spec: {
        kind: "review_body",
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        reviewId: params.reviewId,
      } satisfies GithubSpec,
    },
  ];

  await tasks.enqueueRound({
    task: params.task,
    kind: "review",
    externalId: reviewIdStr,
    payload,
    targets: replyTargets,
    prUrl,
  });
}

// GitHub `workflow_run` completed — one row per task whose PR URL matches.
// external_id includes runAttempt (re-runs share runId but bump attempt) and
// prNumber (one run can touch multiple PRs).
//
// Loop breaker. harness fixes CI → pushes → CI re-runs → may fail again, ad
// infinitum. Once a task has `limit` ci_result rows, whatever their status,
// further failures are dropped and logged. 0 or negative: no cap.
export async function enqueueCiResult(
  tasks: Pick<TaskService, "enqueueRound">,
  params: {
    task: Pick<Task, "id" | "key">;
    runId: number;
    runAttempt: number;
    workflowName: string;
    workflowPath: string;
    conclusion: string;
    runUrl: string;
    headSha: string;
    headBranch: string;
    owner: string;
    repo: string;
    prNumber: number;
    limit: number;
  },
  log: Pick<Logger, "warn">,
): Promise<void> {
  const runIdStr = String(params.runId);
  const externalId = `workflow_run:${params.runId}:${params.runAttempt}:${params.prNumber}`;
  const prUrl = `https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}`;
  const result = await tasks.enqueueRound({
    task: params.task,
    kind: "ci_result",
    externalId,
    payload: {
      target_id: runIdStr,
      workflow_name: params.workflowName,
      workflow_path: params.workflowPath,
      conclusion: params.conclusion,
      run_url: params.runUrl,
      head_sha: params.headSha,
      head_branch: params.headBranch,
      pr: { repo: params.repo, pr_url: prUrl },
    },
    targets: [
      {
        id: runIdStr,
        spec: {
          kind: "issue_comment",
          owner: params.owner,
          repo: params.repo,
          prNumber: params.prNumber,
          // commentId: 0 is the sentinel for "post new comment" (no existing
          // comment to reply to — the dispatcher posts a fresh PR comment).
          commentId: 0,
        } satisfies GithubSpec,
      },
    ],
    prUrl,
    limit: params.limit,
  });
  if ("dropped" in result && result.dropped === "limit") {
    log.warn("ci_result loop breaker tripped — dropping CI failure", {
      taskId: params.task.id,
      seen: result.count,
      max: params.limit,
      runId: params.runId,
      prNumber: params.prNumber,
    });
  }
}
