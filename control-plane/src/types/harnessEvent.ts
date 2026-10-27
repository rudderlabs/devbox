// CP-facing event surface. The daemon appends these (one JSON object per line)
// to /workspace/.harness/events.jsonl; CP reads them via a per-task cursor.
//
// Two categories:
//  - Generic agent emits (agent_thought / agent_action / agent_response /
//    agent_error): the dispatcher forwards each to the source-specific emit.
//  - Structural events (pr_opened, completed): source-independent CP-side
//    state changes.
// Generic agent emits — dispatcher forwards to source-aware emit. All four
// share one shape, parametrized over `type` so `Extract<HarnessEvent, { type:
// "agent_X" }>` still narrows correctly at call sites.
//
// `target_id` is always present and matches an inbox row's reply_targets[]
// entry:
//   - assignment: the Linear agent session id (AssignmentPayload.target_id)
//   - comment: the GH comment id (CommentPayload.target_id)
//   - review: a review_body or inline-comment target_id (the agent picks one
//     per item for response; for thought/action it conventionally targets
//     the primary item — the first reply_target).

type AgentEmitOf<T extends string> = {
  seq: number;
  ts: string;
  type: T;
  inbox_id: string;
  target_id: string;
  body: string;
};

export type AgentEmit =
  | AgentEmitOf<"agent_thought">
  | AgentEmitOf<"agent_action">
  | AgentEmitOf<"agent_response">
  | AgentEmitOf<"agent_error">;

export type HarnessEvent =
  | AgentEmit
  // Structural events — CP state changes regardless of source.
  | {
      seq: number;
      ts: string;
      type: "pr_opened";
      inbox_id: string;
      repo: string;
      pr_url: string;
      branch: string;
      commit_sha: string;
    }
  | {
      seq: number;
      ts: string;
      type: "completed";
      inbox_id: string;
      // Bare terminal marker — signals "this inbox row is processed" so CP can
      // mark it responded and the reaper can free the sandbox. The user-facing
      // message rides on the preceding agent_response / agent_error emit, not
      // here. `kind`-specific side effects (e.g. assignment → run archive upload)
      // are derived from the loaded inbox row's `kind`, not the event.
      // `status` is stored as the round's `inbox.outcome`. Optional because
      // comment/review rounds don't carry one (only assignment does).
      status?: "completed" | "partial_failure" | "no_action" | "failed";
    };
