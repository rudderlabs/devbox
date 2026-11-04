// What an integration module may import, so each integration stays a
// self-contained folder that reaches core only through its definition's Core
// (TaskService, logger) and the shared files next to this folder.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../..");
const INTEGRATIONS = join(SRC, "integrations");

// Besides its own folder and packages (node:*, hono, npm), a file under
// integrations/<name>/ may import these, the API clients in clients/, and the
// database row types (type-only).
const SHARED = [
  "integrations/types",
  "integrations/outbound",
  "integrations/http",
  "integrations/env",
  "services/experimentalFlags",
];
const TYPES_ONLY = ["db/schema"];

// Every static, re-export, side-effect, dynamic and require specifier, with
// whether the statement is type-only (`import type` / `export type`).
function imports(code: string): { spec: string; typeOnly: boolean }[] {
  const re =
    /\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  return [...code.matchAll(re)].map((m) => ({
    spec: (m[2] ?? m[3]) as string,
    typeOnly: m[1] !== undefined,
  }));
}

// Why `file` may not import `spec`, or undefined when it may.
function violation(file: string, spec: string, typeOnly: boolean): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const target = relative(SRC, resolve(dirname(file), spec)).replace(/\.ts$/, "");
  const own = relative(SRC, dirname(file)).split("/").slice(0, 2).join("/");
  if (target === own || target.startsWith(`${own}/`)) return undefined;
  if (SHARED.includes(target) || target.startsWith("clients/")) return undefined;
  if (typeOnly && TYPES_ONLY.includes(target)) return undefined;
  return `${relative(SRC, file)} imports ${spec}`;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sourceFiles(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path] : [];
  });
}

const files = readdirSync(INTEGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "__tests__")
  .flatMap((e) => sourceFiles(join(INTEGRATIONS, e.name)));

describe("integration folders", () => {
  it("import only their own files, the shared integration files, clients and packages", () => {
    expect(files.map((f) => relative(INTEGRATIONS, f))).toEqual(
      expect.arrayContaining(["api/index.ts", "github/index.ts", "linear/index.ts"]),
    );
    const found = files.flatMap((file) =>
      imports(readFileSync(file, "utf8")).map(({ spec, typeOnly }) =>
        violation(file, spec, typeOnly),
      ),
    );
    expect(found.length).toBeGreaterThan(files.length);
    expect(found.filter(Boolean)).toEqual([]);
  });

  it("the check rejects core modules, another integration and a value import of the schema", () => {
    const file = join(INTEGRATIONS, "linear", "index.ts");
    const code = [
      'import type { Task } from "../../db/schema";',
      'import { taskSource } from "../../db/schema";',
      'import {\n  type Logger,\n  ReplyTarget,\n} from "../types";',
      'import type { InboxRow } from "../../repositories/inbox.repository";',
      'export { enqueueComment } from "../github/rounds";',
      'const { config } = await import("../../config");',
      'import "../../logger";',
      'import { Hono } from "hono";',
      'import { AgentSessionService } from "./agentSession";',
      'import { getUserById } from "../../clients/github";',
    ].join("\n");
    expect(
      imports(code)
        .map(({ spec, typeOnly }) => violation(file, spec, typeOnly))
        .filter(Boolean),
    ).toEqual([
      "integrations/linear/index.ts imports ../../db/schema",
      "integrations/linear/index.ts imports ../../repositories/inbox.repository",
      "integrations/linear/index.ts imports ../github/rounds",
      "integrations/linear/index.ts imports ../../config",
      "integrations/linear/index.ts imports ../../logger",
    ]);
  });
});
