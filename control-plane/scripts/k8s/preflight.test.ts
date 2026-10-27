import { describe, expect, it } from "bun:test";
import { fakeRunner, type Step } from "./fakeRunner";
import {
  checkCluster,
  checkNetworkPolicy,
  checkNodeFits,
  checkNoOtherOpenSandbox,
  checkStorage,
  checkTools,
  K8sPreflightError,
  requireImageValues,
} from "./preflight";
import { KubeError, kube, type RunResult } from "./run";

const kc = (...args: string[]) => ["kubectl", "--context", "c", ...args];
const step = (cmd: string[], result?: Partial<RunResult>): Step => ({ cmd, result });
const k8s = (script: Step[]) => {
  const f = fakeRunner(script);
  return { ...f, k: kube(f.runner, "c") };
};

describe("checkTools", () => {
  const KUBECTL = ["kubectl", "version", "--client", "-o", "json"];
  const HELM = ["helm", "version", "--short"];

  it.each(["v3.14.0+g3fc9f4b", "v3.19.2+g8766e71", "v4.0.1+g12500dd"])(
    "accepts helm %s",
    async (version) => {
      const f = fakeRunner([
        step(KUBECTL, { stdout: "{}" }),
        step(HELM, { stdout: `${version}\n` }),
      ]);
      await checkTools(f.runner);
      f.done();
    },
  );

  it("rejects an old helm", async () => {
    const f = fakeRunner([
      step(KUBECTL, { stdout: "{}" }),
      step(HELM, { stdout: "v3.13.0+g825e86f\n" }),
    ]);
    await expect(checkTools(f.runner)).rejects.toThrow(
      new K8sPreflightError("helm v3.13.0 is too old: devbox needs Helm 3.14 or newer"),
    );
  });

  it("reports a kubectl that does not work", async () => {
    const f = fakeRunner([step(KUBECTL, { code: 127, stderr: "kubectl: broken\n" })]);
    await expect(checkTools(f.runner)).rejects.toThrow(
      new K8sPreflightError("kubectl is not working: kubectl: broken"),
    );
  });

  it("reports a helm that does not work", async () => {
    const f = fakeRunner([
      step(KUBECTL, { stdout: "{}" }),
      step(HELM, { code: 1, stderr: "helm: broken\n" }),
    ]);
    await expect(checkTools(f.runner)).rejects.toThrow(
      new K8sPreflightError("helm is not working: helm: broken"),
    );
  });
});

describe("checkCluster", () => {
  const VERSION = kc("version", "-o", "json");
  const server = (major: string, minor: string) =>
    JSON.stringify({ clientVersion: {}, serverVersion: { major, minor } });

  it.each([
    ["1", "27"],
    ["1", "29+"],
    ["1", "34"],
  ])("accepts Kubernetes %s.%s", async (major, minor) => {
    const f = k8s([step(VERSION, { stdout: server(major, minor) })]);
    await checkCluster(f.k);
    f.done();
  });

  it("rejects an old cluster", async () => {
    const f = k8s([step(VERSION, { stdout: server("1", "26") })]);
    await expect(checkCluster(f.k)).rejects.toThrow(
      new K8sPreflightError("Kubernetes 1.26 is too old: devbox needs 1.27 or newer"),
    );
  });

  it("names the context it cannot reach, with the first stderr line", async () => {
    const f = k8s([
      step(VERSION, {
        code: 1,
        stdout: JSON.stringify({ clientVersion: {} }),
        stderr: "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout\nmore\n",
      }),
    ]);
    await expect(checkCluster(f.k)).rejects.toThrow(
      new K8sPreflightError(
        'cannot reach the cluster of context "c": Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout',
      ),
    );
  });
});

describe("checkStorage", () => {
  const values = { storage: { storageClass: "gp3", volumeSnapshotClass: "ebs" } };
  const SC = kc("get", "storageclass", "gp3", "-o", "json");
  const VSC = kc("get", "volumesnapshotclass", "ebs", "-o", "json");
  const sc = (provisioner: string, volumeBindingMode?: string) => ({
    stdout: JSON.stringify({ provisioner, volumeBindingMode }),
  });
  const vsc = (driver: string) => ({ stdout: JSON.stringify({ driver }) });

  it("accepts a snapshot class of the StorageClass's driver", async () => {
    const f = k8s([step(SC, sc("ebs.csi.aws.com")), step(VSC, vsc("ebs.csi.aws.com"))]);
    expect(await checkStorage(f.k, values)).toEqual({
      name: "gp3",
      provisioner: "ebs.csi.aws.com",
      bindingMode: "Immediate",
    });
    f.done();
  });

  it("reports a WaitForFirstConsumer binding mode", async () => {
    const f = k8s([
      step(SC, sc("ebs.csi.aws.com", "WaitForFirstConsumer")),
      step(VSC, vsc("ebs.csi.aws.com")),
    ]);
    expect(await checkStorage(f.k, values)).toEqual({
      name: "gp3",
      provisioner: "ebs.csi.aws.com",
      bindingMode: "WaitForFirstConsumer",
    });
    f.done();
  });

  it("names a missing StorageClass", async () => {
    const f = k8s([
      step(SC, {
        code: 1,
        stderr: 'Error from server (NotFound): storageclasses.storage.k8s.io "gp3" not found\n',
      }),
    ]);
    await expect(checkStorage(f.k, values)).rejects.toThrow(
      new K8sPreflightError('StorageClass "gp3" not found (kubectl get storageclass)'),
    );
  });

  it("explains missing snapshot CRDs", async () => {
    const f = k8s([
      step(SC, sc("ebs.csi.aws.com")),
      step(VSC, {
        code: 1,
        stderr: 'error: the server doesn\'t have a resource type "volumesnapshotclass"\n',
      }),
    ]);
    await expect(checkStorage(f.k, values)).rejects.toThrow(
      new K8sPreflightError(
        "volume snapshots are not installed: install the snapshot CRDs and controller (docs/kubernetes/README.md#prerequisites)",
      ),
    );
  });

  it("names a missing VolumeSnapshotClass", async () => {
    const f = k8s([
      step(SC, sc("ebs.csi.aws.com")),
      step(VSC, {
        code: 1,
        stderr:
          'Error from server (NotFound): volumesnapshotclasses.snapshot.storage.k8s.io "ebs" not found\n',
      }),
    ]);
    await expect(checkStorage(f.k, values)).rejects.toThrow(
      new K8sPreflightError(
        'VolumeSnapshotClass "ebs" not found (kubectl get volumesnapshotclass)',
      ),
    );
  });

  it("rejects a snapshot class of another driver", async () => {
    const f = k8s([step(SC, sc("y")), step(VSC, vsc("x"))]);
    await expect(checkStorage(f.k, values)).rejects.toThrow(
      new K8sPreflightError(
        'VolumeSnapshotClass "ebs" uses driver "x" but StorageClass "gp3" uses "y": pick a class of the same CSI driver',
      ),
    );
  });

  it("passes on other kubectl errors as they are", async () => {
    const f = k8s([step(SC, { code: 1, stderr: "Error from server (Forbidden): no\n" })]);
    const run = checkStorage(f.k, values);
    await expect(run).rejects.toBeInstanceOf(KubeError);
    await expect(run).rejects.toThrow(
      "kubectl get storageclass gp3 failed: Error from server (Forbidden): no",
    );
  });

  it("requires both classes before asking the cluster", async () => {
    const f = k8s([]);
    await expect(checkStorage(f.k, { storage: { volumeSnapshotClass: "ebs" } })).rejects.toThrow(
      new K8sPreflightError(
        "storage.storageClass is required: the StorageClass for task workspaces",
      ),
    );
    await expect(checkStorage(f.k, { storage: { storageClass: "gp3" } })).rejects.toThrow(
      new K8sPreflightError(
        "storage.volumeSnapshotClass is required: a VolumeSnapshotClass of the StorageClass's CSI driver",
      ),
    );
    f.done();
  });
});

describe("requireImageValues", () => {
  it("passes when the images are left to the chart's defaults or set", () => {
    expect(() => requireImageValues({})).not.toThrow();
    expect(() =>
      requireImageValues({ images: { controlPlane: "r/cp", harness: "r/h", tag: "1" } }),
    ).not.toThrow();
  });

  it.each([
    ["controlPlane", "images.controlPlane is required: the control-plane image repository"],
    ["harness", "images.harness is required: the harness image repository"],
  ])("refuses an empty images.%s", (key, message) => {
    for (const value of ["", null]) {
      expect(() => requireImageValues({ images: { [key]: value } })).toThrow(
        new K8sPreflightError(message),
      );
    }
  });
});

describe("checkNetworkPolicy", () => {
  const NS = "devbox-netpol-check-abc";
  const AGNHOST = "registry.k8s.io/e2e-test-images/agnhost:2.52";
  const APPLY = kc("apply", "-f", "-");
  const CREATE_NS = kc("create", "namespace", NS);
  const WAIT = kc("wait", "--for=condition=Ready", "pod/server", "-n", NS, "--timeout=120s");
  const IP = kc("get", "pod", "server", "-n", NS, "-o", "jsonpath={.status.podIP}");
  const phase = (pod: string) => kc("get", "pod", pod, "-n", NS, "-o", "jsonpath={.status.phase}");
  const DELETE_NS = kc("delete", "namespace", NS, "--wait=false");
  const pod = (name: string, args: string[]) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: NS, labels: { "devbox-netpol-check": name } },
    spec: {
      restartPolicy: "Never",
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
  });
  const policy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "deny-server", namespace: NS },
    spec: {
      podSelector: { matchLabels: { "devbox-netpol-check": "server" } },
      policyTypes: ["Ingress"],
    },
  };
  const deps = () => {
    const sleeps: number[] = [];
    return { sleeps, deps: { sleep: async (ms: number) => void sleeps.push(ms), suffix: "abc" } };
  };
  const upToBefore = [
    step(CREATE_NS),
    step(APPLY),
    step(WAIT),
    step(IP, { stdout: "10.244.0.7" }),
    step(APPLY),
  ];

  it("passes when the policy blocks the second connection, and cleans up", async () => {
    const f = k8s([
      ...upToBefore,
      step(phase("client-before"), { stdout: "Pending" }),
      step(phase("client-before"), { stdout: "Running" }),
      step(phase("client-before"), { stdout: "Succeeded" }),
      step(APPLY),
      step(APPLY),
      step(phase("client-after"), { stdout: "Running" }),
      step(phase("client-after"), { stdout: "Failed" }),
      step(DELETE_NS),
    ]);
    const d = deps();
    await checkNetworkPolicy(f.k, d.deps);
    f.done();
    expect(d.sleeps).toEqual([2000, 2000, 5000, 2000]);
    const stdin = f.calls.flatMap((c) => (c.stdin === undefined ? [] : [JSON.parse(c.stdin)]));
    expect(stdin).toEqual([
      pod("server", ["netexec", "--http-port=8080"]),
      pod("client-before", ["connect", "10.244.0.7:8080", "--timeout=5s"]),
      policy,
      pod("client-after", ["connect", "10.244.0.7:8080", "--timeout=5s"]),
    ]);
  });

  it("brackets an IPv6 server address", async () => {
    const f = k8s([
      step(CREATE_NS),
      step(APPLY),
      step(WAIT),
      step(IP, { stdout: "fd00::7" }),
      step(APPLY),
      step(phase("client-before"), { stdout: "Succeeded" }),
      step(APPLY),
      step(APPLY),
      step(phase("client-after"), { stdout: "Failed" }),
      step(DELETE_NS),
    ]);
    await checkNetworkPolicy(f.k, deps().deps);
    f.done();
    expect(JSON.parse(f.calls[4]?.stdin ?? "").spec.containers[0].args).toEqual([
      "connect",
      "[fd00::7]:8080",
      "--timeout=5s",
    ]);
  });

  it("fails when the policy is not enforced", async () => {
    const f = k8s([
      ...upToBefore,
      step(phase("client-before"), { stdout: "Succeeded" }),
      step(APPLY),
      step(APPLY),
      step(phase("client-after"), { stdout: "Succeeded" }),
      step(DELETE_NS),
    ]);
    await expect(checkNetworkPolicy(f.k, deps().deps)).rejects.toThrow(
      new K8sPreflightError(
        "NetworkPolicy is not enforced in this cluster, so the sandbox egress lockdown would silently not happen. Use a CNI that enforces it (docs/kubernetes/README.md#prerequisites), or pass --skip-netpol-check to install anyway",
      ),
    );
    f.done();
  });

  it("fails when pods cannot talk even without a policy", async () => {
    const f = k8s([
      ...upToBefore,
      step(phase("client-before"), { stdout: "Failed" }),
      step(DELETE_NS),
    ]);
    await expect(checkNetworkPolicy(f.k, deps().deps)).rejects.toThrow(
      new K8sPreflightError(
        "could not run the NetworkPolicy check: a test pod could not reach another one without any policy (namespace devbox-netpol-check-abc)",
      ),
    );
    f.done();
  });

  it("gives up on the first client after 60 s", async () => {
    const polls = Array.from({ length: 30 }, () =>
      step(phase("client-before"), { stdout: "Running" }),
    );
    const f = k8s([...upToBefore, ...polls, step(DELETE_NS)]);
    const d = deps();
    await expect(checkNetworkPolicy(f.k, d.deps)).rejects.toThrow(
      new K8sPreflightError(
        "could not run the NetworkPolicy check: a test pod could not reach another one without any policy (namespace devbox-netpol-check-abc)",
      ),
    );
    f.done();
    expect(d.sleeps).toEqual(Array(29).fill(2000));
  });

  it("fails when the second client never finishes", async () => {
    const polls = Array.from({ length: 30 }, () =>
      step(phase("client-after"), { stdout: "Pending" }),
    );
    const f = k8s([
      ...upToBefore,
      step(phase("client-before"), { stdout: "Succeeded" }),
      step(APPLY),
      step(APPLY),
      ...polls,
      step(DELETE_NS),
    ]);
    await expect(checkNetworkPolicy(f.k, deps().deps)).rejects.toThrow(
      new K8sPreflightError(
        "could not run the NetworkPolicy check: test pod client-after did not finish within 60 s (namespace devbox-netpol-check-abc)",
      ),
    );
    f.done();
  });

  it("deletes the probe namespace when a step fails, and explains the failure", async () => {
    const f = k8s([
      step(CREATE_NS),
      step(APPLY),
      step(WAIT, {
        code: 1,
        stderr: "error: timed out waiting for the condition on pods/server\n",
      }),
      step(DELETE_NS),
    ]);
    const run = checkNetworkPolicy(f.k, deps().deps);
    await expect(run).rejects.toBeInstanceOf(K8sPreflightError);
    await expect(run).rejects.toThrow(
      "could not run the NetworkPolicy check: kubectl wait --for=condition=Ready pod/server failed: error: timed out waiting for the condition on pods/server (pass --skip-netpol-check to install without it)",
    );
    f.done();
  });

  it("explains a probe pod rejected at admission", async () => {
    const f = k8s([
      step(CREATE_NS),
      step(APPLY, {
        code: 1,
        stderr:
          'Error from server (Forbidden): pods "server" is forbidden: violates PodSecurity "restricted:latest"\n',
      }),
      step(DELETE_NS),
    ]);
    const run = checkNetworkPolicy(f.k, deps().deps);
    await expect(run).rejects.toBeInstanceOf(K8sPreflightError);
    await expect(run).rejects.toThrow(
      'could not run the NetworkPolicy check: kubectl apply -f - failed: Error from server (Forbidden): pods "server" is forbidden: violates PodSecurity "restricted:latest" (pass --skip-netpol-check to install without it)',
    );
    f.done();
  });
});

describe("checkNodeFits", () => {
  const NODES = kc("get", "nodes", "-o", "json");
  const node = (cpu: string, memory: string, unschedulable?: boolean) => ({
    spec: unschedulable === undefined ? {} : { unschedulable },
    status: { allocatable: { cpu, memory, pods: "110" } },
  });
  const nodes = (...items: unknown[]) => ({ stdout: JSON.stringify({ items }) });

  it("passes when one node fits the default sandbox", async () => {
    const f = k8s([step(NODES, nodes(node("1900m", "7864320Ki"), node("4", "16303308Ki")))]);
    await checkNodeFits(f.k, {});
    f.done();
  });

  it("uses the configured sandbox size", async () => {
    const f = k8s([step(NODES, nodes(node("1900m", "7864320Ki")))]);
    await checkNodeFits(f.k, { sandbox: { cpu: "1", memory: "4Gi" } });
    f.done();
  });

  it("names the largest node when none fits", async () => {
    const f = k8s([
      step(NODES, nodes(node("1", "4Gi"), node("1900m", "7864320Ki"), node("8", "64Gi", true))),
    ]);
    await expect(checkNodeFits(f.k, {})).rejects.toThrow(
      new K8sPreflightError(
        "no node can fit a sandbox (2 CPU, 8Gi): the largest has 1.9 CPU and 7.5Gi allocatable; lower values.sandbox.cpu/memory in the target file or add bigger nodes",
      ),
    );
  });

  it.each([
    ["cpu", { cpu: "two" }, 'values.sandbox.cpu: bad quantity "two"'],
    ["memory", { memory: "8 GB" }, 'values.sandbox.memory: bad quantity "8 GB"'],
  ])("names a bad sandbox %s before asking the cluster", async (_, sandbox, message) => {
    const f = k8s([]);
    const run = checkNodeFits(f.k, { sandbox });
    await expect(run).rejects.toBeInstanceOf(K8sPreflightError);
    await expect(run).rejects.toThrow(message);
    f.done();
  });

  it("explains a cluster with no schedulable node", async () => {
    const f = k8s([step(NODES, nodes(node("8", "64Gi", true)))]);
    await expect(checkNodeFits(f.k, { sandbox: { cpu: "500m", memory: "1Gi" } })).rejects.toThrow(
      new K8sPreflightError(
        "no node can fit a sandbox (500m CPU, 1Gi): no node accepts new pods; lower values.sandbox.cpu/memory in the target file or add bigger nodes",
      ),
    );
  });
});

describe("checkNoOtherOpenSandbox", () => {
  const DEPLOYMENTS = kc(
    "get",
    "deployments",
    "-A",
    "-l",
    "app.kubernetes.io/name=opensandbox,control-plane=controller-manager",
    "-o",
    'jsonpath={range .items[*]}{.metadata.namespace}{"\\n"}{end}',
  );
  const CRD = kc(
    "get",
    "crd",
    "batchsandboxes.sandbox.opensandbox.io",
    "-o",
    "jsonpath={.metadata.annotations.meta\\.helm\\.sh/release-name}",
  );
  const noCrd = {
    code: 1,
    stderr:
      'Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "batchsandboxes.sandbox.opensandbox.io" not found\n',
  };

  it("passes on a clean cluster", async () => {
    const f = k8s([step(DEPLOYMENTS), step(CRD, noCrd)]);
    await checkNoOtherOpenSandbox(f.k);
    f.done();
  });

  it("passes on its own release", async () => {
    const f = k8s([step(DEPLOYMENTS, { stdout: "devbox\n" }), step(CRD, { stdout: "devbox" })]);
    await checkNoOtherOpenSandbox(f.k);
    f.done();
  });

  it("names another controller's namespace", async () => {
    const f = k8s([step(DEPLOYMENTS, { stdout: "devbox\nx\n" })]);
    await expect(checkNoOtherOpenSandbox(f.k)).rejects.toThrow(
      new K8sPreflightError(
        'another OpenSandbox controller runs in namespace "x": devbox bundles its own; uninstall the other one first',
      ),
    );
  });

  it("names the release that owns the CRDs", async () => {
    const f = k8s([step(DEPLOYMENTS), step(CRD, { stdout: "y" })]);
    await expect(checkNoOtherOpenSandbox(f.k)).rejects.toThrow(
      new K8sPreflightError('the OpenSandbox CRDs belong to Helm release "y": uninstall it first'),
    );
  });

  it("rejects CRDs installed outside Helm", async () => {
    const f = k8s([step(DEPLOYMENTS), step(CRD, { stdout: "" })]);
    await expect(checkNoOtherOpenSandbox(f.k)).rejects.toThrow(
      new K8sPreflightError(
        "the OpenSandbox CRDs were installed outside Helm: delete them first (kubectl get crd | grep opensandbox.io)",
      ),
    );
  });
});
