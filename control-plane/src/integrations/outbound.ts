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
      // User-safe text: the harness's "what failed" summary, or core's
      // workspace_missing notice (WORKSPACE_MISSING_MESSAGE).
      summary?: string;
      detail?: string; // raw error text (exception message): never post it on a public channel
    };
export type SendCtx = { signal: AbortSignal; log: Logger };

// What a workspace_missing notice tells the user, wherever it is shown.
export const WORKSPACE_MISSING_MESSAGE =
  "The workspace for this task has been cleaned up and can no longer be resumed. " +
  "Please reach out to the harness team or open a new ticket to continue.";

// Throw only before the first request is sent (a transient token failure,
// 429, connection refused, DNS, TLS handshake).
export class RetryableError extends Error {
  constructor(
    msg: string,
    readonly retryAfterMs?: number,
  ) {
    super(msg);
  }
}
