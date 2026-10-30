import { afterEach, describe, expect, it, mock } from "bun:test";
import { LinearClient } from "@linear/sdk";
import type { ReplyTarget } from "../../repositories/inbox.repository";

// A token file that does not exist: the GitHub client has no token to send.
mock.module("../../config", () => ({
  config: { podId: "pod-test", github: { tokenSettings: { file: "/nonexistent/devbox/token" } } },
}));

const { HttpError, TokenFetchError, parseRetryAfter, retryable, withTimeout } = await import(
  "../http"
);
const { RetryableError } = await import("../outbound");
const { LinearIntegration } = await import("../linear");
const { LinearTokenError } = await import("../../clients/linearOauth");
// A fresh instance (see github.test.ts): never the possibly-mocked barrel.
const { postIssueComment } = (await import(
  "../../clients/githubApi.ts" + "?http-test"
)) as typeof import("../../clients/githubApi");
const { logger } = await import("../../logger");

// What fetch throws for `url`.
async function fetchError(url: string): Promise<unknown> {
  try {
    await fetch(url);
  } catch (err) {
    return err;
  }
  throw new Error(`fetch ${url} succeeded`);
}

const codeOf = (err: unknown) => (err as { code?: unknown }).code;

// A local TCP server whose sockets do `onOpen` / `onData`.
function tcpServer(handlers: {
  open?: (s: { write(d: string): void; end(): void }) => void;
  data?: (s: { end(): void }) => void;
}) {
  return Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open: (s) => handlers.open?.(s), data: (s) => handlers.data?.(s) },
  });
}

// The exact shapes bun 1.4.4's fetch throws; retryable() is written from these.
describe("retryable: bun fetch failures", () => {
  it("connection refused is a TypeError with code ECONNREFUSED: retryable", async () => {
    const closed = tcpServer({});
    const port = closed.port;
    closed.stop(true);
    const err = await fetchError(`http://127.0.0.1:${port}/`);
    expect(err).toBeInstanceOf(TypeError);
    expect(codeOf(err)).toBe("ECONNREFUSED");
    expect(retryable(err)).toBeInstanceOf(RetryableError);
  });

  it("an unknown host is a TypeError with code ENOTFOUND (EAI_AGAIN without a resolver): retryable", async () => {
    const err = await fetchError("https://devbox-http-test.invalid/");
    expect(err).toBeInstanceOf(TypeError);
    expect(["ENOTFOUND", "EAI_AGAIN"]).toContain(codeOf(err) as string);
    expect(retryable(err)).toBeInstanceOf(RetryableError);
  });

  it("a failed TLS handshake is a TypeError with code EPROTO: retryable", async () => {
    const plain = tcpServer({
      open: (s) => {
        s.write("HTTP/1.1 200 OK\r\n\r\nnot tls");
        s.end();
      },
    });
    try {
      const err = await fetchError(`https://127.0.0.1:${plain.port}/`);
      expect(err).toBeInstanceOf(TypeError);
      expect(codeOf(err)).toBe("EPROTO");
      expect(retryable(err)).toBeInstanceOf(RetryableError);
    } finally {
      plain.stop(true);
    }
  });

  it("a reset after the request went out (ECONNRESET) is not retryable", async () => {
    const resetter = tcpServer({ data: (s) => s.end() });
    try {
      const err = await fetchError(`http://127.0.0.1:${resetter.port}/`);
      expect(codeOf(err)).toBe("ECONNRESET");
      expect(retryable(err)).toBeUndefined();
    } finally {
      resetter.stop(true);
    }
  });

  it("a timed-out (aborted) fetch is not retryable: it may have landed", async () => {
    const hang = tcpServer({});
    try {
      const err = await withTimeout(20, (signal) =>
        fetch(`http://127.0.0.1:${hang.port}/`, { signal }),
      ).catch((e: unknown) => e);
      expect((err as Error).message).toBe("timed out after 20 ms");
      expect(retryable(err)).toBeUndefined();
    } finally {
      hang.stop(true);
    }
  });
});

describe("retryable: typed errors", () => {
  it("a 429 is retryable and keeps its Retry-After; 5xx and other 4xx are not", () => {
    const limited = retryable(new HttpError("HTTP 429 slow down", 429, 7000));
    expect(limited).toBeInstanceOf(RetryableError);
    expect(limited?.message).toBe("HTTP 429 slow down");
    expect(limited?.retryAfterMs).toBe(7000);
    for (const status of [400, 403, 404, 422, 500, 502, 503]) {
      expect(retryable(new HttpError(`HTTP ${status}`, status))).toBeUndefined();
    }
  });

  it("a certificate failure in the TLS handshake (DEPTH_ZERO_SELF_SIGNED_CERT) is retryable", () => {
    const err = Object.assign(new TypeError("self signed certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    expect(retryable(err)).toBeInstanceOf(RetryableError);
  });

  it("a token-fetch failure is retryable, Linear's included", () => {
    expect(retryable(new TokenFetchError("no token"))).toBeInstanceOf(RetryableError);
    expect(retryable(new LinearTokenError("Linear token request failed"))).toBeInstanceOf(
      RetryableError,
    );
  });

  it("anything else is not retryable", () => {
    expect(retryable(new Error("boom"))).toBeUndefined();
    expect(retryable("boom")).toBeUndefined();
    expect(retryable(null)).toBeUndefined();
  });
});

describe("parseRetryAfter", () => {
  it("reads delay-seconds and HTTP dates; ignores anything else", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter("0")).toBe(0);
    const inAMinute = parseRetryAfter(new Date(Date.now() + 60_000).toUTCString()) ?? 0;
    expect(inAMinute).toBeGreaterThan(58_000);
    expect(inAMinute).toBeLessThanOrEqual(60_000);
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("withTimeout", () => {
  it("returns the send's result and leaves its signal alone", async () => {
    let seen: AbortSignal | undefined;
    const out = await withTimeout(1000, async (signal) => {
      seen = signal;
      return "sent";
    });
    expect(out).toBe("sent");
    expect(seen?.aborted).toBe(false);
  });

  it("gives up after the bound even when the send ignores its signal, and aborts the signal", async () => {
    let seen: AbortSignal | undefined;
    const err = await withTimeout(20, (signal) => {
      seen = signal;
      return new Promise<never>(() => {});
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("timed out after 20 ms");
    expect(seen?.aborted).toBe(true);
  });
});

describe("GitHub client", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("a missing token is a TokenFetchError and sends nothing", async () => {
    const fetchStub = mock(() => Promise.resolve(new Response("{}")));
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    const err = await postIssueComment("o", "r", 1, "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenFetchError);
    expect(retryable(err)).toBeInstanceOf(RetryableError);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

// Linear's SDK wraps every failure in a LinearError; the integration maps the
// SDK's rate-limit error and the raw transport error underneath.
describe("Linear deliver: SDK failures", () => {
  const target: ReplyTarget = { id: "sess-1", spec: { kind: "linear_session" } };
  const reply = { type: "reply", body: "hi" } as const;
  const integrationFor = (apiUrl: string) =>
    new LinearIntegration({
      getAuthorizedLinearClient: (signal?: AbortSignal) =>
        Promise.resolve(new LinearClient({ accessToken: "t", apiUrl, signal })),
    });
  const deliverTo = (apiUrl: string, signal = new AbortController().signal) =>
    integrationFor(apiUrl)
      .deliver({ signal, log: logger }, target, reply)
      .then(() => "sent")
      .catch((e: unknown) => e);

  const server = (respond: () => Response | Promise<Response>) =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });

  it("an HTTP 429 is retryable with Retry-After", async () => {
    const s = server(
      () => new Response("Too many requests", { status: 429, headers: { "retry-after": "12" } }),
    );
    try {
      const err = await deliverTo(`http://127.0.0.1:${s.port}/graphql`);
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as InstanceType<typeof RetryableError>).retryAfterMs).toBe(12_000);
    } finally {
      s.stop(true);
    }
  });

  it("a ratelimited GraphQL error is retryable", async () => {
    const s = server(() =>
      Response.json(
        {
          errors: [
            {
              message: "Rate limit exceeded",
              extensions: { type: "ratelimited", code: "RATELIMITED" },
            },
          ],
        },
        { status: 400 },
      ),
    );
    try {
      expect(await deliverTo(`http://127.0.0.1:${s.port}/graphql`)).toBeInstanceOf(RetryableError);
    } finally {
      s.stop(true);
    }
  });

  it("a rate limit without Retry-After waits for Linear's reset time, at least a minute", async () => {
    const ratelimited = (headers: Record<string, string>) =>
      server(() =>
        Response.json(
          { errors: [{ message: "Rate limit exceeded", extensions: { type: "ratelimited" } }] },
          { status: 400, headers },
        ),
      );
    const waitOf = async (headers: Record<string, string>) => {
      const s = ratelimited(headers);
      try {
        const err = await deliverTo(`http://127.0.0.1:${s.port}/graphql`);
        expect(err).toBeInstanceOf(RetryableError);
        return (err as InstanceType<typeof RetryableError>).retryAfterMs;
      } finally {
        s.stop(true);
      }
    };
    const inTwoMinutes = await waitOf({
      "x-ratelimit-requests-reset": String(Date.now() + 120_000), // epoch ms
    });
    expect(inTwoMinutes).toBeGreaterThan(110_000);
    expect(inTwoMinutes).toBeLessThanOrEqual(120_000);
    expect(await waitOf({})).toBe(60_000);
  });

  it("a 500 is not retryable", async () => {
    const s = server(() => new Response("boom", { status: 500 }));
    try {
      const err = await deliverTo(`http://127.0.0.1:${s.port}/graphql`);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RetryableError);
    } finally {
      s.stop(true);
    }
  });

  it("connection refused is retryable", async () => {
    const closed = tcpServer({});
    const port = closed.port;
    closed.stop(true);
    expect(await deliverTo(`http://127.0.0.1:${port}/graphql`)).toBeInstanceOf(RetryableError);
  });

  it("the per-call client honours the send's signal (aborted: not retryable)", async () => {
    const s = server(() => new Promise<Response>(() => {}));
    try {
      const ac = new AbortController();
      const pending = deliverTo(`http://127.0.0.1:${s.port}/graphql`, ac.signal);
      ac.abort(new Error("timed out after 20000 ms"));
      const err = await pending;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RetryableError);
    } finally {
      s.stop(true);
    }
  });
});
