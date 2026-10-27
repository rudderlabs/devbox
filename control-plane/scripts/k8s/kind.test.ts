import { describe, expect, it } from "bun:test";
import type { DevboxConfig } from "../up/config";
import { fakeRunner, type Step } from "./fakeRunner";
import type { InstallDeps, InstallOptions } from "./install";
import { KIND_VALUES, kindSetup, parseKindVersion } from "./kind";
import { KubeError, type RunResult } from "./run";
import { type Target, TargetError } from "./target";

const TMP = "/tmp/devbox-kind-test";
const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const K = (...args: string[]) => ["kubectl", "--context", "kind-devbox", ...args];
const step = (cmd: string[], result?: Partial<RunResult>): Step => ({ cmd, result });
const VERSION = "kind v0.32.0 go1.25.1 linux/amd64\n";
const SNAPSHOTTER = "https://github.com/kubernetes-csi/external-snapshotter";
const SNAPCLASS_YAML = `${TMP}/deploy/kubernetes-latest/hostpath/csi-hostpath-snapshotclass.yaml`;

const OPTS: InstallOptions = {
  skipPushCheck: true,
  skipLlmCheck: true,
  skipLinearCheck: false,
  netpol: "auto",
  timeout: "15m",
};

const PRELUDE: Step[] = [
  step(["kind", "version"], { stdout: VERSION }),
  step(["docker", "info", "--format", "{{.ServerVersion}}"], { stdout: "27.0.0\n" }),
];
const SNAPSHOT_CONTROLLER: Step[] = [
  step(K("apply", "-k", `${SNAPSHOTTER}/client/config/crd?ref=v8.7.0`)),
  step(K("apply", "-k", `${SNAPSHOTTER}/deploy/kubernetes/snapshot-controller?ref=v8.7.0`)),
  step(
    K("rollout", "status", "deployment/snapshot-controller", "-n", "kube-system", "--timeout=3m"),
  ),
];
const HOSTPATH_CLASS = K("get", "storageclass", "csi-hostpath-sc");
const SNAPCLASS = K("get", "volumesnapshotclass", "csi-hostpath-snapclass");
const CURRENT_CONTEXT = ["kubectl", "config", "current-context"];
const NO_CONTEXT = { code: 1, stderr: "error: current-context is not set\n" };
const DEPLOY_SH = [`${TMP}/deploy/kubernetes-latest/deploy.sh`];
const CLONE_HOSTPATH = step([
  "git",
  "clone",
  "--depth",
  "1",
  "--branch",
  "v1.18.0",
  "https://github.com/kubernetes-csi/csi-driver-host-path",
  TMP,
]);
// The deploy script acts on the current context: it is switched to kind-devbox
// and restored after, when there was one.
const HOSTPATH_DEPLOY = (
  snapclass: Partial<RunResult> = {},
  previous: string | undefined = "my-eks",
): Step[] => [
  CLONE_HOSTPATH,
  step(CURRENT_CONTEXT, previous ? { stdout: `${previous}\n` } : NO_CONTEXT),
  step(["kubectl", "config", "use-context", "kind-devbox"]),
  step(DEPLOY_SH),
  ...(previous ? [step(["kubectl", "config", "use-context", previous])] : []),
  step(K("apply", "-f", `${TMP}/examples/csi-storageclass.yaml`)),
  step(SNAPCLASS, snapclass),
  ...(snapclass.code ? [step(K("apply", "-f", SNAPCLASS_YAML))] : []),
];
const IMAGES: Step[] = [
  step(["docker", "build", "-t", "devbox-control-plane:kind", `${REPO}/control-plane`]),
  step(["make", "-C", `${REPO}/harness`, "build", "IMAGE=devbox-harness", "TAG=kind"]),
  step([
    "kind",
    "load",
    "docker-image",
    "devbox-control-plane:kind",
    "devbox-harness:kind",
    "--name",
    "devbox",
  ]),
];

function setup(script: Step[]) {
  const f = fakeRunner(script);
  const logs: string[] = [];
  const installs: { target: Target; opts: InstallOptions; overlay: unknown }[] = [];
  const files: Record<string, string> = {};
  const deps = {
    runner: f.runner,
    cfg: {} as DevboxConfig,
    log: (line: string) => void logs.push(line),
    readFile: (p: string) => files[p],
    writeFile: (p: string, t: string) => {
      files[p] = t;
    },
  } as unknown as InstallDeps;
  const inject = {
    install: async (d: InstallDeps, opts: InstallOptions, overlay?: unknown) => {
      installs.push({ target: d.target, opts, overlay });
    },
    mkdtemp: () => TMP,
  };
  return { f, deps, inject, logs, installs, files };
}

describe("parseKindVersion", () => {
  it("reads major, minor and patch", () => {
    expect(parseKindVersion("kind v0.32.0 go1.25.1 linux/amd64")).toEqual([0, 32, 0]);
  });

  it("rejects output that is not a kind version", () => {
    expect(() => parseKindVersion("something else")).toThrow(KubeError);
  });
});

describe("kindSetup", () => {
  it("rejects a kind that is too old", async () => {
    const s = setup([step(["kind", "version"], { stdout: "kind v0.23.0 go1.22 linux/amd64\n" })]);
    await expect(kindSetup(s.deps, OPTS, s.inject)).rejects.toThrow(
      new KubeError(
        "kind v0.23.0 is too old: devbox needs kind v0.24 or newer, whose default network enforces NetworkPolicy",
      ),
    );
    s.f.done();
    expect(s.installs).toEqual([]);
  });

  it("explains a Docker daemon that is not running", async () => {
    const s = setup([
      ...PRELUDE.slice(0, 1),
      step(PRELUDE[1]?.cmd ?? [], { code: 1, stderr: "Cannot connect to the Docker daemon" }),
    ]);
    await expect(kindSetup(s.deps, OPTS, s.inject)).rejects.toThrow(
      "docker is not running: Cannot connect to the Docker daemon",
    );
  });

  it("builds a fresh machine from nothing, then installs", async () => {
    const s = setup([
      ...PRELUDE,
      step(["kind", "get", "clusters"], { stdout: "" }),
      step(["kind", "create", "cluster", "--name", "devbox", "--wait", "120s"]),
      ...SNAPSHOT_CONTROLLER,
      step(HOSTPATH_CLASS, { code: 1, stderr: "NotFound" }),
      ...HOSTPATH_DEPLOY({}, undefined),
      ...IMAGES,
    ]);
    await kindSetup(s.deps, OPTS, s.inject);
    s.f.done();
    expect(s.installs).toEqual([
      {
        target: { context: "kind-devbox", profile: "k8s-kind-devbox", values: {} },
        opts: OPTS,
        overlay: KIND_VALUES,
      },
    ]);
    expect(s.logs.some((l) => l.startsWith("Creating the kind cluster"))).toBe(true);
  });

  it("writes devbox.kind.json and installs from it", async () => {
    const s = setup([
      ...PRELUDE,
      step(["kind", "get", "clusters"], { stdout: "devbox\n" }),
      ...SNAPSHOT_CONTROLLER,
      step(HOSTPATH_CLASS),
      ...IMAGES,
    ]);
    await kindSetup(s.deps, OPTS, s.inject);
    expect(JSON.parse(s.files[`${REPO}/devbox.kind.json`] as string)).toEqual({
      context: "kind-devbox",
      profile: "k8s-kind-devbox",
      values: {},
    });
    expect(s.installs).toEqual([
      {
        target: { context: "kind-devbox", profile: "k8s-kind-devbox", values: {} },
        opts: OPTS,
        overlay: KIND_VALUES,
      },
    ]);
    s.f.done();
  });

  it("keeps an existing file's values and rewrites its context and profile", async () => {
    const s = setup([
      ...PRELUDE,
      step(["kind", "get", "clusters"], { stdout: "devbox\n" }),
      ...SNAPSHOT_CONTROLLER,
      step(HOSTPATH_CLASS),
      ...IMAGES,
    ]);
    s.files[`${REPO}/devbox.kind.json`] = JSON.stringify({
      context: "my-eks",
      profile: "prod",
      values: { sandbox: { cpu: "500m" } },
    });
    await kindSetup(s.deps, OPTS, s.inject);
    expect(JSON.parse(s.files[`${REPO}/devbox.kind.json`] as string)).toEqual({
      context: "kind-devbox",
      profile: "k8s-kind-devbox",
      values: { sandbox: { cpu: "500m" } },
    });
    expect(s.installs[0]?.target).toEqual({
      context: "kind-devbox",
      profile: "k8s-kind-devbox",
      values: { sandbox: { cpu: "500m" } },
    });
    s.f.done();
  });

  it("keeps an existing file's integrations and public URL", async () => {
    const s = setup([
      ...PRELUDE,
      step(["kind", "get", "clusters"], { stdout: "devbox\n" }),
      ...SNAPSHOT_CONTROLLER,
      step(HOSTPATH_CLASS),
      ...IMAGES,
    ]);
    const integrations = {
      linear: { enabled: true, clientId: "client-1" },
      slack: { enabled: false, channelId: "C123" },
    };
    s.files[`${REPO}/devbox.kind.json`] = JSON.stringify({
      publicUrl: "https://hooks.example.com",
      values: {},
      integrations,
    });
    await kindSetup(s.deps, OPTS, s.inject);
    const expected = {
      context: "kind-devbox",
      profile: "k8s-kind-devbox",
      publicUrl: "https://hooks.example.com",
      values: {},
      integrations,
    };
    expect(JSON.parse(s.files[`${REPO}/devbox.kind.json`] as string)).toEqual(expected);
    expect(s.installs[0]?.target).toEqual(expected);
    s.f.done();
  });

  it("refuses a devbox.kind.json with an unknown key", async () => {
    const s = setup([]);
    s.files[`${REPO}/devbox.kind.json`] = JSON.stringify({ value: { sandbox: { cpu: "500m" } } });
    await expect(kindSetup(s.deps, OPTS, s.inject)).rejects.toThrow(
      new TargetError(
        `${REPO}/devbox.kind.json: unknown key "value"; chart values go under values`,
      ),
    );
    s.f.done();
    expect(s.installs).toEqual([]);
  });

  it("refuses a devbox.kind.json that is not a target file", async () => {
    const s = setup([...PRELUDE]);
    s.files[`${REPO}/devbox.kind.json`] = "{ nope";
    await expect(kindSetup(s.deps, OPTS, s.inject)).rejects.toThrow(
      `${REPO}/devbox.kind.json: not valid JSON`,
    );
  });

  it("reuses an existing cluster that already has the hostpath driver", async () => {
    const s = setup([
      ...PRELUDE,
      step(["kind", "get", "clusters"], { stdout: "other\ndevbox\n" }),
      ...SNAPSHOT_CONTROLLER,
      step(HOSTPATH_CLASS),
      ...IMAGES,
    ]);
    await kindSetup(s.deps, OPTS, s.inject);
    s.f.done();
    expect(s.installs).toHaveLength(1);
  });

  it("applies the snapshot class itself when the driver's deploy did not", async () => {
    const s = setup([
      ...PRELUDE,
      step(["kind", "get", "clusters"], { stdout: "devbox\n" }),
      ...SNAPSHOT_CONTROLLER,
      step(HOSTPATH_CLASS, { code: 1 }),
      ...HOSTPATH_DEPLOY({ code: 1, stderr: "NotFound" }),
      ...IMAGES,
    ]);
    await kindSetup(s.deps, OPTS, s.inject);
    s.f.done();
  });

  it("restores the user's context when the hostpath driver's deploy fails", async () => {
    const script = [
      ...PRELUDE,
      step(["kind", "get", "clusters"], { stdout: "devbox\n" }),
      ...SNAPSHOT_CONTROLLER,
      step(HOSTPATH_CLASS, { code: 1 }),
      CLONE_HOSTPATH,
      step(CURRENT_CONTEXT, { stdout: "my-eks\n" }),
      step(["kubectl", "config", "use-context", "kind-devbox"]),
      step(DEPLOY_SH, { code: 1, stderr: "deploy failed" }),
      step(["kubectl", "config", "use-context", "my-eks"]),
    ];
    const s = setup(script);
    await expect(kindSetup(s.deps, OPTS, s.inject)).rejects.toThrow(
      `${DEPLOY_SH[0]} failed: deploy failed`,
    );
    s.f.done();
    expect(s.f.calls.map((c) => c.cmd)).toEqual(script.map((c) => c.cmd));
    expect(s.installs).toEqual([]);
  });

  it("stops with the command's stderr when a step fails, without installing", async () => {
    const s = setup([
      ...PRELUDE,
      step(["kind", "get", "clusters"], { stdout: "devbox\n" }),
      ...SNAPSHOT_CONTROLLER,
      step(HOSTPATH_CLASS),
      step(["docker", "build", "-t", "devbox-control-plane:kind", `${REPO}/control-plane`], {
        code: 1,
        stderr: "no space left on device",
      }),
      step(["make", "-C", `${REPO}/harness`, "build", "IMAGE=devbox-harness", "TAG=kind"]),
    ]);
    await expect(kindSetup(s.deps, OPTS, s.inject)).rejects.toThrow(
      "docker build failed: no space left on device",
    );
    expect(s.installs).toEqual([]);
  });

  it("carries the kind settings", () => {
    expect(KIND_VALUES).toEqual({
      storage: { storageClass: "csi-hostpath-sc", volumeSnapshotClass: "csi-hostpath-snapclass" },
      images: {
        controlPlane: "devbox-control-plane",
        harness: "devbox-harness",
        tag: "kind",
        pullPolicy: "IfNotPresent",
      },
      sandbox: { cpu: "1", memory: "2Gi", maxConcurrent: 5 },
      workspace: { size: "2Gi" },
      postgresql: { size: "1Gi" },
    });
  });
});
