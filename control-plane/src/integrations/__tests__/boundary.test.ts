// What an integration module may import, so each integration stays a
// self-contained folder that reaches core only through its definition's Core
// (TaskService, logger) and the shared files next to this folder.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const SRC = resolve(import.meta.dir, "../..");
const INTEGRATIONS = join(SRC, "integrations");
const SOURCE = /\.[cm]?([jt]sx?)$/;

// Besides its own folder and packages (node:*, hono, npm), a file under
// integrations/<name>/ may import these, its own API clients (named <name>
// up to their first capital, such as clients/linearOauth for linear, so Linear
// never calls GitHub: the code host does), and the database row types
// (type-only).
const SHARED = [
  "integrations/types",
  "integrations/outbound",
  "integrations/http",
  "integrations/env",
  "services/experimentalFlags",
];
const TYPES_ONLY = ["db/schema"];

// Every specifier `code` imports, re-exports or loads, and whether only types
// come from it. Bun's scanner lists what runs (static and dynamic imports,
// require), dropping type-only imports; TypeScript's lists every static one.
function imports(path: string, code: string): { spec: string; typeOnly: boolean }[] {
  const loader = path.match(SOURCE)?.[1] as "ts" | "tsx" | "js" | "jsx";
  const loaded = new Set(new Bun.Transpiler({ loader }).scanImports(code).map((i) => i.path));
  const all = ts.preProcessFile(code, true, true).importedFiles.map((f) => f.fileName);
  return [...new Set([...loaded, ...all])].map((spec) => ({ spec, typeOnly: !loaded.has(spec) }));
}

// Why `file` may not import `spec`, or undefined when it may.
function violation(file: string, spec: string, typeOnly: boolean): string | undefined {
  const why = `${relative(SRC, file)} imports ${spec}`;
  if (spec.startsWith("/") || spec.startsWith("file:")) return why;
  if (!spec.startsWith(".")) return undefined;
  const target = relative(SRC, resolve(dirname(file), spec)).replace(SOURCE, "");
  const own = relative(SRC, dirname(file)).split("/").slice(0, 2).join("/");
  if (target === own || target.startsWith(`${own}/`)) return undefined;
  if (SHARED.includes(target)) return undefined;
  const client =
    target.startsWith("clients/") && target.replace(/^clients\//, "").replace(/[A-Z].*$/, "");
  if (client === own.split("/")[1]) return undefined;
  if (typeOnly && TYPES_ONLY.includes(target)) return undefined;
  return why;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sourceFiles(path);
    return SOURCE.test(e.name) && !/\.test\.[cm]?[jt]sx?$/.test(e.name) ? [path] : [];
  });
}

const files = readdirSync(INTEGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "__tests__")
  .flatMap((e) => sourceFiles(join(INTEGRATIONS, e.name)));

const violations = (file: string, code: string) =>
  imports(file, code)
    .map(({ spec, typeOnly }) => violation(file, spec, typeOnly))
    .filter(Boolean);

describe("integration folders", () => {
  it("import only their own files, the shared integration files, their own clients and packages", () => {
    expect(files.map((f) => relative(INTEGRATIONS, f))).toEqual(
      expect.arrayContaining(["api/index.ts", "github/index.ts", "linear/index.ts"]),
    );
    const found = files.map((file) => imports(file, readFileSync(file, "utf8")));
    expect(found.flat().length).toBeGreaterThan(files.length);
    expect(files.flatMap((file) => violations(file, readFileSync(file, "utf8")))).toEqual([]);
  });

  it("the check rejects core modules, another integration, its clients and a value import of the schema", () => {
    const file = join(INTEGRATIONS, "linear", "index.ts");
    const code = [
      'import type { Task } from "../../db/schema";',
      'import { type Person } from "../../db/schema";',
      'import { tasks, type Task as T } from "../../db/schema";',
      'import {\n  type Logger, // isn\'t "core"; really\n  ReplyTarget,\n} from "../types";',
      'import type { InboxRow /* it\'s "a row" */ } from "../../repositories/inbox.repository";',
      'import { /* "x"; */ y } /* from "../types" */ from "../../services/inbox.service";',
      'export { enqueueComment } from "../github/rounds";',
      "const { config } = await import(`../../config`);",
      'const { logger } = require("../../logger");',
      'import "/abs/integrations/types";',
      'import { Hono } from "hono";',
      'import { AgentSessionService } from "./agentSession.js";',
      'import { getUserById } from "../../clients/github";',
      'import { LinearTokenError } from "../../clients/linearOauth";',
    ].join("\n");
    expect(violations(file, code)).toEqual([
      "integrations/linear/index.ts imports ../../db/schema",
      "integrations/linear/index.ts imports ../../services/inbox.service",
      "integrations/linear/index.ts imports ../github/rounds",
      "integrations/linear/index.ts imports ../../config",
      "integrations/linear/index.ts imports ../../logger",
      "integrations/linear/index.ts imports /abs/integrations/types",
      "integrations/linear/index.ts imports ../../clients/github",
      "integrations/linear/index.ts imports ../../repositories/inbox.repository",
    ]);
  });

  it("an integration's clients are those named after it up to their first capital", () => {
    const allowed = (name: string, client: string) =>
      violations(
        join(INTEGRATIONS, name, "index.ts"),
        `import { x } from "../../clients/${client}";`,
      ).length === 0;
    expect(["linear", "linearApi", "linearOauth"].map((c) => allowed("linear", c))).toEqual([
      true,
      true,
      true,
    ]);
    expect(["github", "githubApi", "githubToken"].map((c) => allowed("github", c))).toEqual([
      true,
      true,
      true,
    ]);
    expect(["github", "githubApi", "gitlab"].map((c) => allowed("git", c))).toEqual([
      false,
      false,
      false,
    ]);
  });
});
