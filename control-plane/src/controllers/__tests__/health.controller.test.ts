import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { HealthController } from "../health.controller";

const execute = mock(() => Promise.resolve());

describe("HealthController.check", () => {
  let app: Hono;

  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue(undefined);
    const controller = new HealthController({ execute });
    app = new Hono().get("/health", (c) => controller.check(c));
  });

  it("returns 200 + {status:ok, db:up} when DB probe succeeds", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "up" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns 503 + {status:error, db:down} when DB probe rejects", async () => {
    execute.mockImplementation(() => Promise.reject(new Error("connection refused")));

    const res = await app.request("/health");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error", db: "down" });
  });

  it("does not leak raw DB error details in the 503 response body", async () => {
    execute.mockImplementation(() =>
      Promise.reject(new Error("FATAL: password auth failed for user harness")),
    );

    const res = await app.request("/health");

    const body = await res.text();
    expect(body).not.toContain("password");
    expect(body).not.toContain("harness");
  });
});
