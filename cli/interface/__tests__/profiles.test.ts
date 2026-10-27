import { describe, expect, it } from "bun:test";
import {
  EMPTY_PROFILE_FILE,
  ProfileFileError,
  parseProfileFile,
  serializeProfileFile,
  withoutProfile,
  withProfile,
} from "../profiles";

const FILE = {
  current: "local",
  profiles: {
    local: { url: "http://localhost:3000", token: "dbx_a" },
    "k8s-kind-devbox": { url: "http://localhost:13000", token: "dbx_b" },
  },
};

describe("parseProfileFile", () => {
  it("reads profiles and the current one", () => {
    expect(parseProfileFile(JSON.stringify(FILE))).toEqual(FILE);
  });

  it("allows no current profile", () => {
    expect(parseProfileFile('{"profiles":{}}')).toEqual(EMPTY_PROFILE_FILE);
  });

  it.each([
    ["{", "is not valid JSON"],
    [
      '{"url":"http://x","token":"t"}',
      'must hold {"current": "...", "profiles": {"<name>": {"url": "...", "token": "..."}}}',
    ],
    [
      '{"profiles":{"Bad_Name":{"url":"http://x","token":"t"}}}',
      'has a bad profile name "Bad_Name"',
    ],
    [
      '{"profiles":{"a":{"url":"","token":"t"}}}',
      'profile "a" must hold {"url": "...", "token": "..."}',
    ],
    ['{"current":"constructor","profiles":{}}', '"current" names no profile: "constructor"'],
    [
      '{"current":"b","profiles":{"a":{"url":"http://x","token":"t"}}}',
      '"current" names no profile: "b"',
    ],
  ])("rejects %s", (text, message) => {
    expect(() => parseProfileFile(text)).toThrow(new ProfileFileError(message));
  });
});

describe("editing", () => {
  it("serializes what it parses", () => {
    expect(parseProfileFile(serializeProfileFile(FILE))).toEqual(FILE);
    expect(serializeProfileFile(EMPTY_PROFILE_FILE)).toBe('{\n  "profiles": {}\n}\n');
  });

  it("adds or replaces a profile, optionally making it current", () => {
    const p = { url: "http://localhost:13001", token: "dbx_c" };
    expect(withProfile(FILE, "k8s-eks", p, false)).toEqual({
      current: "local",
      profiles: { ...FILE.profiles, "k8s-eks": p },
    });
    expect(withProfile(FILE, "local", p, true)).toEqual({
      current: "local",
      profiles: { ...FILE.profiles, local: p },
    });
  });

  it("refuses a bad name", () => {
    expect(() => withProfile(FILE, "My Cluster", { url: "http://x", token: "" }, false)).toThrow(
      new ProfileFileError('bad profile name "My Cluster": use lower-case letters, digits and "-"'),
    );
  });

  it("removes a profile and clears current when it was current", () => {
    expect(withoutProfile(FILE, "local")).toEqual({
      current: undefined,
      profiles: { "k8s-kind-devbox": FILE.profiles["k8s-kind-devbox"] },
    });
    expect(withoutProfile(FILE, "absent")).toEqual(FILE);
  });
});
