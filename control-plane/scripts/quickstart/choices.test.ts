import { describe, expect, it } from "bun:test";
import {
  type ChoiceDeps,
  ChoiceError,
  chooseIntegration,
  choosePlatform,
  platformFlag,
  requireDecidable,
  undecidedFlags,
} from "./choices";

// Answers the questions in order; records them and what was logged.
function world(answers: (string | boolean)[]) {
  const asked: string[] = [];
  const log: string[] = [];
  const next = (q: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new Error(`unexpected question: ${q}`);
    return a;
  };
  const deps: ChoiceDeps = {
    isTTY: true,
    promptLine: async (q) => String(next(q)),
    confirm: async (q, { defaultYes }) => {
      const a = next(q);
      return a === "" ? defaultYes : a === true;
    },
    log: (l) => void log.push(l),
  };
  return { deps, asked, log };
}

const OFF = { githubApp: false, linear: false };

describe("platformFlag", () => {
  it("reads --compose and --kind", () => {
    expect(platformFlag({ compose: true })).toBe("compose");
    expect(platformFlag({ kind: true })).toBe("kind");
    expect(platformFlag({})).toBeUndefined();
  });

  it("refuses both, and the negated forms", () => {
    expect(() => platformFlag({ compose: true, kind: true })).toThrow(
      "--compose and --kind exclude each other",
    );
    expect(() => platformFlag({ kind: false })).toThrow(ChoiceError);
    expect(() => platformFlag({ compose: false })).toThrow(ChoiceError);
  });
});

describe("requireDecidable", () => {
  it("names every open choice when there is no terminal", () => {
    expect(undecidedFlags({ kind: true })).toEqual([
      "--github-app or --no-github-app",
      "--linear or --no-linear",
    ]);
    expect(() => requireDecidable({ "github-app": false }, false)).toThrow(
      "no terminal to ask in: pass --compose or --kind, --linear or --no-linear",
    );
  });

  it("passes with every flag, or with a terminal", () => {
    requireDecidable({ compose: true, "github-app": false, linear: true }, false);
    requireDecidable({}, true);
  });
});

describe("choosePlatform", () => {
  it("takes the flag without asking", async () => {
    const w = world([]);
    expect(await choosePlatform({ kind: true }, w.deps)).toBe("kind");
    expect(w.asked).toEqual([]);
  });

  it("asks until the answer is compose or kind", async () => {
    const w = world(["docker", " Kind "]);
    expect(await choosePlatform({}, w.deps)).toBe("kind");
    expect(w.asked).toHaveLength(2);
    expect(w.log).toEqual(['Answer "compose" or "kind".']);
  });
});

describe("chooseIntegration", () => {
  it("takes --github-app and --no-github-app without asking", async () => {
    const w = world([]);
    expect(await chooseIntegration("githubApp", { "github-app": true }, OFF, w.deps)).toBe(true);
    expect(await chooseIntegration("githubApp", { "github-app": false }, OFF, w.deps)).toBe(false);
    expect(w.asked).toEqual([]);
  });

  it("asks when the flag is omitted; Enter means no", async () => {
    const w = world([""]);
    expect(await chooseIntegration("linear", {}, OFF, w.deps)).toBe(false);
    expect(w.asked).toEqual(["Set up Linear? [y/N] "]);
    expect(w.log[0]).toContain("It needs a public HTTPS URL");
  });

  it("asks to run the setup again when already on; Enter means yes", async () => {
    const w = world([""]);
    const on = { githubApp: true, linear: false };
    expect(await chooseIntegration("githubApp", {}, on, w.deps)).toBe(true);
    expect(w.asked).toEqual(["The GitHub App is already set up. Run its setup again? [Y/n] "]);
  });
});
