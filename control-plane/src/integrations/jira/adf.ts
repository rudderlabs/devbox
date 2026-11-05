// Markdown to Atlassian Document Format (ADF), for the comments devbox posts on
// Jira. A small line-based parser for what agents write: paragraphs, ATX
// headings, bullet and numbered lists, fenced code, rules, and inline bold,
// italic, code and links. It emits only the node types below, so anything else
// the agent echoes (a mention, an image, a smart link, wiki markup) shows as
// literal text instead of notifying someone or fetching something. Links are
// http(s) only. Output aims to be safe and readable, not full CommonMark.

export type AdfMark =
  | { type: "strong" | "em" | "code" }
  | { type: "link"; attrs: { href: string } };
export type AdfNode = {
  type:
    | "paragraph"
    | "heading"
    | "bulletList"
    | "orderedList"
    | "listItem"
    | "codeBlock"
    | "text"
    | "hardBreak"
    | "rule";
  attrs?: Record<string, string | number>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
};
export type AdfDoc = { type: "doc"; version: 1; content: AdfNode[] };

// Jira rejects a comment over about 32k characters; parts stay under 30,000
// with room to spare, since the exact way Jira counts is not documented.
const COMMENT_MAX_CHARS = 29_000;
const MAX_COMMENTS = 3;
const SHORT_COMMENT_CHARS = 10_000;
const TRUNCATED: AdfNode = paragraph("Full text in the pull request.");

// The reply as at most MAX_COMMENTS docs, each within COMMENT_MAX_CHARS of
// serialized JSON. A code block cut across parts is closed and reopened with
// the same language. Past the last part the text is cut and ends with a
// pointer to the pull request. Blank input gives no docs.
export function adfComments(markdown: string): AdfDoc[] {
  const blocks = parseBlocks(typeof markdown === "string" ? markdown : "");
  if (blocks.length === 0) return [];
  let parts = pack(blocks, COMMENT_MAX_CHARS);
  if (parts.length > MAX_COMMENTS) {
    parts = pack(blocks, COMMENT_MAX_CHARS - size(TRUNCATED) - 1);
    if (parts.length > MAX_COMMENTS) {
      parts = parts.slice(0, MAX_COMMENTS);
      parts[MAX_COMMENTS - 1]?.push(TRUNCATED);
    }
  }
  return parts.map(doc);
}

// Jira refused a part as too long though it was within COMMENT_MAX_CHARS. The
// fallback: one comment, the reply's start cut to a third of that, and the
// pointer to the pull request.
export function adfShortComment(markdown: string): AdfDoc {
  const blocks = parseBlocks(typeof markdown === "string" ? markdown : "");
  const start = pack(blocks, SHORT_COMMENT_CHARS - size(TRUNCATED) - 1)[0] ?? [];
  return doc([...start, TRUNCATED]);
}

function doc(content: AdfNode[]): AdfDoc {
  return { type: "doc", version: 1, content };
}

function paragraph(text: string): AdfNode {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])[ \t]+(.*)$/;

type OpenList = { indent: number; ordered: boolean; node: AdfNode };

function parseBlocks(md: string): AdfNode[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: AdfNode[] = [];
  // Paragraphs collect their lines first so emphasis can span a line break.
  const pending = new Map<AdfNode, string[]>();
  let para: string[] | undefined;
  let lists: OpenList[] = [];
  const endPara = () => {
    para = undefined;
  };
  const endBlock = () => {
    endPara();
    lists = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    // A backtick fence's info string can't hold a backtick (that's inline code).
    if (fence && !(fence[2]?.startsWith("`") && fence[3]?.includes("`"))) {
      endBlock();
      const [, indent = "", marker = "", info = ""] = fence;
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const l = lines[i] ?? "";
        const t = l.trim();
        if (t.length >= marker.length && t === (marker[0] ?? "").repeat(t.length)) break;
        body.push(l.startsWith(indent) ? l.slice(indent.length) : l.trimStart());
      }
      // A language name, not a payload: anything long is dropped.
      const language = /^[\w+#.-]{1,32}(?!\S)/.exec(info.trim())?.[0];
      const text = body.join("\n");
      blocks.push({
        type: "codeBlock",
        ...(language ? { attrs: { language } } : {}),
        content: text ? [{ type: "text", text }] : [],
      });
      continue;
    }
    if (line.trim() === "") {
      endBlock();
      continue;
    }
    if (RULE.test(line)) {
      endBlock();
      blocks.push({ type: "rule" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endBlock();
      blocks.push({
        type: "heading",
        attrs: { level: heading[1]?.length ?? 1 },
        content: inline((heading[2] ?? "").trim()),
      });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      endPara();
      const indent = (item[1] ?? "").replace(/\t/g, "    ").length;
      const ordered = item[3] !== undefined;
      while (lists.length > 0 && (lists.at(-1)?.indent ?? 0) > indent) lists.pop();
      let top = lists.at(-1);
      if (top && top.indent === indent && top.ordered !== ordered) {
        lists.pop();
        top = lists.at(-1);
      }
      if (!top || top.indent < indent) {
        const start = Number(item[3] ?? 1);
        const list: AdfNode = ordered
          ? {
              type: "orderedList",
              ...(start !== 1 ? { attrs: { order: start } } : {}),
              content: [],
            }
          : { type: "bulletList", content: [] };
        if (top) top.node.content?.at(-1)?.content?.push(list);
        else blocks.push(list);
        top = { indent, ordered, node: list };
        lists.push(top);
      }
      const p: AdfNode = { type: "paragraph", content: [] };
      pending.set(p, [item[4] ?? ""]);
      top.node.content?.push({ type: "listItem", content: [p] });
      continue;
    }
    const text = line.trim();
    // A plain line after a list item continues that item.
    const lastItemPara = lists.at(-1)?.node.content?.at(-1)?.content?.[0];
    const continued = para ?? (lastItemPara && pending.get(lastItemPara));
    if (continued) {
      continued.push(text);
      continue;
    }
    const p: AdfNode = { type: "paragraph", content: [] };
    para = [text];
    pending.set(p, para);
    blocks.push(p);
  }
  for (const [node, ls] of pending) node.content = inline(ls.join("\n"));
  return blocks;
}

const PUNCT = /[!-/:-@[-`{-~]/;
const LINK = /\[([^[\]\n]*)\]\(\s*([^\s()]+)\s*\)/y;
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/y;
const BARE_URL = /https?:\/\/[^\s<>]+/y;

// Longer URLs stay plain text: a link's URL rides on every piece of its text,
// so it has to fit in a comment many times over.
const MAX_HREF = 2_048;

function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    const web = u.protocol === "http:" || u.protocol === "https:";
    return web && u.href.length <= MAX_HREF ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// Text with emphasis, code spans and links; a newline is a hard break, as
// GitHub shows it in comments.
function inline(s: string, marks: AdfMark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ type: "text", text: buf, ...(marks.length ? { marks } : {}) });
    buf = "";
  };
  // Delimiters with no closer from some point on have none further on either.
  const unclosed = new Set<string>();
  const inLink = marks.some((m) => m.type === "link");
  // A bare URL that was turned down is turned down whole: no "http" inside it
  // is tried again, which keeps a run of them linear.
  let urlScanEnd = 0;

  let i = 0;
  while (i < s.length) {
    const c = s[i] ?? "";
    const next = s[i + 1] ?? "";
    if (c === "\n") {
      flush();
      out.push({ type: "hardBreak" });
      i++;
      continue;
    }
    if (c === "\\" && PUNCT.test(next)) {
      buf += next;
      i += 2;
      continue;
    }
    if (c === "`") {
      const len = runLength(s, i, "`");
      const close = unclosed.has(`\`${len}`) ? -1 : findCodeClose(s, i + len, len);
      if (close < 0) {
        unclosed.add(`\`${len}`);
        buf += "`".repeat(len);
        i += len;
        continue;
      }
      let code = s.slice(i + len, close).replace(/\n/g, " ");
      if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      flush();
      // ADF allows only a link alongside the code mark.
      const codeMarks: AdfMark[] = [...marks.filter((m) => m.type === "link"), { type: "code" }];
      if (code) out.push({ type: "text", text: code, marks: codeMarks });
      i = close + len;
      continue;
    }
    if (c === "*" || c === "_") {
      const len = runLength(s, i, c);
      const delim = c.repeat(len >= 2 ? 2 : 1);
      const type = delim.length === 2 ? "strong" : "em";
      // A mark already in force stays literal, which also bounds the nesting.
      const close = marks.some((m) => m.type === type) ? -1 : emphasisClose(s, i, delim, unclosed);
      if (close < 0) {
        buf += c.repeat(len);
        i += len;
        continue;
      }
      flush();
      out.push(...inline(s.slice(i + delim.length, close), [...marks, { type }]));
      i = close + delim.length;
      continue;
    }
    if (c === "[" && s[i - 1] !== "!" && !inLink) {
      LINK.lastIndex = i;
      const m = LINK.exec(s);
      const href = m && safeHref(m[2] ?? "");
      if (m && href) {
        flush();
        const label = inline(m[1] ?? "", [...marks, linkMark(href)]);
        const shown: AdfNode = { type: "text", text: href, marks: [...marks, linkMark(href)] };
        out.push(...(label.length ? label : [shown]));
        i += m[0].length;
        continue;
      }
    }
    if (c === "<" && !inLink) {
      AUTOLINK.lastIndex = i;
      const m = AUTOLINK.exec(s);
      const href = m && safeHref(m[1] ?? "");
      if (m && href) {
        flush();
        out.push({ type: "text", text: m[1] ?? href, marks: [...marks, linkMark(href)] });
        i += m[0].length;
        continue;
      }
    }
    if (
      (c === "h" || c === "H") &&
      i >= urlScanEnd &&
      !inLink &&
      !/[\p{L}\p{N}]/u.test(s[i - 1] ?? "")
    ) {
      BARE_URL.lastIndex = i;
      const raw = BARE_URL.exec(s)?.[0] ?? "";
      const url = trimUrl(raw);
      const href = url && safeHref(url);
      if (href) {
        flush();
        out.push({ type: "text", text: url, marks: [...marks, linkMark(href)] });
        i += url.length;
        continue;
      }
      urlScanEnd = i + raw.length;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function linkMark(href: string): AdfMark {
  return { type: "link", attrs: { href } };
}

function runLength(s: string, i: number, c: string): number {
  let j = i;
  while (s[j] === c) j++;
  return j - i;
}

// The start of the next backtick run exactly `len` long, or -1.
function findCodeClose(s: string, from: number, len: number): number {
  for (let j = s.indexOf("`", from); j >= 0; j = s.indexOf("`", j)) {
    const run = runLength(s, j, "`");
    if (run === len) return j;
    j += run;
  }
  return -1;
}

// Where `delim` (one or two of * or _) opening at `i` closes, or -1. An opener
// is followed by a non-space; a closer follows a non-space. `_` must not touch
// a letter or digit outside (snake_case stays as written). A single delimiter
// never closes on part of a double, and a double closes at the end of its run.
function emphasisClose(s: string, i: number, delim: string, unclosed: Set<string>): number {
  const c = delim[0] ?? "";
  const n = delim.length;
  const wordy = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  if (unclosed.has(delim) || /\s/.test(s[i + n] ?? " ")) return -1;
  if (c === "_" && wordy(s[i - 1])) return -1;
  for (let j = s.indexOf(delim, i + n + 1); j >= 0; j = s.indexOf(delim, j + 1)) {
    const run = runLength(s, j, c);
    if (n === 1 && (run > 1 || s[j - 1] === c)) {
      j += run - 1;
      continue;
    }
    const at = n === 2 ? j + run - 2 : j;
    if (/\s/.test(s[at - 1] ?? " ")) {
      j += run - 1;
      continue;
    }
    if (c === "_" && wordy(s[at + n])) {
      j += run - 1;
      continue;
    }
    return at;
  }
  unclosed.add(delim);
  return -1;
}

// Trailing punctuation ends a sentence, not the URL; so does a ")" with no "(".
// A loop, not a regex: a regex anchored at the end backtracks quadratically
// over a long run of punctuation.
function trimUrl(url: string): string {
  let opens = 0;
  let closes = 0;
  for (const ch of url) {
    if (ch === "(") opens++;
    else if (ch === ")") closes++;
  }
  let end = url.length;
  for (;;) {
    const ch = url[end - 1];
    if (ch === undefined) return "";
    if (".,;:!?'\"*_".includes(ch)) end--;
    else if (ch === ")" && closes > opens) {
      end--;
      closes--;
    } else return url.slice(0, end);
  }
}

const size = (node: unknown) => JSON.stringify(node).length;
const EMPTY_DOC = size(doc([]));

// Less room than this left in a part isn't worth cutting a block for.
const MIN_FILL = 1_000;

// Blocks packed in order into docs of at most `max` serialized characters. A
// block that fits a doc of its own is never cut; a bigger one is, and its
// first piece fills what is left of the current doc.
function pack(blocks: AdfNode[], max: number): AdfNode[][] {
  const room = max - EMPTY_DOC;
  const parts: AdfNode[][] = [];
  let part: AdfNode[] = [];
  let used = EMPTY_DOC - 1;
  const add = (node: AdfNode) => {
    const s = size(node) + 1;
    if (part.length > 0 && used + s > max) {
      parts.push(part);
      part = [];
      used = EMPTY_DOC - 1;
    }
    part.push(node);
    used += s;
  };
  for (const block of blocks) {
    if (size(block) <= room) {
      add(block);
      continue;
    }
    const free = max - used - 1;
    for (const piece of fit(block, room, free >= MIN_FILL ? free : room)) add(piece);
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

// `children` cut into consecutive runs whose parent, `base` characters when
// empty, stays within `max` with them inside (`first` for the first run). A
// child too big on its own gets a run to itself.
function runs(base: number, children: AdfNode[], max: number, first = max): AdfNode[][] {
  const out: AdfNode[][] = [];
  let run: AdfNode[] = [];
  let used = base - 1;
  let limit = first;
  for (const child of children) {
    const s = size(child) + 1;
    if (run.length > 0 && used + s > limit) {
      out.push(run);
      run = [];
      used = base - 1;
      limit = max;
    }
    run.push(child);
    used += s;
  }
  if (run.length > 0) out.push(run);
  return out;
}

// `block` as blocks of at most `room` characters each, the first aiming at
// `first`: a code block cut by lines into blocks of the same language, a list
// cut between items (numbering carries on; an item too big alone becomes its
// own blocks), a paragraph or heading cut between, or inside, its text runs.
function fit(block: AdfNode, room: number, first = room): AdfNode[] {
  if (size(block) <= room) return [block];
  const content = block.content ?? [];
  if (block.type === "codeBlock") {
    const shell = size({ ...block, content: [{ type: "text", text: "" }] });
    return chunks(content[0]?.text ?? "", room - shell, first - shell).map((text) => ({
      ...block,
      content: [{ type: "text", text }],
    }));
  }
  if (block.type === "bulletList" || block.type === "orderedList") {
    const out: AdfNode[] = [];
    let order = Number(block.attrs?.order ?? 1);
    // Sized with the widest start number a cut list can get.
    const shell = size({ ...block, attrs: { order: Number.MAX_SAFE_INTEGER }, content: [] });
    for (const run of runs(shell, content, room, first)) {
      const list: AdfNode =
        block.type === "orderedList"
          ? { ...block, attrs: { order }, content: run }
          : { ...block, content: run };
      if (size(list) <= room) out.push(list);
      else out.push(...run.flatMap((item) => (item.content ?? []).flatMap((b) => fit(b, room))));
      order += run.length;
    }
    return out;
  }
  const shell = size({ ...block, content: [] });
  const pieces = content.flatMap((node) => {
    if (node.type !== "text" || shell + size(node) <= room) return [node];
    const overhead = size({ ...node, text: "" });
    return chunks(node.text ?? "", room - shell - overhead).map((text) => ({ ...node, text }));
  });
  return runs(shell, pieces, room, first).map((run) => ({ ...block, content: run }));
}

// `s` cut into pieces whose JSON-escaped length is at most `max` (`first` for
// the first piece), at a line end where one is in reach. The newline itself is
// dropped: a new block starts on a new line anyway. No piece is empty (ADF
// text can't be), so a newline with nothing before it is simply dropped.
function chunks(s: string, max: number, first = max): string[] {
  const escaped = (t: string) => JSON.stringify(t).length - 2;
  const out: string[] = [];
  let cur = "";
  let used = 0;
  let limit = first;
  for (const ch of s) {
    const n = escaped(ch);
    while (cur && used + n > limit) {
      const nl = cur.lastIndexOf("\n");
      if (nl > 0) out.push(cur.slice(0, nl));
      else if (nl < 0) out.push(cur);
      cur = nl >= 0 ? cur.slice(nl + 1) : "";
      used = escaped(cur);
      if (nl !== 0) limit = max;
    }
    cur += ch;
    used += n;
  }
  if (cur || out.length === 0) out.push(cur);
  return out;
}
