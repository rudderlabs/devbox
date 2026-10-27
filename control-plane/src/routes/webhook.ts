import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GitHubWebhookController } from "../controllers/githubWebhook.controller";
import type { LinearWebhookController } from "../controllers/linearWebhook.controller";
import { WEBHOOK_BODY_LIMIT_BYTES } from "../requestLimits";

// Each webhook is registered only when its integration is configured; an
// unconfigured one answers 404.
export function createWebhookRoutes(controllers: {
  linear?: LinearWebhookController;
  github?: GitHubWebhookController;
}): Hono {
  const app = new Hono();
  const { linear, github } = controllers;

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

  if (linear)
    app.post("/webhook/linear", webhookBodyLimit, readLimitedWebhookBody, (c) =>
      linear.handleWebhook(c),
    );
  if (github)
    app.post("/webhook/github", webhookBodyLimit, readLimitedWebhookBody, (c) =>
      github.handleWebhook(c),
    );
  return app;
}
