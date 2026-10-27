import { describe, expect, it } from "bun:test";
import { GITHUB_TOKEN_TTL_MS, githubTokenProvider, parseGithubTokenSettings } from "../githubToken";

describe("parseGithubTokenSettings", () => {
  it("prefers GITHUB_TOKEN_FILE", () => {
    expect(
      parseGithubTokenSettings({ GITHUB_TOKEN_FILE: " /run/token ", GITHUB_TOKEN: "ghp_x" }),
    ).toEqual({ file: "/run/token" });
  });

  it("falls back to GITHUB_TOKEN", () => {
    expect(parseGithubTokenSettings({ GITHUB_TOKEN_FILE: " ", GITHUB_TOKEN: "ghp_x" })).toEqual({
      token: "ghp_x",
    });
  });

  it("requires one of them", () => {
    expect(() => parseGithubTokenSettings({})).toThrow(
      new Error("Missing required env var: GITHUB_TOKEN (or GITHUB_TOKEN_FILE)"),
    );
  });
});

// A file whose contents and readability the test controls, with a frozen clock.
function fixture(initial: string | Error, initialExpiry: string | Error = new Error("ENOENT")) {
  let contents: string | Error = initial;
  let expiry: string | Error = initialExpiry;
  let now = 1_000_000;
  const reads: string[] = [];
  const warnings: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const provider = githubTokenProvider(
    { file: "/run/token" },
    {
      readFile: (path) => {
        reads.push(path);
        const value = path === "/run/expires-at" ? expiry : contents;
        if (value instanceof Error) throw value;
        return value;
      },
      now: () => now,
      warn: (message, meta) => warnings.push({ message, meta }),
    },
  );
  return {
    provider,
    reads,
    warnings,
    set: (next: string | Error) => {
      contents = next;
    },
    setExpiry: (next: string | Error) => {
      expiry = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("githubTokenProvider", () => {
  it("returns GITHUB_TOKEN when no file is set", () => {
    const provider = githubTokenProvider(
      { token: "ghp_env" },
      { readFile: () => "unused", now: () => 0, warn: () => {} },
    );
    expect(provider()).toBe("ghp_env");
  });

  it("reads the file once per TTL and trims it", () => {
    const f = fixture("ghp_one\n");
    expect(f.provider()).toBe("ghp_one");
    f.set("ghp_two\n");
    f.advance(GITHUB_TOKEN_TTL_MS - 1);
    expect(f.provider()).toBe("ghp_one");
    f.advance(1);
    expect(f.provider()).toBe("ghp_two");
    expect(f.reads.filter((p) => p === "/run/token")).toEqual(["/run/token", "/run/token"]);
  });

  it("throws when the first read fails, without the token in the message", () => {
    const f = fixture(new Error("ENOENT: no such file"));
    expect(() => f.provider()).toThrow(
      new Error("cannot read GITHUB_TOKEN_FILE /run/token: ENOENT: no such file"),
    );
  });

  it("treats an empty file as unreadable", () => {
    const f = fixture("\n");
    expect(() => f.provider()).toThrow(
      new Error("cannot read GITHUB_TOKEN_FILE /run/token: the file is empty"),
    );
  });

  it("keeps the last good token when a later read fails, warning once per TTL", () => {
    const f = fixture("ghp_one");
    expect(f.provider()).toBe("ghp_one");
    f.set(new Error("EIO"));
    f.advance(GITHUB_TOKEN_TTL_MS);
    expect(f.provider()).toBe("ghp_one");
    expect(f.provider()).toBe("ghp_one");
    expect(f.warnings).toEqual([
      { message: "github_token_file_unreadable", meta: { file: "/run/token", reason: "EIO" } },
    ]);
  });

  it("state(): env source has no expiry and no reads", () => {
    const provider = githubTokenProvider(
      { token: "ghp_env" },
      { readFile: () => "unused", now: () => 0, warn: () => {} },
    );
    expect(provider.state()).toEqual({
      source: "env",
      expiresAt: null,
      readAt: null,
      lastError: null,
    });
  });

  it("state(): reads expires-at next to the token file", () => {
    const f = fixture("ghp_one", "2026-10-19T12:31:00Z\n");
    expect(f.provider()).toBe("ghp_one");
    expect(f.provider.state()).toEqual({
      source: "file",
      expiresAt: "2026-10-19T12:31:00Z",
      readAt: new Date(1_000_000).toISOString(),
      lastError: null,
    });
    expect(f.reads).toEqual(["/run/token", "/run/expires-at"]);
  });

  it("state(): expiresAt is null when the file is absent or not a date", () => {
    const f = fixture("ghp_one");
    expect(f.provider.state().expiresAt).toBeNull();
    f.setExpiry("not a date");
    f.advance(GITHUB_TOKEN_TTL_MS);
    expect(f.provider.state().expiresAt).toBeNull();
  });

  it("state(): picks up a rewritten expires-at after the TTL, not before", () => {
    const f = fixture("ghp_one", "2026-10-19T12:31:00Z");
    f.provider();
    f.setExpiry("2026-10-19T13:01:00Z");
    f.set("ghp_two");
    f.advance(GITHUB_TOKEN_TTL_MS - 1);
    expect(f.provider.state().expiresAt).toBe("2026-10-19T12:31:00Z");
    f.advance(1);
    expect(f.provider.state()).toEqual({
      source: "file",
      expiresAt: "2026-10-19T13:01:00Z",
      readAt: new Date(1_000_000 + GITHUB_TOKEN_TTL_MS).toISOString(),
      lastError: null,
    });
    expect(f.provider()).toBe("ghp_two");
  });

  it("state(): records the unreadable-file error and keeps the last good readAt", () => {
    const f = fixture("ghp_one", "2026-10-19T12:31:00Z");
    f.provider();
    f.set(new Error("EIO"));
    f.advance(GITHUB_TOKEN_TTL_MS);
    expect(f.provider()).toBe("ghp_one");
    expect(f.provider.state()).toEqual({
      source: "file",
      expiresAt: "2026-10-19T12:31:00Z",
      readAt: new Date(1_000_000).toISOString(),
      lastError: "cannot read GITHUB_TOKEN_FILE /run/token: EIO",
    });
    f.set("ghp_two");
    f.advance(GITHUB_TOKEN_TTL_MS);
    expect(f.provider.state().lastError).toBeNull();
  });

  it("state(): reports a first-read failure without throwing", () => {
    const f = fixture(new Error("ENOENT: no such file"));
    expect(f.provider.state()).toEqual({
      source: "file",
      expiresAt: null,
      readAt: null,
      lastError: "cannot read GITHUB_TOKEN_FILE /run/token: ENOENT: no such file",
    });
  });
});
