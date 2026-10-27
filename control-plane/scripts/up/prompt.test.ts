import { describe, expect, it } from "bun:test";
import { fakeTerminal } from "./fakeTerminal";
import {
  confirm,
  PromptInterrupted,
  promptHidden,
  promptLine,
  type Terminal,
  watchEnter,
} from "./prompt";

const ENTER = "\r";
const CTRL_D = "\u0004";

async function answer(keys: string, defaultYes: boolean) {
  const t = fakeTerminal(keys);
  const yes = await confirm("Go? ", { defaultYes }, t.term);
  return { yes, written: t.written };
}

describe("confirm", () => {
  it("Enter alone gives the default", async () => {
    expect(await answer(ENTER, true)).toEqual({ yes: true, written: ["Go? ", "\n"] });
    expect(await answer(ENTER, false)).toEqual({ yes: false, written: ["Go? ", "\n"] });
  });

  it("Ctrl-D is no, whatever the default and whatever was typed", async () => {
    for (const keys of [CTRL_D, `y${CTRL_D}`, `yes${CTRL_D}`]) {
      expect((await answer(keys, true)).yes).toBe(false);
      expect((await answer(keys, false)).yes).toBe(false);
    }
  });

  it("y, yes, n and no in any case override the default", async () => {
    for (const keys of ["y\r", "Y\r", "yes\r", " YES \r", "y\n"]) {
      expect((await answer(keys, false)).yes).toBe(true);
    }
    for (const keys of ["n\r", "N\r", "no\r", "nope\r"]) {
      expect((await answer(keys, true)).yes).toBe(false);
    }
  });

  it("is no without a terminal and asks nothing", async () => {
    const t = fakeTerminal(ENTER, false);
    expect(await confirm("Go? ", { defaultYes: true }, t.term)).toBe(false);
    expect(t.written).toEqual([]);
  });

  it("Ctrl-C interrupts", async () => {
    const t = fakeTerminal("\u0003");
    await expect(confirm("Go? ", { defaultYes: true }, t.term)).rejects.toBeInstanceOf(
      PromptInterrupted,
    );
  });
});

describe("promptHidden and promptLine", () => {
  it("hidden input is not echoed", async () => {
    const t = fakeTerminal("s3crx\u007fet\r");
    expect(await promptHidden("Key: ", t.term)).toBe("s3cret");
    expect(t.written).toEqual(["Key: ", "\n"]);
  });

  it("a line is echoed", async () => {
    const t = fakeTerminal("ab\r");
    expect(await promptLine("Name: ", t.term)).toBe("ab");
    expect(t.written).toEqual(["Name: ", "a", "b", "\n"]);
  });

  it("empty without a terminal", async () => {
    const t = fakeTerminal("x\r", false);
    expect(await promptHidden("Key: ", t.term)).toBe("");
    expect(t.written).toEqual([]);
  });
});

describe("watchEnter", () => {
  // A terminal whose keystrokes the test sends, recording what the watcher does.
  function liveTerminal(isTTY = true) {
    const events: string[] = [];
    let listener: ((chunk: Buffer) => void) | undefined;
    const term: Terminal = {
      stdin: {
        isTTY,
        setRawMode: (on: boolean) => void events.push(`raw ${on}`),
        resume: () => void events.push("resume"),
        pause: () => void events.push("pause"),
        on: (_e, l) => {
          events.push("on");
          listener = l;
        },
        off: () => {
          events.push("off");
          listener = undefined;
        },
      },
      stderr: { write: () => {} },
    };
    return { term, events, press: (keys: string) => listener?.(Buffer.from(keys, "utf8")) };
  }
  const pending = Symbol("pending");
  const settle = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<typeof pending>((r) => setTimeout(() => r(pending), 10))]);

  it("Enter resolves every waiting next(); other keys don't", async () => {
    const t = liveTerminal();
    const w = watchEnter(t.term);
    const a = w.next();
    const b = w.next();
    t.press("x");
    expect(await settle(a)).toBe(pending);
    t.press("\r");
    expect(await settle(a)).toBeUndefined();
    expect(await settle(b)).toBeUndefined();
    const c = w.next();
    expect(await settle(c)).toBe(pending);
    t.press("\n");
    expect(await settle(c)).toBeUndefined();
    w.stop();
    expect(t.events).toEqual(["raw true", "resume", "on", "off", "raw false", "pause"]);
  });

  it("Ctrl-C rejects the waiting next() and every later one", async () => {
    const t = liveTerminal();
    const w = watchEnter(t.term);
    const a = w.next().catch((err: unknown) => err);
    t.press("\u0003");
    expect(await a).toEqual(new PromptInterrupted("interrupted"));
    // A Ctrl-C between waits is not lost.
    expect(await w.next().catch((err: unknown) => err)).toEqual(
      new PromptInterrupted("interrupted"),
    );
    w.stop();
  });

  it("without a terminal: never resolves, touches nothing", async () => {
    const t = liveTerminal(false);
    const w = watchEnter(t.term);
    expect(await settle(w.next())).toBe(pending);
    w.stop();
    expect(t.events).toEqual([]);
  });
});
