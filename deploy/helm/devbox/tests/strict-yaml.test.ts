// Every case renders YAML that strict parsers accept. kubeconform rejects a
// duplicate key; Helm and Bun.YAML keep the last one, so only a strict parse
// catches it. The `yaml` package comes from control-plane's dependencies.
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CASES, helmTemplate } from "./render";

const { parseAllDocuments } = createRequire(
  join(import.meta.dir, "..", "..", "..", "..", "control-plane", "package.json"),
)("yaml") as {
  parseAllDocuments: (s: string) => { errors: { message: string }[] }[];
};
const VALUES = join(import.meta.dir, "values");

describe("rendered YAML", () => {
  for (const [name, files] of Object.entries(CASES)) {
    it(`has no duplicate keys: ${name}`, async () => {
      const r = await helmTemplate(files.flatMap((f) => ["-f", join(VALUES, f)]));
      expect(r.code).toBe(0);
      const errors = parseAllDocuments(r.stdout).flatMap((d) => d.errors.map((e) => e.message));
      expect(errors).toEqual([]);
    });
  }
});
