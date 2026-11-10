import { describe, expect, it } from "bun:test";
import { GITLAB_TOKEN_TTL_MS, gitlabTokenProvider, parseGitlabTokenSettings } from "../token";

describe("parseGitlabTokenSettings", () => {
  it("prefers GITLAB_TOKEN_FILE, falls back to GITLAB_TOKEN, and needs neither", () => {
    expect(
      parseGitlabTokenSettings({ GITLAB_TOKEN_FILE: " /run/token ", GITLAB_TOKEN: "glpat-x" }),
    ).toEqual({ file: "/run/token" });
    expect(parseGitlabTokenSettings({ GITLAB_TOKEN_FILE: " ", GITLAB_TOKEN: " glpat-x " })).toEqual(
      {
        token: "glpat-x",
      },
    );
    expect(parseGitlabTokenSettings({})).toEqual({});
  });
});

// A file whose contents and readability the test controls, with a frozen clock.
function fixture(initial: string | Error) {
  let contents: string | Error = initial;
  let now = 1_000_000;
  const reads: string[] = [];
  const warnings: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const provider = gitlabTokenProvider(
    { file: "/run/token" },
    {
      readFile: (path) => {
        reads.push(path);
        if (contents instanceof Error) throw contents;
        return contents;
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
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("gitlabTokenProvider", () => {
  it("serves GITLAB_TOKEN as it is; with neither setting it throws and reports unconfigured", () => {
    const env = gitlabTokenProvider({ token: "glpat-env" }, fixtureDeps());
    expect(env()).toBe("glpat-env");
    expect(env.state()).toEqual({ configured: true, source: "env", readAt: null, lastError: null });
    const none = gitlabTokenProvider({}, fixtureDeps());
    expect(() => none()).toThrow("no GitLab token: set GITLAB_TOKEN_FILE or GITLAB_TOKEN");
    expect(none.state()).toEqual({
      configured: false,
      source: null,
      readAt: null,
      lastError: null,
    });
  });

  it("reads the file trimmed and caches it for the TTL", () => {
    const f = fixture("glpat-one\n");
    expect(f.provider()).toBe("glpat-one");
    f.set("glpat-two\n");
    f.advance(GITLAB_TOKEN_TTL_MS - 1);
    expect(f.provider()).toBe("glpat-one");
    expect(f.reads).toHaveLength(1);
  });

  it("picks up a rotated token once the TTL has passed", () => {
    const f = fixture("glpat-one");
    f.provider();
    f.set("glpat-two");
    f.advance(GITLAB_TOKEN_TTL_MS);
    expect(f.provider()).toBe("glpat-two");
    expect(f.reads).toHaveLength(2);
  });

  it("throws while the file has never been readable, or is empty, and recovers when it is", () => {
    const f = fixture(new Error("ENOENT"));
    expect(() => f.provider()).toThrow("cannot read GITLAB_TOKEN_FILE /run/token: ENOENT");
    expect(f.provider.state()).toMatchObject({
      configured: true,
      source: "file",
      readAt: null,
      lastError: "cannot read GITLAB_TOKEN_FILE /run/token: ENOENT",
    });
    f.set("  \n");
    expect(() => f.provider()).toThrow(
      "cannot read GITLAB_TOKEN_FILE /run/token: the file is empty",
    );
    // No cached token yet, so the next call reads again without waiting for the TTL.
    f.set("glpat-one");
    expect(f.provider()).toBe("glpat-one");
    expect(f.provider.state()).toEqual({
      configured: true,
      source: "file",
      readAt: new Date(1_000_000).toISOString(),
      lastError: null,
    });
  });

  it("keeps the last good token when a later read fails, warns, and clears the error on recovery", () => {
    const f = fixture("glpat-one");
    f.provider();
    f.set(new Error("EACCES"));
    f.advance(GITLAB_TOKEN_TTL_MS);
    expect(f.provider()).toBe("glpat-one");
    expect(f.warnings).toEqual([
      { message: "gitlab_token_file_unreadable", meta: { file: "/run/token", reason: "EACCES" } },
    ]);
    expect(f.provider.state().lastError).toBe("cannot read GITLAB_TOKEN_FILE /run/token: EACCES");
    // The failed attempt restarts the TTL: no read storm against a broken mount.
    const reads = f.reads.length;
    f.provider();
    expect(f.reads).toHaveLength(reads);
    f.set("glpat-two");
    f.advance(GITLAB_TOKEN_TTL_MS);
    expect(f.provider()).toBe("glpat-two");
    expect(f.provider.state().lastError).toBeNull();
  });

  it("never puts the token in an error or a warning", () => {
    const f = fixture("glpat-secret");
    f.provider();
    f.set(new Error("EIO"));
    f.advance(GITLAB_TOKEN_TTL_MS);
    f.provider();
    expect(JSON.stringify([f.warnings, f.provider.state()])).not.toContain("glpat-secret");
  });
});

function fixtureDeps() {
  return { readFile: () => "", now: () => 0, warn: () => {} };
}
