import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../command";
import {
  type ConfigFs,
  configFilePath,
  loadConfigFile,
  realConfigFs,
  writeConfigFile,
} from "../configFile";
import { memFs } from "./fakes";

const HINT = "run `bun run up` or `bun run k8s:install`, or pass --url/--token";

const P = "/home/me/.config/devbox/config.json";
const FILE = {
  current: "local",
  profiles: { local: { url: "http://localhost:3000", token: "dbx_f" } },
};
const PROFILES = JSON.stringify(FILE);

describe("configFilePath", () => {
  it("uses XDG_CONFIG_HOME when set, else ~/.config", () => {
    const fs = memFs({});
    expect(configFilePath({ XDG_CONFIG_HOME: "/xdg" }, fs)).toBe("/xdg/devbox/config.json");
    expect(configFilePath({ XDG_CONFIG_HOME: "" }, fs)).toBe(P);
    expect(configFilePath({}, fs)).toBe(P);
  });
});

describe("loadConfigFile", () => {
  const load = (fs: ConfigFs) => {
    const warnings: string[] = [];
    const config = loadConfigFile(P, fs, (w) => warnings.push(w));
    return { config, warnings };
  };

  it("reads profiles and the current one", () => {
    const fs = memFs({ [P]: { text: PROFILES } });
    expect(load(fs)).toEqual({ config: FILE, warnings: [] });
  });

  it("returns undefined for a missing file", () => {
    expect(load(memFs({}))).toEqual({ config: undefined, warnings: [] });
  });

  it("gives a usage error naming the path when the file is unreadable", () => {
    expect(() => load(memFs({ [P]: { error: "EACCES" } }))).toThrow(
      new UsageError(`cannot read ${P} (EACCES): ${HINT}`),
    );
  });

  it("gives a usage error naming the path for invalid JSON", () => {
    expect(() => load(memFs({ [P]: { text: "{url:" } }))).toThrow(
      new UsageError(`${P} is not valid JSON: ${HINT}`),
    );
  });

  it("gives a usage error naming the path for the wrong shape, the old format included", () => {
    for (const text of ["[]", "null", '{"url":"http://u","token":"dbx"}']) {
      expect(() => load(memFs({ [P]: { text } }))).toThrow(
        new UsageError(
          `${P} must hold {"current": "...", "profiles": {"<name>": {"url": "...", "token": "..."}}}: ${HINT}`,
        ),
      );
    }
  });

  it("warns about a mode wider than 0600 and still uses the file", () => {
    const fs = memFs({ [P]: { text: PROFILES, mode: 0o644 } });
    expect(load(fs)).toEqual({
      config: FILE,
      warnings: [
        `devbox: warning: ${P} has mode 0644, so other users may read its token; run: chmod 600 ${P}`,
      ],
    });
  });
});

describe("writeConfigFile", () => {
  it("serializes the profiles through the fs", () => {
    const fs = memFs({});
    writeConfigFile(P, FILE, fs);
    expect(fs.files).toEqual({ [P]: { text: `${JSON.stringify(FILE, null, 2)}\n`, mode: 0o600 } });
  });
});

describe("realConfigFs", () => {
  const dir = mkdtempSync(join(tmpdir(), "devbox-configfs-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads text and mode, and throws ENOENT for a missing file", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o640);
    expect(realConfigFs.read(path)).toBe("{}");
    expect(realConfigFs.mode(path)).toBe(0o640);
    expect(() => realConfigFs.read(join(dir, "nope"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("writes a file of mode 0600 in a 0700 directory, replacing the old one", () => {
    const path = join(dir, "sub", "config.json");
    realConfigFs.write(path, "one");
    realConfigFs.write(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
  });
});
