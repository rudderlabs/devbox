// `bun run k8s:kind`: a local cluster for trying devbox and
// for CI. kind ≥ 0.24, whose default network (kindnet) enforces
// NetworkPolicy; the CSI snapshot CRDs and controller; the CSI hostpath driver
// (single node: local and CI only); images built from this checkout and
// loaded into the cluster; then `k8s:install` with kind's settings, from the
// target file it writes, devbox.kind.json.
import { join } from "node:path";
import type { InstallDeps, InstallOptions, install } from "./install";
import { KubeError, kube, type Runner } from "./run";
import { parseTarget, type Target, TargetError } from "./target";

export const KIND_CLUSTER = "devbox";
export const KIND_CONTEXT = `kind-${KIND_CLUSTER}`;
const SNAPSHOTTER = "v8.7.0";
const SNAPSHOTTER_URL = "https://github.com/kubernetes-csi/external-snapshotter";
const HOSTPATH = "v1.18.0";
const HOSTPATH_URL = "https://github.com/kubernetes-csi/csi-driver-host-path";
const STORAGE_CLASS = "csi-hostpath-sc";
const SNAPSHOT_CLASS = "csi-hostpath-snapclass";
const ROOT = join(import.meta.dir, "..", "..", "..");

export const KIND_TARGET_FILE = "devbox.kind.json";

export const KIND_TARGET = { context: KIND_CONTEXT, profile: "k8s-kind-devbox" } as const;

// The command that installs a target's deployment. kind's is `k8s:kind`,
// which adds KIND_VALUES: `k8s:install` alone would fail without them.
export const installCommand = (context: string, targetPath: string): string =>
  context === KIND_CONTEXT ? "bun run k8s:kind" : `bun run k8s:install --target ${targetPath}`;

// Below the target file's values, above the installer's defaults.
export const KIND_VALUES = {
  storage: { storageClass: STORAGE_CLASS, volumeSnapshotClass: SNAPSHOT_CLASS },
  images: {
    controlPlane: "devbox-control-plane",
    harness: "devbox-harness",
    tag: "kind",
    pullPolicy: "IfNotPresent",
  },
  sandbox: { cpu: "1", memory: "2Gi", maxConcurrent: 5 },
  workspace: { size: "2Gi" },
  postgresql: { size: "1Gi" },
};

export function parseKindVersion(out: string): [number, number, number] {
  const m = /\bv(\d+)\.(\d+)\.(\d+)/.exec(out);
  if (!m) throw new KubeError(`cannot read the kind version from "${out.trim()}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Runs a command, throwing its stderr when it fails.
async function must(runner: Runner, cmd: string[]): Promise<string> {
  const r = await runner(cmd);
  if (r.code !== 0) {
    throw new KubeError(
      `${cmd.slice(0, 2).join(" ")} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`,
    );
  }
  return r.stdout;
}

// kind's target file: context and profile are kind's; a user's values are
// kept (the CI workflow lowers the sandbox CPU this way), and so are its
// integrations and public URL (written by linear:setup).
function kindTarget(deps: InstallDeps): { path: string; target: Target } {
  const path = join(ROOT, KIND_TARGET_FILE);
  const text = deps.readFile(path);
  let kept: Pick<Target, "values" | "integrations" | "publicUrl"> = { values: {} };
  if (text !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new TargetError(`${path}: not valid JSON`);
    }
    // The whole file is checked (an unknown key fails rather than being
    // dropped on rewrite), with kind's context and profile in place.
    const { values, integrations, publicUrl } = parseTarget(
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...raw, context: KIND_CONTEXT, profile: KIND_TARGET.profile }
        : raw,
      path,
    );
    kept = {
      values,
      ...(integrations !== undefined ? { integrations } : {}),
      ...(publicUrl !== undefined ? { publicUrl } : {}),
    };
  }
  const target: Target = { ...KIND_TARGET, ...kept };
  deps.writeFile(path, `${JSON.stringify(target, null, 2)}\n`);
  return { path, target };
}

export async function kindSetup(
  deps: InstallDeps,
  opts: InstallOptions,
  inject: { install: typeof install; mkdtemp: () => string },
): Promise<void> {
  const { runner, log } = deps;
  const k = kube(runner, KIND_CONTEXT);
  const { path, target } = kindTarget(deps);

  const versionOut = await must(runner, ["kind", "version"]);
  const [major, minor] = parseKindVersion(versionOut);
  if (major === 0 && minor < 24) {
    const v = /v\d+\.\d+\.\d+/.exec(versionOut)?.[0];
    throw new KubeError(
      `kind ${v} is too old: devbox needs kind v0.24 or newer, whose default network enforces NetworkPolicy`,
    );
  }
  const docker = await runner(["docker", "info", "--format", "{{.ServerVersion}}"]);
  if (docker.code !== 0) {
    throw new KubeError(`docker is not running: ${docker.stderr.trim() || `exit ${docker.code}`}`);
  }

  const clusters = await must(runner, ["kind", "get", "clusters"]);
  if (!clusters.split("\n").some((c) => c.trim() === KIND_CLUSTER)) {
    log(`Creating the kind cluster "${KIND_CLUSTER}" (this can take a few minutes)`);
    await must(runner, ["kind", "create", "cluster", "--name", KIND_CLUSTER, "--wait", "120s"]);
  }

  log("Installing the CSI snapshot CRDs and controller");
  await k.kubectlOk(["apply", "-k", `${SNAPSHOTTER_URL}/client/config/crd?ref=${SNAPSHOTTER}`]);
  await k.kubectlOk([
    "apply",
    "-k",
    `${SNAPSHOTTER_URL}/deploy/kubernetes/snapshot-controller?ref=${SNAPSHOTTER}`,
  ]);
  await k.kubectlOk([
    "rollout",
    "status",
    "deployment/snapshot-controller",
    "-n",
    "kube-system",
    "--timeout=3m",
  ]);

  if ((await k.kubectl(["get", "storageclass", STORAGE_CLASS])).code !== 0) {
    log(`Installing the CSI hostpath driver ${HOSTPATH}`);
    const dir = inject.mkdtemp();
    await must(runner, ["git", "clone", "--depth", "1", "--branch", HOSTPATH, HOSTPATH_URL, dir]);
    // The upstream deploy script acts on the current context: switch to
    // kind's for it, then give the user theirs back.
    const current = await runner(["kubectl", "config", "current-context"]);
    const previous = current.code === 0 ? current.stdout.trim() : "";
    await must(runner, ["kubectl", "config", "use-context", KIND_CONTEXT]);
    try {
      await must(runner, [join(dir, "deploy", "kubernetes-latest", "deploy.sh")]);
    } finally {
      if (previous) await must(runner, ["kubectl", "config", "use-context", previous]);
    }
    await k.kubectlOk(["apply", "-f", join(dir, "examples", "csi-storageclass.yaml")]);
    if ((await k.kubectl(["get", "volumesnapshotclass", SNAPSHOT_CLASS])).code !== 0) {
      await k.kubectlOk([
        "apply",
        "-f",
        join(dir, "deploy", "kubernetes-latest", "hostpath", "csi-hostpath-snapshotclass.yaml"),
      ]);
    }
  }

  log("Building the control-plane and harness images (this can take several minutes)");
  await Promise.all([
    must(runner, [
      "docker",
      "build",
      "-t",
      `${KIND_VALUES.images.controlPlane}:kind`,
      join(ROOT, "control-plane"),
    ]),
    must(runner, [
      "make",
      "-C",
      join(ROOT, "harness"),
      "build",
      `IMAGE=${KIND_VALUES.images.harness}`,
      "TAG=kind",
    ]),
  ]);
  await must(runner, [
    "kind",
    "load",
    "docker-image",
    `${KIND_VALUES.images.controlPlane}:kind`,
    `${KIND_VALUES.images.harness}:kind`,
    "--name",
    KIND_CLUSTER,
  ]);

  await inject.install({ ...deps, target, targetPath: path }, opts, KIND_VALUES);
}
