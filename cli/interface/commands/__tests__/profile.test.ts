import { describe, expect, it } from "bun:test";
import { testIo } from "../../__tests__/fakes";
import { UsageError } from "../../command";
import { runAdd, runLs, runUse } from "../profile";

const P = "/home/me/.config/devbox/config.json";
const TEXT = JSON.stringify({
  current: "local",
  profiles: {
    local: { url: "http://localhost:3000", token: "dbx_a" },
    "k8s-kind-devbox": { url: "http://localhost:13000", token: "dbx_b" },
  },
});
const io = () => testIo({ env: {}, configFiles: { [P]: { text: TEXT } } });
const saved = (t: ReturnType<typeof io>) => JSON.parse(t.configFs.read(P));

describe("devbox profile", () => {
  it("ls marks the current profile and never prints tokens", async () => {
    const t = io();
    expect(await runLs(false, t)).toBe(0);
    expect(t.stdout).toEqual([
      "  k8s-kind-devbox  http://localhost:13000",
      "* local            http://localhost:3000",
    ]);
  });

  it("ls --json", async () => {
    const t = io();
    await runLs(true, t);
    expect(JSON.parse(t.stdout.join("\n"))).toEqual({
      current: "local",
      profiles: [
        { name: "k8s-kind-devbox", url: "http://localhost:13000" },
        { name: "local", url: "http://localhost:3000" },
      ],
    });
  });

  it("ls without a file says how to log in", async () => {
    const t = testIo({ env: {} });
    await runLs(false, t);
    expect(t.stdout).toEqual(["no profiles: run `bun run up` or `bun run k8s:install`"]);
  });

  it("use switches the current profile", async () => {
    const t = io();
    expect(await runUse("k8s-kind-devbox", t)).toBe(0);
    expect(saved(t).current).toBe("k8s-kind-devbox");
    expect(t.stdout).toEqual(["Using profile k8s-kind-devbox"]);
  });

  it("use refuses an unknown profile", async () => {
    await expect(runUse("gke", io())).rejects.toThrow(
      new UsageError(`no profile "gke" in ${P}`, "profile"),
    );
  });

  it("use refuses a prototype name", async () => {
    await expect(runUse("constructor", io())).rejects.toThrow(
      new UsageError(`no profile "constructor" in ${P}`, "profile"),
    );
  });

  it("add saves a profile without switching unless --use", async () => {
    const t = io();
    await runAdd("k8s-gke", { url: "https://devbox.example.com/", token: "dbx_c", use: false }, t);
    expect(saved(t)).toEqual({
      current: "local",
      profiles: {
        ...JSON.parse(TEXT).profiles,
        "k8s-gke": { url: "https://devbox.example.com", token: "dbx_c" },
      },
    });
    expect(t.stdout).toEqual(["Saved profile k8s-gke"]);
  });

  it("add refuses a bad name or URL", async () => {
    await expect(runAdd("GKE", { url: "http://x", token: "t", use: false }, io())).rejects.toThrow(
      new UsageError('bad profile name "GKE": use lower-case letters, digits and "-"', "profile"),
    );
    await expect(runAdd("gke", { url: "nope", token: "t", use: false }, io())).rejects.toThrow(
      new UsageError("--url must be an http(s) URL, got nope", "profile"),
    );
  });

  it("add refuses a URL without http or https", async () => {
    await expect(runAdd("k8s", { url: "localhost:3000", token: "dbx_c", use: false }, io())).rejects.toThrow(
      new UsageError("--url must be an http(s) URL, got localhost:3000", "profile"),
    );
  });
});
