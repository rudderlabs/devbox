// Why kubectl shell-out instead of @kubernetes/client-node?
//
// Bun's `node:https` mTLS path is broken: client certificates configured via
// `https.Agent` (or fetch's `tls.cert/key`) are silently NOT presented during
// the TLS handshake. Under Node the SDK works fine; under Bun calls to an API
// server that requires client certificates fail because the certificate is not
// presented.
//
// Tracked in:
//   - https://github.com/oven-sh/bun/issues/21643 (https.Agent cert regression, open)
//   - https://github.com/oven-sh/bun/issues/6940  (original `node:https` cert support)
//   - https://github.com/oven-sh/bun/issues/7332  (@kubernetes/client-node + Bun)
//
// `kubectl` handles auth (exec plugins locally, the ServiceAccount token in a pod), TLS
// routing, and SNI uniformly — its overhead (~100 ms/call) is
// dwarfed by sandbox boot time. When the Bun bug is fixed we can swap back to
// the SDK; the function signatures here are stable.

import { REPO_SNAPSHOT_SELECTOR } from "./repoSnapshots";

const KUBECTL = process.env.KUBECTL_BIN ?? "kubectl";

// `timeoutMs` kills kubectl from here: its own --request-timeout flag would
// make it skip the in-cluster config (the ServiceAccount) in a pod.
async function runKubectl(args: string[], stdin?: string, timeoutMs?: number): Promise<string> {
  const proc = Bun.spawn([KUBECTL, ...args], {
    // A Blob, not "pipe": on Linux Bun's pipe is a socket, which kubectl's
    // `--patch-file /dev/stdin` cannot open; a Blob is an in-memory file.
    stdin: stdin ? new Blob([stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (timeoutMs !== undefined && proc.signalCode !== null) {
    throw new Error(`kubectl ${args.join(" ")} timed out after ${timeoutMs / 1000}s`);
  }
  if (code !== 0) {
    const err = new Error(
      `kubectl ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`,
    );
    // Surface stderr verbatim so caller-side `isK8sNotFoundError` can match
    // kubectl's own NotFound wording instead of an HTTP code.
    (err as Error & { stderr: string }).stderr = stderr;
    throw err;
  }
  return stdout;
}

export type CreatePvcFromSnapshotOpts = {
  name: string;
  namespace: string;
  snapshotName: string;
  storageClassName: string;
  storageSize: string;
};

export async function createPvcFromSnapshot(opts: CreatePvcFromSnapshotOpts): Promise<void> {
  const manifest = JSON.stringify({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: opts.name, namespace: opts.namespace },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: opts.storageClassName,
      resources: { requests: { storage: opts.storageSize } },
      dataSource: {
        name: opts.snapshotName,
        kind: "VolumeSnapshot",
        apiGroup: "snapshot.storage.k8s.io",
      },
    },
  });
  await runKubectl(["create", "-n", opts.namespace, "-f", "-"], manifest);
}

export async function deletePvc(opts: { name: string; namespace: string }): Promise<void> {
  await runKubectl(["delete", "pvc", opts.name, "-n", opts.namespace, "--wait=false"]);
}

// True if the named PVC exists. A NotFound from kubectl → false; any other
// error (real API failure) bubbles so the caller does not mistake an outage
// for a pruned PVC. Used by SandboxManager.createSandboxFromExistingPvc to
// fail fast on a pruned workspace instead of waiting out the pod ready timeout.
export async function pvcExists(opts: { name: string; namespace: string }): Promise<boolean> {
  try {
    await runKubectl(["get", "pvc", opts.name, "-n", opts.namespace, "-o", "name"]);
    return true;
  } catch (err) {
    if (isK8sNotFoundError(err)) return false;
    throw err;
  }
}

type VolumeSnapshotItem = {
  metadata?: { name?: string; creationTimestamp?: string };
  status?: { readyToUse?: boolean };
};

export { REPO_SNAPSHOT_SELECTOR } from "./repoSnapshots";

// Equivalent of:
//   kubectl get volumesnapshots.snapshot.storage.k8s.io -n <namespace> -l <REPO_SNAPSHOT_SELECTOR> -o json
// then picking the newest `readyToUse: true` snapshot whose name starts with
// `prefix`. Returns null when none match.
export async function getLatestVolumeSnapshotName(
  namespace: string,
  prefix: string,
): Promise<string | null> {
  const out = await runKubectl([
    "get",
    "volumesnapshots.snapshot.storage.k8s.io",
    "-n",
    namespace,
    "-l",
    REPO_SNAPSHOT_SELECTOR,
    "-o",
    "json",
  ]);
  const parsed = JSON.parse(out) as { items?: VolumeSnapshotItem[] };
  let latest: VolumeSnapshotItem | undefined;
  let latestTs = -Infinity;
  for (const item of parsed.items ?? []) {
    const name = item.metadata?.name;
    const ts = item.metadata?.creationTimestamp;
    if (!name || !ts) continue;
    if (item.status?.readyToUse !== true) continue;
    if (prefix && !name.startsWith(prefix)) continue;
    const t = Date.parse(ts);
    if (Number.isNaN(t)) continue;
    if (t > latestTs) {
      latestTs = t;
      latest = item;
    }
  }
  return latest?.metadata?.name ?? null;
}

// Merge-patches `data` (plain values, base64-encoded here) into an existing
// Secret: the GitHub token minter's secret sink. The patch goes on
// stdin so the values never reach argv; a merge patch keeps the Secret's
// labels (the installer's).
export async function patchSecret(opts: {
  namespace: string;
  name: string;
  data: Record<string, string>;
  timeoutMs?: number;
}): Promise<void> {
  const data = Object.fromEntries(
    Object.entries(opts.data).map(([k, v]) => [k, Buffer.from(v).toString("base64")]),
  );
  try {
    await runKubectl(
      [
        "-n",
        opts.namespace,
        "patch",
        "secret",
        opts.name,
        "--type",
        "merge",
        "--patch-file",
        "/dev/stdin",
      ],
      JSON.stringify({ data }),
      opts.timeoutMs ?? 30_000,
    );
  } catch (err) {
    // The minter logs this as sink_failed's reason: keep it short. Argv holds
    // no secret; kubectl's own stderr is the useful part (RBAC, NotFound).
    const target = `kubectl patch secret ${opts.namespace}/${opts.name}`;
    const message = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr;
    if (stderr === undefined) throw new Error(`${target} failed: ${message.slice(0, 300)}`);
    const code = /exited (\d+):/.exec(message)?.[1] ?? "?";
    throw new Error(`${target} exited ${code}: ${stderr.trim().slice(0, 300)}`);
  }
}

// kubectl's NotFound output ("Error from server (NotFound): ..."). Used by
// callers that want to swallow "already gone" deletes without hiding genuine
// errors.
export function isK8sNotFoundError(err: unknown): boolean {
  if (err instanceof Error) {
    const stderr = (err as Error & { stderr?: string }).stderr ?? "";
    return /NotFound|not found/i.test(stderr) || /NotFound|not found/i.test(err.message);
  }
  return false;
}

// The sandbox workload container inside each sandbox pod. OpenSandbox names it
// "sandbox" (confirmed via kube-state-metrics `container` label).
const SANDBOX_CONTAINER = "sandbox";
// Label the OpenSandbox controller stamps on every sandbox pod; its value is the
// lifecycle-API sandbox id.
const SANDBOX_ID_LABEL = "opensandbox.io/id";

export type PodStatus = {
  // false when the pod no longer exists (kubectl NotFound).
  exists: boolean;
  // Pod phase: Pending | Running | Succeeded | Failed | Unknown. Undefined when
  // !exists.
  phase?: string;
  // The sandbox container's terminated reason ("Error", "OOMKilled", ...), if it
  // has a terminated state (current or last).
  terminatedReason?: string;
  // The sandbox container's terminated exit code, if terminated. 137 = SIGKILL,
  // the usual OOM-kill exit.
  exitCode?: number;
  // Best-effort OOM signal: an explicit OOMKilled reason (container or pod) or a
  // 137 exit. IMPORTANT: a nested/child OOM — e.g. a build inside the sandbox's
  // docker-in-docker — is killed by the kernel WITHOUT kubelet labelling the
  // container OOMKilled, and PID1 may exit non-137, so `false` here does NOT rule
  // OOM out. The authoritative signal is the cgroup `memory.events` oom_kill
  // counter, readable only from inside the sandbox (daemon-side).
  oomKilled: boolean;
};

// Reads the sandbox pod's status straight from k8s — used to tell a dead/terminal
// pod apart from one that is still booting. The OpenSandbox lifecycle API can keep
// reporting a sandbox "alive" for minutes after its pod has Failed / been GC'd
// (the management-server record lags k8s), which strands a reconcile in the
// files-unavailable defer loop; this bypasses that record. Throws on a real
// kubectl/RBAC error (caller treats that as "unknown" and keeps its time-based
// behaviour); a NotFound is returned as `{exists:false}`, not thrown.
export async function getSandboxPodStatus(opts: {
  name: string;
  namespace: string;
}): Promise<PodStatus> {
  let out: string;
  try {
    out = await runKubectl(["get", "pod", opts.name, "-n", opts.namespace, "-o", "json"]);
  } catch (err) {
    if (isK8sNotFoundError(err)) return { exists: false, oomKilled: false };
    throw err;
  }
  const pod = JSON.parse(out) as {
    status?: {
      phase?: string;
      reason?: string;
      containerStatuses?: Array<{
        name?: string;
        state?: { terminated?: { reason?: string; exitCode?: number } };
        lastState?: { terminated?: { reason?: string; exitCode?: number } };
      }>;
    };
  };
  const status = pod.status;
  const container = status?.containerStatuses?.find((c) => c.name === SANDBOX_CONTAINER);
  const terminated = container?.state?.terminated ?? container?.lastState?.terminated;
  const terminatedReason = terminated?.reason;
  const exitCode = terminated?.exitCode;
  const oomKilled =
    /oomkilled/i.test(terminatedReason ?? "") ||
    /oomkilled/i.test(status?.reason ?? "") ||
    exitCode === 137;
  return { exists: true, phase: status?.phase, terminatedReason, exitCode, oomKilled };
}

export type PvcPod = {
  sandboxId: string | null;
  phase: string | undefined;
  deleting: boolean;
};

// Pods in `namespace` that mount `pvcName`. Ground truth for "what is on this
// workspace right now": the OpenSandbox record can lag k8s, and a sandbox tagged
// with the task can sit on a different PVC after a re-delegation. The sandbox id
// comes from the controller's label, falling back to the `<id>-0` pod name, so a
// label rename degrades to the fallback rather than to an empty list.
export async function listPodsUsingPvc(opts: {
  namespace: string;
  pvcName: string;
}): Promise<PvcPod[]> {
  const out = await runKubectl(["get", "pods", "-n", opts.namespace, "-o", "json"]);
  const list = JSON.parse(out) as {
    items?: Array<{
      metadata?: { name?: string; labels?: Record<string, string>; deletionTimestamp?: string };
      spec?: { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }> };
      status?: { phase?: string };
    }>;
  };
  return (list.items ?? [])
    .filter((p) =>
      (p.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === opts.pvcName),
    )
    .map((p) => ({
      sandboxId:
        p.metadata?.labels?.[SANDBOX_ID_LABEL] ??
        (p.metadata?.name?.endsWith("-0") ? p.metadata.name.slice(0, -2) : null),
      phase: p.status?.phase,
      deleting: p.metadata?.deletionTimestamp !== undefined,
    }));
}
