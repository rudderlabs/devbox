import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { config } from "../config";
import { logger } from "../logger";
import type { AgentSessionService } from "../services/agentSession.service";
import type { ParsedAgentSessionEvent } from "../types/agentSession";

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

type MaybeRecord = Record<string, unknown> | null | undefined;
const asRecord = (v: unknown): MaybeRecord =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;

export class LinearWebhookController {
  private readonly agentSessionService: AgentSessionService;

  private readonly onSignedWebhook: (at: Date) => void;
  private readonly now: () => Date;

  constructor(
    agentSessionService: AgentSessionService,
    onSignedWebhook: (at: Date) => void,
    now: () => Date = () => new Date(),
  ) {
    this.agentSessionService = agentSessionService;
    this.onSignedWebhook = onSignedWebhook;
    this.now = now;
  }

  async handleWebhook(c: Context): Promise<Response> {
    const body = await c.req.text();
    const signature = c.req.header("linear-signature");

    const secret = config.linear?.webhookSecret;
    if (!secret || !signature || !this.verifySignature(body, signature, secret)) {
      // A signed request that fails is most likely Linear with a secret that
      // differs from LINEAR_WEBHOOK_SECRET; an unsigned one (linear:status's
      // probe) is expected and not logged. Nothing from the request is logged.
      if (secret && signature) {
        logger.warn("Linear webhook rejected: signature mismatch (check LINEAR_WEBHOOK_SECRET)");
      }
      return c.json({ error: "invalid signature" }, 401);
    }

    this.onSignedWebhook(this.now());

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const event = this.parseAgentSessionEvent(payload);
    if (!event) return c.json({ status: "ignored" }, 200);

    try {
      const result = await this.agentSessionService.handleEvent(event);
      if (result.status === "session_not_found") {
        // `prompted` arrived before `created`. Return 5xx so Linear retries
        // after the `created` event lands. (Linear only retries on 5xx.)
        return c.json({ error: "session_not_found" }, 503);
      }
      return c.json({ status: "ok" }, 200);
    } catch (err) {
      return this.handleError(c, err, event);
    }
  }

  private verifySignature(body: string, signature: string, secret: string): boolean {
    if (!HEX_SHA256.test(signature)) return false;
    const expected = createHmac("sha256", secret).update(body).digest();
    const provided = Buffer.from(signature, "hex");
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(expected, provided);
  }

  private parseAgentSessionEvent(payload: unknown): ParsedAgentSessionEvent | null {
    const p = asRecord(payload);
    if (!p || p.type !== "AgentSessionEvent") return null;
    const action = p.action;
    const session = asRecord(p.agentSession);
    const agentSessionId = session && typeof session.id === "string" ? session.id : null;
    if (!agentSessionId) return null;

    if (action === "created") {
      const issue = session && asRecord(session.issue);
      if (
        !issue ||
        typeof issue.id !== "string" ||
        issue.id.length === 0 ||
        typeof issue.title !== "string" ||
        typeof issue.url !== "string" ||
        issue.url.length === 0
      ) {
        return null;
      }
      return {
        action: "created",
        agentSessionId,
        issue: {
          id: issue.id,
          title: issue.title,
          description: typeof issue.description === "string" ? issue.description : "",
          url: issue.url,
        },
      };
    }

    if (action === "prompted") {
      const activity = asRecord(p.agentActivity);
      // Linear cancel button emits a `prompted` event with `agentActivity.signal === "stop"`.
      // We don't support cancellation yet — surface the limitation back to the
      // user as a Linear response instead of dropping it as a comment.
      if (activity && activity.signal === "stop") {
        return { action: "stop_requested", agentSessionId };
      }
      const content = activity && asRecord(activity.content);
      const body = content && typeof content.body === "string" ? content.body : null;
      // `prompted` routes by Linear issue id (a fresh agent session is minted
      // per re-prompt) and the agent-activity id is the inbox idempotency key.
      // Both required — without them the comment can't be enqueued/routed.
      const issue = session && asRecord(session.issue);
      const issueId =
        issue && typeof issue.id === "string" && issue.id.length > 0 ? issue.id : null;
      const activityId =
        activity && typeof activity.id === "string" && activity.id.length > 0 ? activity.id : null;
      // Postgres jsonb rejects NUL bytes; strip them out rather than 500-ing the handler.
      if (!body || !issueId || !activityId) return null;
      return {
        action: "prompted",
        agentSessionId,
        issue: { id: issueId },
        activityId,
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping NUL before jsonb insert
        activityBody: body.replace(/\u0000/g, ""),
      };
    }

    return null;
  }

  private handleError(c: Context, err: unknown, event: ParsedAgentSessionEvent): Response {
    const e = err instanceof Error ? err : new Error(String(err));
    const cause =
      e.cause instanceof Error ? { message: e.cause.message, stack: e.cause.stack } : e.cause;
    logger.error("handleAgentSessionEvent failed", {
      action: event.action,
      agentSessionId: event.agentSessionId,
      message: e.message,
      cause,
      stack: e.stack,
    });
    return c.json({ error: "internal" }, 500);
  }
}
