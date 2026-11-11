// Markdown to a small block tree, for the comments devbox posts on platforms
// that take rich text (Jira's ADF, ClickUp's comment parts). A line-based
// parser for what agents write: paragraphs, ATX headings, bullet and numbered
// lists, fenced code, rules, and inline bold, italic, code and links. It emits
// only the node types below, so anything else the agent echoes (a mention, an
// image, a smart link, wiki markup) stays literal text instead of notifying
// someone or fetching something. Links are http(s) only. Output aims to be
// safe and readable, not full CommonMark. The tree has ADF's shape, which
// Jira posts as is.

export type MdMark = { type: "strong" | "em" | "code" } | { type: "link"; attrs: { href: string } };
export type MdNode = {
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
  content?: MdNode[];
  text?: string;
  marks?: MdMark[];
};

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])[ \t]+(.*)$/;

type OpenList = { indent: number; ordered: boolean; node: MdNode };

// The blocks of `md`; blank input gives none.
export function parseMarkdown(md: string): MdNode[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdNode[] = [];
  // Paragraphs collect their lines first so emphasis can span a line break.
  const pending = new Map<MdNode, string[]>();
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
        const list: MdNode = ordered
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
      const p: MdNode = { type: "paragraph", content: [] };
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
    const p: MdNode = { type: "paragraph", content: [] };
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
function inline(s: string, marks: MdMark[] = []): MdNode[] {
  const out: MdNode[] = [];
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
      const codeMarks: MdMark[] = [...marks.filter((m) => m.type === "link"), { type: "code" }];
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
        const shown: MdNode = { type: "text", text: href, marks: [...marks, linkMark(href)] };
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

function linkMark(href: string): MdMark {
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
