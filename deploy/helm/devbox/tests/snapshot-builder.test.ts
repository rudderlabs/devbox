// The snapshot builder's install hook Job.
import { describe, expect, it } from "bun:test";
import { renderWith } from "./render";

describe("snapshot builder install hook", () => {
  // Helm never deletes hooks on uninstall, and the pod of a finished Job still
  // mounts the scratch PVC, whose pvc-protection then blocks
  // `helm uninstall --wait`. A failed Job stays, for its logs.
  it("is deleted once it succeeds", async () => {
    const job = (await renderWith(["base.yaml"]))["Job/devbox-sandboxes/devbox-snapshot-builder-install"];
    expect(job?.metadata.annotations).toEqual({
      "helm.sh/hook": "post-install",
      "helm.sh/hook-weight": "5",
      "helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded",
    });
  });

  // A chart PVC on a WaitForFirstConsumer class never binds before the
  // post-install hook that mounts it, and `helm --wait` waits for it first.
  // The bootstrap hook creates the claim instead (files/bootstrap.sh).
  it("declares no scratch PVC; the bootstrap hook creates it", async () => {
    const docs = await renderWith(["base.yaml"]);
    expect(Object.keys(docs).filter((k) => k.startsWith("PersistentVolumeClaim/"))).toEqual([]);
    const job = docs["Job/devbox/devbox-bootstrap"];
    const env = Object.fromEntries(
      job?.spec.template.spec.containers[0].env.map((e: { name: string; value: string }) => [e.name, e.value]),
    );
    expect(env).toMatchObject({
      SCRATCH_PVC: "devbox-repos-scratch",
      STORAGE_CLASS: "csi-hostpath-sc",
      WORKSPACE_SIZE: "15Gi",
    });
    const role = docs["Role/devbox-sandboxes/devbox-bootstrap"];
    expect(role?.rules).toContainEqual({ apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["create"] });
    expect(role?.rules).toContainEqual({
      apiGroups: [""], resources: ["persistentvolumeclaims"], resourceNames: ["devbox-repos-scratch"], verbs: ["get"],
    });
  });

  // `kubectl create job --from=cronjob` gives the Job a non-controller owner
  // reference, so the CronJob's history limits never prune it. A TTL on the
  // template covers scheduled, manual and hook Jobs alike.
  it("gives every builder Job a TTL after it finishes", async () => {
    const docs = await renderWith(["base.yaml"]);
    expect(docs["CronJob/devbox-sandboxes/devbox-snapshot-builder"]?.spec.jobTemplate.spec.ttlSecondsAfterFinished).toBe(600);
    expect(docs["Job/devbox-sandboxes/devbox-snapshot-builder-install"]?.spec.ttlSecondsAfterFinished).toBe(600);
  });
});
