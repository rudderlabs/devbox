import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type {
  AgentSessionCreated,
  AgentSessionPrompted,
  HandleAgentSessionResult,
} from "../../types/agentSession";

const WEBHOOK_SECRET = "test-webhook-secret";

mock.module("../../config", () => ({
  config: {
    linear: { webhookSecret: WEBHOOK_SECRET },
  },
}));

const { LinearWebhookController } = await import("../linearWebhook.controller");
const { logger } = await import("../../logger");

type AgentSessionServiceLike = {
  handleEvent: (
    event: AgentSessionCreated | AgentSessionPrompted,
  ) => Promise<HandleAgentSessionResult>;
};

const sign = (body: string) => createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

const createdPayload = () => ({
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "ws-1",
  agentSession: {
    id: "sess-1",
    issue: {
      id: "issue-1",
      title: "Fix auth",
      description: "desc",
      url: "https://linear.app/x/issue/ISS-1",
    },
  },
});

const promptedPayload = () => ({
  type: "AgentSessionEvent",
  action: "prompted",
  organizationId: "ws-1",
  agentSession: { id: "sess-1", issue: { id: "issue-1" } },
  agentActivity: { id: "act-1", content: { body: "follow-up" } },
});

const FROZEN = new Date("2026-10-16T07:55:25.031Z");
let onSignedWebhook: ReturnType<typeof mock> = mock(() => {});

const buildApp = (service: AgentSessionServiceLike) => {
  const controller = new LinearWebhookController(
    service as never,
    onSignedWebhook as never,
    () => FROZEN,
  );
  const app = new Hono();
  app.post("/webhook/linear", (c) => controller.handleWebhook(c));
  return app;
};

const post = (app: Hono, body: string, signature?: string) =>
  app.request("/webhook/linear", {
    method: "POST",
    headers: signature ? { "linear-signature": signature } : undefined,
    body,
  });

describe("LinearWebhookController.handleWebhook", () => {
  let handleEvent: ReturnType<typeof mock>;
  let service: AgentSessionServiceLike;

  beforeEach(() => {
    onSignedWebhook = mock(() => {});
    handleEvent = mock(() => Promise.resolve({ status: "ok" }));
    service = { handleEvent: handleEvent as never };
  });

  it("returns 401 when signature header missing", async () => {
    const body = JSON.stringify(createdPayload());
    const res = await post(buildApp(service), body);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(handleEvent).not.toHaveBeenCalled();
    expect(onSignedWebhook).not.toHaveBeenCalled();
  });

  it("a request without a signature gets 401 invalid signature and records nothing", async () => {
    const res = await post(buildApp(service), "{}");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(onSignedWebhook).not.toHaveBeenCalled();
  });

  it("returns 401 when signature format is invalid", async () => {
    const body = JSON.stringify(createdPayload());
    const res = await post(buildApp(service), body, "not-hex");

    expect(res.status).toBe(401);
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("returns 401 when HMAC does not match", async () => {
    const body = JSON.stringify(createdPayload());
    const wrong = createHmac("sha256", "other-secret").update(body).digest("hex");

    const res = await post(buildApp(service), body, wrong);

    expect(res.status).toBe(401);
    expect(handleEvent).not.toHaveBeenCalled();
  });

  // The warning names the cause and nothing from the request.
  const MISMATCH = "Linear webhook rejected: signature mismatch (check LINEAR_WEBHOOK_SECRET)";

  const warnings = async (send: () => Response | Promise<Response>) => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    // Another file's mock.module stub of the logger may be shared here.
    warn.mockClear();
    try {
      const res = await send();
      return { res, calls: warn.mock.calls };
    } finally {
      warn.mockRestore();
    }
  };

  it("logs a warning when the signature does not match", async () => {
    const body = JSON.stringify(createdPayload());
    const wrong = createHmac("sha256", "other-secret").update(body).digest("hex");

    const { res, calls } = await warnings(() => post(buildApp(service), body, wrong));

    expect(res.status).toBe(401);
    expect(calls).toEqual([[MISMATCH]]);
  });

  it("logs a warning when the signature is malformed", async () => {
    const { res, calls } = await warnings(() => post(buildApp(service), "{}", "not-hex"));

    expect(res.status).toBe(401);
    expect(calls).toEqual([[MISMATCH]]);
  });

  it("logs nothing for a request without a signature (the status probe)", async () => {
    const { res, calls } = await warnings(() => post(buildApp(service), "{}"));

    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("logs nothing for a valid signature", async () => {
    const body = JSON.stringify({ type: "IssueEvent" });

    const { res, calls } = await warnings(() => post(buildApp(service), body, sign(body)));

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("returns 400 when body is invalid JSON (after signature verify)", async () => {
    const body = "not-json";
    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid json" });
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("returns 200 ignored for non-AgentSessionEvent payloads", async () => {
    const body = JSON.stringify({ type: "IssueEvent" });
    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("dispatches created event and returns 200 ok", async () => {
    const body = JSON.stringify(createdPayload());
    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(handleEvent).toHaveBeenCalledTimes(1);
    const [event] = handleEvent.mock.calls[0] ?? [];
    expect(event.action).toBe("created");
    expect(event.agentSessionId).toBe("sess-1");
    expect(event.issue.id).toBe("issue-1");
  });

  it("strips NUL bytes from prompted activity body", async () => {
    const payload = promptedPayload();
    payload.agentActivity.content.body = "hi\u0000there";
    const body = JSON.stringify(payload);

    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(200);
    const [event] = handleEvent.mock.calls[0] ?? [];
    expect(event.action).toBe("prompted");
    expect(event.activityBody).toBe("hithere");
  });

  it("returns 503 when service reports session_not_found (prompted before created)", async () => {
    handleEvent.mockResolvedValue({ status: "session_not_found" });
    const body = JSON.stringify(promptedPayload());

    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "session_not_found" });
  });

  it("returns 500 when service throws", async () => {
    handleEvent.mockImplementation(() => Promise.reject(new Error("boom")));
    const body = JSON.stringify(createdPayload());

    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("returns 200 ignored when created event lacks required issue fields", async () => {
    const payload = createdPayload();
    (payload.agentSession.issue as { id: string }).id = "";
    const body = JSON.stringify(payload);

    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("returns 200 ignored when prompted event lacks activity body", async () => {
    const body = JSON.stringify({
      type: "AgentSessionEvent",
      action: "prompted",
      organizationId: "ws-1",
      agentSession: { id: "sess-1" },
      agentActivity: { content: {} },
    });

    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("dispatches stop_requested and 200s when prompted activity has signal=stop (Linear cancel button)", async () => {
    const payload = promptedPayload() as ReturnType<typeof promptedPayload> & {
      agentActivity: { signal?: string };
    };
    payload.agentActivity.signal = "stop";
    const body = JSON.stringify(payload);

    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(handleEvent).toHaveBeenCalledTimes(1);
    const event = handleEvent.mock.calls[0]?.[0] as { action: string; agentSessionId: string };
    expect(event.action).toBe("stop_requested");
    expect(event.agentSessionId).toBe("sess-1");
  });

  it("acknowledges a signed unknown type and records it", async () => {
    const body = JSON.stringify({ type: "DevboxSetupCheck", nonce: "n" });
    const res = await post(buildApp(service), body, sign(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(onSignedWebhook).toHaveBeenCalledWith(FROZEN);
  });

  it("rejects a badly signed payload without recording", async () => {
    const body = JSON.stringify({ type: "DevboxSetupCheck", nonce: "n" });
    const res = await post(buildApp(service), body, "0".repeat(64));

    expect(res.status).toBe(401);
    expect(onSignedWebhook).not.toHaveBeenCalled();
  });
});
