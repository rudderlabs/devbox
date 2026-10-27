import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Paths are resolved from this file, so the suite runs from any directory.
const CLI = resolve(import.meta.dir, "..");
const REPO = resolve(CLI, "..");
const API_TYPES = join(REPO, "control-plane/src/types/api");

const sources = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.includes("__tests__"))
    .map((f) => join(dir, f));

// `[^;]` keeps each match inside one import statement, across line breaks.
const imports = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map(
    (m) => m[1] ?? "",
  );

describe("devbox bundle", () => {
  // The CLI may import only types from the control plane:
  // control-plane/src/config.ts validates server env on import. Bun's bundler
  // marks each bundled module with a `// <path>` comment, relative to the
  // working directory; they are re-rooted at the repo so any cwd works.
  it("contains only cli/ modules and commander", async () => {
    const result = await Bun.build({ entrypoints: [join(CLI, "devbox.ts")], target: "bun" });
    expect(result.success).toBe(true);
    const text = (await result.outputs[0]?.text()) ?? "";
    const modules = [
      ...new Set(
        text
          .split("\n")
          .filter((l) => /^\/\/ \S+\.(ts|js)$/.test(l))
          .map((l) => relative(REPO, resolve(l.slice(3)))),
      ),
    ];
    expect(modules).toContain("cli/devbox.ts");
    expect(
      modules.filter(
        (m) =>
          !(m.startsWith("cli/") && !m.startsWith("cli/node_modules/")) &&
          !m.startsWith("cli/node_modules/commander/"),
      ),
    ).toEqual([]);
  });
});

describe("layering", () => {
  it("core never imports the interface or commander", () => {
    const bad = sources(join(CLI, "core")).flatMap((f) =>
      imports(f)
        .filter((i) => i.includes("interface/") || i === "commander")
        .map((i) => `${f}: ${i}`),
    );
    expect(bad).toEqual([]);
  });

  it("the interface never uses ApiClient", () => {
    const bad = sources(join(CLI, "interface")).filter((f) =>
      /\bApiClient\b/.test(readFileSync(f, "utf8")),
    );
    expect(bad).toEqual([]);
  });

  it("only control-plane/src/types/api.ts is imported from the control plane, and only as types", () => {
    const bad = [
      ...sources(join(CLI, "core")),
      ...sources(join(CLI, "interface")),
      join(CLI, "devbox.ts"),
    ].flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)]
        // Anything that resolves outside cli/ is the control plane's (or another
        // component's); only a type import of the API types is allowed.
        .filter((m) => {
          const spec = m[2] ?? "";
          if (!spec.startsWith(".")) return false;
          const target = resolve(dirname(f), spec);
          if (target.startsWith(`${CLI}/`)) return false;
          return !m[1] || target !== API_TYPES;
        })
        .map((m) => `${relative(REPO, f)}: ${m[0]}`),
    );
    expect(bad).toEqual([]);
  });
});
