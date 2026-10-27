import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { Clock } from "../clock";
import { ApiError } from "../errors";
import { logger } from "../logger";
import type {
  ApiTaskService,
  CreateTaskInput,
  ListTasksInput,
  Principal,
} from "../services/apiTask.service";
import { EXPERIMENTAL_FLAG_NAME_RE } from "../services/experimentalFlags";
import type { ApiErrorBody, ApiErrorCode, ApiTaskState, MeResponse } from "../types/api";

export type ApiEnv = { Variables: { principal: Principal | null } };
export type ApiTaskServicePort = Pick<
  ApiTaskService,
  | "create"
  | "list"
  | "get"
  | "sendMessage"
  | "restart"
  | "events"
  | "streamTarget"
  | "streamState"
  | "eventsAfter"
>;
export type ApiControllerOptions = {
  authEnabled: boolean;
  ssePollMs: number;
  sseMaxDurationMs: number;
  clock: Clock;
};

const TITLE_MAX_CHARS = 256;
const TEXT_MAX_BYTES = 64 * 1024;
const FLAGS_MAX = 16;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES: readonly ApiTaskState[] = ["queued", "running", "idle", "failed"];

export function errorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

const invalid = (message: string) => new ApiError(400, "invalid_request", message);

// /api HTTP boundary. Bodies are checked by hand, as the other controllers do;
// the messages name the field and the reason.
export class ApiController {
  constructor(
    protected service: ApiTaskServicePort,
    protected opts: ApiControllerOptions,
  ) {}

  async createTask(c: Context<ApiEnv>): Promise<Response> {
    try {
      const body = await readJsonObject(c);
      return c.json(await this.service.create(c.get("principal"), parseTaskDefinition(body)), 201);
    } catch (err) {
      return this.handleError(c, err);
    }
  }

  async listTasks(c: Context<ApiEnv>): Promise<Response> {
    try {
      return c.json(await this.service.list(c.get("principal"), parseListQuery(c)), 200);
    } catch (err) {
      return this.handleError(c, err);
    }
  }

  async getTask(c: Context<ApiEnv>): Promise<Response> {
    try {
      return c.json(await this.service.get(c.req.param("ref") ?? ""), 200);
    } catch (err) {
      return this.handleError(c, err);
    }
  }

  async sendMessage(c: Context<ApiEnv>): Promise<Response> {
    try {
      const body = await readJsonObject(c);
      if (typeof body.body !== "string" || body.body.length === 0) {
        throw invalid("body must be a non-empty string");
      }
      if (utf8Bytes(body.body) > TEXT_MAX_BYTES)
        throw invalid(`body must be at most ${TEXT_MAX_BYTES} bytes`);
      return c.json(await this.service.sendMessage(c.req.param("ref") ?? "", body.body), 202);
    } catch (err) {
      return this.handleError(c, err);
    }
  }

  async restartTask(c: Context<ApiEnv>): Promise<Response> {
    try {
      const input = parseTaskDefinition(await readJsonObject(c));
      return c.json(await this.service.restart(c.req.param("ref") ?? "", input), 202);
    } catch (err) {
      return this.handleError(c, err);
    }
  }

  async listEvents(c: Context<ApiEnv>): Promise<Response> {
    try {
      const after = parseIntParam(
        c.req.query("after"),
        0,
        0,
        Number.MAX_SAFE_INTEGER,
        "after must be a non-negative integer",
      );
      const limit = parseIntParam(
        c.req.query("limit"),
        200,
        1,
        1000,
        "limit must be an integer from 1 to 1000",
      );
      return c.json(await this.service.events(c.req.param("ref") ?? "", after, limit), 200);
    } catch (err) {
      return this.handleError(c, err);
    }
  }

  me(c: Context<ApiEnv>): Response {
    const p = c.get("principal");
    const body: MeResponse = p
      ? { token: { id: p.tokenId, name: p.name } }
      : { token: null, auth: "disabled" };
    return c.json(body, 200);
  }

  private readonly shutdown = new AbortController();

  // Called on SIGTERM/SIGINT: every open stream ends; clients reconnect with
  // Last-Event-ID to another pod.
  closeStreams(): void {
    this.shutdown.abort();
  }

  // SSE over the event log. Stateless: the cursor is the client's
  // Last-Event-ID / ?after=. Errors before the first byte are JSON; errors
  // after are logged and close the stream (no message to the client).
  async streamEvents(c: Context<ApiEnv>): Promise<Response> {
    let target: { id: string; source: "linear" | "api" };
    let start: number;
    try {
      start = parseStreamStart(c.req.header("last-event-id"), c.req.query("after"));
      target = await this.service.streamTarget(c.req.param("ref") ?? "");
    } catch (err) {
      return this.handleError(c, err);
    }
    // Bun.serve closes connections after 10s without data; turn that off for
    // this request. Hono on Bun exposes the server as c.env (absent in tests).
    const server = c.env as { timeout?: (req: Request, seconds: number) => void } | undefined;
    server?.timeout?.(c.req.raw, 0);

    return streamSSE(c, async (stream) => {
      const closed = new AbortController();
      stream.onAbort(() => closed.abort());
      // Combine the client, shutdown and deadline signals by hand; this only
      // avoids a dependency on AbortSignal.any.
      const combined = new AbortController();
      const abortCombined = () => combined.abort();
      const signal = combined.signal;
      // A write to a client that stopped reading blocks on backpressure, so the
      // loop cannot be trusted to notice the deadline or a shutdown. Aborting the
      // stream cancels its reader, which fails the pending write. Attached before
      // any abort can happen, so an already-fired shutdown is covered too.
      signal.addEventListener("abort", () => stream.abort(), { once: true });
      // Only the shutdown signal outlives the stream, so only its listener is removed.
      if (this.shutdown.signal.aborted) abortCombined();
      else this.shutdown.signal.addEventListener("abort", abortCombined, { once: true });
      closed.signal.addEventListener("abort", abortCombined, { once: true });
      // A real timer, not a check between writes. It is cancelled when the
      // handler returns; that must not abort the stream, which could drop
      // frames a slow client has not read yet.
      const deadlineTimer = new AbortController();
      void this.opts.clock.sleep(this.opts.sseMaxDurationMs, deadlineTimer.signal).then(() => {
        if (!deadlineTimer.signal.aborted) abortCombined();
      });
      try {
        await this.runStream(stream, target, start, signal);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        // After a client disconnect or shutdown, a failed write is expected.
        if (signal.aborted) {
          logger.debug("api event stream ended after abort", {
            taskId: target.id,
            message: e.message,
          });
          return;
        }
        logger.error("api event stream failed", {
          taskId: target.id,
          message: e.message,
          stack: e.stack,
        });
      } finally {
        this.shutdown.signal.removeEventListener("abort", abortCombined);
        deadlineTimer.abort();
      }
    });
  }

  private async runStream(
    stream: SSEStreamingApi,
    target: { id: string; source: "linear" | "api" },
    start: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { clock } = this.opts;
    if (target.source !== "api") {
      await stream.writeSSE({
        event: "state",
        data: JSON.stringify(await this.service.streamState(target.id)),
      });
      await stream.writeSSE({ event: "logging", data: JSON.stringify({ logging: "unavailable" }) });
      return;
    }
    const startedAt = clock.now();
    let lastWriteAt = startedAt;
    let cursor = start;
    let lastState: string | null = null;
    while (!signal.aborted && clock.now() - startedAt < this.opts.sseMaxDurationMs) {
      for (const e of await this.service.eventsAfter(target.id, cursor, SSE_BATCH)) {
        if (signal.aborted) return;
        await stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) });
        cursor = e.id;
        lastWriteAt = clock.now();
      }
      if (signal.aborted) return;
      // `state` carries no id, so it never moves the client's resume point.
      const state = JSON.stringify(await this.service.streamState(target.id));
      if (state !== lastState) {
        await stream.writeSSE({ event: "state", data: state });
        lastState = state;
        lastWriteAt = clock.now();
      }
      if (clock.now() - lastWriteAt >= KEEPALIVE_MS) {
        await stream.write(": keepalive\n\n");
        lastWriteAt = clock.now();
      }
      await clock.sleep(this.opts.ssePollMs, signal);
    }
  }

  protected handleError(c: Context<ApiEnv>, err: unknown): Response {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status);
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error("api request failed", { path: c.req.path, message: e.message, stack: e.stack });
    return c.json(errorBody("internal", "Internal error"), 500);
  }
}

// A body without Content-Length (chunked) is capped while it is read: Hono's
// bodyLimit then makes the read reject with a BodyLimitError.
async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await c.req.text();
  } catch (err) {
    if (err instanceof Error && err.name === "BodyLimitError") {
      throw invalid("Request body is too large");
    }
    throw invalid("Request body must be a JSON object");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid("Request body must be a JSON object");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// The full task definition, shared by create and restart. A description left
// out becomes null and experimental_flags left out becomes [].
function parseTaskDefinition(body: Record<string, unknown>): CreateTaskInput {
  return {
    title: parseTitle(body.title),
    description: parseDescription(body.description) ?? null,
    experimentalFlags: parseFlags(body.experimental_flags) ?? [],
  };
}

function parseTitle(v: unknown): string {
  // Characters = code points; a whitespace-only title is rejected.
  if (typeof v !== "string" || v.trim().length === 0 || [...v].length > TITLE_MAX_CHARS) {
    throw invalid(`title must be a string of 1 to ${TITLE_MAX_CHARS} characters`);
  }
  return v;
}

// undefined = field absent.
function parseDescription(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v !== "string") throw invalid("description must be a string or null");
  if (utf8Bytes(v) > TEXT_MAX_BYTES)
    throw invalid(`description must be at most ${TEXT_MAX_BYTES} bytes`);
  return v;
}

function parseFlags(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > FLAGS_MAX) {
    throw invalid(`experimental_flags must be an array of at most ${FLAGS_MAX} flag names`);
  }
  for (const f of v) {
    if (typeof f !== "string" || !EXPERIMENTAL_FLAG_NAME_RE.test(f)) {
      throw invalid(`experimental_flags: ${JSON.stringify(f)} is not a valid flag name`);
    }
  }
  return [...new Set(v as string[])];
}

const SSE_BATCH = 500;
const KEEPALIVE_MS = 15_000;

function parseStreamStart(lastEventId: string | undefined, after: string | undefined): number {
  if (lastEventId !== undefined && lastEventId !== "") {
    return parseIntParam(
      lastEventId,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
      "Last-Event-ID must be a non-negative integer",
    );
  }
  return parseIntParam(
    after,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
    "after must be a non-negative integer",
  );
}

function parseIntParam(
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
  message: string,
): number {
  if (raw === undefined || raw === "") return def;
  if (!/^\d+$/.test(raw)) throw invalid(message);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid(message);
  return n;
}

function parseListQuery(c: Context): ListTasksInput {
  const q: ListTasksInput = {
    limit: parseIntParam(
      c.req.query("limit"),
      20,
      1,
      100,
      "limit must be an integer from 1 to 100",
    ),
  };
  const source = c.req.query("source");
  if (source !== undefined) {
    if (source !== "linear" && source !== "api") throw invalid("source must be linear or api");
    q.source = source;
  }
  const state = c.req.query("state");
  if (state !== undefined) {
    if (!STATES.includes(state as ApiTaskState))
      throw invalid(`state must be one of ${STATES.join(", ")}`);
    q.state = state as ApiTaskState;
  }
  const createdBy = c.req.query("created_by");
  if (createdBy !== undefined) {
    if (createdBy !== "me" && !UUID_RE.test(createdBy))
      throw invalid('created_by must be "me" or a token id');
    q.createdBy = createdBy;
  }
  const before = c.req.query("before");
  if (before !== undefined) {
    if (!UUID_RE.test(before)) throw invalid("before must be a task id");
    q.before = before;
  }
  return q;
}
