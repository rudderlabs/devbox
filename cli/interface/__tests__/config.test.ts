import { describe, expect, it } from "bun:test";
import { UsageError } from "../command";
import { resolveConfig } from "../config";
import type { ProfileFile } from "../profiles";

const PATH = "/home/me/.config/devbox/config.json";
const FILE: ProfileFile = {
  current: "local",
  profiles: {
    local: { url: "http://localhost:3000/", token: "dbx_local" },
    "k8s-eks": { url: "http://localhost:13000", token: "dbx_eks" },
  },
};
const file = (f: ProfileFile | undefined) => ({ path: PATH, load: () => f });
const noRead = {
  path: PATH,
  load: (): ProfileFile | undefined => {
    throw new Error("must not read the file");
  },
};

describe("resolveConfig", () => {
  it("uses --url and --token without reading the file", () => {
    expect(resolveConfig({ url: "http://cp/", token: "t" }, {}, noRead)).toEqual({
      client: { url: "http://cp", token: "t" },
    });
  });

  it("uses DEVBOX_CLI_URL and DEVBOX_CLI_TOKEN without reading the file", () => {
    expect(
      resolveConfig({}, { DEVBOX_CLI_URL: "http://cp", DEVBOX_CLI_TOKEN: "t" }, noRead),
    ).toEqual({ client: { url: "http://cp", token: "t" } });
  });

  it("uses the current profile", () => {
    expect(resolveConfig({}, {}, file(FILE))).toEqual({
      client: { url: "http://localhost:3000", token: "dbx_local" },
      tokenFrom: { path: PATH, profile: "local" },
    });
  });

  it("--profile beats DEVBOX_CLI_PROFILE, which beats current", () => {
    expect(resolveConfig({}, { DEVBOX_CLI_PROFILE: "k8s-eks" }, file(FILE)).client.url).toBe(
      "http://localhost:13000",
    );
    expect(
      resolveConfig({ profile: "local" }, { DEVBOX_CLI_PROFILE: "k8s-eks" }, file(FILE)).client.url,
    ).toBe("http://localhost:3000");
  });

  it("--token overrides the profile's token", () => {
    expect(resolveConfig({ token: "t" }, {}, file(FILE))).toEqual({
      client: { url: "http://localhost:3000", token: "t" },
    });
  });

  it("names the profiles when the requested one is missing", () => {
    expect(() => resolveConfig({ profile: "gke" }, {}, file(FILE))).toThrow(
      new UsageError(`no profile "gke" in ${PATH} (profiles: k8s-eks, local)`),
    );
  });

  it("treats prototype names as missing profiles", () => {
    const missing = new UsageError(`no profile "toString" in ${PATH} (profiles: k8s-eks, local)`);
    expect(() => resolveConfig({ profile: "toString" }, {}, file(FILE))).toThrow(missing);
    expect(() => resolveConfig({}, { DEVBOX_CLI_PROFILE: "toString" }, file(FILE))).toThrow(
      missing,
    );
  });

  it("asks for `devbox profile use` when none is current", () => {
    expect(() => resolveConfig({}, {}, file({ ...FILE, current: undefined }))).toThrow(
      new UsageError(
        `no current profile in ${PATH}: run \`devbox profile use <name>\` (profiles: k8s-eks, local)`,
      ),
    );
  });

  it("says how to log in when there is no file or no profile", () => {
    const message = `no API URL and no profile in ${PATH}: run \`bun run up\` or \`bun run k8s:install\`, or pass --url/--token`;
    expect(() => resolveConfig({}, {}, file(undefined))).toThrow(new UsageError(message));
    expect(() => resolveConfig({}, {}, file({ current: undefined, profiles: {} }))).toThrow(
      new UsageError(message),
    );
  });
});
