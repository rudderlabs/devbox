import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sandboxManager.service.test.ts mock.module()s this client for the whole test
// process, so the real module runs in a child bun with KUBECTL_BIN pointing at
// a fake kubectl that records its argv and prints $DIR/out.json.
const CLIENT = join(import.meta.dir, "..", "k8s.ts");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devbox-k8s-client-"));
  const kubectl = join(dir, "kubectl");
  writeFileSync(
    kubectl,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/argv.log"\ncat "${dir}/out.json"\n`,
  );
  chmodSync(kubectl, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function latest(items: unknown[], prefix: string): Promise<string> {
  writeFileSync(join(dir, "out.json"), JSON.stringify({ items }));
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `const { getLatestVolumeSnapshotName } = await import(${JSON.stringify(CLIENT)});
       console.log(JSON.stringify(await getLatestVolumeSnapshotName("devbox-sandboxes", ${JSON.stringify(prefix)})));`,
    ],
    { env: { ...process.env, KUBECTL_BIN: join(dir, "kubectl") }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return JSON.parse(stdout);
}
const snap = (name: string, ts: string, readyToUse = true) => ({
  metadata: { name, creationTimestamp: ts },
  status: { readyToUse },
});

describe("getLatestVolumeSnapshotName", () => {
  it("lists only the snapshot builder's own snapshots", async () => {
    await latest([], "repos-");
    expect(readFileSync(join(dir, "argv.log"), "utf8").trim()).toBe(
      "get volumesnapshots.snapshot.storage.k8s.io -n devbox-sandboxes" +
        " -l app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder -o json",
    );
  });

  it("picks the newest ready snapshot with the prefix", async () => {
    const name = await latest(
      [
        snap("repos-1", "2026-10-01T00:00:00Z"),
        snap("repos-3", "2026-10-03T00:00:00Z", false),
        snap("other-4", "2026-10-04T00:00:00Z"),
        snap("repos-2", "2026-10-02T00:00:00Z"),
      ],
      "repos-",
    );
    expect(name).toBe("repos-2");
  });

  it("returns null when nothing matches", async () => {
    expect(await latest([snap("other-1", "2026-10-01T00:00:00Z")], "repos-")).toBeNull();
  });
});

describe("patchSecret", () => {
  it("merge-patches base64 data from stdin, keeping values out of argv", async () => {
    const kubectl = join(dir, "kubectl");
    // Opens /dev/stdin by path, as kubectl's --patch-file does: on Linux that
    // fails when stdin is a socket.
    writeFileSync(
      kubectl,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/argv.log"\ncat /dev/stdin > "${dir}/stdin.log"\n`,
    );
    chmodSync(kubectl, 0o755);
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { patchSecret } = await import(${JSON.stringify(CLIENT)});
         await patchSecret({ namespace: "devbox", name: "devbox-github",
           data: { token: "ghs_abc", "expires-at": "2026-10-19T13:00:00Z" } });`,
      ],
      { env: { ...process.env, KUBECTL_BIN: kubectl }, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(stderr);
    const argv = readFileSync(join(dir, "argv.log"), "utf8").trim();
    expect(argv).toBe("-n devbox patch secret devbox-github --type merge --patch-file /dev/stdin");
    expect(JSON.parse(readFileSync(join(dir, "stdin.log"), "utf8"))).toEqual({
      data: {
        token: Buffer.from("ghs_abc").toString("base64"),
        "expires-at": Buffer.from("2026-10-19T13:00:00Z").toString("base64"),
      },
    });
  });
});

describe("patchSecret failures", () => {
  it("kills a kubectl that hangs past the timeout", async () => {
    // No --request-timeout: that flag makes kubectl skip its in-cluster config.
    const kubectl = join(dir, "kubectl");
    writeFileSync(kubectl, `#!/bin/sh\nexec sleep 10\n`);
    chmodSync(kubectl, 0o755);
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { patchSecret } = await import(${JSON.stringify(CLIENT)});
         try {
           await patchSecret({ namespace: "devbox", name: "devbox-github", data: { token: "ghs_abc" }, timeoutMs: 200 });
         } catch (e) { console.log(JSON.stringify(e.message)); }`,
      ],
      { env: { ...process.env, KUBECTL_BIN: kubectl }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toBe(
      "kubectl patch secret devbox/devbox-github failed: kubectl -n devbox patch secret devbox-github --type merge --patch-file /dev/stdin timed out after 0.2s",
    );
  });

  it("truncates kubectl's stderr to 300 characters", async () => {
    const kubectl = join(dir, "kubectl");
    writeFileSync(kubectl, `#!/bin/sh\ncat > /dev/null\nprintf 'forbidden%0400d' 0 >&2\nexit 1\n`);
    chmodSync(kubectl, 0o755);
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { patchSecret } = await import(${JSON.stringify(CLIENT)});
         try {
           await patchSecret({ namespace: "devbox", name: "devbox-github", data: { token: "ghs_abc" } });
         } catch (e) { console.log(JSON.stringify(e.message)); }`,
      ],
      { env: { ...process.env, KUBECTL_BIN: kubectl }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toBe(
      `kubectl patch secret devbox/devbox-github exited 1: forbidden${"0".repeat(291)}`,
    );
  });
});
