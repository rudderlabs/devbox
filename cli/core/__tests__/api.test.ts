import { describe, expect, it } from "bun:test";
import { task } from "../../__tests__/fixtures";
import { apiError, createStub, sse, stubApi, TOKEN } from "../../__tests__/stub";
import { ApiClient, ApiFailure, isFatal } from "../api";

function failure(p: Promise<unknown>): Promise<ApiFailure> {
  return p.then(
    () => {
      throw new Error("expected an ApiFailure");
    },
    (err) => {
      expect(err).toBeInstanceOf(ApiFailure);
      return err as ApiFailure;
    },
  );
}

const fields = (err: ApiFailure) => ({ status: err.status, code: err.code, message: err.message });

describe("ApiClient", () => {
  it("sends the bearer token and JSON bodies", async () => {
    const stub = createStub();
    stub.app.post("/api/tasks", (c) => c.json(task(), 201));

    expect(await stubApi(stub).createTask({ title: "Fix flaky test" })).toEqual(task());
    expect(stub.requests).toEqual([
      {
        method: "POST",
        path: "/api/tasks",
        authorization: `Bearer ${TOKEN}`,
        lastEventId: null,
        body: { title: "Fix flaky test" },
      },
    ]);
  });

  it("sends no Authorization header without a token", async () => {
    const stub = createStub();
    stub.app.get("/api/me", (c) => c.json({ token: null, auth: "disabled" }));
    await stubApi(stub, null).me();
    expect(stub.requests[0]?.authorization).toBeNull();
  });

  it("builds list queries and encodes refs", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks", (c) => c.json({ tasks: [], next_before: null }));
    stub.app.get("/api/tasks/:ref/events", (c) =>
      c.json({ events: [], next_after: 5, logging: "available" }),
    );
    const api = stubApi(stub);

    await api.listTasks({
      source: "api",
      created_by: "me",
      state: "idle",
      limit: 100,
      before: "x",
    });
    await api.listTasks({ limit: 100 });
    await api.listEvents("DBX API/7", 5, 1000);
    expect(stub.requests.map((r) => r.path)).toEqual([
      "/api/tasks?source=api&created_by=me&state=idle&limit=100&before=x",
      "/api/tasks?limit=100",
      "/api/tasks/DBX%20API%2F7/events?after=5&limit=1000",
    ]);
  });

  it("maps the API error body", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks/:ref", () => apiError(404, "task_not_found", 'no task matches "X"'));
    expect(fields(await failure(stubApi(stub).getTask("X")))).toEqual({
      status: 404,
      code: "task_not_found",
      message: 'no task matches "X" (404 task_not_found)',
    });
  });

  it("maps a non-JSON error (e.g. the ALB's 502)", async () => {
    const stub = createStub();
    stub.app.get("/api/me", () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(fields(await failure(stubApi(stub).me()))).toEqual({
      status: 502,
      code: "http_502",
      message: "HTTP 502 from http://cp.test",
    });
  });

  // The token never reaches an error message.
  it("reports an unreachable API without the token", async () => {
    const down = (async () => {
      throw new TypeError("Unable to connect");
    }) as unknown as typeof fetch;
    const err = await failure(new ApiClient({ url: "http://cp.test", token: TOKEN }, down).me());
    expect(fields(err)).toEqual({
      status: null,
      code: "unreachable",
      message: "cannot reach http://cp.test: Unable to connect",
    });
  });

  it("never puts the token in a 401 message", async () => {
    const stub = createStub();
    stub.app.get("/api/me", () => apiError(401, "unauthorized", "invalid or missing token"));
    const err = await failure(stubApi(stub).me());
    expect(err.message).toBe("invalid or missing token (401 unauthorized)");
    expect(err.message).not.toContain("SECRET");
  });

  it("opens the stream with Last-Event-ID", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks/:ref/events/stream", () => sse([": hi\n\n"]));

    const body = await stubApi(stub).openStream("DBX-API-7", "41", new AbortController().signal);
    expect(await new Response(body).text()).toBe(": hi\n\n");
    expect(stub.requests[0]?.lastEventId).toBe("41");
  });

  // An SSO or ingress login page answers 200 with HTML.
  const loginPage = () =>
    new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });

  it("rejects a 2xx answer that is not JSON", async () => {
    const stub = createStub();
    stub.app.get("/api/me", loginPage);
    expect(fields(await failure(stubApi(stub).me()))).toEqual({
      status: 200,
      code: "invalid_response",
      message: "unexpected response from http://cp.test: not JSON",
    });
  });

  it("rejects a stream answer that is not an event stream", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks/:ref/events/stream", loginPage);
    const err = await failure(
      stubApi(stub).openStream("DBX-API-7", undefined, new AbortController().signal),
    );
    expect(fields(err)).toEqual({
      status: 200,
      code: "invalid_response",
      message: "unexpected response from http://cp.test: not an event stream",
    });
  });

  it("isFatal: 4xx and invalid responses", () => {
    expect(isFatal(new ApiFailure(200, "invalid_response", ""))).toBe(true);
    expect(isFatal(new ApiFailure(401, "unauthorized", ""))).toBe(true);
    expect(isFatal(new ApiFailure(404, "task_not_found", ""))).toBe(true);
    expect(isFatal(new ApiFailure(409, "not_api_task", ""))).toBe(true);
    expect(isFatal(new ApiFailure(503, "http_503", ""))).toBe(false);
    expect(isFatal(new ApiFailure(null, "unreachable", ""))).toBe(false);
    expect(isFatal(new Error("connection reset"))).toBe(false);
  });
});
