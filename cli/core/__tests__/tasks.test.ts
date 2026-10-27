import { describe, expect, it } from "bun:test";
import { task } from "../../__tests__/fixtures";
import { apiError, createStub, stubApi } from "../../__tests__/stub";
import { ApiFailure } from "../api";
import { roundStart } from "../events";
import { createTask, listTasks, restartTask, sendMessage, showTask } from "../tasks";

describe("listTasks", () => {
  const page = (keys: string[], next: string | null) => ({
    tasks: keys.map((key) => task({ key, id: `id-${key}` })),
    next_before: next,
  });

  it("follows next_before until the last page", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks", (c) => {
      const before = c.req.query("before");
      if (!before) return c.json(page(["DBX-API-3"], "id-DBX-API-3"));
      if (before === "id-DBX-API-3") return c.json(page(["DBX-API-2"], "id-DBX-API-2"));
      return c.json(page(["DBX-API-1"], null));
    });
    const tasks = await listTasks(stubApi(stub), { source: "api", mine: true, state: "idle" });
    expect(tasks.map((t) => t.key)).toEqual(["DBX-API-3", "DBX-API-2", "DBX-API-1"]);
    expect(stub.requests.map((r) => r.path)).toEqual([
      "/api/tasks?source=api&created_by=me&state=idle&limit=100",
      "/api/tasks?source=api&created_by=me&state=idle&limit=100&before=id-DBX-API-3",
      "/api/tasks?source=api&created_by=me&state=idle&limit=100&before=id-DBX-API-2",
    ]);
  });

  it("stops at the limit and sizes the last request", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks", (c) => {
      const limit = Number(c.req.query("limit"));
      const keys = Array.from(
        { length: limit },
        (_, i) => `K-${c.req.query("before") ?? "a"}-${i}`,
      );
      return c.json(page(keys, `next-${limit}`));
    });
    const tasks = await listTasks(stubApi(stub), { mine: false, limit: 150 });
    expect(tasks).toHaveLength(150);
    expect(stub.requests.map((r) => r.path)).toEqual([
      "/api/tasks?limit=100",
      "/api/tasks?limit=50&before=next-100",
    ]);
  });
});

describe("showTask", () => {
  it("gets the task by ref", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks/ABC-1", (c) => c.json(task({ key: "ABC-1", source: "linear" })));
    expect(await showTask(stubApi(stub), "ABC-1")).toEqual(
      task({ key: "ABC-1", source: "linear" }),
    );
  });
});

describe("createTask", () => {
  it("posts only the given fields", async () => {
    const stub = createStub();
    stub.app.post("/api/tasks", (c) => c.json(task(), 201));
    const api = stubApi(stub);

    expect(await createTask(api, { title: "Fix flaky test", experimentalFlags: [] })).toEqual({
      task: task(),
      from: { round: roundStart.created() },
    });
    await createTask(api, { title: "T", description: "D", experimentalFlags: ["FOO"] });
    expect(stub.requests.map((r) => r.body)).toEqual([
      { title: "Fix flaky test" },
      { title: "T", description: "D", experimental_flags: ["FOO"] },
    ]);
  });
});

describe("sendMessage", () => {
  it("posts the body", async () => {
    const stub = createStub();
    stub.app.post("/api/tasks/DBX-API-7/messages", (c) => c.json({ round_id: "round-2" }, 202));
    expect(await sendMessage(stubApi(stub), { ref: "DBX-API-7", body: "also the docs" })).toEqual({
      message: { round_id: "round-2" },
      from: { round: roundStart.message("round-2") },
    });
    expect(stub.requests[0]?.body).toEqual({ body: "also the docs" });
  });
});

describe("restartTask", () => {
  it("restarts with the current definition, overrides applied, by the task's key", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks/dbx-api-7", (c) => c.json(task({ experimental_flags: ["OLD"] })));
    stub.app.post("/api/tasks/DBX-API-7/restart", (c) => c.json(task(), 202));

    expect(
      await restartTask(stubApi(stub), { ref: "dbx-api-7", experimentalFlags: ["NEW"] }),
    ).toEqual({
      task: task(),
      from: { round: roundStart.restarted() },
    });
    expect(stub.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ["GET", "/api/tasks/dbx-api-7", undefined],
      [
        "POST",
        "/api/tasks/DBX-API-7/restart",
        {
          title: "Fix flaky test",
          description: "The test fails on CI.",
          experimental_flags: ["NEW"],
        },
      ],
    ]);
  });

  it("replaces title and description and keeps the flags", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks/DBX-API-7", (c) => c.json(task({ experimental_flags: ["KEEP"] })));
    stub.app.post("/api/tasks/DBX-API-7/restart", (c) => c.json(task(), 202));
    await restartTask(stubApi(stub), { ref: "DBX-API-7", title: "New", description: "New text" });
    expect(stub.requests[1]?.body).toEqual({
      title: "New",
      description: "New text",
      experimental_flags: ["KEEP"],
    });
  });

  it("passes the API's 409 for a Linear task through", async () => {
    const stub = createStub();
    stub.app.get("/api/tasks/ABC-1", (c) => c.json(task({ key: "ABC-1", source: "linear" })));
    stub.app.post("/api/tasks/ABC-1/restart", () =>
      apiError(409, "not_api_task", "ABC-1 is a Linear task"),
    );
    const err = await restartTask(stubApi(stub), { ref: "ABC-1" }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).code).toBe("not_api_task");
  });
});
