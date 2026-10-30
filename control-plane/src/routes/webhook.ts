import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { TaskIntake } from "../integrations/intake";
import type { Integration } from "../integrations/types";
import { WEBHOOK_BODY_LIMIT_BYTES } from "../requestLimits";

// POST /webhook/<name> is registered only for an enabled integration that has
// a webhook; any other name answers 404.
export function createWebhookRoutes(
  integrations: Pick<Integration, "name" | "enabled" | "webhook">[],
  intake: TaskIntake,
): Hono {
  const app = new Hono();

  const payloadTooLarge = (c: Context) => c.json({ error: "payload too large" }, 413);
  const webhookBodyLimit = bodyLimit({
    maxSize: WEBHOOK_BODY_LIMIT_BYTES,
    onError: payloadTooLarge,
  });
  const readLimitedWebhookBody: MiddlewareHandler = async (c, next) => {
    try {
      // Force streaming bodies through bodyLimit before a controller runs. The
      // cached raw text remains available for exact-byte HMAC verification.
      await c.req.text();
    } catch (err) {
      if (err instanceof Error && err.name === "BodyLimitError") {
        return payloadTooLarge(c);
      }
      throw err;
    }
    await next();
  };

  for (const integration of integrations) {
    const webhook = integration.webhook?.bind(integration);
    if (!integration.enabled || !webhook) continue;
    app.post(`/webhook/${integration.name}`, webhookBodyLimit, readLimitedWebhookBody, (c) =>
      webhook(c, intake),
    );
  }
  return app;
}
