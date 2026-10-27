// Server-Sent Events for /api/tasks/:ref/events/stream: an incremental parser,
// and a follower that reconnects with Last-Event-ID.

export type SseMessage = { event: string; data: string; id?: string };

// text/event-stream parser (WHATWG HTML, "Server-sent events"): lines end in
// LF, CRLF or CR; ":" lines are comments; data lines join with "\n"; a blank
// line dispatches. A block cut off by a dropped connection is never
// dispatched, so its id never becomes the resume point.
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    for (;;) {
      const end = /\r\n|\r|\n/.exec(this.buffer);
      // A trailing CR may be the first half of a CRLF split across chunks.
      if (!end || (end[0] === "\r" && end.index === this.buffer.length - 1)) break;
      const line = this.buffer.slice(0, end.index);
      this.buffer = this.buffer.slice(end.index + end[0].length);
      const message = this.line(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  private line(line: string): SseMessage | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return undefined;
  }

  private dispatch(): SseMessage | undefined {
    const message: SseMessage | undefined =
      this.data.length === 0
        ? undefined
        : {
            event: this.event || "message",
            data: this.data.join("\n"),
            ...(this.id === undefined ? {} : { id: this.id }),
          };
    this.data = [];
    this.event = "";
    this.id = undefined;
    return message;
  }
}

export const BACKOFF_START_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;

// 1s doubling to a 30s cap; reset() after any event.
export class Backoff {
  private next = BACKOFF_START_MS;

  delay(): number {
    const d = this.next;
    this.next = Math.min(d * 2, BACKOFF_CAP_MS);
    return d;
  }

  reset(): void {
    this.next = BACKOFF_START_MS;
  }
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export type FollowStreamOptions = {
  open: (
    lastEventId: string | undefined,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array>>;
  lastEventId?: string;
  signal: AbortSignal;
  sleep: Sleep;
  isFatal: (err: unknown) => boolean;
};

// Yields messages across reconnects until `signal` aborts or a fatal error is
// thrown. The server ends streams at its max duration and on shutdown, and
// networks drop them; every reconnect resumes after the last dispatched id.
export async function* followStream(o: FollowStreamOptions): AsyncGenerator<SseMessage> {
  const backoff = new Backoff();
  let lastEventId = o.lastEventId;
  while (!o.signal.aborted) {
    const conn = new AbortController();
    const abort = () => conn.abort();
    o.signal.addEventListener("abort", abort, { once: true });
    try {
      const reader = (await o.open(lastEventId, conn.signal)).getReader();
      // End a pending read on abort, even when the transport ignores the signal.
      conn.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), {
        once: true,
      });
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          if (message.id !== undefined) lastEventId = message.id;
          backoff.reset();
          yield message;
        }
      }
    } catch (err) {
      if (o.signal.aborted) return;
      if (o.isFatal(err)) throw err;
    } finally {
      o.signal.removeEventListener("abort", abort);
      conn.abort();
    }
    if (o.signal.aborted) return;
    await o.sleep(backoff.delay(), o.signal);
  }
}
