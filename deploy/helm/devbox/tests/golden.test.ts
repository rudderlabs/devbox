// Whole-output golden tests: every case's rendered manifests,
// minus upstream CRDs, as sorted JSON. Regenerate after an intended change
// with `UPDATE_GOLDEN=1 bun run test:chart` and review the diff.
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, type Rendered, renderCase, withoutCrds } from "./render";

const GOLDEN = join(import.meta.dir, "golden");

const sorted = (r: Rendered): Rendered =>
  Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k] as Rendered[string]]));

describe("chart golden files", () => {
  for (const name of Object.keys(CASES)) {
    it(name, async () => {
      const actual = sorted(withoutCrds(await renderCase(name)));
      const path = join(GOLDEN, `${name}.json`);
      if (process.env.UPDATE_GOLDEN === "1") {
        writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
      }
      expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
    });
  }
});
