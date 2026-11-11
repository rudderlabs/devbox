// Markdown to Atlassian Document Format (ADF), for the comments devbox posts on
// Jira: ../markdown's tree, which has ADF's shape, packed into comments of
// the size Jira takes.

import { type MdMark, type MdNode, parseMarkdown } from "../markdown";

export type AdfMark = MdMark;
export type AdfNode = MdNode;
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
  const blocks = parseMarkdown(typeof markdown === "string" ? markdown : "");
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
  const blocks = parseMarkdown(typeof markdown === "string" ? markdown : "");
  const start = pack(blocks, SHORT_COMMENT_CHARS - size(TRUNCATED) - 1)[0] ?? [];
  return doc([...start, TRUNCATED]);
}

function doc(content: AdfNode[]): AdfDoc {
  return { type: "doc", version: 1, content };
}

function paragraph(text: string): AdfNode {
  return { type: "paragraph", content: [{ type: "text", text }] };
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
