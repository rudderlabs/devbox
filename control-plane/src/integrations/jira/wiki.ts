// Jira wiki markup to Markdown, for issue descriptions and comment bodies on
// their way to the agent (Jira's admin webhooks deliver both as wiki text).
// Covers what people write: *bold*, _italic_, * and # lists, h1.-h6.
// headings, bq. quotes, ---- rules, {{monospace}}, {noformat} and {code}
// blocks, and [text|url] links. Other macros lose their syntax and keep their
// text. Mentions never pass another person's account id on: the bot's own
// mention is dropped and anyone else's becomes "@user". Never throws.

// An id never holds a bracket, so a run of unclosed mentions stays linear.
const ACCOUNT_MENTION = /\[~accountid:([^[\]\n]*)\]/gi;
const CODE_OPEN = /\{(noformat|code)(?::([^{}\n]*))?\}/g;
const MACRO = /\{[a-zA-Z]+(?::[^{}\n]*)?\}/g;
const MONOSPACE = /\{\{([^{}\n]+)\}\}/g;
// Jira's bold: a * pair hugging non-space text, not inside a word.
const BOLD = /(^|[^\w*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![\w*])/g;
const BRACKETS = /\[([^[\]\n]*)\]/g;

type Piece = { text: string } | { code: string; params?: string };

// The text cut into prose and {code}/{noformat} blocks. An opener with no
// closer stays in the prose; once a name has none, later openers of that name
// have none either, which keeps the scan linear.
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  const unclosed = new Set<string>();
  let last = 0;
  CODE_OPEN.lastIndex = 0;
  for (let m = CODE_OPEN.exec(text); m; m = CODE_OPEN.exec(text)) {
    const name = m[1] ?? "";
    if (unclosed.has(name)) continue;
    const close = text.indexOf(`{${name}}`, CODE_OPEN.lastIndex);
    if (close < 0) {
      unclosed.add(name);
      continue;
    }
    out.push({ text: text.slice(last, m.index) });
    out.push({
      code: text.slice(CODE_OPEN.lastIndex, close),
      ...(name === "code" && m[2] !== undefined ? { params: m[2] } : {}),
    });
    last = close + name.length + 2;
    CODE_OPEN.lastIndex = last;
  }
  out.push({ text: text.slice(last) });
  return out;
}

// Whether the wiki text mentions the bot: a mention picked from Jira's picker
// ([~accountid:<id>]) or "@<bot display name>" typed out (Jira leaves a typed
// mention as plain text), in any case. Text in {code} and {noformat} blocks
// doesn't count: Jira can't put a real mention there. The typed name must
// stand alone, though Jira's _italic_ marks may hug it: "@devboxer",
// "@devbox/cli" and "foo_@devbox" don't count; "_@devbox please_" does.
export function mentionsBot(wiki: string, botAccountId: string, botName: string): boolean {
  if (typeof wiki !== "string") return false;
  const prose = pieces(wiki)
    .map((p) => ("text" in p ? p.text : ""))
    .join("\n");
  if (botAccountId) {
    for (const m of prose.matchAll(ACCOUNT_MENTION)) if (m[1] === botAccountId) return true;
  }
  const name = typeof botName === "string" ? botName.trim() : "";
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = "[\\p{L}\\p{N}]";
  return new RegExp(
    `(?<!${word}|[\\p{L}\\p{N}_]_)@${escaped}(?!${word}|[/-]|_[\\p{L}\\p{N}_])`,
    "iu",
  ).test(prose);
}

export function wikiToMarkdown(wiki: string, botAccountId: string): string {
  if (typeof wiki !== "string") return "";
  // Mentions go first and everywhere, code blocks included. NUL goes too:
  // Postgres can't store it, so a stored message would fail on every retry.
  const text = wiki
    .replaceAll("\0", "")
    .replace(/\r\n?/g, "\n")
    .replace(ACCOUNT_MENTION, (_, id: string) => (id === botAccountId ? "" : "@user"));
  // Text and code pieces, joined by one blank line so each fence sits on
  // lines of its own.
  const out = pieces(text)
    .map((p) => ("text" in p ? convertText(trimNewlines(p.text)) : codeBlock(p.code, p.params)))
    .filter((p) => p.trim())
    .join("\n\n")
    .trim();
  // Converting links can bring the halves of a mention together
  // ("[[|x]~accountid:…]"); a second pass catches whatever that rebuilt.
  return out.replace(ACCOUNT_MENTION, "@user");
}

// Newlines off both ends. A loop, not a regex: /\n+$/ backtracks
// quadratically over a long run of newlines that isn't at the end.
function trimNewlines(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "\n") start++;
  while (end > start && s[end - 1] === "\n") end--;
  return s.slice(start, end);
}

// A fenced block, its fence longer than any backtick run inside.
// {code:java} and {code:title=X|java} name the language.
function codeBlock(body: string, params: string | undefined): string {
  const content = body.replace(/^\n/, "").replace(/\n$/, "");
  const longest = (content.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  const lang = params?.split("|").find((p) => /^[\w+#.-]+$/.test(p)) ?? "";
  return `${fence}${lang}\n${content}\n${fence}`;
}

function convertText(s: string): string {
  return s.split("\n").map(convertLine).join("\n");
}

function convertLine(line: string): string {
  const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${convertInline(heading[2] ?? "")}`;
  const quote = /^\s*bq\.\s+(.*)$/.exec(line);
  if (quote) return `> ${convertInline(quote[1] ?? "")}`;
  if (/^\s*-{4,}\s*$/.test(line)) return "---";
  // * and # lists; ** and ## nest, the last marker picks the kind.
  const item = /^\s*([*#]+)\s+(.*)$/.exec(line);
  if (item) {
    const markers = item[1] ?? "*";
    const bullet = markers.endsWith("#") ? "1." : "-";
    return `${"   ".repeat(markers.length - 1)}${bullet} ${convertInline(item[2] ?? "")}`;
  }
  return convertInline(line);
}

function convertInline(s: string): string {
  return s
    .replace(MONOSPACE, (_, code: string) => `\`${code}\``)
    .replace(MACRO, "")
    .replace(BOLD, "$1**$2**")
    .replace(BRACKETS, link);
}

// [url], [text|url] and [~name] (an old-style mention). A link to anything
// but http(s) keeps only its text; other brackets stay as written.
function link(whole: string, inner: string): string {
  if (inner.startsWith("~")) return "@user";
  const [label = "", target = label] = inner.split("|");
  const url = target.trim();
  if (/^https?:\/\/\S+$/i.test(url)) return label === target ? `<${url}>` : `[${label}](${url})`;
  return inner.includes("|") ? label : whole;
}
