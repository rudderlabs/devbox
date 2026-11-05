import { describe, expect, it } from "bun:test";
import { type AdfDoc, type AdfMark, type AdfNode, adfComments } from "../adf";

// The limits are spelled out, not imported, so a change to them shows here:
// a comment's serialized ADF stays within 30,000 characters less a margin,
// and a reply takes at most three comments.
const PART_LIMIT = 29_000;
const MAX_PARTS = 3;

const size = (d: AdfDoc) => JSON.stringify(d).length;

const BLOCKS = new Set(["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "rule"]);
const INLINE = new Set(["text", "hardBreak"]);
const CHILDREN: Record<string, Set<string>> = {
  doc: BLOCKS,
  paragraph: INLINE,
  heading: INLINE,
  bulletList: new Set(["listItem"]),
  orderedList: new Set(["listItem"]),
  listItem: new Set(["paragraph", "bulletList", "orderedList", "codeBlock"]),
  codeBlock: new Set(["text"]),
};
const MARKS = new Set(["strong", "em", "code", "link"]);

// What would make Jira reject the doc, after the ADF schema; [] when valid.
function adfProblems(doc: AdfDoc): string[] {
  const problems: string[] = [];
  if (doc.type !== "doc" || doc.version !== 1) problems.push("doc: wrong type or version");
  if (doc.content.length === 0) problems.push("doc: empty");
  const visit = (n: AdfNode, parent: string) => {
    const at = `${parent} > ${n.type}`;
    if (!CHILDREN[parent]?.has(n.type)) problems.push(`${at}: not allowed here`);
    if (n.type === "text") {
      if (typeof n.text !== "string" || n.text === "") problems.push(`${at}: empty text`);
      const types = (n.marks ?? []).map((m) => m.type);
      if (new Set(types).size !== types.length) problems.push(`${at}: repeated mark ${types}`);
      if (types.some((t) => !MARKS.has(t))) problems.push(`${at}: unknown mark ${types}`);
      if (types.includes("code") && types.some((t) => t !== "code" && t !== "link")) {
        problems.push(`${at}: code mark with ${types}`);
      }
      if (parent === "codeBlock" && types.length > 0) problems.push(`${at}: marks in code`);
      for (const m of n.marks ?? []) {
        const href = (m as AdfMark & { attrs?: { href?: unknown } }).attrs?.href;
        if (m.type === "link" && (typeof href !== "string" || !/^https?:\/\//.test(href))) {
          problems.push(`${at}: link without an http(s) href`);
        }
      }
      if (n.content) problems.push(`${at}: text with content`);
      return;
    }
    if (n.text !== undefined || n.marks) problems.push(`${at}: text or marks off a text node`);
    const level = n.attrs?.level;
    if (
      n.type === "heading" &&
      !(Number.isInteger(level) && Number(level) >= 1 && Number(level) <= 6)
    ) {
      problems.push(`${at}: level ${level}`);
    }
    const order = n.attrs?.order;
    if (
      n.type === "orderedList" &&
      order !== undefined &&
      !(Number.isInteger(order) && Number(order) >= 0)
    ) {
      problems.push(`${at}: order ${order}`);
    }
    if (n.type === "codeBlock" && n.attrs?.language !== undefined && !n.attrs.language) {
      problems.push(`${at}: blank language`);
    }
    if (["bulletList", "orderedList", "listItem"].includes(n.type) && !n.content?.length) {
      problems.push(`${at}: empty`);
    }
    const first = n.content?.[0]?.type;
    if (n.type === "listItem" && first !== "paragraph" && first !== "codeBlock") {
      problems.push(`${at}: starts with ${first}`);
    }
    if ((n.type === "hardBreak" || n.type === "rule") && (n.content || n.attrs)) {
      problems.push(`${at}: content or attrs on a leaf`);
    }
    for (const child of n.content ?? []) visit(child, n.type);
  };
  for (const n of doc.content) visit(n, "doc");
  return problems;
}

// adfComments, with every doc checked for validity and the limits.
function convert(markdown: string): AdfDoc[] {
  const docs = adfComments(markdown);
  expect(docs.length).toBeLessThanOrEqual(MAX_PARTS);
  for (const d of docs) {
    expect(adfProblems(d)).toEqual([]);
    expect(size(d)).toBeLessThanOrEqual(PART_LIMIT);
  }
  return docs;
}

const ALLOWED_NODES = new Set([...BLOCKS, ...INLINE, "listItem"]);

function* walk(nodes: AdfNode[]): Generator<AdfNode> {
  for (const n of nodes) {
    yield n;
    yield* walk(n.content ?? []);
  }
}

function only(markdown: string): AdfDoc {
  const docs = convert(markdown);
  expect(docs).toHaveLength(1);
  return docs[0] as AdfDoc;
}

// Every text the doc shows, in order.
const plain = (d: AdfDoc) => [...walk(d.content)].map((n) => n.text ?? "").join("");
const text = (t: string, marks?: AdfNode["marks"]): AdfNode =>
  marks ? { type: "text", text: t, marks } : { type: "text", text: t };
const para = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });

describe("adfComments: conversion", () => {
  it("wraps blocks in a version 1 doc", () => {
    expect(only("hi")).toEqual({ type: "doc", version: 1, content: [para(text("hi"))] });
  });

  it("converts headings, rules and line breaks", () => {
    expect(only("## Title\n\nline one\nline two\n\n---").content).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
      para(text("line one"), { type: "hardBreak" }, text("line two")),
      { type: "rule" },
    ]);
  });

  it("converts bold, italic, inline code and links", () => {
    expect(only("**b** _i_ *j* `c` [l](https://example.com/x) __u__").content).toEqual([
      para(
        text("b", [{ type: "strong" }]),
        text(" "),
        text("i", [{ type: "em" }]),
        text(" "),
        text("j", [{ type: "em" }]),
        text(" "),
        text("c", [{ type: "code" }]),
        text(" "),
        text("l", [{ type: "link", attrs: { href: "https://example.com/x" } }]),
        text(" "),
        text("u", [{ type: "strong" }]),
      ),
    ]);
  });

  it("nests emphasis and keeps only the link beside a code mark", () => {
    const [p] = only("***both*** and **bold `code`**").content;
    expect(p?.content?.[0]).toEqual(text("both", [{ type: "strong" }, { type: "em" }]));
    expect(p?.content?.at(-1)).toEqual(text("code", [{ type: "code" }]));
  });

  it("leaves snake_case and spaced stars as written", () => {
    expect(plain(only("call do_the_thing and 2 * 3 * 4"))).toBe("call do_the_thing and 2 * 3 * 4");
  });

  it("links bare and angle-bracket URLs, leaving sentence punctuation out", () => {
    const d = only("See https://example.com/pull/1. Or <https://example.com/a>");
    const links = [...walk(d.content)].filter((n) => n.marks?.some((m) => m.type === "link"));
    expect(links.map((n) => n.text)).toEqual([
      "https://example.com/pull/1",
      "https://example.com/a",
    ]);
  });

  it("converts nested and numbered lists, keeping the start number", () => {
    expect(only("- a\n  - a1\n- b\n\n3. three\n4. four").content).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              para(text("a")),
              { type: "bulletList", content: [{ type: "listItem", content: [para(text("a1"))] }] },
            ],
          },
          { type: "listItem", content: [para(text("b"))] },
        ],
      },
      {
        type: "orderedList",
        attrs: { order: 3 },
        content: [
          { type: "listItem", content: [para(text("three"))] },
          { type: "listItem", content: [para(text("four"))] },
        ],
      },
    ]);
  });

  it("converts fenced code with and without a language", () => {
    expect(only("```ts\nconst a = `x`;\n\n**not bold**\n```\n~~~\nplain\n~~~").content).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [text("const a = `x`;\n\n**not bold**")],
      },
      { type: "codeBlock", content: [text("plain")] },
    ]);
  });

  it("gives no docs for blank input", () => {
    expect(adfComments("")).toEqual([]);
    expect(adfComments(" \n\n  \n")).toEqual([]);
  });
});

describe("adfComments: safety", () => {
  const hostile = [
    "[x](javascript:alert(1)) [y](JaVaScRiPt:alert(1)) [z](data:text/html,hi) [v](vbscript:x)",
    "[m](mailto:a@example.com) [f](file:///etc/passwd) [r](/relative) <javascript:alert(1)>",
    "[~accountid:5d4c3b2a1f0e9d8c7b6a5f43] and [~someone] and @here",
    "!http://example.com/a.png! and ![img](http://example.com/i.png)",
    '<img src="https://example.com/x.png"> <a href="javascript:x">a</a>',
    ":smile: {status:colour=Red|title=x} {panel}p{panel} {expand}e{expand}",
    "| a | b |\n|---|---|\n| 1 | 2 |\n> quoted\n\n<details>x</details>",
    "https://example.com/smart-link and [text](https://example.com/?q=<script>)",
    "- [ ] task\n- [x] done\n\n1) one\n\n***\n\n```mermaid\ngraph\n```",
  ].join("\n\n");

  it("emits only the allowed nodes and marks", () => {
    for (const d of convert(hostile)) {
      for (const n of walk(d.content)) {
        expect(ALLOWED_NODES.has(n.type)).toBe(true);
        for (const m of n.marks ?? []) expect(MARKS.has(m.type)).toBe(true);
      }
    }
  });

  it("links only http(s) URLs", () => {
    const d = only(hostile);
    for (const n of walk(d.content)) {
      for (const m of n.marks ?? []) {
        if (m.type === "link") expect(m.attrs.href).toMatch(/^https?:\/\//);
      }
    }
  });

  it("shows a link to another scheme, a mention and image markup as literal text", () => {
    const shown = plain(only(hostile));
    expect(shown).toContain("[x](javascript:alert(1))");
    expect(shown).toContain("<javascript:alert(1)>");
    expect(shown).toContain("[~accountid:5d4c3b2a1f0e9d8c7b6a5f43]");
    expect(shown).toContain("!http://example.com/a.png!");
    expect(shown).toContain("![img](");
  });

  it("never throws on odd input", () => {
    const odd = [
      "`",
      "``",
      "```",
      "**",
      "*_*_*_*",
      "[",
      "[]()",
      "[](https://example.com)",
      "<>",
      "<https://>",
      "\\",
      "- \n  - \n    -",
      "1.",
      "\u0000\uD800￿",
      `${"*_".repeat(50_000)}x${"_*".repeat(50_000)}`,
      // Long runs a backtracking regex would take seconds over.
      `https://a.example/${".".repeat(100_000)}x`,
      `https://a.example/${")".repeat(100_000)}`,
      `# x${" ".repeat(100_000)}y`,
      `${"[a](".repeat(50_000)}`,
      `${"`a ``".repeat(30_000)}`,
    ];
    for (const s of odd) convert(s);
    expect(adfComments(null as unknown as string)).toEqual([]);
  });
});

describe("adfComments: validity", () => {
  it("never repeats a mark, even where links or emphasis nest", () => {
    for (const md of [
      "[https://a.example/x](https://b.example/y)",
      "[see <https://a.example/x>](https://b.example/y)",
      "*a _b_ c* and _a *b* c_",
      "**a __b__ c** and __a **b** c__",
      "***a _b_ __c__ d***",
      "[**b** _i_ `c` *_x_*](https://a.example)",
      "**bold `code` [l](https://a.example) _it `c`_**",
    ]) {
      convert(md);
    }
  });

  it("stays valid on random markdown-ish input", () => {
    // A fixed seed, so a failure reproduces.
    let seed = 0x5eed;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const tokens = [
      "*",
      "**",
      "_",
      "__",
      "`",
      "``",
      "```",
      "~~~",
      "[",
      "]",
      "(",
      ")",
      "<",
      ">",
      "!",
      "\\",
      "#",
      "## ",
      "- ",
      "  - ",
      "1. ",
      "3) ",
      "---",
      "\n",
      "\n\n",
      " ",
      "\t",
      "a",
      "b c",
      ".",
      "|",
      "http://a.example/x",
      "https://b.example",
      "javascript:x",
      "[~accountid:x]",
      "h",
    ];
    for (let n = 0; n < 3000; n++) {
      let md = "";
      const length = 1 + Math.floor(random() * 40);
      for (let k = 0; k < length; k++) md += tokens[Math.floor(random() * tokens.length)];
      convert(md);
    }
  });
});

describe("adfComments: time", () => {
  // Runs that made each turned-down URL rescan the rest of the line: about two
  // seconds each at this size before, a few milliseconds now.
  const ms = (f: () => unknown) => {
    const start = performance.now();
    f();
    return performance.now() - start;
  };
  const fill = (unit: string) => unit.repeat(Math.ceil(60_000 / unit.length)).slice(0, 60_000);

  it("turns down a run of unusable URLs in linear time", () => {
    for (const unit of ["http://", "(http://a", "[x](http://a", "<http://a"]) {
      const md = fill(unit);
      expect(ms(() => adfComments(md))).toBeLessThan(300);
      convert(md);
    }
  });
});

describe("adfComments: splitting", () => {
  const paragraphs = (n: number) =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i} ${"lorem ipsum ".repeat(80)}`).join("\n\n");

  it("keeps a reply that fits in one comment whole", () => {
    expect(convert(paragraphs(10))).toHaveLength(1);
  });

  it("splits a long reply between blocks, each part within the limit", () => {
    const docs = convert(paragraphs(40));
    expect(docs.length).toBe(2);
    for (const d of docs) expect(size(d)).toBeLessThanOrEqual(PART_LIMIT);
    expect(docs.map(plain).join("")).toBe(
      plain({ type: "doc", version: 1, content: docs.flatMap((d) => d.content) }),
    );
    expect(docs.flatMap((d) => d.content)).toHaveLength(40);
  });

  it("closes a code block cut across parts and reopens it with its language", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `const line${i} = "${"x".repeat(20)}";`);
    const docs = convert(`Intro\n\n\`\`\`ts\n${lines.join("\n")}\n\`\`\`\n\nOutro`);
    expect(docs).toHaveLength(2);
    const [first, second] = docs as [AdfDoc, AdfDoc];
    // The code starts in the first part, right after the intro.
    expect(first.content.map((n) => n.type)).toEqual(["paragraph", "codeBlock"]);
    expect(second.content.map((n) => n.type)).toEqual(["codeBlock", "paragraph"]);
    const end = first.content.at(-1);
    const start = second.content[0];
    expect(end?.type).toBe("codeBlock");
    expect(start?.type).toBe("codeBlock");
    expect(end?.attrs).toEqual({ language: "ts" });
    expect(start?.attrs).toEqual({ language: "ts" });
    // Cut at a line end: nothing is lost or broken mid-line.
    expect(`${end?.content?.[0]?.text}\n${start?.content?.[0]?.text}`).toBe(lines.join("\n"));
    for (const d of docs) expect(size(d)).toBeLessThanOrEqual(PART_LIMIT);
  });

  it("cuts one huge paragraph, list or line of code to fit", () => {
    const words = "word ".repeat(20_000);
    const items = Array.from({ length: 3000 }, (_, i) => `${i + 1}. item ${"y".repeat(20)}`);
    const cases = [words, items.join("\n"), `\`\`\`\n${"z".repeat(70_000)}\n\`\`\``, `- ${words}`];
    for (const md of cases) {
      const docs = convert(md);
      expect(docs.length).toBeGreaterThan(1);
      for (const d of docs) expect(size(d)).toBeLessThanOrEqual(PART_LIMIT);
    }
  });

  it("keeps parts within the limit whatever the URLs or code languages", () => {
    const long = `https://example.com/${"a".repeat(40_000)}`;
    for (const md of [
      `[x](${long}) ${"word ".repeat(10_000)}`,
      `${long} and more`,
      `\`\`\`${"l".repeat(50_000)}\n${"code\n".repeat(10_000)}\`\`\``,
    ]) {
      convert(md);
    }
    const [d] = convert(`[x](${long})`);
    expect([...walk(d?.content ?? [])].some((n) => n.marks?.length)).toBe(false);
  });

  it("never makes an empty piece of code where a cut meets a newline", () => {
    // A blank first line, then more than a part holds.
    const blank = convert(`\`\`\`\n\n${"x".repeat(40_000)}\n\`\`\``);
    expect(blank).toHaveLength(2);
    // A line that exactly fills a part, then its newline: the cut lands right
    // before the newline, and the newline must not become a piece of its own.
    const exact = convert(`\`\`\`\n${"a".repeat(28_902)}\n${"b".repeat(40_000)}\n\`\`\``);
    expect(exact).toHaveLength(3);
    expect(exact.some((d) => plain(d).includes("Full text"))).toBe(false);
    expect(exact.map(plain).join("").replace(/\n/g, "")).toBe(
      `${"a".repeat(28_902)}${"b".repeat(40_000)}`,
    );
  });

  it("carries numbering on when a numbered list is cut", () => {
    const items = Array.from(
      { length: 2000 },
      (_, i) => `${i + 1}. item ${i + 1} ${"y".repeat(20)}`,
    );
    const [, second] = convert(items.join("\n")) as [AdfDoc, AdfDoc];
    const list = second.content[0];
    const firstText = list?.content?.[0]?.content?.[0]?.content?.[0]?.text;
    expect(list?.attrs?.order).toBe(Number(firstText?.split(" ")[1]));
  });

  it("truncates past the last part and points to the pull request", () => {
    const docs = convert(paragraphs(200));
    expect(docs).toHaveLength(MAX_PARTS);
    for (const d of docs) expect(size(d)).toBeLessThanOrEqual(PART_LIMIT);
    expect(docs.at(-1)?.content.at(-1)).toEqual(para(text("Full text in the pull request.")));
    expect(docs.slice(0, -1).some((d) => plain(d).includes("Full text"))).toBe(false);
  });

  it("truncates a huge code block, filling the last part", () => {
    const docs = convert(`\`\`\`\n${"a line of code\n".repeat(20_000)}\`\`\``);
    expect(docs).toHaveLength(MAX_PARTS);
    const last = docs.at(-1) as AdfDoc;
    expect(last.content.map((n) => n.type)).toEqual(["codeBlock", "paragraph"]);
    expect(size(last)).toBeGreaterThan(PART_LIMIT - 1000);
    expect(size(last)).toBeLessThanOrEqual(PART_LIMIT);
  });
});
