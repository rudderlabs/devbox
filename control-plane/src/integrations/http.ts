import { RetryableError } from "./outbound";

// Shared rules for integrations' outbound HTTP (I16): the typed errors clients
// throw, which failures may be retried, and how long one send may take.

// Upper bound on one deliver() call (§4 I14).
export const SEND_TIMEOUT_MS = 20_000;

// A non-2xx answer. The message keeps the client's own wording (tests and logs
// match on it); status, the wait before a retry and whether the platform
// rate-limited the call ride along for classification.
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    // GitHub also answers a rate limit with a 403 (see githubFetch).
    readonly rateLimited = status === 429,
  ) {
    super(message);
  }
}

// How long a rate limit without Retry-After waits: until the platform's reset
// time (epoch ms), and at least a minute. GitHub may ban integrations that
// retry sooner (§4).
export function rateLimitWaitMs(resetAtMs?: number): number {
  const untilReset =
    resetAtMs !== undefined && Number.isFinite(resetAtMs) ? resetAtMs - Date.now() : 0;
  return Math.max(untilReset, 60_000);
}

// The client had no credential to send with, so nothing was sent.
export class TokenFetchError extends Error {}

// What bun 1.4.4's fetch throws when the request never reached the server: a
// TypeError whose `code` names the cause (shapes pinned in http.test.ts). A
// reset (ECONNRESET) can come after the request went out, so it is not here.
const NOTHING_SENT = new Set([
  "ECONNREFUSED", // connection refused
  "ENOTFOUND", // DNS: no such host
  "EAI_AGAIN", // DNS: resolver unavailable (bun ships Node's code; not reproducible offline)
  "EPROTO", // TLS handshake failed
  // TLS: the server's certificate failed verification during the handshake
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

// The failure as a RetryableError when it is one of the exact retryable cases
// (§4): a rate limit (429), connection refused, DNS, TLS handshake, token
// fetch. Anything else (timeouts, 5xx, other 4xx) is undefined: the caller
// logs and drops it.
export function retryable(err: unknown): RetryableError | undefined {
  if (err instanceof RetryableError) return err;
  if (err instanceof TokenFetchError) return new RetryableError(err.message);
  if (err instanceof HttpError) {
    return err.rateLimited ? new RetryableError(err.message, err.retryAfterMs) : undefined;
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (err instanceof TypeError && typeof code === "string" && NOTHING_SENT.has(code)) {
    return new RetryableError(err.message);
  }
  return undefined;
}

// Retry-After as delay-seconds or an HTTP date; undefined when absent or unreadable.
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

// Runs `send` with an abort signal and stops waiting after `ms`, whether or not
// the client honours the signal. The send may still land after the timeout, so
// a timeout is a plain failure (dropped), never a retry.
export async function withTimeout<T>(
  ms: number,
  send: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms} ms`);
      ac.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([send(ac.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}
