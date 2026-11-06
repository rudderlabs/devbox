import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WEBHOOK_BODY_LIMIT_BYTES } from "../requestLimits";

// POST /webhook/<name> for each of `webhooks` (the registry's enabled
// integrations that take webhooks); any other name answers 404.
export function createWebhookRoutes(
  webhooks: { name: string; webhook(c: Context): Promise<Response> }[],
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

  for (const { name, webhook } of webhooks) {
    app.post(`/webhook/${name}`, webhookBodyLimit, readLimitedWebhookBody, webhook);
  }
  return app;
}
