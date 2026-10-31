import { describe, expect, it, mock, spyOn } from "bun:test";
import { ApiError } from "../../errors";
import { fakeIntegrations } from "../../integrations/__tests__/fakeIntegrations";
import { logger } from "../../logger";
import { createApiRoutes } from "../../routes/api";
import type { ApiTask } from "../../types/api";
import { ApiController, type ApiTaskServicePort } from "../api.controller";

const ID = "0192f000-0000-7000-8000-000000000001";
const TOKEN_ID = "0192f000-0000-7000-8000-0000000000ff";
const T0 = "2026-10-07T12:00:00.000Z";
const principal = { tokenId: TOKEN_ID, name: "frodo" };

const task: ApiTask = {
  id: ID,
  key: "DBX-API-1",
  source: "api",
  title: "T",
  description: null,
  external_url: "https://api.example/api/tasks/DBX-API-1",
  created_by: { id: TOKEN_ID, name: "frodo" },
  experimental_flags: [],
  state: "queued",
  sandbox_live: false,
  prs: [],
  rounds: [],
  created_at: T0,
  updated_at: T0,
};

const UNAUTHORIZED = { error: { code: "unauthorized", message: "Missing or invalid API token" } };

function setup(opts: { authEnabled: boolean; allowedHosts?: string[] }) {
  const service = {
    create: mock(() => Promise.resolve(task)),
    list: mock(() => Promise.resolve({ tasks: [task], next_before: null })),
    get: mock(() => Promise.resolve(task)),
    sendMessage: mock(() => Promise.resolve({ round_id: "r-1" })),
    restart: mock(() => Promise.resolve(task)),
    events: mock(() =>
      Promise.resolve({ events: [], next_after: 0, logging: "available" as const }),
    ),
    streamTarget: mock(() => Promise.resolve({ id: ID, source: "api" as const })),
    streamState: mock(() => Promise.resolve({ state: "queued" as const, sandbox_live: false })),
    eventsAfter: mock(() => Promise.resolve([])),
  };
  const auth = {
    authenticate: mock((h: string | undefined) =>
      Promise.resolve(h === "Bearer good" ? principal : null),
    ),
  };
  const controller = new ApiController(service as unknown as ApiTaskServicePort, {
    authEnabled: opts.authEnabled,
    ssePollMs: 1000,
    sseMaxDurationMs: 2000,
    clock: { now: () => 0, sleep: async () => {} },
  });
  const app = createApiRoutes(controller, auth, {
    authEnabled: opts.authEnabled,
    allowedHosts: opts.allowedHosts ?? [],
    integrations: fakeIntegrations({
      linear: { status: async () => LINEAR_STATUS },
      github: { status: async () => GITHUB_STATUS },
      api: { status: async () => ({ enabled: true }) },
    }),
  });
  const req = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    app.request(path, {
      ...init,
      headers: {
        ...(opts.authEnabled ? { authorization: "Bearer good" } : {}),
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  return { service, auth, app, req };
}

const LINEAR_STATUS = {
  configured: true as const,
  workspace: { id: "org-1", name: "Example", urlKey: "example" },
  appUser: { id: "app-1", name: "Devbox" },
  lastWebhookAt: "2026-10-16T07:55:25.031Z",
  lastTokenError: null,
};

const GITHUB_STATUS = {
  token: {
    source: "file" as const,
    expiresAt: "2026-10-19T12:31:00Z",
    readAt: "2026-10-19T11:32:10.000Z",
    lastError: null,
  },
  webhooks: { enabled: true, lastWebhookAt: "2026-10-19T11:20:02.000Z", ciResults: true },
};

const routes: Array<[string, string, unknown?]> = [
  ["POST", "/api/tasks", { title: "T" }],
  ["GET", "/api/tasks"],
  ["GET", "/api/tasks/DBX-API-1"],
  ["POST", "/api/tasks/DBX-API-1/messages", { body: "hi" }],
  ["POST", "/api/tasks/DBX-API-1/restart", { title: "T" }],
  ["GET", "/api/tasks/DBX-API-1/events"],
  ["GET", "/api/me"],
  ["GET", "/api/integrations/linear"],
  ["GET", "/api/integrations/github"],
  ["GET", "/api/integrations/api"],
];

describe("ApiController", () => {
  it("GET /api/integrations/linear returns the status body", async () => {
    const { req } = setup({ authEnabled: true });
    const res = await req("/api/integrations/linear");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LINEAR_STATUS);
  });

  it("GET /api/integrations/github returns the status body", async () => {
    const { req } = setup({ authEnabled: true });
    const res = await req("/api/integrations/github");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GITHUB_STATUS);
  });

  it("GET /api/integrations/api returns the status body; an unknown name is 404", async () => {
    const { req } = setup({ authEnabled: true });
    expect(await (await req("/api/integrations/api")).json()).toEqual({ enabled: true });
    for (const name of ["jira", "constructor"]) {
      expect((await req(`/api/integrations/${name}`)).status).toBe(404);
    }
  });

  describe("auth on", () => {
    it.each(routes)(
      "%s %s without a token is 401 with the uniform body",
      async (method, path, json) => {
        const { app, service } = setup({ authEnabled: true });
        const res = await app.request(path, {
          method,
          body: json ? JSON.stringify(json) : undefined,
        });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual(UNAUTHORIZED);
        expect(service.create).not.toHaveBeenCalled();
      },
    );

    it.each(routes)("%s %s with a bad token is 401 with the same body", async (method, path) => {
      const { app } = setup({ authEnabled: true });
      const res = await app.request(path, { method, headers: { authorization: "Bearer bad" } });
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 401,
        body: UNAUTHORIZED,
      });
    });

    it("POST /api/tasks → 201 with the task; the principal and normalized input reach the service", async () => {
      const { req, service } = setup({ authEnabled: true });
      const res = await req("/api/tasks", {
        method: "POST",
        json: { title: "T", experimental_flags: ["FOO", "FOO"] },
      });
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 201, body: task });
      expect(service.create).toHaveBeenCalledWith(principal, {
        title: "T",
        description: null,
        experimentalFlags: ["FOO"],
      });
    });

    it("GET /api/tasks → 200 with filters parsed", async () => {
      const { req, service } = setup({ authEnabled: true });
      const res = await req(`/api/tasks?source=api&created_by=me&state=idle&limit=5&before=${ID}`);
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 200,
        body: { tasks: [task], next_before: null },
      });
      expect(service.list).toHaveBeenCalledWith(principal, {
        source: "api",
        createdBy: "me",
        state: "idle",
        limit: 5,
        before: ID,
      });
    });

    it("GET /api/tasks defaults limit to 20", async () => {
      const { req, service } = setup({ authEnabled: true });
      await req("/api/tasks");
      expect(service.list).toHaveBeenCalledWith(principal, { limit: 20 });
    });

    it("GET /api/tasks/:ref → 200", async () => {
      const { req, service } = setup({ authEnabled: true });
      const res = await req("/api/tasks/DBX-API-1");
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: task });
      expect(service.get).toHaveBeenCalledWith("DBX-API-1");
    });

    it("POST /messages → 202 { round_id }", async () => {
      const { req, service } = setup({ authEnabled: true });
      const res = await req("/api/tasks/DBX-API-1/messages", {
        method: "POST",
        json: { body: "hi" },
      });
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 202,
        body: { round_id: "r-1" },
      });
      expect(service.sendMessage).toHaveBeenCalledWith("DBX-API-1", "hi");
    });

    it("POST /restart → 202 with the task; omitted optional fields become null and []", async () => {
      const { req, service } = setup({ authEnabled: true });
      const res = await req("/api/tasks/DBX-API-1/restart", {
        method: "POST",
        json: { title: "T2" },
      });
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 202, body: task });
      expect(service.restart).toHaveBeenCalledWith("DBX-API-1", {
        title: "T2",
        description: null,
        experimentalFlags: [],
      });
    });

    it("POST /restart with the full definition passes every field", async () => {
      const { req, service } = setup({ authEnabled: true });
      const res = await req("/api/tasks/DBX-API-1/restart", {
        method: "POST",
        json: { title: "T2", description: "D2", experimental_flags: ["FOO"] },
      });
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 202, body: task });
      expect(service.restart).toHaveBeenCalledWith("DBX-API-1", {
        title: "T2",
        description: "D2",
        experimentalFlags: ["FOO"],
      });
    });

    it("GET /events → 200 with after/limit parsed", async () => {
      const { req, service } = setup({ authEnabled: true });
      const res = await req("/api/tasks/DBX-API-1/events?after=7&limit=1000");
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 200,
        body: { events: [], next_after: 0, logging: "available" },
      });
      expect(service.events).toHaveBeenCalledWith("DBX-API-1", 7, 1000);
    });

    it("GET /api/me → the token", async () => {
      const { req } = setup({ authEnabled: true });
      expect(await (await req("/api/me")).json()).toEqual({
        token: { id: TOKEN_ID, name: "frodo" },
      });
    });
  });

  describe("auth off", () => {
    it.each(routes)("%s %s works without a token", async (method, path, json) => {
      const { req } = setup({ authEnabled: false });
      const res = await req(path, { method, json });
      expect([200, 201, 202]).toContain(res.status);
    });

    it("principal is null and /api/me reports auth disabled", async () => {
      const { req, service, auth } = setup({ authEnabled: false });
      await req("/api/tasks", { method: "POST", json: { title: "T" } });
      expect(service.create).toHaveBeenCalledWith(null, {
        title: "T",
        description: null,
        experimentalFlags: [],
      });
      expect(await (await req("/api/me")).json()).toEqual({ token: null, auth: "disabled" });
      expect(auth.authenticate).not.toHaveBeenCalled();
    });
  });

  describe("errors", () => {
    const bad = (message: string) => ({
      status: 400,
      body: { error: { code: "invalid_request", message } },
    });

    it.each([
      [{}, "title must be a string of 1 to 256 characters"],
      [{ title: "   " }, "title must be a string of 1 to 256 characters"],
      [{ title: "x".repeat(257) }, "title must be a string of 1 to 256 characters"],
      [{ title: "T", description: 5 }, "description must be a string or null"],
      [
        { title: "T", experimental_flags: "FOO" },
        "experimental_flags must be an array of at most 16 flag names",
      ],
      [
        { title: "T", experimental_flags: Array.from({ length: 17 }, (_, i) => `F${i}`) },
        "experimental_flags must be an array of at most 16 flag names",
      ],
      [
        { title: "T", experimental_flags: ["lower"] },
        'experimental_flags: "lower" is not a valid flag name',
      ],
    ])("POST /api/tasks %j → 400", async (json, message) => {
      const { req } = setup({ authEnabled: false });
      const res = await req("/api/tasks", { method: "POST", json });
      expect({ status: res.status, body: await res.json() }).toEqual(bad(message));
    });

    it("malformed JSON → 400", async () => {
      const { req } = setup({ authEnabled: false });
      const res = await req("/api/tasks", {
        method: "POST",
        body: "{",
        headers: { "content-type": "application/json" },
      });
      expect({ status: res.status, body: await res.json() }).toEqual(
        bad("Request body must be a JSON object"),
      );
    });

    it.each([
      ["malformed", "{"],
      ["non-object", "[]"],
    ])("POST /restart with a %s body → 400", async (_label, body) => {
      const { req, service } = setup({ authEnabled: false });
      const res = await req("/api/tasks/DBX-API-1/restart", { method: "POST", body });
      expect({ status: res.status, body: await res.json() }).toEqual(
        bad("Request body must be a JSON object"),
      );
      expect(service.restart).not.toHaveBeenCalled();
    });

    it.each([
      ["no body", {}],
      ["Content-Length: 0", { body: "", headers: { "content-length": "0" } }],
    ])("POST /restart with %s → 400", async (_label, init) => {
      const { req, service } = setup({ authEnabled: false });
      const res = await req("/api/tasks/DBX-API-1/restart", { method: "POST", ...init });
      expect({ status: res.status, body: await res.json() }).toEqual(
        bad("Request body must be a JSON object"),
      );
      expect(service.restart).not.toHaveBeenCalled();
    });

    it("POST /restart without a title → 400 with the title message", async () => {
      const { req, service } = setup({ authEnabled: false });
      const res = await req("/api/tasks/DBX-API-1/restart", {
        method: "POST",
        json: { description: "D" },
      });
      expect({ status: res.status, body: await res.json() }).toEqual(
        bad("title must be a string of 1 to 256 characters"),
      );
      expect(service.restart).not.toHaveBeenCalled();
    });

    const OVERSIZED = JSON.stringify({ title: "T", description: "x".repeat(256 * 1024) });

    it("a body over 256 KiB with Content-Length → 400 too large", async () => {
      const { req, service } = setup({ authEnabled: false });
      const res = await req("/api/tasks", {
        method: "POST",
        body: OVERSIZED,
        headers: { "content-length": String(Buffer.byteLength(OVERSIZED)) },
      });
      expect({ status: res.status, body: await res.json() }).toEqual(
        bad("Request body is too large"),
      );
      expect(service.create).not.toHaveBeenCalled();
    });

    it("a body over 256 KiB without Content-Length (chunked) → 400 too large", async () => {
      const { req, service } = setup({ authEnabled: false });
      const bytes = new TextEncoder().encode(OVERSIZED);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 64 * 1024) {
            controller.enqueue(bytes.subarray(i, i + 64 * 1024));
          }
          controller.close();
        },
      });
      const res = await req("/api/tasks", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit);
      expect({ status: res.status, body: await res.json() }).toEqual(
        bad("Request body is too large"),
      );
      expect(service.create).not.toHaveBeenCalled();
    });

    it("description limit counts UTF-8 bytes", async () => {
      const { req } = setup({ authEnabled: false });
      const ok = await req("/api/tasks", {
        method: "POST",
        json: { title: "T", description: "😀".repeat(16384) },
      });
      expect(ok.status).toBe(201);
      const tooBig = await req("/api/tasks", {
        method: "POST",
        json: { title: "T", description: "😀".repeat(16385) },
      });
      expect({ status: tooBig.status, body: await tooBig.json() }).toEqual(
        bad("description must be at most 65536 bytes"),
      );
    });

    it("message body: required, at most 64 KiB", async () => {
      const { req } = setup({ authEnabled: false });
      for (const [json, message] of [
        [{}, "body must be a non-empty string"],
        [{ body: "" }, "body must be a non-empty string"],
        [{ body: "a".repeat(65537) }, "body must be at most 65536 bytes"],
      ] as const) {
        const res = await req("/api/tasks/DBX-API-1/messages", { method: "POST", json });
        expect({ status: res.status, body: await res.json() }).toEqual(bad(message));
      }
    });

    it("non-UUID query values are 400; a non-UUID non-key ref is 404", async () => {
      const { req, service } = setup({ authEnabled: false });
      for (const [path, message] of [
        ["/api/tasks?before=abc", "before must be a task id"],
        ["/api/tasks?created_by=abc", 'created_by must be "me" or a token id'],
        ["/api/tasks?limit=0", "limit must be an integer from 1 to 100"],
        ["/api/tasks?limit=101", "limit must be an integer from 1 to 100"],
        ["/api/tasks?state=done", "state must be one of queued, running, idle, failed"],
        ["/api/tasks?source=github", "source must be linear or api"],
        ["/api/tasks/DBX-API-1/events?after=-1", "after must be a non-negative integer"],
        ["/api/tasks/DBX-API-1/events?limit=1001", "limit must be an integer from 1 to 1000"],
      ] as const) {
        const res = await req(path);
        expect({ path, status: res.status, body: await res.json() }).toEqual({
          path,
          ...bad(message),
        });
      }
      service.get.mockRejectedValueOnce(new ApiError(404, "task_not_found", "Task not found"));
      const res = await req("/api/tasks/%27%3B--");
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 404,
        body: { error: { code: "task_not_found", message: "Task not found" } },
      });
    });

    it("409 not_api_task is passed through", async () => {
      const { req, service } = setup({ authEnabled: false });
      service.sendMessage.mockRejectedValueOnce(
        new ApiError(409, "not_api_task", "Only API tasks can be changed through the API"),
      );
      const res = await req("/api/tasks/ABC-1/messages", { method: "POST", json: { body: "x" } });
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 409,
        body: {
          error: { code: "not_api_task", message: "Only API tasks can be changed through the API" },
        },
      });
    });

    it("unexpected errors are 500 internal with a generic message", async () => {
      const { req, service } = setup({ authEnabled: false });
      service.get.mockRejectedValueOnce(new Error("connection refused at 10.0.0.1 password=x"));
      const res = await req("/api/tasks/DBX-API-1");
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 500,
        body: { error: { code: "internal", message: "Internal error" } },
      });
    });

    it("an auth backend failure logs its message and stack, never the header", async () => {
      const { app, auth } = setup({ authEnabled: true });
      const err = new Error("db down");
      auth.authenticate.mockRejectedValueOnce(err);
      const error = spyOn(logger, "error").mockImplementation(() => logger);
      // Another file's mock.module stub of the logger may be shared here.
      error.mockClear();
      try {
        await app.request("/api/me", { headers: { authorization: "Bearer good" } });
        expect(error.mock.calls).toEqual([
          ["api auth failed", { message: "db down", stack: err.stack }],
        ]);
      } finally {
        error.mockRestore();
      }
    });

    it("an auth backend failure is 500, not 401", async () => {
      const { app, auth } = setup({ authEnabled: true });
      auth.authenticate.mockRejectedValueOnce(new Error("db down"));
      const res = await app.request("/api/me", { headers: { authorization: "Bearer good" } });
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 500,
        body: { error: { code: "internal", message: "Internal error" } },
      });
    });
  });

  describe("API_ALLOWED_HOSTS", () => {
    it("404s a host not on the list, before auth", async () => {
      const { app, auth } = setup({ authEnabled: true, allowedHosts: ["api.internal.example"] });
      const res = await app.request("http://public.example/api/me", {
        headers: { authorization: "Bearer good", host: "public.example" },
      });
      expect({ status: res.status, body: await res.text() }).toEqual({
        status: 404,
        body: "404 Not Found",
      });
      expect(auth.authenticate).not.toHaveBeenCalled();
    });

    it("API_ALLOWED_HOSTS ignores case and port", async () => {
      const { app } = setup({ authEnabled: true, allowedHosts: ["api.internal.example"] });
      const res = await app.request("http://API.Internal.Example:443/api/me", {
        headers: { authorization: "Bearer good", host: "API.Internal.Example:443" },
      });
      expect(res.status).toBe(200);
    });

    it("an empty list allows any host", async () => {
      const { app } = setup({ authEnabled: true });
      expect(
        (
          await app.request("http://anything.example/api/me", {
            headers: { authorization: "Bearer good" },
          })
        ).status,
      ).toBe(200);
    });
  });
});
