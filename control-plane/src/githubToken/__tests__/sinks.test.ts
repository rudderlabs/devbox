import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSink, parseSink, secretSink } from "../sinks";

const minted = { token: "ghs_abc", expiresAt: "2026-10-19T13:00:00Z" };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devbox-token-sink-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("fileSink", () => {
  it("writes token and expires-at atomically, leaving no temp files", async () => {
    const sink = fileSink(join(dir, "token"));
    expect(sink.describe).toBe(`file:${join(dir, "token")}`);
    await sink.write({ token: "old", expiresAt: "2026-10-19T12:00:00Z" });
    await sink.write(minted);
    expect(readdirSync(dir).sort()).toEqual(["expires-at", "token"]);
    expect(readFileSync(join(dir, "token"), "utf8")).toBe("ghs_abc");
    expect(readFileSync(join(dir, "expires-at"), "utf8")).toBe("2026-10-19T13:00:00Z");
  });

  it("replaces a stale temp file's permissions instead of reusing them", async () => {
    const path = join(dir, "token");
    writeFileSync(`${path}.tmp`, "stale", { mode: 0o666 });
    chmodSync(`${path}.tmp`, 0o666);
    await fileSink(path).write(minted);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(statSync(join(dir, "expires-at")).mode & 0o777).toBe(0o644);
    rmSync(`${path}.tmp`);
    expect(readdirSync(dir).sort()).toEqual(["expires-at", "token"]);
  });
});

describe("secretSink", () => {
  it("patches token and expires-at into the Secret", async () => {
    const calls: unknown[] = [];
    const sink = secretSink("devbox", "devbox-github", async (opts) => {
      calls.push(opts);
    });
    expect(sink.describe).toBe("secret:devbox/devbox-github");
    await sink.write(minted);
    expect(calls).toEqual([
      {
        namespace: "devbox",
        name: "devbox-github",
        data: { token: "ghs_abc", "expires-at": "2026-10-19T13:00:00Z" },
      },
    ]);
  });
});

describe("parseSink", () => {
  it("accepts file:<abs path> and secret:<ns>/<name>", () => {
    expect(parseSink("file:/var/run/devbox/github/token").describe).toBe(
      "file:/var/run/devbox/github/token",
    );
    expect(parseSink("secret:devbox/devbox-github").describe).toBe("secret:devbox/devbox-github");
  });

  for (const bad of [
    "secret:noslash",
    "secret:a/b/c",
    "secret:/name",
    "file:relative/token",
    "file:",
    "s3:bucket",
    "",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => parseSink(bad)).toThrow(`bad GITHUB_TOKEN_SINK: ${JSON.stringify(bad)}`);
    });
  }
});
