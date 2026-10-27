import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// kind-guard.sh with the real kubectl on a throwaway kubeconfig and a fake
// docker that reports the kind node's published API server port.
const GUARD = join(import.meta.dir, "kind-guard.sh");
let dir: string;

// The first real kubectl call is slow on a cold CI runner: one run went
// over the default 5s.
setDefaultTimeout(30_000);

const kubeconfig = (kindServer: string) => `apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: kind-devbox
  cluster: {server: "${kindServer}"}
- name: prod
  cluster: {server: "https://prod.example:443"}
contexts:
- name: kind-devbox
  context: {cluster: kind-devbox, user: kind-devbox}
- name: prod
  context: {cluster: prod, user: prod}
users:
- name: kind-devbox
  user: {token: a}
- name: prod
  user: {token: b}
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devbox-kind-guard-"));
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh
if [ "$*" = "port devbox-control-plane 6443/tcp" ] && [ -f "${dir}/port" ]; then cat "${dir}/port"; exit 0; fi
echo "Error: No such container: devbox-control-plane" >&2; exit 1
`,
  );
  chmodSync(join(dir, "docker"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function guard(kindServer: string, port?: string, then = "true") {
  writeFileSync(join(dir, "config"), kubeconfig(kindServer));
  if (port) writeFileSync(join(dir, "port"), port);
  const proc = Bun.spawn(
    ["bash", "-c", `set -euo pipefail; source "${GUARD}"; kind_guard; ${then}`],
    {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, KUBECONFIG: join(dir, "config") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe.skipIf(!Bun.which("kubectl"))("kind_guard", () => {
  it("leaves only the kind context for everything that follows", async () => {
    const r = await guard(
      "https://127.0.0.1:50000",
      "127.0.0.1:50000\n",
      'kubectl config get-contexts -o name; kubectl config current-context; echo "$KUBECONFIG"',
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const [contexts, current, copy] = r.stdout.trim().split("\n");
    expect([contexts, current]).toEqual(["kind-devbox", "kind-devbox"]);
    // The copy is removed when the shell exits.
    expect(copy).not.toBe(join(dir, "config"));
    expect(existsSync(copy as string)).toBe(false);
  });

  it("refuses a kind-devbox context that points at another cluster", async () => {
    const r = await guard("https://prod.example:443", "127.0.0.1:50000\n", "echo reached");
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("reached");
    expect(r.stderr).toContain(
      "context kind-devbox points at https://prod.example:443, not the kind node's API server https://127.0.0.1:50000",
    );
  });

  it("refuses when the kind node is not running", async () => {
    const r = await guard("https://127.0.0.1:50000", undefined, "echo reached");
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("reached");
    expect(r.stderr).toContain("no kind node devbox-control-plane: run `bun run k8s:kind` first");
  });
});
