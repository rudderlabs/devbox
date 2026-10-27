import { describe, expect, it } from "bun:test";
import { checkPrerequisites, olderThan, parseVersion, type Ran, type Run } from "./prerequisites";

const GiB = 1024 ** 3;
const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });
const MISSING: Ran = { code: 127, stdout: "", stderr: "", missing: true };

// Every tool present and new enough, unless `over` says otherwise; keyed by
// the command's first two words.
function tools(over: Record<string, Ran> = {}): { run: Run; ran: string[] } {
  const all: Record<string, Ran> = {
    "docker info": ok(`28.0.1 ${16 * GiB}`),
    "docker compose": ok("2.29.1"),
    "make --version": ok("GNU Make 4.4"),
    "openssl version": ok("OpenSSL 3.0.13"),
    "kind version": ok("kind v0.27.0 go1.23.6 darwin/arm64"),
    "kubectl version": ok("Client Version: v1.32.2"),
    "helm version": ok("v3.17.1+g980d8ac"),
    "git --version": ok("git version 2.47.1"),
    ...over,
  };
  const ran: string[] = [];
  const run: Run = async (cmd) => {
    const key = cmd.slice(0, 2).join(" ");
    ran.push(key);
    const r = all[key];
    if (!r) throw new Error(`unexpected command: ${cmd.join(" ")}`);
    return r;
  };
  return { run, ran };
}

describe("versions", () => {
  it("parses with or without a v", () => {
    expect(parseVersion("v2.13.0")).toEqual([2, 13, 0]);
    expect(parseVersion("Docker Compose version 2.29.1-desktop.1")).toEqual([2, 29, 1]);
    expect(parseVersion("nonsense")).toBeUndefined();
  });

  it("compares component by component", () => {
    expect(olderThan([2, 12, 9], [2, 13, 0])).toBe(true);
    expect(olderThan([2, 13, 0], [2, 13, 0])).toBe(false);
    expect(olderThan([3, 0, 0], [2, 13, 0])).toBe(false);
  });
});

describe("checkPrerequisites", () => {
  it("Compose: checks docker, compose, make and openssl", async () => {
    const t = tools();
    expect(await checkPrerequisites("compose", t.run)).toEqual({ problems: [], warnings: [] });
    expect(t.ran).toEqual(["docker info", "make --version", "docker compose", "openssl version"]);
  });

  it("kind: checks kind, kubectl, helm and git instead of compose and openssl", async () => {
    const t = tools();
    const f = await checkPrerequisites("kind", t.run);
    expect(f.problems).toEqual([]);
    expect(f.warnings).toEqual([
      "kind needs about 30 GB of free disk for the cluster, the images and the volumes",
    ]);
    expect(t.ran).toEqual([
      "docker info",
      "make --version",
      "kind version",
      "kubectl version",
      "helm version",
      "git --version",
    ]);
  });

  it("reports every problem at once", async () => {
    const t = tools({
      "docker compose": ok("2.12.2"),
      "make --version": MISSING,
      "openssl version": MISSING,
    });
    expect((await checkPrerequisites("compose", t.run)).problems).toEqual([
      "make not found: install it",
      "Docker Compose 2.12.2 is too old: devbox needs 2.13.0 or newer",
      "openssl not found: install it",
    ]);
  });

  it("kind and helm too old, kubectl missing", async () => {
    const t = tools({
      "kind version": ok("kind v0.23.0 go1.22"),
      "helm version": ok("v3.13.3+gc8b9489"),
      "kubectl version": MISSING,
    });
    expect((await checkPrerequisites("kind", t.run)).problems).toEqual([
      "kind 0.23.0 is too old: devbox needs 0.24.0 or newer",
      "kubectl not found: install it",
      "helm 3.13.3 is too old: devbox needs 3.14.0 or newer",
    ]);
  });

  it("without docker, skips the compose check", async () => {
    const t = tools({ "docker info": MISSING });
    const f = await checkPrerequisites("compose", t.run);
    expect(f.problems).toEqual([
      "docker not found: install Docker (Docker Desktop, or Docker Engine on Linux)",
    ]);
    expect(t.ran).not.toContain("docker compose");
  });

  it("explains a daemon that refuses the user", async () => {
    const t = tools({
      "docker info": { code: 1, stdout: "", stderr: "permission denied while trying to connect" },
    });
    expect((await checkPrerequisites("compose", t.run)).problems[0]).toContain(
      "sudo usermod -aG docker $USER",
    );
  });

  it("warns, without failing, when Docker has little memory", async () => {
    const t = tools({ "docker info": ok(`28.0.1 ${4 * GiB}`) });
    expect(await checkPrerequisites("compose", t.run)).toEqual({
      problems: [],
      warnings: [
        "Docker has 4.0 GB of memory; devbox needs about 8 GB (Docker Desktop: Settings → Resources)",
      ],
    });
  });
});
