import { describe, expect, it, spyOn } from "bun:test";
import { WEBHOOK_BODY_LIMIT_BYTES } from "../requestLimits";
import { createWebhookRoutes } from "../routes/webhook";

const OVERSIZED_BODY = "x".repeat(WEBHOOK_BODY_LIMIT_BYTES + 1);

function chunkedBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 64 * 1024) {
        controller.enqueue(bytes.subarray(i, i + 64 * 1024));
      }
      controller.close();
    },
  });
}

describe("createWebhookRoutes", () => {
  it("serves neither webhook when Linear and GitHub webhooks are off", async () => {
    const app = createWebhookRoutes({});
    const linear = await app.request("/webhook/linear", { method: "POST", body: "{}" });
    const github = await app.request("/webhook/github", { method: "POST", body: "{}" });
    expect(linear.status).toBe(404);
    expect(github.status).toBe(404);
  });

  it("registers only the enabled controllers", async () => {
    const handled: string[] = [];
    const app = createWebhookRoutes({
      github: {
        handleWebhook: async (c: { json: (b: unknown, s: number) => Response }) => {
          handled.push("github");
          return c.json({ ok: true }, 200);
        },
      } as never,
    });
    expect((await app.request("/webhook/github", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await app.request("/webhook/linear", { method: "POST", body: "{}" })).status).toBe(404);
    expect(handled).toEqual(["github"]);
  });

  it("rejects an oversized GitHub body from Content-Length before the controller", async () => {
    let handled = false;
    const app = createWebhookRoutes({
      github: {
        handleWebhook: async () => {
          handled = true;
          return new Response(null, { status: 401 });
        },
      } as never,
    });

    const response = await app.request("/webhook/github", {
      method: "POST",
      body: OVERSIZED_BODY,
      headers: { "content-length": String(Buffer.byteLength(OVERSIZED_BODY)) },
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload too large" });
    expect(handled).toBe(false);
  });

  it("rejects an oversized chunked Linear body before the controller without logging an error", async () => {
    let handled = false;
    const app = createWebhookRoutes({
      linear: {
        handleWebhook: async () => {
          handled = true;
          return new Response(null, { status: 401 });
        },
      } as never,
    });
    const error = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await app.request("/webhook/linear", {
        method: "POST",
        body: chunkedBody(OVERSIZED_BODY),
        duplex: "half",
      } as RequestInit);

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "payload too large" });
      expect(handled).toBe(false);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("leaves disabled and unknown webhook routes as 404 even for oversized bodies", async () => {
    const app = createWebhookRoutes({
      github: {
        handleWebhook: async () => new Response(null, { status: 204 }),
      } as never,
    });

    for (const path of ["/webhook/linear", "/webhook/unknown"]) {
      const response = await app.request(path, {
        method: "POST",
        body: OVERSIZED_BODY,
        headers: { "content-length": String(Buffer.byteLength(OVERSIZED_BODY)) },
      });
      expect(response.status).toBe(404);
    }
  });

  it("leaves disabled and unknown webhook routes as 404 for oversized chunked bodies", async () => {
    const app = createWebhookRoutes({
      github: {
        handleWebhook: async () => new Response(null, { status: 204 }),
      } as never,
    });

    for (const path of ["/webhook/linear", "/webhook/unknown"]) {
      const response = await app.request(path, {
        method: "POST",
        body: chunkedBody(OVERSIZED_BODY),
        duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(404);
    }
  });

  it("passes unsigned under-limit bodies to enabled controllers", async () => {
    const app = createWebhookRoutes({
      linear: {
        handleWebhook: async (c: { json: (b: unknown, s: number) => Response }) =>
          c.json({ error: "invalid signature" }, 401),
      } as never,
      github: {
        handleWebhook: async (c: { json: (b: unknown, s: number) => Response }) =>
          c.json({ error: "invalid signature" }, 401),
      } as never,
    });

    for (const path of ["/webhook/linear", "/webhook/github"]) {
      const response = await app.request(path, { method: "POST", body: "{}" });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid signature" });
    }
  });
});
