import { describe, expect, it } from "bun:test";
import { mentionsBot, wikiToMarkdown } from "../wiki";

const BOT = "5e0f1a2b3c4d5e6f7a8b9c0d";
const OTHER = "5d4c3b2a1f0e9d8c7b6a5f43";
const OTHER_LONG = "557058:0f1e2d3c-aaaa-bbbb-cccc-111122223333";

const md = (wiki: string) => wikiToMarkdown(wiki, BOT);

describe("wikiToMarkdown: inline", () => {
  it("turns *bold* into **bold** and keeps _italic_", () => {
    expect(md("a *bold* and _italic_ word")).toBe("a **bold** and _italic_ word");
  });

  it("leaves stars that aren't bold alone", () => {
    expect(md("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(md("a*b*c")).toBe("a*b*c");
  });

  it("keeps formatting-like text inside {{monospace}} as written", () => {
    expect(md("glob {{src/*.ts*}} and *bold*")).toBe("glob `src/*.ts*` and **bold**");
    expect(md("use {{*value*}} here")).toBe("use `*value*` here");
    expect(md("see {{[label|https://example.com]}}")).toBe("see `[label|https://example.com]`");
    expect(md("tick {{a`b}}")).toBe("tick ``a`b``");
  });

  it("turns {{monospace}} into inline code", () => {
    expect(md("run {{bun test}} now")).toBe("run `bun test` now");
  });

  it("turns [text|url] and [url] into Markdown links", () => {
    expect(md("see [the docs|https://example.com/docs]")).toBe(
      "see [the docs](https://example.com/docs)",
    );
    expect(md("[example.com|http://example.com]")).toBe("[example.com](http://example.com)");
    expect(md("[https://example.com/a]")).toBe("<https://example.com/a>");
  });

  it("keeps only the text of a link to anything but http(s)", () => {
    expect(md("[click|javascript:alert(1)] and [mail|mailto:a@example.com]")).toBe(
      "click and mail",
    );
  });

  it("leaves brackets that aren't links as written", () => {
    expect(md("[WIP] title")).toBe("[WIP] title");
  });

  it("drops unknown macros and keeps their text", () => {
    expect(md("{color:red}red{color} and {quote}said{quote} and {panel:title=X}p{panel}")).toBe(
      "red and said and p",
    );
  });
});

describe("wikiToMarkdown: blocks", () => {
  it("turns h1. to h6. into headings", () => {
    expect(md("h1. One\nh3. Three\nh6. Six")).toBe("# One\n### Three\n###### Six");
  });

  it("turns * and # lists into - and 1. lists, nesting by depth", () => {
    expect(md("* a\n** a.1\n# one\n## one.a\n*# mixed")).toBe(
      "- a\n   - a.1\n1. one\n   1. one.a\n   1. mixed",
    );
  });

  it("keeps bold inside a list item", () => {
    expect(md("* the *key* point")).toBe("- the **key** point");
  });

  it("turns bq. into a quote and ---- into a rule", () => {
    expect(md("bq. quoted\n----")).toBe("> quoted\n---");
  });

  it("turns {noformat} into a fenced block, even when it shares lines with text", () => {
    expect(
      md("before\n\n{noformat}raw *x* [a|https://b.example]\nline two{noformat}\n\nafter"),
    ).toBe("before\n\n```\nraw *x* [a|https://b.example]\nline two\n```\n\nafter");
  });

  it("turns {code} and {code:lang} into fenced blocks with the language", () => {
    expect(md("{code}\nplain\n{code}")).toBe("```\nplain\n```");
    expect(md("{code:python}\nprint(1)\n{code}")).toBe("```python\nprint(1)\n```");
    expect(md("{code:title=a.ts|ts}\nlet a;\n{code}")).toBe("```ts\nlet a;\n```");
  });

  it("fences code that holds backticks with a longer fence", () => {
    expect(md("{noformat}a ``` b{noformat}")).toBe("````\na ``` b\n````");
  });

  it("drops the syntax of an unclosed {code} and keeps its text", () => {
    expect(md("{code}\nnever closed")).toBe("never closed");
  });

  it("converts a realistic comment", () => {
    const wiki =
      "@devbox *also*\n\n* first point\n* second point\n\n{noformat}some output\nmore output{noformat}\n\n[example.com|https://example.com]";
    expect(md(wiki)).toBe(
      "@devbox **also**\n\n- first point\n- second point\n\n```\nsome output\nmore output\n```\n\n[example.com](https://example.com)",
    );
  });
});

describe("wikiToMarkdown: mentions", () => {
  it("drops the bot's mention and turns anyone else's into @user", () => {
    expect(md(`[~accountid:${BOT}] please ask [~accountid:${OTHER}]`)).toBe("please ask @user");
  });

  it("never passes another person's account id on, in code blocks included", () => {
    const out = md(
      `[~accountid:${OTHER_LONG}] {noformat}[~accountid:${OTHER}]{noformat} {code:js}x("[~accountid:${OTHER_LONG}]"){code} [~olduser]`,
    );
    expect(out).not.toContain(OTHER);
    expect(out).not.toContain(OTHER_LONG);
    expect(out).not.toContain("accountid");
    expect(out).not.toContain("olduser");
  });

  it("can't be rebuilt from pieces by link conversion", () => {
    // Removing an empty link joins the halves into a mention, which then goes too.
    for (const wiki of [`[[|javascript:x]~accountid:${OTHER}]`, `[[|x][|y]~accountid:${OTHER}]`]) {
      expect(md(wiki)).toBe("@user");
    }
    // Text typed to look like a mention stays text, never a mention.
    expect(md(`[[[|x]~accountid:${BOT}]~accountid:${OTHER}]`)).not.toContain("[~accountid:");
  });

  it("mentionsBot finds only the exact account, and blank ids or names find nothing", () => {
    expect(mentionsBot(`hi [~accountid:${BOT}]`, BOT, "devbox")).toBe(true);
    expect(mentionsBot(`hi [~accountid:${OTHER}]`, BOT, "devbox")).toBe(false);
    expect(mentionsBot(`hi [~accountid:${BOT}0]`, BOT, "devbox")).toBe(false);
    expect(mentionsBot(`hi [~accountid:${BOT}]`, "", "")).toBe(false);
    expect(mentionsBot("hi @someone", BOT, "")).toBe(false);
    expect(mentionsBot(null as unknown as string, BOT, "devbox")).toBe(false);
  });
});

describe("wikiToMarkdown: time", () => {
  // Inputs a backtracking regex takes most of a second or more over; a linear
  // scan takes a few milliseconds.
  const ms = (f: () => unknown) => {
    const start = performance.now();
    f();
    return performance.now() - start;
  };

  it("trims a long run of newlines in linear time", () => {
    expect(ms(() => md(`x${"\n".repeat(32_767)}x`))).toBeLessThan(100);
    expect(ms(() => md(`x${"\n".repeat(100_000)}x`))).toBeLessThan(200);
  });

  it("reads a run of unclosed mentions in linear time", () => {
    expect(ms(() => md("[~accountid:".repeat(10_000)))).toBeLessThan(200);
    expect(ms(() => mentionsBot("[~accountid:".repeat(10_000), BOT, "devbox"))).toBeLessThan(200);
  });
});

describe("wikiToMarkdown: odd input", () => {
  it("never throws", () => {
    const odd = [
      "",
      "{",
      "}{",
      "{{",
      "{{}}",
      "[",
      "[|]",
      "[~",
      "[~accountid:]",
      "*",
      "**",
      "h1.",
      "h7. x",
      "#",
      "{code:}{code}",
      "{noformat}",
      "{noformat}{code}{noformat}{code}",
      "\u0000￿\uD800",
      "`".repeat(100_000),
      "{code}".repeat(10_000),
      "[a|".repeat(10_000),
      // Long runs a backtracking regex would take seconds over.
      "{{".repeat(100_000),
      `*${"a ".repeat(100_000)}`,
      `h1. ${" ".repeat(100_000)}x`,
      `${"-".repeat(100_000)}x`,
    ];
    for (const s of odd) expect(() => wikiToMarkdown(s, BOT)).not.toThrow();
    expect(wikiToMarkdown(null as unknown as string, BOT)).toBe("");
    expect(wikiToMarkdown(undefined as unknown as string, BOT)).toBe("");
  });
});
