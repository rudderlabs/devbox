// Checks before `k8s:install` touches the cluster. Each failure says what is
// wrong and how to fix it. None reads a Secret; `k8s:check` validates the
// user's own Secrets.
import { parseCpu, parseMemory } from "./quantity";
import { type Kube, KubeError, NAMESPACE, RELEASE, type Runner, type RunResult } from "./run";
import type { Values } from "./values";

export class K8sPreflightError extends Error {}

const AGNHOST = "registry.k8s.io/e2e-test-images/agnhost:2.52";
const fail = (message: string): never => {
  throw new K8sPreflightError(message);
};
const get = (values: Values, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (v, k) => (v && typeof v === "object" ? (v as Values)[k] : undefined),
    values,
  );

const isNotFound = (r: RunResult) => /\(NotFound\)/.test(r.stderr);
// The stdout of a successful kubectl call; any failure but the expected ones
// is passed on as it is.
function stdoutOf(args: string[], r: RunResult): string {
  if (r.code !== 0) {
    throw new KubeError(
      `kubectl ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  }
  return r.stdout;
}

export async function checkTools(runner: Runner): Promise<void> {
  const kubectl = await runner(["kubectl", "version", "--client", "-o", "json"]);
  if (kubectl.code !== 0) fail(`kubectl is not working: ${kubectl.stderr.trim()}`);
  const helm = await runner(["helm", "version", "--short"]);
  if (helm.code !== 0) fail(`helm is not working: ${helm.stderr.trim()}`);
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(helm.stdout.trim());
  const [major, minor] = [Number(m?.[1]), Number(m?.[2])];
  if (!m || (major === 3 && minor < 14) || major < 3) {
    fail(`helm ${helm.stdout.trim().split("+")[0]} is too old: devbox needs Helm 3.14 or newer`);
  }
}

export async function checkCluster(k: Kube): Promise<void> {
  const r = await k.kubectl(["version", "-o", "json"]);
  if (r.code !== 0) {
    fail(`cannot reach the cluster of context "${k.context}": ${r.stderr.trim().split("\n")[0]}`);
  }
  const server = (JSON.parse(r.stdout) as { serverVersion?: { major: string; minor: string } })
    .serverVersion;
  const [major, minor] = [
    Number.parseInt(server?.major ?? "0", 10),
    Number.parseInt(server?.minor ?? "0", 10),
  ];
  if (major < 1 || (major === 1 && minor < 27)) {
    fail(`Kubernetes ${major}.${minor} is too old: devbox needs 1.27 or newer`);
  }
}

// The chart refuses these too (templates/validate.yaml); say so before any cluster call.
export function requireStorageValues(values: Values): { sc: string; vsc: string } {
  const sc = String(get(values, "storage", "storageClass") ?? "");
  if (!sc) fail("storage.storageClass is required: the StorageClass for task workspaces");
  const vsc = String(get(values, "storage", "volumeSnapshotClass") ?? "");
  if (!vsc) {
    fail(
      "storage.volumeSnapshotClass is required: a VolumeSnapshotClass of the StorageClass's CSI driver",
    );
  }
  return { sc, vsc };
}

// The chart defaults both images, so only a value set to empty fails; the chart
// refuses it too (templates/_helpers.tpl), but only after the Secrets step.
export function requireImageValues(values: Values): void {
  for (const [key, what] of [
    ["controlPlane", "the control-plane image repository"],
    ["harness", "the harness image repository"],
  ] as const) {
    const image = get(values, "images", key);
    if (image !== undefined && !String(image ?? "")) fail(`images.${key} is required: ${what}`);
  }
}

export async function checkStorage(
  k: Kube,
  values: Values,
): Promise<{ name: string; provisioner: string; bindingMode: string }> {
  const { sc, vsc } = requireStorageValues(values);

  const scArgs = ["get", "storageclass", sc, "-o", "json"];
  const scRes = await k.kubectl(scArgs);
  if (isNotFound(scRes)) fail(`StorageClass "${sc}" not found (kubectl get storageclass)`);
  const { provisioner, volumeBindingMode } = JSON.parse(stdoutOf(scArgs, scRes)) as {
    provisioner?: string;
    volumeBindingMode?: string;
  };

  const vscArgs = ["get", "volumesnapshotclass", vsc, "-o", "json"];
  const vscRes = await k.kubectl(vscArgs);
  if (vscRes.code !== 0 && vscRes.stderr.includes("the server doesn't have a resource type")) {
    fail(
      "volume snapshots are not installed: install the snapshot CRDs and controller (docs/kubernetes/README.md#prerequisites)",
    );
  }
  if (isNotFound(vscRes))
    fail(`VolumeSnapshotClass "${vsc}" not found (kubectl get volumesnapshotclass)`);
  const { driver } = JSON.parse(stdoutOf(vscArgs, vscRes)) as { driver?: string };

  if (driver !== provisioner) {
    fail(
      `VolumeSnapshotClass "${vsc}" uses driver "${driver}" but StorageClass "${sc}" uses "${provisioner}": pick a class of the same CSI driver`,
    );
  }
  return {
    name: sc,
    provisioner: provisioner ?? "",
    bindingMode: volumeBindingMode ?? "Immediate",
  };
}

// The NetworkPolicy probe: a server, a client that must reach it, a policy
// denying all ingress to the server, and a client that must not.
export function probePod(namespace: string, name: string, args: string[]): Values {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, labels: { "devbox-netpol-check": name } },
    spec: {
      restartPolicy: "Never",
      // Admitted under Pod Security "restricted", which some clusters enforce by default.
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65534,
        runAsGroup: 65534,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "agnhost",
          image: AGNHOST,
          args,
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        },
      ],
    },
  };
}

export function denyAllPolicy(namespace: string): Values {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "deny-server", namespace },
    spec: {
      podSelector: { matchLabels: { "devbox-netpol-check": "server" } },
      policyTypes: ["Ingress"],
    },
  };
}

const POLL_MS = 2000;
const POLL_LIMIT_MS = 60_000;

// The pod's phase once it is Succeeded or Failed, or its last phase after 60 s.
async function waitPhase(
  k: Kube,
  namespace: string,
  pod: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  let phase = "";
  for (let i = 0; i < POLL_LIMIT_MS / POLL_MS; i++) {
    if (i > 0) await sleep(POLL_MS);
    phase = (
      await k.kubectlOk(["get", "pod", pod, "-n", namespace, "-o", "jsonpath={.status.phase}"])
    ).trim();
    if (phase === "Succeeded" || phase === "Failed") return phase;
  }
  return phase;
}

export async function checkNetworkPolicy(
  k: Kube,
  deps: { sleep: (ms: number) => Promise<void>; suffix: string },
): Promise<void> {
  const ns = `devbox-netpol-check-${deps.suffix}`;
  const apply = (manifest: Values) =>
    k.kubectlOk(["apply", "-f", "-"], { stdin: JSON.stringify(manifest) });
  try {
    await k.kubectlOk(["create", "namespace", ns]);
    await apply(probePod(ns, "server", ["netexec", "--http-port=8080"]));
    await k.kubectlOk(["wait", "--for=condition=Ready", "pod/server", "-n", ns, "--timeout=120s"]);
    const ip = (
      await k.kubectlOk(["get", "pod", "server", "-n", ns, "-o", "jsonpath={.status.podIP}"])
    ).trim();
    const target = `${ip.includes(":") ? `[${ip}]` : ip}:8080`;
    const client = (name: string) => probePod(ns, name, ["connect", target, "--timeout=5s"]);

    await apply(client("client-before"));
    if ((await waitPhase(k, ns, "client-before", deps.sleep)) !== "Succeeded") {
      fail(
        `could not run the NetworkPolicy check: a test pod could not reach another one without any policy (namespace ${ns})`,
      );
    }

    await apply(denyAllPolicy(ns));
    await deps.sleep(5000); // policies apply asynchronously
    await apply(client("client-after"));
    const after = await waitPhase(k, ns, "client-after", deps.sleep);
    if (after === "Succeeded") {
      fail(
        "NetworkPolicy is not enforced in this cluster, so the sandbox egress lockdown would silently not happen. Use a CNI that enforces it (docs/kubernetes/README.md#prerequisites), or pass --skip-netpol-check to install anyway",
      );
    }
    if (after !== "Failed") {
      fail(
        `could not run the NetworkPolicy check: test pod client-after did not finish within 60 s (namespace ${ns})`,
      );
    }
  } catch (err) {
    if (err instanceof K8sPreflightError) throw err;
    throw new K8sPreflightError(
      `could not run the NetworkPolicy check: ${(err as Error).message} (pass --skip-netpol-check to install without it)`,
    );
  } finally {
    // Not kubectlOk: a failed cleanup must not hide the check's own result.
    await k.kubectl(["delete", "namespace", ns, "--wait=false"]);
  }
}

type Node = {
  spec?: { unschedulable?: boolean };
  status?: { allocatable?: { cpu?: string; memory?: string } };
};

const userQuantity = (key: string, q: string, parse: (q: string) => number): number => {
  try {
    return parse(q);
  } catch (err) {
    return fail(`values.sandbox.${key}: ${(err as Error).message}`);
  }
};

// Rounded down, so a node just short of the request never reads as enough.
const oneDecimal = (n: number) => (Math.floor(n * 10) / 10).toFixed(1);

export async function checkNodeFits(k: Kube, values: Values): Promise<void> {
  const cpu = String(get(values, "sandbox", "cpu") ?? "2");
  const memory = String(get(values, "sandbox", "memory") ?? "8Gi");
  const [wantCpu, wantMemory] = [
    userQuantity("cpu", cpu, parseCpu),
    userQuantity("memory", memory, parseMemory),
  ];
  const { items } = JSON.parse(await k.kubectlOk(["get", "nodes", "-o", "json"])) as {
    items: Node[];
  };
  const nodes = items
    .filter((n) => !n.spec?.unschedulable)
    .map((n) => ({
      cpu: parseCpu(n.status?.allocatable?.cpu ?? "0"),
      memory: parseMemory(n.status?.allocatable?.memory ?? "0"),
    }));
  if (nodes.some((n) => n.cpu >= wantCpu && n.memory >= wantMemory)) return;

  const advice = "lower values.sandbox.cpu/memory in the target file or add bigger nodes";
  // "Largest" is the node closest to fitting: the highest share of the scarcer resource.
  const fit = (n: { cpu: number; memory: number }) =>
    Math.min(n.cpu / wantCpu, n.memory / wantMemory);
  const largest = nodes.reduce<(typeof nodes)[number] | undefined>(
    (best, n) => (!best || fit(n) > fit(best) ? n : best),
    undefined,
  );
  const found = largest
    ? `the largest has ${oneDecimal(largest.cpu)} CPU and ${oneDecimal(largest.memory / 2 ** 30)}Gi allocatable`
    : "no node accepts new pods";
  fail(`no node can fit a sandbox (${cpu} CPU, ${memory}): ${found}; ${advice}`);
}

export async function checkNoOtherOpenSandbox(k: Kube): Promise<void> {
  const namespaces = await k.kubectlOk([
    "get",
    "deployments",
    "-A",
    "-l",
    "app.kubernetes.io/name=opensandbox,control-plane=controller-manager",
    "-o",
    'jsonpath={range .items[*]}{.metadata.namespace}{"\\n"}{end}',
  ]);
  const other = namespaces
    .split("\n")
    .map((s) => s.trim())
    .find((ns) => ns && ns !== NAMESPACE);
  if (other) {
    fail(
      `another OpenSandbox controller runs in namespace "${other}": devbox bundles its own; uninstall the other one first`,
    );
  }

  const args = [
    "get",
    "crd",
    "batchsandboxes.sandbox.opensandbox.io",
    "-o",
    "jsonpath={.metadata.annotations.meta\\.helm\\.sh/release-name}",
  ];
  const r = await k.kubectl(args);
  if (isNotFound(r)) return;
  const release = stdoutOf(args, r).trim();
  if (release === RELEASE) return;
  if (!release) {
    fail(
      "the OpenSandbox CRDs were installed outside Helm: delete them first (kubectl get crd | grep opensandbox.io)",
    );
  }
  fail(`the OpenSandbox CRDs belong to Helm release "${release}": uninstall it first`);
}
