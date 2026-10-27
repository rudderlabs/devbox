// Request and response types for /api. Type-only: no runtime imports and no
// values, so the devbox CLI can import it without pulling
// in server modules. Guarded by src/types/__tests__/api.test.ts.

export type ApiTaskSource = "linear" | "api";
export type ApiTaskState = "queued" | "running" | "idle" | "failed";
export type ApiRoundStatus = "pending" | "delivered" | "responded" | "failed";
export type ApiRoundOutcome = "completed" | "partial_failure" | "no_action" | "failed";

export type ApiCreator = { id: string; name: string };
export type ApiPr = { repo: string; url: string; branch: string };

export type ApiRound = {
  id: string;
  source: string;
  kind: string;
  status: ApiRoundStatus;
  outcome: ApiRoundOutcome | null;
  failure_reason: string | null;
  created_at: string;
};

export type ApiTask = {
  id: string;
  key: string;
  source: ApiTaskSource;
  title: string;
  description: string | null;
  external_url: string;
  created_by: ApiCreator | null;
  experimental_flags: string[];
  state: ApiTaskState;
  sandbox_live: boolean;
  prs: ApiPr[];
  // Newest first, at most 20.
  rounds: ApiRound[];
  created_at: string;
  updated_at: string;
};

export type CreateTaskRequest = {
  title: string;
  description?: string | null;
  experimental_flags?: string[];
};
// Restart takes the full task definition, like create; nothing is merged.
export type RestartTaskRequest = CreateTaskRequest;
export type SendMessageRequest = { body: string };
export type SendMessageResponse = { round_id: string };
export type ListTasksResponse = { tasks: ApiTask[]; next_before: string | null };

export type ApiEventOrigin = "daemon" | "control_plane";
export type ApiEventEnvelope = {
  id: number;
  task_id: string;
  origin: ApiEventOrigin;
  type: string;
  round_id: string | null;
  seq: number | null;
  created_at: string;
  data: unknown;
};
export type ListEventsResponse = {
  events: ApiEventEnvelope[];
  next_after: number;
  logging: "available" | "unavailable";
};

// SSE `state` event payload. Sent without an id.
export type SseStateData = { state: ApiTaskState; sandbox_live: boolean };
export type SseLoggingData = { logging: "unavailable" };

export type MeResponse = { token: ApiCreator } | { token: null; auth: "disabled" };

export type ApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "task_not_found"
  | "not_api_task"
  | "internal";
export type ApiErrorBody = { error: { code: ApiErrorCode; message: string } };
