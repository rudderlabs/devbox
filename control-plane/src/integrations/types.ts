import type { ReplyTarget } from "../repositories/inbox.repository";
import type { Outbound, SendCtx } from "./outbound";

// One per task/round source (today's InboxSource).
export type IntegrationName = "linear" | "api" | "github";

export interface Integration {
  name: IntegrationName;

  // Outgoing. Core labels each message; the integration decides where (or
  // whether) it shows up. Throws RetryableError only before anything was sent.
  deliver(ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void>;
}
