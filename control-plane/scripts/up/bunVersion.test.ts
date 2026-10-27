import { describe, expect, test } from "bun:test";
import { bunVersionError, MIN_BUN } from "./bunVersion";

describe("bunVersionError", () => {
  test("accepts the minimum and newer versions", () => {
    expect(bunVersionError(MIN_BUN)).toBeUndefined();
    expect(bunVersionError("1.5.0")).toBeUndefined();
  });

  test("refuses an older version and names the minimum", () => {
    expect(bunVersionError("1.4.3")).toBe(
      `Bun 1.4.3 is too old: devbox needs ${MIN_BUN} or newer (bun upgrade, or brew upgrade bun)`,
    );
  });
});
