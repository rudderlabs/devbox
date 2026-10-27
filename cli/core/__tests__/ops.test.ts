import { describe, expect, it } from "bun:test";
import { envelope, task } from "../../__tests__/fixtures";
import { createStub, serveEvents, stubApi } from "../../__tests__/stub";
import { bindCore } from "../ops";

describe("bindCore", () => {
  it("binds each operation to the client", async () => {
    const stub = createStub();
    stub.app.get("/api/me", (c) => c.json({ token: null, auth: "disabled" }));
    stub.app.get("/api/tasks/DBX-API-7", (c) => c.json(task()));
    serveEvents(stub, "DBX-API-7", [envelope(1, "task_created", { title: "T" })]);
    const ops = bindCore(stubApi(stub), { sleep: async () => {} });
    expect(await ops.whoami()).toEqual({ token: null, auth: "disabled" });
    expect(await ops.showTask("DBX-API-7")).toEqual(task());
    const history: number[] = [];
    for await (const e of ops.taskHistory({ ref: "DBX-API-7", after: 0 })) history.push(e.id);
    expect(history).toEqual([1]);
  });
});
