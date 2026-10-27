// The task event log: reading the history and following the live stream.
import type { ApiEventEnvelope, ApiRoundOutcome } from "../../control-plane/src/types/api";
import { type ApiClient, ApiFailure, isFatal } from "./api";
import { MAX_TIMEOUT_MS } from "./limits";
import { followStream, type Sleep } from "./sse";

export class NoEventLog extends Error {
  constructor(ref: string) {
    super(`${ref} has no event log (only API tasks are logged)`);
  }
}

// Where a write's round starts: the CP event the write committed. Only core reads its fields.
export type RoundStart = {
  readonly type: "task_created" | "message_queued" | "task_restarted";
  readonly roundId?: string;
  readonly pick: "first" | "last";
};
export const roundStart = {
  created: (): RoundStart => ({ type: "task_created", pick: "first" }),
  message: (roundId: string): RoundStart => ({ type: "message_queued", roundId, pick: "first" }),
  restarted: (): RoundStart => ({ type: "task_restarted", pick: "last" }),
};
export type From = { round: RoundStart } | { after: number } | "latest";
export type HistoryOptions = { ref: string; after: number; signal?: AbortSignal };
export type FollowOptions = {
  ref: string;
  from: From;
  untilDone?: boolean;
  timeoutMs?: number;
  signal: AbortSignal;
};
export type RoundResult = {
  outcome: ApiRoundOutcome | null;
  failed: boolean;
  response?: ApiEventEnvelope;
  reason?: string;
};
export type FollowItem =
  | { kind: "event"; event: ApiEventEnvelope }
  | { kind: "done"; result: RoundResult }
  | { kind: "timeout" };
export type CoreDeps = { sleep: Sleep };

const PAGE_SIZE = 1000;

export async function* taskHistory(
  api: ApiClient,
  o: HistoryOptions,
): AsyncGenerator<ApiEventEnvelope> {
  let cursor = o.after;
  for (;;) {
    const page = await api.listEvents(o.ref, cursor, PAGE_SIZE, o.signal);
    if (page.logging === "unavailable") throw new NoEventLog(o.ref);
    if (page.events.length === 0) return;
    yield* page.events;
    cursor = page.next_after;
  }
}

const ROUND_EVENTS = new Set([
  "task_created",
  "message_queued",
  "task_restarted",
  "agent_thought",
  "agent_action",
  "agent_response",
  "agent_error",
  "pr_opened",
  "completed",
  "round_failed",
]);

// `superseded`: a restart ended the round, which is final whatever the task's state.
type RoundEnd = {
  outcome: ApiRoundOutcome | null;
  failed: boolean;
  reason?: string;
  superseded?: boolean;
};

const SUPERSEDED: RoundEnd = {
  outcome: null,
  failed: true,
  reason: "superseded by a restart",
  superseded: true,
};

// Follows the rounds in an event stream to tell when the latest one is over.
class RoundTracker {
  private latest: string | null = null;
  // The round of the last task_created or task_restarted. A restart gives the
  // assignment a new round id and doesn't list the old one as superseded.
  private assignment: string | null = null;

  // `fixed` pins the round to report; without it, the latest one is reported.
  constructor(private readonly fixed: string | null = null) {}

  private readonly responses = new Map<string, ApiEventEnvelope>();
  private readonly errors = new Map<string, string>();
  private readonly ended = new Map<string, RoundEnd>();
  // Rounds that have had a round event other than `completed`.
  private readonly worked = new Set<string>();

  observe(e: ApiEventEnvelope): void {
    const data = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "task_restarted" && Array.isArray(data.superseded_round_ids)) {
      for (const id of data.superseded_round_ids) this.ended.set(String(id), SUPERSEDED);
    }
    if (e.round_id === null || !ROUND_EVENTS.has(e.type)) return;
    const round = e.round_id;
    // A status-less `completed` for a round with no other round event did no
    // work. Such a `completed` neither moves the latest round nor ends one.
    if (e.type === "completed" && round !== this.fixed && !this.worked.has(round)) return;
    if (e.type !== "completed") this.worked.add(round);
    if (e.type === "task_created" || e.type === "task_restarted") {
      const previous = this.assignment;
      if (
        e.type === "task_restarted" &&
        previous !== null &&
        previous !== round &&
        !this.ended.has(previous)
      ) {
        this.ended.set(previous, SUPERSEDED);
      }
      this.assignment = round;
    }
    this.latest = round;
    if (e.type === "agent_response") {
      this.responses.set(round, e);
    } else if (e.type === "agent_error") {
      this.errors.set(round, typeof data.body === "string" ? data.body : "");
    } else if (e.type === "round_failed") {
      this.ended.set(round, {
        outcome: null,
        failed: true,
        reason:
          typeof data.reason === "string" && data.reason !== "" ? data.reason : "the round failed",
      });
    } else if (e.type === "completed") {
      const outcome = (data.status as ApiRoundOutcome | undefined) ?? null;
      this.ended.set(round, {
        outcome,
        failed: outcome === "failed",
        reason: this.errors.get(round) ?? "the round failed",
      });
    }
  }

  // The target round's result once it is final, else undefined.
  result(state: string | undefined): RoundResult | undefined {
    const settled = state === "idle" || state === "failed";
    const target = this.fixed ?? this.latest;
    // No round seen yet: the task's state alone doesn't say how a round ended.
    if (target === null) return undefined;
    const end = this.ended.get(target);
    // A superseded round is over at once. Other ends wait for the task to
    // settle: CP marks the round responded before it logs `completed`, so the
    // task can be idle while the round's end is still on its way.
    if (!end || (!end.superseded && !settled)) return undefined;
    const result: RoundResult = {
      outcome: end.outcome,
      failed: end.failed,
      response: this.responses.get(target),
    };
    if (end.failed) result.reason = end.reason;
    return result;
  }
}

// The event the write committed, with a non-null round id.
async function findRoundStart(
  api: ApiClient,
  ref: string,
  start: RoundStart,
  signal: AbortSignal,
): Promise<ApiEventEnvelope & { round_id: string }> {
  let match: ApiEventEnvelope | undefined;
  for await (const e of taskHistory(api, { ref, after: 0, signal })) {
    if (e.type !== start.type) continue;
    if (start.roundId !== undefined && e.round_id !== start.roundId) continue;
    match = e;
    if (start.pick === "first") break;
  }
  if (!match || match.round_id === null) {
    throw new ApiFailure(null, "event_not_found", `no ${start.type} event in the log of ${ref}`);
  }
  return { ...match, round_id: match.round_id };
}

// Reads the log after `after` into `tracker` and returns the last event's id
// (`after` for no events). Events after `printAfter` are yielded; without it,
// none are.
async function* readLog(
  api: ApiClient,
  ref: string,
  after: number,
  tracker: RoundTracker,
  signal: AbortSignal,
  printAfter?: number,
): AsyncGenerator<FollowItem, number> {
  let last = after;
  for await (const event of taskHistory(api, { ref, after, signal })) {
    tracker.observe(event);
    last = event.id;
    if (printAfter !== undefined && event.id > printAfter) yield { kind: "event", event };
  }
  return last;
}

export async function* followTask(
  api: ApiClient,
  o: FollowOptions,
  deps: CoreDeps,
): AsyncGenerator<FollowItem> {
  if (o.timeoutMs !== undefined && !(o.timeoutMs >= 1 && o.timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new RangeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  // The deadline and Ctrl-C cover reading the history too.
  const timeout = new AbortController();
  const timer =
    o.timeoutMs === undefined ? undefined : setTimeout(() => timeout.abort(), o.timeoutMs);
  const signal = AbortSignal.any([o.signal, timeout.signal]);
  const timedOut = () => timeout.signal.aborted && !o.signal.aborted;
  try {
    let tracker = new RoundTracker();
    let cursor: number;
    try {
      if (o.from === "latest") {
        cursor = yield* readLog(api, o.ref, 0, tracker, signal);
      } else if ("round" in o.from) {
        const match = await findRoundStart(api, o.ref, o.from.round, signal);
        tracker = new RoundTracker(match.round_id);
        cursor = match.id - 1;
      } else if (o.untilDone) {
        // CP sends the task's state after every batch of history, so a state
        // seen mid-replay can belong to an older round: read the whole log
        // first, including the rounds before the cursor, which can hold the
        // outcome.
        const after = o.from.after;
        cursor = Math.max(yield* readLog(api, o.ref, 0, tracker, signal, after), after);
      } else {
        cursor = o.from.after;
      }
    } catch (err) {
      // fetch's AbortError: the deadline passed or Ctrl-C.
      if (!signal.aborted) throw err;
      if (timedOut()) yield { kind: "timeout" };
      return;
    }
    // The highest event id read so far. The stream resends events a drain
    // below already read; those are skipped.
    let seen = cursor;
    let state: string | undefined;
    for await (const message of followStream({
      open: (lastEventId, connSignal) => api.openStream(o.ref, lastEventId, connSignal),
      lastEventId: String(cursor),
      signal,
      sleep: deps.sleep,
      isFatal,
    })) {
      if (message.event === "logging") throw new NoEventLog(o.ref);
      if (message.event === "state") {
        state = (JSON.parse(message.data) as { state: string }).state;
      } else {
        const event = JSON.parse(message.data) as ApiEventEnvelope;
        if (event.id <= seen) continue;
        seen = event.id;
        tracker.observe(event);
        yield { kind: "event", event };
      }
      if (!o.untilDone || !tracker.result(state)) continue;
      // CP sends the task's state after every batch of up to 500 events, also
      // when a reconnect replays what was logged while the stream was down, so
      // the state can arrive before a newer round's events. Read the rest of
      // the log before accepting the result.
      try {
        seen = yield* readLog(api, o.ref, seen, tracker, signal, seen);
      } catch (err) {
        if (!signal.aborted) throw err;
        if (timedOut()) yield { kind: "timeout" };
        return;
      }
      const result = tracker.result(state);
      if (result) {
        yield { kind: "done", result };
        return;
      }
    }
    if (timedOut()) yield { kind: "timeout" };
  } finally {
    clearTimeout(timer);
  }
}
