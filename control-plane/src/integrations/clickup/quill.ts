import { type MdNode, parseMarkdown } from "../markdown";

// ClickUp's rich text both ways. Comments arrive, and are posted, as a list of
// Quill-delta-like parts: text with inline attributes (bold, italic, code,
// strike, link), a "\n" whose attributes format the line it ends (list,
// code-block, header, blockquote), and typed parts such as mentions
// ({type: "tag", user: {id}}) and emoji.
//
// Incoming parts become Markdown for the agent. Mentions never pass a person
// on: the bot's own is dropped and anyone else's becomes "@user", never their
// id, name or email. Links are http(s) only. Read defensively: odd input
// gives odd text, never a throw, and every pass is linear.
//
// Outgoing Markdown becomes parts using only the attributes ClickUp documents
// for the API (bold, italic, code, link, list, code-block), so nothing the
// agent writes mentions or notifies anyone.

export type ClickUpPart = { text: string; attributes: Record<string, unknown> };

// ── Incoming ─────────────────────────────────────────────────────────────

type Segment = { text: string; attrs: Record<string, unknown> } | { tag: number | null };
type Line = { segments: Segment[]; format: Record<string, unknown> };

// The parts cut into lines, each with the attributes of the "\n" that ends
// it. A part's "\n" takes that part's attributes, as in Quill.
function readLines(parts: unknown): Line[] {
  const lines: Line[] = [];
  let segments: Segment[] = [];
  for (const raw of Array.isArray(parts) ? parts : []) {
    const part = record(raw);
    if (!part) continue;
    if (part.type === "tag") {
      segments.push({ tag: userId(record(part.user)?.id) });
      continue;
    }
    // Plain text, or an emoji. Other typed parts (attachments, task or doc
    // mentions) are dropped: their text may name something or someone.
    let text: string;
    if (part.type === undefined || part.type === null || part.type === "text") {
      text = typeof part.text === "string" ? part.text : "";
    } else if (part.type === "emoticon") {
      text = emoji(record(part.emoticon)?.code);
    } else continue;
    const attrs = record(part.attributes) ?? {};
    // Without NUL, which Postgres can't store.
    const pieces = text.replaceAll("\0", "").replace(/\r\n?/g, "\n").split("\n");
    for (const [i, piece] of pieces.entries()) {
      if (i > 0) {
        lines.push({ segments, format: attrs });
        segments = [];
      }
      if (piece) segments.push({ text: piece, attrs });
    }
  }
  if (segments.length > 0) lines.push({ segments, format: {} });
  return lines;
}

// Whether the comment mentions the bot: a mention picked in ClickUp (a tag
// part with the bot's user id), or "@<botName>" typed as plain text, in any
// case and standing alone ("@devboxer" and "@devbox/cli" don't count). Text in
// code doesn't count.
export function mentionsBot(parts: unknown, botUserId: number, botName: string): boolean {
  const lines = readLines(parts);
  if (lines.some((l) => l.segments.some((s) => "tag" in s && s.tag === botUserId))) return true;
  const prose = lines
    .filter((l) => codeLanguage(l.format) === undefined)
    .map((l) => l.segments.map((s) => ("tag" in s || s.attrs.code ? " " : s.text)).join(""));
  const name = typeof botName === "string" ? botName.trim() : "";
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])@${escaped}(?![\\p{L}\\p{N}_/-])`, "iu").test(
    prose.join("\n"),
  );
}

// The comment as Markdown: inline attributes as **bold**, _italic_, `code`,
// ~~strike~~ and [links](https://…); lists, headings and quotes by their
// markers; consecutive code-block lines as one fenced block in the first
// line's language.
export function commentToMarkdown(parts: unknown, botUserId: number): string {
  const out: string[] = [];
  let code: { lang: string; lines: string[] } | undefined;
  const endCode = () => {
    if (code) out.push(fenced(code.lines, code.lang));
    code = undefined;
  };
  for (const line of readLines(parts)) {
    const lang = codeLanguage(line.format);
    if (lang !== undefined) {
      code ??= { lang, lines: [] };
      code.lines.push(line.segments.map((s) => ("tag" in s ? tag(s, botUserId) : s.text)).join(""));
      continue;
    }
    endCode();
    out.push(linePrefix(line.format) + line.segments.map((s) => inline(s, botUserId)).join(""));
  }
  endCode();
  return trimBlankLines(out).join("\n");
}

function tag(s: { tag: number | null }, botUserId: number): string {
  return s.tag === botUserId ? "" : "@user";
}

function inline(s: Segment, botUserId: number): string {
  if ("tag" in s) return tag(s, botUserId);
  const { text, attrs } = s;
  if (attrs.code) return inlineCode(text);
  let out = text;
  if (attrs.strike) out = wrap(out, "~~");
  if (attrs.italic) out = wrap(out, "_");
  if (attrs.bold) out = wrap(out, "**");
  const href = safeHref(attrs.link);
  return href ? `[${out}](${href})` : out;
}

// `text` between `mark`s, with its outer spaces kept outside, where Markdown
// needs them. Blank text stays as it is.
function wrap(text: string, mark: string): string {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  if (end <= start) return text;
  return `${text.slice(0, start)}${mark}${text.slice(start, end)}${mark}${text.slice(end)}`;
}

function linePrefix(format: Record<string, unknown>): string {
  const indent = "   ".repeat(intIn(format.indent, 1, 8) ?? 0);
  const list = record(format.list)?.list ?? format.list;
  if (list === "bullet") return `${indent}- `;
  if (list === "ordered") return `${indent}1. `;
  if (list === "checked") return `${indent}- [x] `;
  if (list === "unchecked") return `${indent}- [ ] `;
  const level = intIn(format.header, 1, 6);
  if (level !== undefined) return `${"#".repeat(level)} `;
  return format.blockquote ? "> " : "";
}

// A code-block line's language ("" for none or ClickUp's "plain"), or
// undefined when the line isn't code. ClickUp writes the format as
// {"code-block": "<lang>"}; a bare string or true is read too.
function codeLanguage(format: Record<string, unknown>): string | undefined {
  const v = format["code-block"];
  if (!v) return undefined;
  const lang = typeof v === "string" ? v : record(v)?.["code-block"];
  return typeof lang === "string" && lang !== "plain" && /^[\w+#.-]{1,32}$/.test(lang) ? lang : "";
}

// A fenced block, its fence longer than any backtick run inside.
function fenced(lines: string[], lang: string): string {
  const body = lines.join("\n");
  const fence = "`".repeat(Math.max(3, longestRun(body) + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

// Inline code, its fence longer than any backtick run inside; padded when the
// code starts or ends with a backtick, as Markdown requires.
function inlineCode(code: string): string {
  const fence = "`".repeat(longestRun(code) + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

function longestRun(s: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of s) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

// An http(s) URL, its parentheses escaped so a Markdown link can hold it.
function safeHref(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const url = URL.parse(v.trim());
  if (url?.protocol !== "http:" && url?.protocol !== "https:") return undefined;
  return url.href.replaceAll("(", "%28").replaceAll(")", "%29");
}

// An emoji from ClickUp's code: hex code points joined by "-" (1f44d,
// 1f468-200d-1f4bb). Anything else is dropped.
function emoji(code: unknown): string {
  if (typeof code !== "string" || !/^[0-9a-f]{1,6}(?:-[0-9a-f]{1,6}){0,9}$/i.test(code)) return "";
  const points = code.split("-").map((h) => Number.parseInt(h, 16));
  return points.every((p) => p <= 0x10ffff) ? String.fromCodePoint(...points) : "";
}

// Blank lines off both ends.
function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start++;
  while (end > start && !lines[end - 1]?.trim()) end--;
  return lines.slice(start, end);
}

// ── Outgoing ─────────────────────────────────────────────────────────────

// ClickUp documents no length limit for a comment. The only figure published
// anywhere (a third-party client's check) is 5,000 characters, so each part
// stays within that, counted as the text it shows, and a reply takes at most
// three comments.
const COMMENT_MAX_CHARS = 5_000;
const MAX_COMMENTS = 3;
const NL = (attributes: Record<string, unknown> = {}): ClickUpPart => ({ text: "\n", attributes });
const TRUNCATED: ClickUpPart[] = [{ text: "Full text in the pull request.", attributes: {} }, NL()];

// The reply as at most MAX_COMMENTS comments' parts, each within
// COMMENT_MAX_CHARS. A code block cut across comments carries on in the same
// language, since each of its lines carries the format. Past the last comment
// the text is cut and ends with a pointer to the pull request. Blank input
// gives none.
export function markdownToComments(markdown: string): ClickUpPart[][] {
  const blocks = parseMarkdown(typeof markdown === "string" ? markdown.replaceAll("\0", "") : "");
  // A blank line between top-level blocks, as Markdown shows them.
  const lines = blocks.flatMap((b, i) =>
    i > 0 ? [[NL()], ...blockLines(b, 0)] : blockLines(b, 0),
  );
  if (lines.length === 0) return [];
  let comments = pack(lines, COMMENT_MAX_CHARS);
  if (comments.length > MAX_COMMENTS) {
    comments = pack(lines, COMMENT_MAX_CHARS - length(TRUNCATED)).slice(0, MAX_COMMENTS);
    comments[MAX_COMMENTS - 1]?.push(...TRUNCATED);
  }
  return comments;
}

// A block as lines of parts, each line ending with its "\n".
function blockLines(node: MdNode, depth: number): ClickUpPart[][] {
  switch (node.type) {
    case "paragraph":
      return inlineLines(node.content ?? [], {}, {});
    case "heading":
      // ClickUp documents no heading format for the API: a heading is a bold line.
      return inlineLines(node.content ?? [], { bold: true }, {});
    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "plain";
      const format = { "code-block": { "code-block": lang } };
      const text = node.content?.[0]?.text ?? "";
      return text.split("\n").map((l) => (l ? [part(l, {}), NL(format)] : [NL(format)]));
    }
    case "bulletList":
    case "orderedList": {
      const list = { list: { list: node.type === "orderedList" ? "ordered" : "bullet" } };
      const format = depth > 0 ? { ...list, indent: depth } : list;
      return (node.content ?? []).flatMap((item) =>
        (item.content ?? []).flatMap((child) =>
          child.type === "paragraph"
            ? inlineLines(child.content ?? [], {}, format)
            : blockLines(child, child.type === "codeBlock" ? depth : depth + 1),
        ),
      );
    }
    case "rule":
      return [[part("---", {}), NL()]];
    default:
      return [];
  }
}

// Inline nodes as lines (a hard break starts a new one), every line ending
// with a "\n" in `format`.
function inlineLines(
  nodes: MdNode[],
  extra: Record<string, unknown>,
  format: Record<string, unknown>,
): ClickUpPart[][] {
  const lines: ClickUpPart[][] = [];
  let line: ClickUpPart[] = [];
  for (const n of nodes) {
    if (n.type === "hardBreak") {
      lines.push([...line, NL(format)]);
      line = [];
    } else if (n.type === "text" && n.text) {
      const attrs: Record<string, unknown> = { ...extra };
      for (const m of n.marks ?? []) {
        if (m.type === "strong") attrs.bold = true;
        else if (m.type === "em") attrs.italic = true;
        else if (m.type === "code") attrs.code = true;
        else if (m.type === "link") attrs.link = m.attrs.href;
      }
      line.push(part(n.text, attrs));
    }
  }
  lines.push([...line, NL(format)]);
  return lines;
}

function part(text: string, attributes: Record<string, unknown>): ClickUpPart {
  return { text, attributes };
}

function length(parts: ClickUpPart[]): number {
  let n = 0;
  for (const p of parts) n += p.text.length;
  return n;
}

const blank = (line: ClickUpPart[]) =>
  line.length === 1 && Object.keys(line[0]?.attributes ?? {}).length === 0;

// Lines packed in order into comments of at most `max` characters. A line
// too long for one comment is cut into lines that fit. A comment neither
// starts nor ends with a blank line.
function pack(lines: ClickUpPart[][], max: number): ClickUpPart[][] {
  const comments: ClickUpPart[][][] = [];
  let current: ClickUpPart[][] = [];
  let used = 0;
  for (const line of lines.flatMap((l) => cut(l, max))) {
    const n = length(line);
    if (current.length > 0 && used + n > max) {
      comments.push(current);
      current = [];
      used = 0;
    }
    if (current.length === 0 && blank(line)) continue;
    current.push(line);
    used += n;
  }
  if (current.length > 0) comments.push(current);
  return comments.map((c) => {
    while (c.length > 1 && blank(c.at(-1) ?? [])) c.pop();
    return c.flat();
  });
}

// A line as lines of at most `max` characters each, cut inside its text
// where needed (never between the halves of a surrogate pair), each piece
// ending with the line's own "\n".
function cut(line: ClickUpPart[], max: number): ClickUpPart[][] {
  if (length(line) <= max) return [line];
  const nl = line.at(-1) ?? NL();
  const room = max - 1;
  const out: ClickUpPart[][] = [];
  let piece: ClickUpPart[] = [];
  let used = 0;
  for (const p of line.slice(0, -1)) {
    let text = p.text;
    while (text) {
      let take = Math.min(text.length, room - used);
      const code = text.charCodeAt(take - 1);
      if (take < text.length && code >= 0xd800 && code <= 0xdbff) take--;
      if (take <= 0) {
        out.push([...piece, nl]);
        piece = [];
        used = 0;
        continue;
      }
      piece.push({ ...p, text: text.slice(0, take) });
      used += take;
      text = text.slice(take);
    }
  }
  if (piece.length > 0) out.push([...piece, nl]);
  return out;
}

// ── Shared ───────────────────────────────────────────────────────────────

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// A ClickUp user id: an integer (ClickBot's is negative), as a number or digits.
export function userId(v: unknown): number | null {
  const n = typeof v === "string" && /^-?\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
}

function intIn(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}
