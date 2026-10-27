// The devbox skill (skills/devbox) points agents at commands and docs; this
// keeps it from drifting: every `bun run <script>` it names exists, every
// relative link reaches a file and, with a #fragment, a heading or id there.
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SKILL = join(ROOT, "skills", "devbox");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? markdownFiles(join(dir, e.name))
      : e.name.endsWith(".md")
        ? [join(dir, e.name)]
        : [],
  );
}

const FILES = markdownFiles(SKILL);
const read = (path: string) => readFileSync(path, "utf8");
const withoutFences = (text: string) => text.replace(/^```[\s\S]*?^```/gm, "");

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to
// hyphens, -1, -2… for repeats; plus explicit id attributes.
export function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const [, heading] of withoutFences(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = (heading ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n === 0 ? slug : `${slug}-${n}`);
  }
  for (const [, id] of markdown.matchAll(/\bid="([^"]+)"/g)) out.add(id ?? "");
  return out;
}

describe("anchors", () => {
  it("slugs headings as GitHub does", () => {
    const a = anchors("# The target file (`--target`)\n## Without /dev/kmsg\n## A\n## A\n");
    expect([...a]).toEqual(["the-target-file---target", "without-devkmsg", "a", "a-1"]);
  });

  it("skips code fences and keeps explicit ids", () => {
    const a = anchors('```bash\n# not a heading\n```\n<a id="iron-proxy-address"></a>\n');
    expect([...a]).toEqual(["iron-proxy-address"]);
  });
});

describe("the devbox skill", () => {
  it("has a SKILL.md whose name matches its directory", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(read(join(SKILL, "SKILL.md")))?.[1] ?? "";
    expect(front).toMatch(/^name: devbox$/m);
    expect(front).toMatch(/^description: \S.{50,}$/m);
  });

  it("is linked for Claude Code at .claude/skills/devbox", () => {
    const link = join(ROOT, ".claude", "skills", "devbox");
    expect(resolve(dirname(link), readlinkSync(link))).toBe(SKILL);
  });

  it("names only scripts that exist", () => {
    const scripts = Object.keys(
      (JSON.parse(read(join(ROOT, "package.json"))) as { scripts: Record<string, string> }).scripts,
    );
    const missing = FILES.flatMap((f) =>
      [...read(f).matchAll(/bun run ([a-z0-9-]+(?::[a-z0-9-]+)*)/g)]
        .map((m) => m[1] ?? "")
        .filter((s) => !scripts.includes(s))
        .map((s) => `${relative(ROOT, f)}: bun run ${s}`),
    );
    expect(missing).toEqual([]);
  });

  it("links only to files and headings that exist", () => {
    const broken: string[] = [];
    for (const f of FILES) {
      for (const [, target] of withoutFences(read(f)).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (!target || /^[a-z]+:/.test(target)) continue;
        const [path = "", fragment] = target.split("#");
        const file = path ? resolve(dirname(f), path) : f;
        if (!existsSync(file)) broken.push(`${relative(ROOT, f)}: ${target}`);
        else if (fragment && !anchors(read(file)).has(fragment)) {
          broken.push(`${relative(ROOT, f)}: ${target} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
