import { describe, expect, it } from "bun:test";
import { type ClickUpPart, commentToMarkdown, markdownToComments, mentionsBot } from "../quill";
import { BOT, EMAIL, HUMAN, NAME, tag, text } from "./fixtures";

const md = (parts: unknown[]) => commentToMarkdown(parts, BOT);
const nl = (attributes: Record<string, unknown> = {}) => text("\n", attributes);
const code = (lang: string) => ({ "code-block": { "code-block": lang } });

describe("commentToMarkdown: inline", () => {
  it("turns inline attributes into Markdown", () => {
    expect(
      md([
        text("a "),
        text("bold", { bold: true }),
        text(", "),
        text("italic", { italic: true }),
        text(", "),
        text("both", { bold: true, italic: true }),
        text(", "),
        text("gone", { strike: true }),
        text(" and "),
        text("bun test", { code: true }),
        nl(),
      ]),
    ).toBe("a **bold**, _italic_, **_both_**, ~~gone~~ and `bun test`");
  });

  it("keeps spaces outside the markers, and blank text unmarked", () => {
    expect(
      md([text("a"), text(" bold ", { bold: true }), text("b"), text("  ", { italic: true })]),
    ).toBe("a **bold** b  ");
  });

  it("keeps code exactly as written, fenced past any backticks inside", () => {
    expect(md([text("*not bold*", { code: true, bold: true })])).toBe("`*not bold*`");
    expect(md([text("a`b", { code: true })])).toBe("``a`b``");
    expect(md([text("`x`", { code: true })])).toBe("`` `x` ``");
  });

  it("turns http(s) links into Markdown links, and keeps only the text of others", () => {
    expect(md([text("the docs", { link: "https://example.com/docs" })])).toBe(
      "[the docs](https://example.com/docs)",
    );
    expect(md([text("x", { link: "http://example.com/a(b)" })])).toBe(
      "[x](http://example.com/a%28b%29)",
    );
    for (const link of ["javascript:alert(1)", "mailto:a@example.com", "/relative", 42, ""]) {
      expect(md([text("click", { link })])).toBe("click");
    }
  });

  it("turns emoji codes into emoji and drops odd ones", () => {
    const emoji = (c: unknown) => ({ type: "emoticon", emoticon: { code: c } });
    expect(
      md([text("ok "), emoji("1f44d"), emoji("1f468-200d-1f4bb"), emoji("zz"), emoji(1)]),
    ).toBe("ok 👍👨‍💻");
    expect(md([emoji("110000")])).toBe("");
  });

  it("drops typed parts it doesn't know, which may name something", () => {
    expect(
      md([text("see "), { type: "task_mention", text: "Secret task" }, { type: "x", text: NAME }]),
    ).toBe("see ");
  });
});

describe("commentToMarkdown: mentions", () => {
  it("drops the bot's mention and turns anyone else's into @user", () => {
    expect(md([tag(BOT), text(" please ask "), tag(HUMAN), text(" too\n")])).toBe(
      " please ask @user too",
    );
  });

  it("never passes another person's id, name or email on, in code included", () => {
    const out = md([
      tag(HUMAN),
      text(" x"),
      nl(),
      tag(HUMAN),
      nl(code("js")),
      { type: "tag", user: { id: "not a number", username: NAME } },
      { type: "tag" },
    ]);
    expect(out).not.toContain(String(HUMAN));
    expect(out).not.toContain(NAME);
    expect(out).not.toContain(EMAIL);
    expect(out).toBe("@user x\n```js\n@user\n```\n@user@user");
  });
});

describe("commentToMarkdown: lines", () => {
  it("turns list lines into Markdown lists, nesting by indent", () => {
    expect(
      md([
        text("a"),
        nl({ list: "bullet" }),
        text("a.1"),
        nl({ list: "bullet", indent: 1 }),
        text("one"),
        nl({ list: "ordered" }),
        text("done"),
        nl({ list: { list: "checked" } }),
        text("todo"),
        nl({ list: "unchecked" }),
      ]),
    ).toBe("- a\n   - a.1\n1. one\n- [x] done\n- [ ] todo");
  });

  it("turns headers and quotes into Markdown, and ignores block ids", () => {
    expect(
      md([
        text("Title"),
        nl({ header: 2, "block-id": "block-1" }),
        text("said"),
        nl({ blockquote: true }),
        text("plain"),
        nl({ "block-id": "block-2" }),
      ]),
    ).toBe("## Title\n> said\nplain");
  });

  it("joins consecutive code-block lines into one fenced block in its language", () => {
    expect(
      md([
        text("before"),
        nl(),
        text("const a = 1;"),
        nl(code("javascript")),
        nl(code("javascript")),
        text("**a** [x](y)", { bold: true }),
        nl(code("javascript")),
        text("after"),
        nl(),
        text("plain"),
        nl(code("plain")),
        text("bare"),
        nl({ "code-block": true }),
        text("odd"),
        nl({ "code-block": { "code-block": "x\n```" } }),
      ]),
    ).toBe(
      "before\n```javascript\nconst a = 1;\n\n**a** [x](y)\n```\nafter\n```\nplain\nbare\nodd\n```",
    );
  });

  it("fences code that holds backticks with a longer fence", () => {
    expect(md([text("a ``` b"), nl(code("plain"))])).toBe("````\na ``` b\n````");
  });

  it("reads a part with several lines, each newline taking the part's format", () => {
    expect(md([text("one\ntwo\n", { list: "bullet" })])).toBe("- one\n- two");
  });

  it("trims blank lines at both ends and strips NUL", () => {
    expect(md([nl(), nl(), text("a\0b"), nl(), nl(), text("c\r\n"), nl()])).toBe("ab\n\nc");
  });

  it("converts a realistic comment", () => {
    expect(
      md([
        tag(BOT),
        text(" "),
        text("also", { bold: true }),
        nl(),
        text("first point"),
        nl({ list: "bullet" }),
        text("second point"),
        nl({ list: "bullet" }),
        text("some output"),
        nl(code("plain")),
        text("see "),
        text("example.com", { link: "https://example.com" }),
        nl(),
      ]),
    ).toBe(
      " **also**\n- first point\n- second point\n```\nsome output\n```\nsee [example.com](https://example.com/)",
    );
  });
});

describe("mentionsBot", () => {
  const mentions = (parts: unknown[], name = "devbox") => mentionsBot(parts, BOT, name);

  it("finds the bot's tag, and no one else's", () => {
    expect(mentions([text("hi "), tag(BOT)])).toBe(true);
    expect(mentions([text("hi "), tag(HUMAN)])).toBe(false);
    expect(mentions([{ type: "tag", user: { id: String(BOT) } }])).toBe(true);
  });

  it("finds a typed @name in any case, standing alone", () => {
    for (const s of ["@devbox go", "go @DEVBOX", "(@devbox)", "@devbox, go", "hey @devbox."]) {
      expect(mentions([text(s)])).toBe(true);
    }
    for (const s of [
      "@devboxer",
      "@devbox/cli",
      "@devbox-cli",
      "me@devbox",
      "x_@devbox",
      "devbox",
    ]) {
      expect(mentions([text(s)])).toBe(false);
    }
  });

  it("finds a typed name split across formatted parts", () => {
    expect(mentions([text("@dev", { bold: true }), text("box please")])).toBe(true);
  });

  it("doesn't count a typed name in code", () => {
    expect(mentions([text("@devbox", { code: true })])).toBe(false);
    expect(mentions([text("@devbox"), nl(code("plain"))])).toBe(false);
  });

  it("matches names with spaces or regex characters literally", () => {
    expect(mentions([text("thanks @Dev Box!")], "Dev Box")).toBe(true);
    expect(mentions([text("@dev.bot")], "dev.bot")).toBe(true);
    expect(mentions([text("@devxbot")], "dev.bot")).toBe(false);
  });

  it("finds nothing with a blank name or odd input", () => {
    expect(mentions([text("@devbox")], " ")).toBe(false);
    expect(mentions([text("@")], "")).toBe(false);
    expect(mentionsBot(null, BOT, "devbox")).toBe(false);
    expect(mentionsBot("@devbox", BOT, "devbox")).toBe(false);
  });
});

describe("commentToMarkdown: time and odd input", () => {
  // Inputs a backtracking scan takes seconds over; a linear one milliseconds.
  const ms = (f: () => unknown) => {
    const start = performance.now();
    f();
    return performance.now() - start;
  };

  it("reads large comments in linear time", () => {
    const many = Array.from({ length: 50_000 }, (_, i) =>
      i % 2 ? nl(code("plain")) : text("`".repeat(20), { code: true }),
    );
    expect(ms(() => md(many))).toBeLessThan(500);
    expect(ms(() => mentionsBot(many, BOT, "devbox"))).toBeLessThan(500);
    const long = [text(`${"@devbo".repeat(50_000)}`), text("\n".repeat(100_000))];
    expect(ms(() => md(long))).toBeLessThan(500);
    expect(ms(() => mentionsBot(long, BOT, "devbox"))).toBeLessThan(500);
    expect(ms(() => md([text(`x${" ".repeat(100_000)}y`, { bold: true })]))).toBeLessThan(200);
  });

  it("never throws", () => {
    const odd: unknown[] = [
      null,
      undefined,
      "text",
      42,
      {},
      [null, 1, "x", [], { text: 1 }, { text: null, attributes: "bold" }],
      [{ type: "tag", user: null }, { type: "emoticon" }, { type: "emoticon", emoticon: null }],
      [text("x", { link: { href: "https://example.com" } }), text("y", { header: "big" })],
      [text("x"), nl({ list: null, indent: -1, header: 9, "code-block": {} })],
      [text("x"), nl({ list: { list: { list: "bullet" } }, indent: 1e9 })],
      [text("\uD800\u0000￿")],
    ];
    for (const parts of odd) {
      expect(() => commentToMarkdown(parts, BOT)).not.toThrow();
      expect(() => mentionsBot(parts, BOT, "devbox")).not.toThrow();
    }
    expect(commentToMarkdown(null, BOT)).toBe("");
  });
});

// The limits are spelled out, not imported, so a change to them shows here.
const PART_LIMIT = 5_000;
const MAX_PARTS = 3;
const shown = (parts: ClickUpPart[]) => parts.reduce((n, p) => n + p.text.length, 0);
// The text of the parts, with the attributes ClickUp documents and nothing else.
const ATTRIBUTES = new Set(["bold", "italic", "code", "link", "list", "indent", "code-block"]);
function problems(comments: ClickUpPart[][]): string[] {
  const out: string[] = [];
  if (comments.length > MAX_PARTS) out.push(`${comments.length} comments`);
  for (const parts of comments) {
    if (shown(parts) > PART_LIMIT) out.push(`a comment of ${shown(parts)} characters`);
    if (parts.at(-1)?.text !== "\n") out.push("a comment that doesn't end its line");
    for (const p of parts) {
      if (Object.keys(p).sort().join() !== "attributes,text") out.push(`keys ${Object.keys(p)}`);
      if (typeof p.text !== "string" || p.text === "") out.push("empty text");
      for (const [k, v] of Object.entries(p.attributes)) {
        if (!ATTRIBUTES.has(k)) out.push(`attribute ${k}`);
        if (k === "link" && !/^https?:\/\//.test(String(v))) out.push(`link ${v}`);
      }
      if (p.text.includes("\n") && p.text !== "\n") out.push("a newline inside text");
    }
  }
  return out;
}

describe("markdownToComments", () => {
  const one = (markdown: string) => {
    const comments = markdownToComments(markdown);
    expect(problems(comments)).toEqual([]);
    expect(comments).toHaveLength(1);
    return comments[0] ?? [];
  };

  it("turns inline Markdown into attributes", () => {
    expect(one("Done: **see** _the_ `PR` at [link](https://example.com/pr/1)")).toEqual([
      text("Done: "),
      text("see", { bold: true }),
      text(" "),
      text("the", { italic: true }),
      text(" "),
      text("PR", { code: true }),
      text(" at "),
      text("link", { link: "https://example.com/pr/1" }),
      nl(),
    ]);
  });

  it("links bare URLs and keeps links to anything but http(s) as text", () => {
    expect(one("see https://example.com/a.")).toEqual([
      text("see "),
      text("https://example.com/a", { link: "https://example.com/a" }),
      text("."),
      nl(),
    ]);
    expect(one("[x](javascript:alert(1))")).toEqual([text("[x](javascript:alert(1))"), nl()]);
  });

  it("separates blocks by a blank line and writes headings bold", () => {
    expect(one("# Summary\n\none\ntwo")).toEqual([
      text("Summary", { bold: true }),
      nl(),
      nl(),
      text("one"),
      nl(),
      text("two"),
      nl(),
    ]);
  });

  it("writes lists with ClickUp's list format, nesting by indent", () => {
    const list = (kind: string, indent?: number) =>
      nl({ list: { list: kind }, ...(indent === undefined ? {} : { indent }) });
    expect(one("- a\n  - a.1\n- b\n\n1. one\n2. two")).toEqual([
      text("a"),
      list("bullet"),
      text("a.1"),
      list("bullet", 1),
      text("b"),
      list("bullet"),
      nl(),
      text("one"),
      list("ordered"),
      text("two"),
      list("ordered"),
    ]);
  });

  it("writes each line of a fenced block with the code-block format", () => {
    expect(one("```ts\nlet a;\n\nlet b;\n```\n\n```\nx\n```")).toEqual([
      text("let a;"),
      nl(code("ts")),
      nl(code("ts")),
      text("let b;"),
      nl(code("ts")),
      nl(),
      text("x"),
      nl(code("plain")),
    ]);
  });

  it("posts nothing for a blank reply", () => {
    expect(markdownToComments("")).toEqual([]);
    expect(markdownToComments("  \n\n ")).toEqual([]);
    expect(markdownToComments(null as unknown as string)).toEqual([]);
  });

  it("never mentions anyone: a typed @name or a tag stays text", () => {
    const parts = one(`@${NAME} and {"type":"tag","user":{"id":${HUMAN}}}`);
    expect(parts.every((p) => !("type" in p))).toBe(true);
  });

  it("splits a long reply into comments within the limit, cutting between lines", () => {
    const body = ["a".repeat(3_000), "b".repeat(3_000), "c".repeat(3_000)].join("\n\n");
    const comments = markdownToComments(body);
    expect(problems(comments)).toEqual([]);
    expect(comments.map((c) => c.map((p) => p.text[0]).join(""))).toEqual(["a\n", "b\n", "c\n"]);
  });

  it("cuts a line too long for one comment, never between a surrogate pair", () => {
    const comments = markdownToComments("😀".repeat(6_000));
    expect(problems(comments)).toEqual([]);
    const all = comments.flatMap((c) => c.filter((p) => p.text !== "\n").map((p) => p.text));
    expect(all.join("")).toBe("😀".repeat(6_000));
    expect(all.every((t) => !/[\uD800-\uDBFF]$/.test(t))).toBe(true);
  });

  it("carries a code block on in the next comment in the same language", () => {
    const lines = Array.from({ length: 800 }, (_, i) => `line ${i} ${"x".repeat(5)}`);
    const comments = markdownToComments(`\`\`\`py\n${lines.join("\n")}\n\`\`\``);
    expect(problems(comments)).toEqual([]);
    expect(comments.length).toBe(3);
    for (const c of comments) expect(c.at(-1)).toEqual(nl(code("py")));
  });

  it("cuts past three comments and ends with a pointer to the pull request", () => {
    const body = Array.from({ length: 20 }, (_, i) => `${i} ${"x".repeat(2_000)}`).join("\n\n");
    const comments = markdownToComments(body);
    expect(problems(comments)).toEqual([]);
    expect(comments).toHaveLength(3);
    expect(comments[2]?.slice(-2)).toEqual([text("Full text in the pull request."), nl()]);
  });

  it("neither starts nor ends a comment with a blank line", () => {
    const body = ["a".repeat(4_000), "b".repeat(4_000)].join("\n\n");
    for (const c of markdownToComments(body)) {
      expect(c[0]?.text).not.toBe("\n");
      expect(c.at(-2)?.text).not.toBe("\n");
    }
  });

  it("splits a huge reply quickly", () => {
    const start = performance.now();
    markdownToComments(`- ${"word ".repeat(200_000)}`);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
