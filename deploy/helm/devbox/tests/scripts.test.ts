// The chart's shell scripts against a fake kubectl (tests/fake-kubectl.ts).
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every fake kubectl call starts a bun process: on a 2-CPU CI runner one
// snapshot-builder run took over the default 5s.
setDefaultTimeout(30_000);

const FILES = join(import.meta.dir, "..", "files");
let dir: string;
let kubectl: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devbox-chart-"));
  kubectl = join(dir, "kubectl");
  writeFileSync(kubectl, `#!/bin/sh\nexec bun ${join(import.meta.dir, "fake-kubectl.ts")} "$@"\n`);
  chmodSync(kubectl, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function runScript(script: string, env: Record<string, string>) {
  const proc = Bun.spawn(["sh", join(FILES, script)], {
    env: { PATH: process.env.PATH ?? "", KUBECTL: kubectl, FAKE_KUBE_DIR: dir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}
const obj = (...p: string[]) => join(dir, ...p);
const read = (...p: string[]) => readFileSync(obj(...p), "utf8");
const calls = () =>
  readFileSync(obj("calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l).argv.join(" "));

describe("bootstrap.sh", () => {
  const env = {
    RELEASE_NAMESPACE: "devbox",
    SANDBOX_NAMESPACE: "devbox-sandboxes",
    POSTGRES_ENABLED: "true",
    SCRATCH_PVC: "devbox-repos-scratch",
    STORAGE_CLASS: "gp3",
    WORKSPACE_SIZE: "15Gi",
  };

  it("creates the scratch PVC when it is missing, in the sandbox namespace", async () => {
    const r = await runScript("bootstrap.sh", env);
    expect(r.code).toBe(0);
    expect(read("devbox-sandboxes", "pvc", "devbox-repos-scratch", "size")).toBe("15Gi");
    const create = readFileSync(obj("calls.log"), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; stdin: string })
      .find((c) => c.argv.join(" ") === "create -f -");
    expect(create).toBeDefined();
    expect(Bun.YAML.parse(create?.stdin ?? "")).toEqual({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: "devbox-repos-scratch",
        namespace: "devbox-sandboxes",
        labels: { "app.kubernetes.io/part-of": "devbox", "app.kubernetes.io/component": "snapshot-builder" },
        annotations: { "devbox.io/workspace-size": "15Gi" },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "gp3",
        resources: { requests: { storage: "15Gi" } },
      },
    });
    expect(r.stdout).toContain("created the scratch volume devbox-repos-scratch (15Gi)");
  });

  it("reuses an existing scratch PVC of the same size", async () => {
    await runScript("bootstrap.sh", env);
    writeFileSync(obj("calls.log"), "");
    expect((await runScript("bootstrap.sh", env)).code).toBe(0);
    expect(calls().filter((c) => c.startsWith("create -f -"))).toEqual([]);
  });

  it("refuses a scratch PVC of another size, naming the fix", async () => {
    await runScript("bootstrap.sh", env);
    const r = await runScript("bootstrap.sh", { ...env, WORKSPACE_SIZE: "20Gi" });
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(
      "the scratch volume devbox-repos-scratch is 15Gi but workspace.size is 20Gi: delete it to resize (kubectl -n devbox-sandboxes delete pvc devbox-repos-scratch), then run bun run k8s:refresh-snapshot --target <file>",
    );
  });

  it("reuses a claim created as 1024Mi when workspace.size is 1024Mi", async () => {
    // The API server stores 1024Mi as 1Gi: the check reads the annotation.
    const mi = { ...env, WORKSPACE_SIZE: "1024Mi" };
    await runScript("bootstrap.sh", mi);
    writeFileSync(obj("devbox-sandboxes", "pvc", "devbox-repos-scratch", "size"), "1Gi");
    writeFileSync(obj("calls.log"), "");
    expect((await runScript("bootstrap.sh", mi)).code).toBe(0);
    expect(calls().filter((c) => c.startsWith("create -f -"))).toEqual([]);
  });

  it("does not check the size of a claim devbox did not create", async () => {
    mkdirSync(obj("devbox-sandboxes", "pvc", "devbox-repos-scratch"), { recursive: true });
    writeFileSync(obj("devbox-sandboxes", "pvc", "devbox-repos-scratch", "size"), "5Gi");
    const r = await runScript("bootstrap.sh", env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "the scratch volume devbox-repos-scratch was not created by devbox: its size is not checked\n",
    );
    expect(calls().filter((c) => c.startsWith("create -f -"))).toEqual([]);
  });

  it("creates every generated secret and the public CA ConfigMap", async () => {
    const r = await runScript("bootstrap.sh", env);
    expect(r.code).toBe(0);
    expect(read("devbox", "secret", "devbox-opensandbox", "api-key")).toMatch(/^[0-9a-f]{48}$/);
    expect(read("devbox", "secret", "devbox-postgres", "password")).toMatch(/^[0-9a-f]{48}$/);
    const cert = read("devbox", "secret", "devbox-iron-proxy-ca", "tls.crt");
    expect(cert).toStartWith("-----BEGIN CERTIFICATE-----");
    expect(read("devbox", "secret", "devbox-iron-proxy-ca", "tls.key")).toContain("PRIVATE KEY");
    expect(read("devbox-sandboxes", "configmap", "iron-proxy-ca-cert", "ca.crt")).toBe(cert);
    // Only the certificate reaches the sandbox namespace.
    expect(existsSync(obj("devbox-sandboxes", "configmap", "iron-proxy-ca-cert", "tls.key"))).toBe(false);
  });

  it("never replaces existing values on a re-run", async () => {
    await runScript("bootstrap.sh", env);
    const before = ["devbox-opensandbox/api-key", "devbox-postgres/password", "devbox-iron-proxy-ca/tls.crt"].map(
      (p) => read("devbox", "secret", ...p.split("/")),
    );
    writeFileSync(obj("calls.log"), "");
    expect((await runScript("bootstrap.sh", env)).code).toBe(0);
    expect(calls().filter((c) => c.startsWith("create secret"))).toEqual([]);
    expect(
      ["devbox-opensandbox/api-key", "devbox-postgres/password", "devbox-iron-proxy-ca/tls.crt"].map((p) =>
        read("devbox", "secret", ...p.split("/")),
      ),
    ).toEqual(before);
  });

  it("recreates a deleted CA ConfigMap from the existing CA", async () => {
    await runScript("bootstrap.sh", env);
    const cert = read("devbox", "secret", "devbox-iron-proxy-ca", "tls.crt");
    rmSync(obj("devbox-sandboxes", "configmap"), { recursive: true });
    expect((await runScript("bootstrap.sh", env)).code).toBe(0);
    expect(read("devbox-sandboxes", "configmap", "iron-proxy-ca-cert", "ca.crt")).toBe(cert);
  });

  it("skips the Postgres password with an external database", async () => {
    await runScript("bootstrap.sh", { ...env, POSTGRES_ENABLED: "false" });
    expect(existsSync(obj("devbox", "secret", "devbox-postgres"))).toBe(false);
  });

  it("creates the token Secret with an empty token when asked and missing", async () => {
    const r = await runScript("bootstrap.sh", { ...env, GITHUB_TOKEN_SECRET: "devbox-github" });
    expect(r.code).toBe(0);
    expect(read("devbox", "secret", "devbox-github", "token")).toBe("");
    expect(r.stdout).toContain("created secret devbox-github (empty until the minter writes a token)\n");
  });

  it("leaves an existing token Secret untouched", async () => {
    mkdirSync(obj("devbox", "secret", "devbox-github"), { recursive: true });
    writeFileSync(obj("devbox", "secret", "devbox-github", "token"), "ghs_existing");
    expect((await runScript("bootstrap.sh", { ...env, GITHUB_TOKEN_SECRET: "devbox-github" })).code).toBe(0);
    expect(read("devbox", "secret", "devbox-github", "token")).toBe("ghs_existing");
    expect(calls().filter((c) => c.startsWith("create secret generic devbox-github "))).toEqual([]);
  });

  it("creates no token Secret by default", async () => {
    expect((await runScript("bootstrap.sh", env)).code).toBe(0);
    expect(existsSync(obj("devbox", "secret", "devbox-github"))).toBe(false);
  });
});

describe("snapshot-builder.sh", () => {
  const TOKEN = "ghp_realtoken123";
  const setup = () => {
    mkdirSync(obj("devbox", "secret", "devbox-github"), { recursive: true });
    writeFileSync(obj("devbox", "secret", "devbox-github", "token"), `${TOKEN}\n`);
    mkdirSync(obj("repos"));
    writeFileSync(obj("snapshots"), "volumesnapshot.snapshot.storage.k8s.io/my-backup\nvolumesnapshot.snapshot.storage.k8s.io/repos-20261001000000\nvolumesnapshot.snapshot.storage.k8s.io/repos-20261002000000\nvolumesnapshot.snapshot.storage.k8s.io/repos-20261003000000\nvolumesnapshot.snapshot.storage.k8s.io/repos-20261014120000\n");
    chmodSync(join(import.meta.dir, "fake-git.sh"), 0o755);
  };
  const env = () => ({
    REPOS: "https://github.com/acme/widgets.git main\nhttps://github.com/acme/gadgets.git dev",
    RELEASE_NAMESPACE: "devbox",
    SANDBOX_NAMESPACE: "devbox-sandboxes",
    GITHUB_SECRET: "devbox-github",
    SCRATCH_PVC: "devbox-repos-scratch",
    SNAPSHOT_CLASS: "csi-hostpath-snapclass",
    KEEP: "3",
    REPOS_DIR: obj("repos"),
    GIT: join(import.meta.dir, "fake-git.sh"),
    SNAPSHOT_TIMESTAMP: "20261014120000",
  });
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

  it("clones, snapshots, waits and prunes its own snapshots to KEEP", async () => {
    setup();
    const r = await runScript("snapshot-builder.sh", env());
    expect(r.code).toBe(0);
    expect(readFileSync(obj("git.log"), "utf8").trim().split("\n")).toEqual([
      `-c core.fsync=all clone -q --depth 1 --single-branch --branch main -- https://github.com/acme/widgets.git ${obj("repos")}/widgets|Authorization: Basic ${basic}`,
      `-c core.fsync=all clone -q --depth 1 --single-branch --branch dev -- https://github.com/acme/gadgets.git ${obj("repos")}/gadgets|Authorization: Basic ${basic}`,
    ]);
    const log = readFileSync(obj("calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((c) => c.argv.join(" "))).toEqual([
      "get secret devbox-github -n devbox -o jsonpath={.data.token}",
      "create -f -",
      "wait volumesnapshot repos-20261014120000 -n devbox-sandboxes --for=jsonpath={.status.readyToUse}=true --timeout=15m",
      "get volumesnapshot -n devbox-sandboxes -l app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder --sort-by=.metadata.creationTimestamp -o name",
      "delete -n devbox-sandboxes volumesnapshot.snapshot.storage.k8s.io/repos-20261001000000 --wait=false",
    ]);
    expect(Bun.YAML.parse(log[1].stdin)).toEqual({
      apiVersion: "snapshot.storage.k8s.io/v1",
      kind: "VolumeSnapshot",
      metadata: {
        name: "repos-20261014120000",
        namespace: "devbox-sandboxes",
        labels: {
          "app.kubernetes.io/part-of": "devbox",
          "app.kubernetes.io/component": "repo-snapshot",
          "app.kubernetes.io/managed-by": "devbox-snapshot-builder",
        },
      },
      spec: {
        volumeSnapshotClassName: "csi-hostpath-snapclass",
        source: { persistentVolumeClaimName: "devbox-repos-scratch" },
      },
    });
    // The token is never in argv or the output.
    expect(readFileSync(obj("calls.log"), "utf8")).not.toContain(TOKEN);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("fetches repos already in the scratch volume", async () => {
    setup();
    mkdirSync(obj("repos", "widgets", ".git"), { recursive: true });
    await runScript("snapshot-builder.sh", env());
    const git = readFileSync(obj("git.log"), "utf8").trim().split("\n").map((l) => l.split("|")[0]);
    expect(git.slice(0, 3)).toEqual([
      `-C ${obj("repos")}/widgets -c core.fsync=all fetch -q --depth 1 origin +refs/heads/main:refs/remotes/origin/main`,
      `-C ${obj("repos")}/widgets checkout -q -f -B main origin/main`,
      `-C ${obj("repos")}/widgets clean -q -ffdx`,
    ]);
  });

  it("stops when it cannot read the GitHub Secret, without cloning anonymously", async () => {
    setup();
    rmSync(obj("devbox", "secret", "devbox-github"), { recursive: true });
    const r = await runScript("snapshot-builder.sh", env());
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('secret "devbox-github" not found');
    expect(existsSync(obj("git.log"))).toBe(false);
    expect(calls()).toEqual(["get secret devbox-github -n devbox -o jsonpath={.data.token}"]);
  });

  it("refuses a repo URL that is not a GitHub https URL", async () => {
    setup();
    const r = await runScript("snapshot-builder.sh", { ...env(), REPOS: "-oProxyCommand=x main" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unsupported repo url: -oProxyCommand=x");
  });
});
