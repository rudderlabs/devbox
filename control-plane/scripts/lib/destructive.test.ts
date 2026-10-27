import { describe, expect, it } from "bun:test";
import { fakeTerminal } from "../up/fakeTerminal";
import { confirm } from "../up/prompt";
import { confirmDestructive, DestructiveRefused } from "./destructive";

const P = { command: "thing:wipe", items: ["a", "b"], question: "Sure? [y/N] " };

function setup(keys: string, o: { yes?: boolean; isTTY?: boolean } = {}) {
  const logs: string[] = [];
  const asked: string[] = [];
  const term = fakeTerminal(keys, o.isTTY ?? true).term;
  const deps = {
    yes: o.yes ?? false,
    isTTY: o.isTTY ?? true,
    confirm: (q: string, opts: { defaultYes: boolean }) => {
      asked.push(q);
      return confirm(q, opts, term);
    },
    log: (line: string) => void logs.push(line),
  };
  return { deps, logs, asked };
}

describe("confirmDestructive", () => {
  it("terminal yes", async () => {
    const s = setup("y\r");
    expect(await confirmDestructive(P, s.deps)).toBe(true);
    expect(s.logs).toEqual(["This deletes:", "  - a", "  - b"]);
    expect(s.asked).toEqual(["Sure? [y/N] "]);
  });

  it("terminal no", async () => {
    expect(await confirmDestructive(P, setup("n\r").deps)).toBe(false);
  });

  it("Enter answers no", async () => {
    expect(await confirmDestructive(P, setup("\r").deps)).toBe(false);
  });

  it("Ctrl-D answers no", async () => {
    expect(await confirmDestructive(P, setup("\u0004").deps)).toBe(false);
  });

  it("no terminal refuses without --yes", async () => {
    const s = setup("y\r", { isTTY: false });
    await expect(confirmDestructive(P, s.deps)).rejects.toThrow(
      new DestructiveRefused("thing:wipe deletes data: pass --yes to confirm without a terminal"),
    );
    expect(s.logs).toEqual([]);
    expect(s.asked).toEqual([]);
  });

  it("--yes without a terminal", async () => {
    const s = setup("", { yes: true, isTTY: false });
    expect(await confirmDestructive(P, s.deps)).toBe(true);
    expect(s.logs).toEqual([]);
    expect(s.asked).toEqual([]);
  });

  it("--yes with a terminal asks nothing", async () => {
    const s = setup("", { yes: true });
    expect(await confirmDestructive(P, s.deps)).toBe(true);
    expect(s.logs).toEqual([]);
    expect(s.asked).toEqual([]);
  });
});
