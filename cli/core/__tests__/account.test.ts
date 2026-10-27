import { describe, expect, it } from "bun:test";
import { createStub, stubApi } from "../../__tests__/stub";
import { whoami } from "../account";

describe("whoami", () => {
  it("returns /api/me", async () => {
    const stub = createStub();
    stub.app.get("/api/me", (c) => c.json({ token: { id: "tok-1", name: "frodo" } }));
    expect(await whoami(stubApi(stub))).toEqual({ token: { id: "tok-1", name: "frodo" } });
  });
});
