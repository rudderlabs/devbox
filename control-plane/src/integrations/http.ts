import { logger } from "../logger";
import type { InboxRow, ReplyTarget } from "../repositories/inbox.repository";
import { type Outbound, RetryableError } from "./outbound";
import type { Integration, IntegrationName } from "./types";

// Shared rules for integrations' outbound HTTP: the typed errors clients
// throw, which failures may be retried, and how long one send may take.

// Upper bound on one deliver() call.
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
// retry sooner.
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

// The failure as a RetryableError when it is one of the exact retryable
// cases, where nothing was sent yet: a rate limit (429), connection refused,
// DNS, TLS handshake, token fetch. Anything else (timeouts, 5xx, other 4xx)
// is undefined: the caller logs and drops it.
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

// Hands `message` for one of `round`'s targets to the round's integration,
// under the send timeout. An integration this build doesn't know (rows
// written by a newer build before a rollback) or a disabled one is skipped and
// logged: that counts as sent. Any other failure is logged and the message
// dropped, except a RetryableError (nothing was sent), which is rethrown: each
// caller decides whether it holds or drops.
export async function deliverToRound(
  integrations: Record<IntegrationName, Integration>,
  round: InboxRow,
  target: ReplyTarget,
  message: Outbound,
  meta: Record<string, unknown>,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<"ok" | "dropped"> {
  const log = { ...meta, inboxId: round.id, source: round.source, targetId: target.id };
  const integration: Integration | undefined = integrations[round.source];
  if (!integration?.enabled) {
    logger.info(`${message.type} skipped: integration unknown or disabled`, log);
    return "ok";
  }
  try {
    await withTimeout(timeoutMs, (signal) =>
      integration.deliver({ signal, log: logger }, target, message),
    );
    return "ok";
  } catch (err) {
    if (err instanceof RetryableError) throw err;
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error(`deliver ${message.type} failed`, { ...log, message: e.message, stack: e.stack });
    return "dropped";
  }
}
