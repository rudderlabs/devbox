// Test fixtures shared by the core, interface and end-to-end tests: API
// resources and event envelopes with fixed ids and times.
import type { ApiEventEnvelope, ApiTask } from "../../control-plane/src/types/api";

export const TASK_ID = "0192f000-0000-7000-8000-000000000007";
export const T0 = "2026-10-12T12:00:00.000Z";
export const NOW = Date.parse("2026-10-12T12:30:00.000Z");

const CP_TYPES = new Set([
  "task_created",
  "message_queued",
  "task_restarted",
  "sandbox_started",
  "round_failed",
]);

// Event `id` is created at T0 + id seconds, so rendered times are 12:00:<id>.
export function envelope(
  id: number,
  type: string,
  data: unknown,
  roundId: string | null = "round-1",
): ApiEventEnvelope {
  const cp = CP_TYPES.has(type);
  return {
    id,
    task_id: TASK_ID,
    origin: cp ? "control_plane" : "daemon",
    type,
    round_id: roundId,
    seq: cp ? null : id,
    created_at: new Date(Date.parse(T0) + id * 1000).toISOString(),
    data,
  };
}

export function task(over: Partial<ApiTask> = {}): ApiTask {
  return {
    id: TASK_ID,
    key: "DBX-API-7",
    source: "api",
    title: "Fix flaky test",
    description: "The test fails on CI.",
    external_url: "https://cp.internal/api/tasks/DBX-API-7",
    created_by: { id: "0192f000-0000-7000-8000-0000000000aa", name: "frodo" },
    experimental_flags: [],
    state: "queued",
    sandbox_live: false,
    prs: [],
    rounds: [],
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}
