import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// The CLI bundles src/types/api.ts. It must stay type-only, so the bundle
// never pulls in src/config.ts (which validates server env on import).
describe("src/types/api.ts", () => {
  it("has no runtime imports or values", () => {
    const text = readFileSync("src/types/api.ts", "utf8");
    expect(text).not.toMatch(/^\s*import\s+(?!type\b)/m);
    expect(text).not.toMatch(/^\s*export\s+(const|let|var|function|class|enum)\b/m);
  });
});
