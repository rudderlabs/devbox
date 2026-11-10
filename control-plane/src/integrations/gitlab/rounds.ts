import type { Task } from "../../db/schema";
import type { Logger, TaskService } from "../types";

// GitLab's follow-up rounds (a note, a failed pipeline), built from its
// webhooks and queued through GitLab's TaskService. GitLab has no batched
// "review submitted" event with content: each merge request note arrives on
// its own, so there is no review round.

// A GitLab reply target's spec: the merge request thread a reply goes to. The
// JSON is stored with the round and read back by GitLab's deliver.
export type GitlabSpec =
  // A note on a merge request. The reply threads under the note's discussion
  // (resolved at send time when discussionId is unknown). noteId 0 is the
  // sentinel for "post a new note": a CI result answers no note.
  | {
      kind: "mr_note";
      projectId: number;
      project: string; // path_with_namespace, for logs and URLs
      mrIid: number;
      noteId: number;
      discussionId?: string;
    }
  // An inline (diff) note; the reply goes into its discussion thread.
  | {
      kind: "mr_diff_note";
      projectId: number;
      project: string;
      mrIid: number;
      noteId: number;
      discussionId: string;
      path: string;
      line: number;
    };

// Fails to compile unless it lists exactly GitlabSpec's kinds.
const SPEC_KINDS: readonly unknown[] = Object.keys({
  mr_note: true,
  mr_diff_note: true,
} satisfies Record<GitlabSpec["kind"], true>);

// True for a spec GitLab can post to: one of its kinds, on a merge request.
export function isGitlabSpec(spec: unknown): spec is GitlabSpec {
  const s = spec as Record<string, unknown> | null;
  return (
    SPEC_KINDS.includes(s?.kind) &&
    typeof s?.projectId === "number" &&
    typeof s.mrIid === "number" &&
    typeof s.noteId === "number"
  );
}

// The checkout directory of a GitLab project: the last segment of its
// path_with_namespace (repos clone to /workspace/<name>).
function repoName(projectPath: string): string {
  return projectPath.split("/").filter(Boolean).at(-1) ?? projectPath;
}

// A Note Hook on a merge request the agent opened: one round, one reply
// target (the note's thread). Idempotent on the note id.
export async function enqueueComment(
  tasks: Pick<TaskService, "enqueueRound">,
  params: {
    task: Pick<Task, "id" | "key">;
    noteId: number;
    body: string;
    spec: GitlabSpec;
    // path_with_namespace; its last segment is the checkout directory name.
    project: string;
    prUrl: string;
    // ISO-8601 creation time of the note; "" when unknown.
    createdAt: string;
  },
): Promise<void> {
  const externalId = String(params.noteId);
  await tasks.enqueueRound({
    task: params.task,
    kind: "comment",
    externalId,
    payload: {
      target_id: externalId, // matches reply_targets[0].id
      body: params.body,
      pr: { repo: repoName(params.project), pr_url: params.prUrl },
      created_at: params.createdAt,
      ...(params.spec.kind === "mr_diff_note"
        ? { path: params.spec.path, line: params.spec.line }
        : {}),
    },
    targets: [{ id: externalId, spec: params.spec }],
    prUrl: params.prUrl,
  });
}

// A Pipeline Hook with status failed: one round per task whose merge request
// URL matches. external_id includes the merge request iid (a branch pipeline
// can belong to several) and the pipeline's finished_at: a retry (the
// harness's rerun, or a click on Retry) re-runs the failed jobs inside the
// SAME pipeline id, so without it the next failure would collapse into the
// first as a duplicate. A redelivery of one failure keeps its finished_at.
//
// Loop breaker: once a task has `limit` GitLab ci_result rounds, whatever
// their status, further failures are dropped and logged. 0 or negative: no cap.
export async function enqueueCiResult(
  tasks: Pick<TaskService, "enqueueRound">,
  params: {
    task: Pick<Task, "id" | "key">;
    pipelineId: number;
    finishedAt: string;
    name: string;
    status: string;
    url: string;
    sha: string;
    ref: string;
    projectId: number;
    project: string;
    mrIid: number;
    prUrl: string;
    limit: number;
  },
  log: Pick<Logger, "warn">,
): Promise<void> {
  const pipelineIdStr = String(params.pipelineId);
  const externalId = `pipeline:${params.pipelineId}:${params.mrIid}:${params.finishedAt}`;
  const result = await tasks.enqueueRound({
    task: params.task,
    kind: "ci_result",
    externalId,
    payload: {
      target_id: pipelineIdStr,
      workflow_name: params.name,
      workflow_path: ".gitlab-ci.yml",
      // GitLab says "failed"; the harness contract says "failure".
      conclusion: params.status === "failed" ? "failure" : params.status,
      run_url: params.url,
      head_sha: params.sha,
      head_branch: params.ref,
      pr: { repo: repoName(params.project), pr_url: params.prUrl },
    },
    targets: [
      {
        id: pipelineIdStr,
        spec: {
          kind: "mr_note",
          projectId: params.projectId,
          project: params.project,
          mrIid: params.mrIid,
          // noteId 0 is the sentinel for "post a new note".
          noteId: 0,
        } satisfies GitlabSpec,
      },
    ],
    prUrl: params.prUrl,
    limit: params.limit,
  });
  if ("dropped" in result && result.dropped === "limit") {
    log.warn("ci_result loop breaker tripped — dropping CI failure", {
      taskId: params.task.id,
      seen: result.count,
      max: params.limit,
      pipelineId: params.pipelineId,
      mrIid: params.mrIid,
    });
  }
}
