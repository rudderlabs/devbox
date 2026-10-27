import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../../../cli/interface/profiles";
import {
  CliConfigError,
  cliConfigPath,
  ensureCliLogin,
  parseApiTokenOutput,
  readCliProfile,
  removeCliProfile,
} from "./cliLogin";

const root = mkdtempSync(join(tmpdir(), "devbox-cli-login-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const fresh = () => join(root, `case-${++n}`, "devbox", "config.json");
const mode = (p: string) => statSync(p).mode & 0o777;
const parsed = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const URL_ = "http://localhost:3000";
const CLUSTER_PROFILE: Profile = { url: "http://localhost:13000", token: "dbx_eks" };

function seed(path: string, text: string | object, fileMode?: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof text === "string" ? text : JSON.stringify(text), {
    mode: fileMode,
  });
}

function login(path: string, valid: (c: Profile) => boolean) {
  const checked: Profile[] = [];
  let created = 0;
  return {
    checked,
    created: () => created,
    run: () =>
      ensureCliLogin({
        path,
        profile: "local",
        url: URL_,
        isValid: async (c) => {
          checked.push(c);
          return valid(c);
        },
        createToken: async () => `dbx_new${++created}`,
      }),
  };
}

describe("cliConfigPath", () => {
  it("uses XDG_CONFIG_HOME when set, else ~/.config", () => {
    expect(cliConfigPath({ XDG_CONFIG_HOME: "/x" }, "/home/me")).toBe("/x/devbox/config.json");
    expect(cliConfigPath({ XDG_CONFIG_HOME: "" }, "/home/me")).toBe(
      "/home/me/.config/devbox/config.json",
    );
    expect(cliConfigPath({}, "/home/me")).toBe("/home/me/.config/devbox/config.json");
  });
});

describe("ensureCliLogin", () => {
  it("creates a token and writes the file 0600 in a 0700 directory", async () => {
    const path = fresh();
    const l = login(path, () => true);
    expect(await l.run()).toBe("created");
    expect(parsed(path)).toEqual({
      current: "local",
      profiles: { local: { url: URL_, token: "dbx_new1" } },
    });
    expect(mode(path)).toBe(0o600);
    expect(mode(join(path, ".."))).toBe(0o700);
    expect(l.checked).toEqual([]);
  });

  it("keeps a valid local profile and makes it current, leaving other profiles alone", async () => {
    const path = fresh();
    seed(path, {
      current: "k8s-eks",
      profiles: { local: { url: URL_, token: "dbx_old" }, "k8s-eks": CLUSTER_PROFILE },
    });
    const l = login(path, () => true);
    expect(await l.run()).toBe("kept");
    expect(l.checked).toEqual([{ url: URL_, token: "dbx_old" }]);
    expect(l.created()).toBe(0);
    expect(parsed(path)).toEqual({
      current: "local",
      profiles: { local: { url: URL_, token: "dbx_old" }, "k8s-eks": CLUSTER_PROFILE },
    });
  });

  it("tightens the modes of a kept file and its directory", async () => {
    const path = fresh();
    seed(path, { current: "local", profiles: { local: { url: URL_, token: "dbx_old" } } }, 0o644);
    expect(await login(path, () => true).run()).toBe("kept");
    expect(mode(path)).toBe(0o600);
    expect(mode(join(path, ".."))).toBe(0o700);
  });

  it("creates a token when the server rejects the old one", async () => {
    const path = fresh();
    seed(path, { current: "local", profiles: { local: { url: URL_, token: "dbx_revoked" } } });
    expect(await login(path, () => false).run()).toBe("created");
    expect(parsed(path)).toEqual({
      current: "local",
      profiles: { local: { url: URL_, token: "dbx_new1" } },
    });
    expect(mode(path)).toBe(0o600);
  });

  it("creates a token when the profile is for another URL, without checking it", async () => {
    const path = fresh();
    seed(path, {
      profiles: { local: { url: "http://other", token: "dbx_x" }, "k8s-eks": CLUSTER_PROFILE },
    });
    const l = login(path, () => true);
    expect(await l.run()).toBe("created");
    expect(l.checked).toEqual([]);
    expect(parsed(path)).toEqual({
      current: "local",
      profiles: { local: { url: URL_, token: "dbx_new1" }, "k8s-eks": CLUSTER_PROFILE },
    });
  });

  it("refuses a file that is not a profile file, overwriting nothing", async () => {
    const path = fresh();
    seed(path, { Profiles: { prod: CLUSTER_PROFILE }, current: "prod" });
    const before = readFileSync(path, "utf8");
    await expect(login(path, () => true).run()).rejects.toThrow(
      new CliConfigError(
        `${path} must hold {"current": "...", "profiles": {"<name>": {"url": "...", "token": "..."}}}: fix or delete it, then run again`,
      ),
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses the old single-entry format too", async () => {
    const path = fresh();
    seed(path, { url: URL_, token: "dbx_old" });
    await expect(login(path, () => true).run()).rejects.toThrow(CliConfigError);
  });
});

describe("a file that fails validation", () => {
  it("stops ensureCliLogin and leaves the file unchanged", async () => {
    const path = fresh();
    const text = JSON.stringify({
      profiles: { Bad_Name: CLUSTER_PROFILE, "k8s-eks": CLUSTER_PROFILE },
    });
    seed(path, text);
    const l = login(path, () => true);
    await expect(l.run()).rejects.toThrow(
      new CliConfigError(
        `${path} has a bad profile name "Bad_Name": fix or delete it, then run again`,
      ),
    );
    expect(l.created()).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("treats prototype names as missing profiles", () => {
    const path = fresh();
    seed(path, { current: "local", profiles: { local: CLUSTER_PROFILE } });
    expect(readCliProfile(path, "constructor")).toBeUndefined();
  });
});

describe("removeCliProfile and readCliProfile", () => {
  it("removes only the named profile", () => {
    const path = fresh();
    seed(path, {
      current: "k8s-eks",
      profiles: { local: { url: URL_, token: "dbx_a" }, "k8s-eks": CLUSTER_PROFILE },
    });
    removeCliProfile(path, "k8s-eks");
    expect(parsed(path)).toEqual({
      profiles: { local: { url: URL_, token: "dbx_a" } },
    });
    expect(mode(path)).toBe(0o600);
  });

  it("leaves a missing file or profile alone", () => {
    const path = fresh();
    removeCliProfile(path, "k8s-eks");
    expect(() => statSync(path)).toThrow();
  });

  it("reads a profile", () => {
    const path = fresh();
    seed(path, { current: "k8s-eks", profiles: { "k8s-eks": CLUSTER_PROFILE } });
    expect(readCliProfile(path, "k8s-eks")).toEqual(CLUSTER_PROFILE);
    expect(readCliProfile(path, "gke")).toBeUndefined();
  });
});

describe("parseApiTokenOutput", () => {
  it("finds the token line in api-token create's output", () => {
    const out =
      'Created API token "devbox-cli" (id 0b7c).\nStore it now. It is not shown again.\n\ndbx_0b7c_s3cr3t\n';
    expect(parseApiTokenOutput(out)).toBe("dbx_0b7c_s3cr3t");
  });

  it("throws without echoing the output when there is no token", () => {
    expect(() => parseApiTokenOutput("something went wrong")).toThrow(
      "api-token create printed no token",
    );
  });
});
