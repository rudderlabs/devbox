// In-process Hono stub of the CP API, for core and end-to-end tests. `fetch`
// calls app.fetch directly: no port, no proxy, and SSE bodies are scripted
// byte for byte.
import { Hono } from "hono";
import type { ApiEventEnvelope, ApiTaskState } from "../../control-plane/src/types/api";
import { ApiClient } from "../core/api";

export type Recorded = {
  method: string;
  path: string;
  authorization: string | null;
  lastEventId: string | null;
  body: unknown;
};
export type Stub = { app: Hono; fetch: typeof fetch; requests: Recorded[] };

export function createStub(): Stub {
  const app = new Hono();
  const requests: Recorded[] = [];
  app.use(async (c, next) => {
    const url = new URL(c.req.url);
    requests.push({
      method: c.req.method,
      path: url.pathname + url.search,
      authorization: c.req.header("authorization") ?? null,
      lastEventId: c.req.header("last-event-id") ?? null,
      body: c.req.method === "POST" ? await c.req.json() : undefined,
    });
    await next();
  });
  // Like a real fetch, a request rejects with the signal's reason once it
  // aborts, even while the route is still working on its answer.
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    const answer = Promise.resolve(app.fetch(new Request(input as string, init)));
    if (!signal) return answer;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
  return { app, requests, fetch: fetchFn as unknown as typeof fetch };
}

export const TOKEN = "dbx_tok_SECRET";

// An ApiClient on the stub, as the CLI would build it from its config.
// `null` builds a client without a token.
export const stubApi = (stub: Stub, token: string | null = TOKEN): ApiClient =>
  new ApiClient({ url: "http://cp.test", ...(token ? { token } : {}) }, stub.fetch);

export const apiError = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status });

// Same field order as the server's writeSSE: event, data, id.
export const frame = (e: ApiEventEnvelope): string =>
  `event: ${e.type}\ndata: ${JSON.stringify(e)}\nid: ${e.id}\n\n`;
export const stateFrame = (state: ApiTaskState): string =>
  `event: state\ndata: ${JSON.stringify({ state, sandbox_live: state === "running" })}\n\n`;
export const loggingFrame = 'event: logging\ndata: {"logging":"unavailable"}\n\n';

// One SSE connection: the chunks, then the stream closes ("close", as at the
// server's max duration), fails ("error", a network drop) or stays open
// ("hang") until the client cancels. Each string is one network chunk.
// Chunks are handed out on pull: erroring a stream discards whatever is still
// queued, so a "drop" must come only after the client has read every chunk.
export function sse(
  chunks: Array<string | Uint8Array>,
  end: "close" | "error" | "hang" = "close",
): Response {
  const enc = new TextEncoder();
  const queue = chunks.map((c) => (typeof c === "string" ? enc.encode(c) : c));
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const next = queue.shift();
      if (next) return ctrl.enqueue(next);
      if (end === "close") return ctrl.close();
      if (end === "error") return ctrl.error(new Error("connection reset"));
      return new Promise<void>(() => {}); // hang until cancelled
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// Serves `connections` in order on the stream route. Once they run out, every
// further connection hangs until the client aborts.
export function serveStream(stub: Stub, ref: string, connections: Array<() => Response>): void {
  let n = 0;
  stub.app.get(`/api/tasks/${ref}/events/stream`, () => {
    const next = connections[n++];
    return next ? next() : sse([], "hang");
  });
}

// Serves `log` on GET /events with the server's after/limit paging. With
// `delayMs`, each page is answered that much later.
export function serveEvents(stub: Stub, ref: string, log: ApiEventEnvelope[], delayMs = 0): void {
  stub.app.get(`/api/tasks/${ref}/events`, async (c) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 200);
    const events = log.filter((e) => e.id > after).slice(0, limit);
    return c.json({ events, next_after: events.at(-1)?.id ?? after, logging: "available" });
  });
}

// A Linear task: its log pages report `logging: unavailable`, and its stream
// sends one state event, then `logging`, then closes.
export function serveLinearTask(stub: Stub, ref: string): void {
  stub.app.get(`/api/tasks/${ref}/events`, (c) =>
    c.json({ events: [], next_after: 0, logging: "unavailable" }),
  );
  serveStream(stub, ref, [() => sse([stateFrame("idle"), loggingFrame])]);
}
