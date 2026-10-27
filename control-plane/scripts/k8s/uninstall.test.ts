import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestructiveRefused } from "../lib/destructive";
import { fakeTerminal } from "../up/fakeTerminal";
import { confirm } from "../up/prompt";
import { fakeRunner, type Step } from "./fakeRunner";
import { KubeError, type RunResult } from "./run";
import type { Target } from "./target";
import { uninstall } from "./uninstall";

const root = mkdtempSync(join(tmpdir(), "devbox-uninstall-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const kc = (...args: string[]) => ["kubectl", "--context", "kind-devbox", ...args];
const hc = (...args: string[]) => ["helm", "--kube-context", "kind-devbox", ...args];
const step = (cmd: string[], result?: Partial<RunResult>): Step => ({ cmd, result });

const target: Target = { context: "kind-devbox", values: {} };

const LOCAL = { url: "http://localhost:3000", token: "dbx_local" };
let n = 0;
function seededHome(): { home: string; path: string } {
  const home = join(root, `home-${++n}`);
  const path = join(home, ".config", "devbox", "config.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      current: "k8s-kind-devbox",
      profiles: {
        local: LOCAL,
        "k8s-kind-devbox": { url: "http://localhost:13000", token: "dbx_k8s" },
      },
    }),
  );
  return { home, path };
}

const noConfirm = async (): Promise<boolean> => {
  throw new Error("asked");
};
const quiet = { isTTY: false, confirm: noConfirm };

async function run(script: Step[], purge: boolean) {
  const f = fakeRunner(script);
  const { home, path } = seededHome();
  const logs: string[] = [];
  await uninstall(
    { runner: f.runner, target, env: {}, home, ...quiet, log: (line) => void logs.push(line) },
    { purge, yes: purge },
  );
  f.done();
  expect(f.calls.map((c) => c.cmd.join(" "))).toEqual(script.map((s) => s.cmd.join(" ")));
  return { logs, path, file: JSON.parse(readFileSync(path, "utf8")) };
}

// A failed install hook Job stays (hook-delete-policy), and its pod keeps the
// scratch PVC in use, so `helm uninstall --wait` would never finish.
const HOOK_JOB = kc(
  "delete",
  "job",
  "devbox-snapshot-builder-install",
  "-n",
  "devbox-sandboxes",
  "--ignore-not-found",
  "--cascade=foreground",
  "--wait=true",
  "--timeout=2m",
);
const UNINSTALL = hc("uninstall", "devbox", "-n", "devbox", "--wait");
const purgeSteps = (secrets: string): Step[] => [
  step(
    kc(
      "delete",
      "namespace",
      "devbox-sandboxes",
      "--wait=true",
      "--timeout=10m",
      "--ignore-not-found",
    ),
  ),
  step(
    kc(
      "delete",
      "secret",
      "devbox-opensandbox",
      "devbox-postgres",
      "devbox-iron-proxy-ca",
      "-n",
      "devbox",
      "--ignore-not-found",
    ),
  ),
  step(
    kc("delete", "secret", "-n", "devbox", "-l", "app.kubernetes.io/managed-by=devbox-installer"),
  ),
  step(
    kc(
      "delete",
      "pvc",
      "-n",
      "devbox",
      "-l",
      "app.kubernetes.io/component=postgres",
      "--ignore-not-found",
    ),
  ),
  step(kc("get", "secrets", "-n", "devbox", "-o", "name"), { stdout: secrets }),
];

describe("uninstall", () => {
  it("removes the release and the CLI profile", async () => {
    const r = await run([step(HOOK_JOB), step(UNINSTALL)], false);
    expect(r.file).toEqual({ profiles: { local: LOCAL } });
    expect(r.logs).toEqual([
      "removed the devbox release from context kind-devbox",
      "kept namespaces devbox and devbox-sandboxes, their volumes and Secrets (--purge deletes them)",
      `removed CLI profile "k8s-kind-devbox" from ${r.path}`,
    ]);
  });

  it("purges everything the install made, then the empty namespace", async () => {
    const r = await run(
      [
        step(HOOK_JOB),
        step(UNINSTALL),
        ...purgeSteps(""),
        step(kc("delete", "namespace", "devbox", "--wait=false", "--ignore-not-found")),
      ],
      true,
    );
    expect(r.file).toEqual({ profiles: { local: LOCAL } });
    expect(r.logs).toEqual([
      "removed the devbox release from context kind-devbox",
      "deleted namespace devbox-sandboxes, the generated and installer-created Secrets and the Postgres volume",
      "deleted namespace devbox",
      `removed CLI profile "k8s-kind-devbox" from ${r.path}`,
    ]);
  });

  it("keeps the namespace while it holds the user's Secrets", async () => {
    const r = await run(
      [step(HOOK_JOB), step(UNINSTALL), ...purgeSteps("secret/my-github\nsecret/my-llm\n")],
      true,
    );
    expect(r.logs).toEqual([
      "removed the devbox release from context kind-devbox",
      "deleted namespace devbox-sandboxes, the generated and installer-created Secrets and the Postgres volume",
      "kept namespace devbox: it still holds Secrets you created (secret/my-github, secret/my-llm)",
      `removed CLI profile "k8s-kind-devbox" from ${r.path}`,
    ]);
  });

  it("purges even without a release", async () => {
    const r = await run(
      [
        step(HOOK_JOB),
        step(UNINSTALL, {
          code: 1,
          stderr: "Error: uninstall: Release not loaded: devbox: release: not found\n",
        }),
        ...purgeSteps(""),
        step(kc("delete", "namespace", "devbox", "--wait=false", "--ignore-not-found")),
      ],
      true,
    );
    expect(r.logs).toEqual([
      "no devbox release in context kind-devbox",
      "deleted namespace devbox-sandboxes, the generated and installer-created Secrets and the Postgres volume",
      "deleted namespace devbox",
      `removed CLI profile "k8s-kind-devbox" from ${r.path}`,
    ]);
  });

  it("purges a cluster that is already purged", async () => {
    // kubectl reports "No resources found" on stderr with exit 0 for an empty
    // or missing namespace; the deletes all ignore what is not there.
    const r = await run(
      [
        step(HOOK_JOB),
        step(UNINSTALL, {
          code: 1,
          stderr: "Error: uninstall: Release not loaded: devbox: release: not found\n",
        }),
        ...purgeSteps(""),
        step(kc("delete", "namespace", "devbox", "--wait=false", "--ignore-not-found")),
      ],
      true,
    );
    expect(r.logs).toEqual([
      "no devbox release in context kind-devbox",
      "deleted namespace devbox-sandboxes, the generated and installer-created Secrets and the Postgres volume",
      "deleted namespace devbox",
      `removed CLI profile "k8s-kind-devbox" from ${r.path}`,
    ]);
  });

  it("stops before helm when it cannot delete the install hook Job", async () => {
    const f = fakeRunner([
      step(HOOK_JOB, { code: 1, stderr: "Error: Kubernetes cluster unreachable\n" }),
    ]);
    const { home } = seededHome();
    await expect(
      uninstall(
        { runner: f.runner, target, env: {}, home, ...quiet, log: () => {} },
        { purge: true, yes: true },
      ),
    ).rejects.toThrow(
      new KubeError(
        "kubectl delete job devbox-snapshot-builder-install failed: Error: Kubernetes cluster unreachable",
      ),
    );
    f.done();
  });

  it("stops on any other helm failure", async () => {
    const f = fakeRunner([
      step(HOOK_JOB),
      step(UNINSTALL, { code: 1, stderr: "Error: Kubernetes cluster unreachable\n" }),
    ]);
    const { home } = seededHome();
    await expect(
      uninstall(
        { runner: f.runner, target, env: {}, home, ...quiet, log: () => {} },
        { purge: true, yes: true },
      ),
    ).rejects.toThrow(
      new KubeError("helm uninstall failed: Error: Kubernetes cluster unreachable"),
    );
    f.done();
  });

  describe("--purge confirmation", () => {
    const ask = (keys: string, isTTY: boolean, yes: boolean, script: Step[]) => {
      const f = fakeRunner(script);
      const { home } = seededHome();
      const logs: string[] = [];
      const asked: string[] = [];
      const term = fakeTerminal(keys, isTTY).term;
      const result = uninstall(
        {
          runner: f.runner,
          target,
          env: {},
          home,
          isTTY,
          confirm: (q, o) => {
            asked.push(q);
            return confirm(q, o, term);
          },
          log: (line) => void logs.push(line),
        },
        { purge: true, yes },
      );
      return { f, logs, asked, result };
    };

    it("--purge lists and asks before anything runs", async () => {
      const r = ask("n\r", true, false, []);
      await r.result;
      expect(r.f.calls).toEqual([]);
      expect(r.asked).toEqual(["Delete all of this in context kind-devbox? [y/N] "]);
      expect(r.logs).toEqual([
        "This deletes:",
        "  - namespace devbox-sandboxes, with every task volume and repo snapshot",
        "  - Secrets devbox-opensandbox, devbox-postgres, devbox-iron-proxy-ca",
        "  - the Secrets the installer created (label app.kubernetes.io/managed-by=devbox-installer)",
        "  - the Postgres volume",
        "  - namespace devbox, if no Secret of yours is left in it",
        "Nothing was removed.",
      ]);
    });

    it("--purge asks, and on yes runs everything", async () => {
      const r = ask("y\r", true, false, [
        step(HOOK_JOB),
        step(UNINSTALL),
        ...purgeSteps("secret/mine"),
      ]);
      await r.result;
      r.f.done();
      expect(r.asked).toHaveLength(1);
    });

    it("--purge --yes runs as today", async () => {
      const r = ask("", false, true, [
        step(HOOK_JOB),
        step(UNINSTALL),
        ...purgeSteps("secret/mine"),
      ]);
      await r.result;
      r.f.done();
      expect(r.asked).toEqual([]);
      expect(r.logs).not.toContain("This deletes:");
    });

    it("--purge without a terminal refuses", async () => {
      const r = ask("", false, false, []);
      await expect(r.result).rejects.toThrow(
        new DestructiveRefused(
          "k8s:uninstall --purge deletes data: pass --yes to confirm without a terminal",
        ),
      );
      expect(r.f.calls).toEqual([]);
    });
  });
});
