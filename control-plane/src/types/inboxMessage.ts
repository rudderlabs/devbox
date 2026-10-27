// CP → harness wire contract. CP writes one of these per inbox row to
// /workspace/.harness/inbox/<id>.json; the daemon reads it, dispatches on
// (source, kind), and never sees CP-side fields (status, task_id, etc).
//
// Keep this file pristine — it is the source of truth for what the daemon
// receives. CP-internal persistence concerns live in InboxRow (the repository
// layer), which extends InboxMessage with status/lease/timestamps.

export type InboxKind = "assignment" | "comment" | "review" | "ci_result";
export type InboxSource = "linear" | "github" | "api";

// Identity CP stamps on every work payload. Both values are tasks columns
// (tasks.id, tasks.key); nothing is parsed from URLs.
export type TaskIdentity = {
  task_id: string;
  task_key: string;
};

// PR scope for GitHub-sourced rounds. The daemon's prompt uses repo to pick
// the right checkout for multi-repo tasks. null for Linear comments, which
// live on the agent session rather than any PR.
export type PrScope = {
  repo: string;
  pr_url: string;
};

export type ReviewPrScope = PrScope & {
  owner?: string;
  prNumber?: number;
};

export type AssignmentPayload = TaskIdentity & {
  title: string;
  description: string | null;
  external_url: string;
  // Linear agent session id. Matches the row's reply_targets[0].id (a
  // linear_session target); daemon stamps it as the per-round `--target` for
  // emits.
  target_id: string;
};

export type CommentPayload = TaskIdentity & {
  // GH comment id stringified, or Linear activity UUID. Matches the row's
  // single reply_targets[0].id.
  target_id: string;
  body: string;
  // null for linear-sourced (agent-session) comments; PrScope for github.
  pr: PrScope | null;
  // ISO-8601 creation time of the triggering comment. Display-only today —
  // the daemon dedups this comment out of the injected PR-discussion history
  // by id (see discussion_context.py's exclude_ids), not by this timestamp.
  created_at: string;
};

export type ReviewPayload = TaskIdentity & {
  review_body: { target_id: string; body: string };
  inline_comments: Array<{
    target_id: string;
    path: string;
    line: number;
    // Optional multi-line anchor; omitted when unavailable.
    start_line?: number;
    body: string;
  }>;
  // Always set — reviews are GitHub-only. New rows include owner/prNumber so
  // completion side effects can target the PR without depending on reply_targets;
  // optional for historical rows persisted before the fields existed.
  pr: ReviewPrScope;
  // Original reviewer login for best-effort review re-request after completion.
  // Optional for historical rows persisted before this field existed.
  reviewer_login?: string;
  // ISO-8601 submission time of the review (GitHub `submitted_at`).
  // Display-only today — the daemon dedups this review's own inline comments
  // out of the injected PR-discussion history by id (see discussion_context.py's
  // exclude_ids), not by this timestamp.
  created_at: string;
};

export type CiResultPayload = TaskIdentity & {
  // run id stringified — matches reply_targets[0].id
  target_id: string;
  workflow_name: string;
  workflow_path: string;
  // "success" | "failure" | "cancelled" | "skipped" | "timed_out" | ...
  conclusion: string;
  run_url: string;
  head_sha: string;
  head_branch: string;
  pr: PrScope;
};

// The wire contract. Discriminated on (source, kind) together so impossible
// combos (e.g. linear + review) are unrepresentable at the type level.
//
// Field roles:
//   id          — Synthetic uuidv7 PK assigned by CP at insert. The daemon
//                 reads it as the inbox file basename: `inbox/<id>.json`.
//                 Re-delegating a Linear assignment rotates this id on the
//                 existing assignment row so each fresh run gets a fresh
//                 daemon-visible identity while the logical task row and
//                 assignment external_id stay one-per-issue.
//   source      — Channel the round arrived on. Lets the daemon route final
//                 replies through the right adapter (Linear API vs GitHub
//                 REST).
//   kind        — Round shape; selects the daemon handler (assignment.py,
//                 comment.py, review.py).
//   external_id — Upstream identifier (GH comment/review id stringified,
//                 Linear activity UUID, Linear issue UUID for assignment, the task key for an API assignment;
//                 a new UUID for an API comment).
//                 Drives idempotency at CP's `(source, external_id)` unique
//                 index AND flows through to event reply-target routing.
//   payload     — Kind-specific body. See the payload types above.
export type InboxMessage =
  | {
      id: string;
      source: "linear";
      kind: "assignment";
      external_id: string;
      payload: AssignmentPayload;
    }
  | {
      id: string;
      source: "linear";
      kind: "comment";
      external_id: string;
      payload: CommentPayload;
    }
  | {
      id: string;
      source: "api";
      kind: "assignment";
      external_id: string;
      payload: AssignmentPayload;
    }
  | {
      id: string;
      source: "api";
      kind: "comment";
      external_id: string;
      payload: CommentPayload;
    }
  | {
      id: string;
      source: "github";
      kind: "comment";
      external_id: string;
      payload: CommentPayload;
    }
  | {
      id: string;
      source: "github";
      kind: "review";
      external_id: string;
      payload: ReviewPayload;
    }
  | {
      id: string;
      source: "github";
      kind: "ci_result";
      external_id: string;
      payload: CiResultPayload;
    };
