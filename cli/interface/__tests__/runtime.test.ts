import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunVersionWarning, MIN_BUN_VERSION } from "../runtime";

describe("bunVersionWarning", () => {
  it("warns below the minimum, with the versions", () => {
    expect(bunVersionWarning("1.2.20")).toBe(
      "devbox: Bun 1.2.20 is older than 1.4.4, the version devbox is built and tested with; upgrade with `bun upgrade`.",
    );
  });

  it.each(["1.3.14", "1.4.3"])("warns on %s, which lacks the 1.4.4 fixes", (version) => {
    expect(bunVersionWarning(version)).toContain(`Bun ${version} is older than 1.4.4`);
  });

  it.each(["1.4.4", "1.4.5", "1.5.0"])("is silent on %s", (version) => {
    expect(bunVersionWarning(version)).toBeUndefined();
  });

  it("matches the Bun version the CLI's CI pins", () => {
    const pin = /bun-version:\s*([\d.]+)/.exec(
      readFileSync(join(import.meta.dir, "../../../.github/workflows/cli.yml"), "utf8"),
    )?.[1];
    expect(MIN_BUN_VERSION).toBe(pin ?? "");
  });
});
