import type { logger } from "../logger";
import type { InboxRow } from "../repositories/inbox.repository";

type Logger = typeof logger;

// What core hands to deliver(). Core says WHAT a message is; the integration
// decides WHERE (or whether) it shows up.
export type Outbound =
  | { type: "reply"; body: string } // the agent's answer
  | { type: "progress"; kind: "thought" | "action" | "error"; body: string }
  | {
      type: "failure";
      cause: "round_failed" | "task_failed" | "workspace_missing";
      round: InboxRow;
      summary?: string; // user-safe text (the harness's "what failed" summary)
      detail?: string; // raw error text (exception message): never post it on a public channel
    };
export type SendCtx = { signal: AbortSignal; log: Logger };

// Throw only before the first request is sent (token fetch failed, 429,
// connection refused, DNS, TLS handshake).
export class RetryableError extends Error {
  constructor(
    msg: string,
    readonly retryAfterMs?: number,
  ) {
    super(msg);
  }
}
