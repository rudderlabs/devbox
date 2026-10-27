import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrCreateKey } from "./localKey";

const root = mkdtempSync(join(tmpdir(), "devbox-local-key-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const keyPath = () => join(root, `key-${n++}`);

describe("readOrCreateKey", () => {
  test("creates a missing key, owner-only, and returns it", () => {
    const path = keyPath();
    expect(readOrCreateKey(path, () => "fresh")).toBe("fresh");
    expect(readFileSync(path, "utf8")).toBe("fresh\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("keeps an existing key", () => {
    const path = keyPath();
    writeFileSync(path, "existing\n", { mode: 0o600 });
    expect(
      readOrCreateKey(path, () => {
        throw new Error("must not generate");
      }),
    ).toBe("existing");
    expect(readFileSync(path, "utf8")).toBe("existing\n");
  });

  test("replaces an empty key", () => {
    const path = keyPath();
    writeFileSync(path, "  \n", { mode: 0o600 });
    expect(readOrCreateKey(path, () => "fresh")).toBe("fresh");
    expect(readFileSync(path, "utf8")).toBe("fresh\n");
  });

  test("surfaces read errors other than a missing file", () => {
    const path = keyPath();
    mkdirSync(path);
    expect(() => readOrCreateKey(path, () => "fresh")).toThrow(/EISDIR/);
  });
});
