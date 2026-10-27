import { describe, expect, it } from "bun:test";
import { DestructiveRefused } from "./lib/destructive";
import { MemoryKeychain } from "./lib/keychain";
import { type SecretsDeps, secretsCommand } from "./secrets";
import { fakeTerminal } from "./up/fakeTerminal";
import { confirm } from "./up/prompt";

function setup(
  opts: {
    env?: Record<string, string>;
    entries?: Record<string, string>;
    isTTY?: boolean;
    // Keystrokes at the yes/no question, answered by the real confirm().
    keys?: string;
    keychain?: SecretsDeps["keychain"];
    // What `gh auth token` does; by default gh is not installed.
    gh?: { code: number; stdout: string };
  } = {},
) {
  const out: string[] = [];
  const asked: string[] = [];
  const ran: string[][] = [];
  const keychain = new MemoryKeychain(opts.entries);
  const deps: SecretsDeps = {
    keychain: opts.keychain ?? keychain,
    env: opts.env ?? {},
    isTTY: opts.isTTY ?? false,
    confirm: (q, o) => {
      asked.push(q);
      return confirm(q, o, fakeTerminal(opts.keys ?? "y\r").term);
    },
    run: async (cmd) => {
      ran.push(cmd);
      if (!opts.gh) throw new Error("ENOENT: gh");
      return opts.gh;
    },
    log: (line) => out.push(line),
    loadTarget: () => ({ context: "ctx", values: {} }),
  };
  return { deps, out, asked, ran, keychain };
}

const ALL = {
  "compose/GITHUB_TOKEN": "ghp-a",
  "compose/LLM_API_KEY": "sk-b",
  "compose/LINEAR_CLIENT_SECRET": "lc-c",
  "compose/LINEAR_WEBHOOK_SECRET": "lw-d",
};

describe("bun run secrets", () => {
  it("ls lists every secret with its source, never values", async () => {
    const s = setup({
      env: { GITHUB_TOKEN: "ghp-env-value" },
      entries: { "compose/LLM_API_KEY": "sk-keychain-value" },
    });
    expect(await secretsCommand(["ls"], s.deps)).toBe(0);
    expect(s.out.join("\n")).toBe(
      [
        "Secrets for compose:",
        "  GITHUB_TOKEN            env",
        "  LLM_API_KEY             keychain",
        "  LINEAR_CLIENT_SECRET    missing",
        "  LINEAR_WEBHOOK_SECRET   missing",
        "  GITHUB_APP_PRIVATE_KEY  missing",
        "  GITHUB_WEBHOOK_SECRET   missing",
      ].join("\n"),
    );
    expect(s.ran).toEqual([]);
  });

  it("ls reports gh when only `gh auth token` has a GitHub token", async () => {
    const s = setup({ gh: { code: 0, stdout: "gho_gh-cli-value\n" } });
    expect(await secretsCommand(["ls"], s.deps)).toBe(0);
    expect(s.out.join("\n")).toBe(
      [
        "Secrets for compose:",
        "  GITHUB_TOKEN            gh",
        "  LLM_API_KEY             missing",
        "  LINEAR_CLIENT_SECRET    missing",
        "  LINEAR_WEBHOOK_SECRET   missing",
        "  GITHUB_APP_PRIVATE_KEY  missing",
        "  GITHUB_WEBHOOK_SECRET   missing",
      ].join("\n"),
    );
    expect(s.ran).toEqual([["gh", "auth", "token"]]);
  });

  it("ls reports GITHUB_TOKEN missing when gh is logged out or absent", async () => {
    for (const gh of [{ code: 1, stdout: "" }, undefined]) {
      const s = setup(gh ? { gh } : {});
      expect(await secretsCommand(["ls"], s.deps)).toBe(0);
      expect(s.out.join("\n")).toBe(
        [
          "Secrets for compose:",
          "  GITHUB_TOKEN            missing",
          "  LLM_API_KEY             missing",
          "  LINEAR_CLIENT_SECRET    missing",
          "  LINEAR_WEBHOOK_SECRET   missing",
          "  GITHUB_APP_PRIVATE_KEY  missing",
          "  GITHUB_WEBHOOK_SECRET   missing",
        ].join("\n"),
      );
      expect(s.ran).toEqual([["gh", "auth", "token"]]);
    }
  });

  it("secrets ls on k8s lists seven names; on Compose six", async () => {
    const s = setup({ entries: { "k8s:ctx/devbox/LLM_API_KEY": "sk-x" } });
    expect(await secretsCommand(["ls", "--target", "t.json"], s.deps)).toBe(0);
    expect(s.out.join("\n")).toBe(
      [
        "Secrets for k8s:ctx/devbox:",
        "  GITHUB_TOKEN            missing",
        "  LLM_API_KEY             keychain",
        "  LINEAR_CLIENT_SECRET    missing",
        "  LINEAR_WEBHOOK_SECRET   missing",
        "  GITHUB_APP_PRIVATE_KEY  missing",
        "  GITHUB_WEBHOOK_SECRET   missing",
        "  SLACK_BOT_TOKEN         missing",
      ].join("\n"),
    );
  });

  it("rm deletes one entry", async () => {
    const s = setup({ entries: ALL });
    expect(await secretsCommand(["rm", "LLM_API_KEY"], s.deps)).toBe(0);
    expect(s.out).toEqual(["Removed LLM_API_KEY for compose."]);
    expect(Object.keys(s.keychain.entries()).sort()).toEqual(
      [
        "compose/GITHUB_TOKEN",
        "compose/LINEAR_CLIENT_SECRET",
        "compose/LINEAR_WEBHOOK_SECRET",
      ].sort(),
    );
    expect(await secretsCommand(["rm", "LLM_API_KEY"], s.deps)).toBe(0);
    expect(s.out.at(-1)).toBe("LLM_API_KEY is not saved for compose.");
  });

  it("rm accepts the k8s-only names only with --target", async () => {
    const s = setup({ entries: { "k8s:ctx/devbox/SLACK_BOT_TOKEN": "xoxb" } });
    expect(await secretsCommand(["rm", "SLACK_BOT_TOKEN"], s.deps)).toBe(2);
    expect(await secretsCommand(["rm", "SLACK_BOT_TOKEN", "--target", "t.json"], s.deps)).toBe(0);
    expect(s.out.at(-1)).toBe("Removed SLACK_BOT_TOKEN for k8s:ctx/devbox.");
    expect(s.keychain.entries()).toEqual({});
  });

  it("ls shows the private key from the key file, the environment or the keychain", async () => {
    const listing = async (opts: Parameters<typeof setup>[0], key: string) => {
      const s = setup(opts);
      await secretsCommand(["ls"], s.deps);
      expect(s.out.join("\n")).toBe(
        [
          "Secrets for compose:",
          "  GITHUB_TOKEN            missing",
          "  LLM_API_KEY             missing",
          "  LINEAR_CLIENT_SECRET    missing",
          "  LINEAR_WEBHOOK_SECRET   missing",
          `  GITHUB_APP_PRIVATE_KEY  ${key}`,
          "  GITHUB_WEBHOOK_SECRET   missing",
        ].join("\n"),
      );
    };
    await listing({ env: { GITHUB_APP_PRIVATE_KEY_FILE: "/k.pem" } }, "env");
    await listing({ env: { GITHUB_APP_PRIVATE_KEY: "pem" } }, "env");
    await listing({ entries: { "compose/GITHUB_APP_PRIVATE_KEY": "pem" } }, "keychain");
  });

  it("rm deletes the private key entry", async () => {
    const s = setup({ entries: { ...ALL, "compose/GITHUB_APP_PRIVATE_KEY": "pem" } });
    expect(await secretsCommand(["rm", "GITHUB_APP_PRIVATE_KEY"], s.deps)).toBe(0);
    expect(s.out).toEqual(["Removed GITHUB_APP_PRIVATE_KEY for compose."]);
    expect(s.keychain.entries()["compose/GITHUB_APP_PRIVATE_KEY"]).toBeUndefined();
    expect(Object.keys(s.keychain.entries())).toHaveLength(4);
  });

  const PENDING_ENTRIES = {
    "compose/GITHUB_APP_PRIVATE_KEY_PENDING": "pem2",
    "compose/GITHUB_WEBHOOK_SECRET_PENDING": "w2",
  };

  it("ls lists a new App's saved secrets only when there are some", async () => {
    const s = setup({ entries: { "compose/GITHUB_APP_PRIVATE_KEY_PENDING": "pem2" } });
    expect(await secretsCommand(["ls"], s.deps)).toBe(0);
    expect(s.out.join("\n")).toBe(
      [
        "Secrets for compose:",
        "  GITHUB_TOKEN                    missing",
        "  LLM_API_KEY                     missing",
        "  LINEAR_CLIENT_SECRET            missing",
        "  LINEAR_WEBHOOK_SECRET           missing",
        "  GITHUB_APP_PRIVATE_KEY          missing",
        "  GITHUB_WEBHOOK_SECRET           missing",
        "  GITHUB_APP_PRIVATE_KEY_PENDING  keychain (GitHub App private key of the new App, not installed yet)",
      ].join("\n"),
    );
    const both = setup({ entries: PENDING_ENTRIES });
    await secretsCommand(["ls"], both.deps);
    expect(both.out.join("\n")).toBe(
      [
        "Secrets for compose:",
        "  GITHUB_TOKEN                    missing",
        "  LLM_API_KEY                     missing",
        "  LINEAR_CLIENT_SECRET            missing",
        "  LINEAR_WEBHOOK_SECRET           missing",
        "  GITHUB_APP_PRIVATE_KEY          missing",
        "  GITHUB_WEBHOOK_SECRET           missing",
        "  GITHUB_APP_PRIVATE_KEY_PENDING  keychain (GitHub App private key of the new App, not installed yet)",
        "  GITHUB_WEBHOOK_SECRET_PENDING   keychain (GitHub webhook secret of the new App, not installed yet)",
      ].join("\n"),
    );
  });

  it("rm and clear take a new App's saved secrets", async () => {
    const s = setup({ entries: { ...ALL, ...PENDING_ENTRIES } });
    expect(await secretsCommand(["rm", "GITHUB_WEBHOOK_SECRET_PENDING"], s.deps)).toBe(0);
    expect(s.out).toEqual(["Removed GITHUB_WEBHOOK_SECRET_PENDING for compose."]);
    expect(s.keychain.entries()).toEqual({
      ...ALL,
      "compose/GITHUB_APP_PRIVATE_KEY_PENDING": "pem2",
    });
    const c = setup({ entries: { ...ALL, ...PENDING_ENTRIES }, isTTY: true });
    expect(await secretsCommand(["clear"], c.deps)).toBe(0);
    expect(c.out).toEqual([
      ...LISTED,
      "  - GITHUB_APP_PRIVATE_KEY_PENDING for compose",
      "  - GITHUB_WEBHOOK_SECRET_PENDING for compose",
      "Removed 6 saved secrets for compose.",
    ]);
    expect(c.keychain.entries()).toEqual({});
  });

  it("rm refuses an unknown name", async () => {
    const s = setup({ entries: ALL });
    expect(await secretsCommand(["rm", "NOPE"], s.deps)).toBe(2);
    expect(s.out).toEqual([
      'unknown secret "NOPE": use one of GITHUB_TOKEN, LLM_API_KEY, LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, GITHUB_APP_PRIVATE_KEY_PENDING, GITHUB_WEBHOOK_SECRET_PENDING',
    ]);
    expect(Object.keys(s.keychain.entries())).toHaveLength(4);
  });

  const LISTED = [
    "This deletes:",
    "  - GITHUB_TOKEN for compose",
    "  - LLM_API_KEY for compose",
    "  - LINEAR_CLIENT_SECRET for compose",
    "  - LINEAR_WEBHOOK_SECRET for compose",
  ];
  const QUESTION = "Remove these from the system keychain? [y/N] ";

  it("clear lists the saved entries and asks", async () => {
    const s = setup({ entries: { ...ALL, "k8s:ctx/devbox/LLM_API_KEY": "keep" }, isTTY: true });
    expect(await secretsCommand(["clear"], s.deps)).toBe(0);
    expect(s.asked).toEqual([QUESTION]);
    expect(s.out).toEqual([...LISTED, "Removed 4 saved secrets for compose."]);
    expect(s.keychain.entries()).toEqual({ "k8s:ctx/devbox/LLM_API_KEY": "keep" });
  });

  it("clear lists only what is saved", async () => {
    const s = setup({ entries: { "compose/LLM_API_KEY": "sk-b" }, isTTY: true });
    expect(await secretsCommand(["clear"], s.deps)).toBe(0);
    expect(s.out).toEqual([
      "This deletes:",
      "  - LLM_API_KEY for compose",
      "Removed 1 saved secret for compose.",
    ]);
  });

  it("clear does nothing on no, on Enter alone or on Ctrl-D", async () => {
    for (const keys of ["n\r", "\r", "\u0004", "y\u0004"]) {
      const s = setup({ entries: ALL, isTTY: true, keys });
      expect(await secretsCommand(["clear"], s.deps)).toBe(0);
      expect(s.asked).toEqual([QUESTION]);
      expect(s.out).toEqual([...LISTED, "Nothing was removed."]);
      expect(s.keychain.entries()).toEqual(ALL);
    }
  });

  it("clear without a terminal refuses without --yes", async () => {
    const s = setup({ entries: ALL });
    await expect(secretsCommand(["clear"], s.deps)).rejects.toThrow(
      new DestructiveRefused(
        "secrets clear deletes data: pass --yes to confirm without a terminal",
      ),
    );
    expect(s.asked).toEqual([]);
    expect(s.keychain.entries()).toEqual(ALL);
  });

  it("clear --yes", async () => {
    const s = setup({ entries: ALL });
    expect(await secretsCommand(["clear", "--yes"], s.deps)).toBe(0);
    expect(s.asked).toEqual([]);
    expect(s.out).toEqual(["Removed 4 saved secrets for compose."]);
    expect(s.keychain.entries()).toEqual({});
  });

  it("clear with nothing saved", async () => {
    const s = setup({ isTTY: true });
    expect(await secretsCommand(["clear"], s.deps)).toBe(0);
    expect(s.asked).toEqual([]);
    expect(s.out).toEqual(["No saved secrets for compose."]);
  });

  it("--yes with ls or rm is a usage error", async () => {
    const s = setup({ entries: ALL });
    expect(await secretsCommand(["ls", "--yes"], s.deps)).toBe(2);
    expect(await secretsCommand(["rm", "LLM_API_KEY", "--yes"], s.deps)).toBe(2);
    expect(s.keychain.entries()).toEqual(ALL);
  });

  it("a keychain that switched itself off is reported", async () => {
    const s = setup({
      keychain: {
        disabled: true,
        get: async () => undefined,
        set: async () => {},
        delete: async () => false,
      },
    });
    expect(await secretsCommand(["ls"], s.deps)).toBe(1);
    expect(s.out).toEqual(["The system keychain is not available on this machine."]);
  });

  it("a missing or extra argument is a usage error", async () => {
    const s = setup();
    expect(await secretsCommand([], s.deps)).toBe(2);
    expect(await secretsCommand(["rm"], s.deps)).toBe(2);
    expect(await secretsCommand(["clear", "LLM_API_KEY"], s.deps)).toBe(2);
  });
});
