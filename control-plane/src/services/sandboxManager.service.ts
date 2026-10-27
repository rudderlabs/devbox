import type { CommandExecution, SandboxInfo, Volume } from "@alibaba-group/opensandbox";
import {
  ConnectionConfig,
  Sandbox,
  SandboxApiException,
  SandboxManager as SdkSandboxManager,
} from "@alibaba-group/opensandbox";
import * as dockerClient from "../clients/docker";
import {
  createPvcFromSnapshot,
  deletePvc,
  getLatestVolumeSnapshotName,
  getSandboxPodStatus,
  isK8sNotFoundError,
  listPodsUsingPvc,
  type PodStatus,
  type PvcPod,
  pvcExists,
} from "../clients/k8s";
import { logger } from "../logger";

export type { PodStatus } from "../clients/k8s";

export type DockerVolumeClient = Pick<
  typeof dockerClient,
  | "createVolumeFromBase"
  | "removeVolume"
  | "volumeExists"
  | "listContainersUsingVolume"
  | "getSandboxContainerStatus"
>;

import { PvcNotFoundError, SandboxCreateError, SandboxFilesTimeoutError } from "../errors";
import type { GitIdentity } from "../sandboxConfig";
import type { HarnessEvent } from "../types/harnessEvent";
import { experimentalEnvName } from "./experimentalFlags";

export type SandboxCreateParams = {
  taskId: string;
  externalId: string;
  source: string;
  metadata: unknown;
  experimentalFlags?: string[];
};

// The sandbox workspace root. Single source of truth: CP passes this to the
// sandbox as the WORKSPACE env var, and the daemon derives its .harness dir
// (= WORKSPACE/.harness) and every path under it from this one value, so the
// env and the daemon's paths can't drift.
const WORKSPACE = "/workspace";

// On Kubernetes the iron-proxy CA is mounted at /run/iron-proxy/ca.crt by the
// sandbox pod template, and bootstrap.sh adds it to the system bundle. The
// local Docker image bakes the same settings in (harness/Makefile).
export const K8S_EGRESS_ENV: Readonly<Record<string, string>> = {
  IRON_PROXY_EGRESS: "true",
  NODE_EXTRA_CA_CERTS: "/run/iron-proxy/ca.crt",
  SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
  REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
  CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
};
// The harness working dir inside the sandbox — inbox task files, events.jsonl,
// and the inbox lock all live under here. CP builds every Files-API path from
// it; mirrors the daemon's own WORKSPACE/.harness derivation.
const HARNESS_DIR = `${WORKSPACE}/.harness`;

export type SandboxManagerOptions = {
  domain: string;
  apiKey?: string;
  baseImage: string;
  timeoutSeconds: number;
  resourceCpu: string;
  resourceMemory: string;
  reposMountPath: string;
  requestTimeoutSeconds: number;
  readyTimeoutSeconds: number;
  // See config.ts's reconcileFilesTimeoutMs comment: bounds a single
  // reconcile-tick Files-API call, independent of requestTimeoutSeconds.
  reconcileFilesTimeoutMs: number;
  gitIdentity?: GitIdentity;
  // Where each task's workspace volume is minted from (see config.ts):
  // k8s → PVC from the latest ready VolumeSnapshot in `pvcNamespace`, resolved
  // at creation time so each task gets the freshest repos; docker → Docker
  // named volume copied from `reposBaseVolume`.
  sandboxRuntime: "k8s" | "docker";
  reposBaseVolume: string;
  // Docker volume client; tests inject a fake instead of mock.module, whose
  // Linux cross-file leak would reach the real client's own tests.
  docker?: DockerVolumeClient;
  // Optional name-prefix filter applied to k8s snapshot discovery.
  snapshotNamePrefix: string;
  pvcNamespace: string;
  pvcStorageClass: string;
  pvcStorageSize: string;
  // Explicitly allowlisted HARNESS_* configuration, set on the sandbox
  // unchanged; the harness reads these names directly.
  forwardedEnv: Record<string, string>;
  // Comma-separated GitHub orgs whose members, and logins of users, are trusted
  // as PR-discussion authors. Forwarded as HARNESS_TRUSTED_ORGS and
  // HARNESS_TRUSTED_USERS; undefined → not set on the sandbox.
  trustedOrgs?: string;
  trustedUsers?: string;
};

// Contract with the sandbox image (harness/Dockerfile): it installs the task
// runner at this path. SDK's default entrypoint (`tail -f /dev/null`) would
// override the image's ENTRYPOINT, so we pass this explicitly.
const HARNESS_ENTRYPOINT = ["/usr/local/bin/harness-entrypoint"];

// Wraps @alibaba-group/opensandbox with a handle cache so adoption + monitor
// loops don't re-connect on every tick. Owned by the task processor.
export class SandboxManager {
  private readonly connectionConfig: ConnectionConfig;
  private readonly baseImage: string;
  private readonly timeoutSeconds: number;
  private readonly resource: Record<string, string>;
  private readonly reposMountPath: string;
  private readonly handles = new Map<string, Sandbox>();
  private readonly sdkManager: SdkSandboxManager;
  private readonly readyTimeoutSeconds: number;
  private readonly reconcileFilesTimeoutMs: number;
  private readonly gitIdentity: GitIdentity | undefined;
  private readonly sandboxRuntime: "k8s" | "docker";
  private readonly reposBaseVolume: string;
  private readonly docker: DockerVolumeClient;
  private readonly snapshotNamePrefix: string;
  private readonly pvcNamespace: string;
  private readonly pvcStorageClass: string;
  private readonly pvcStorageSize: string;
  private readonly forwardedEnv: Record<string, string>;
  private readonly trustedOrgs: string | undefined;
  private readonly trustedUsers: string | undefined;

  constructor(opts: SandboxManagerOptions) {
    this.connectionConfig = new ConnectionConfig({
      domain: opts.domain,
      apiKey: opts.apiKey,
      // Route execd traffic (files, commands) through the management server
      // instead of direct sandbox host:port. Control-plane pod can reach
      // `domain` but not the sandbox's pod IP / node port.
      useServerProxy: true,
      requestTimeoutSeconds: opts.requestTimeoutSeconds,
    });
    this.baseImage = opts.baseImage;
    this.timeoutSeconds = opts.timeoutSeconds;
    this.resource = { cpu: opts.resourceCpu, memory: opts.resourceMemory };
    this.reposMountPath = opts.reposMountPath;
    this.sdkManager = SdkSandboxManager.create({ connectionConfig: this.connectionConfig });
    this.readyTimeoutSeconds = opts.readyTimeoutSeconds;
    this.reconcileFilesTimeoutMs = opts.reconcileFilesTimeoutMs;
    this.gitIdentity = opts.gitIdentity;
    this.sandboxRuntime = opts.sandboxRuntime;
    this.reposBaseVolume = opts.reposBaseVolume;
    this.docker = opts.docker ?? dockerClient;
    this.snapshotNamePrefix = opts.snapshotNamePrefix;
    this.pvcNamespace = opts.pvcNamespace;
    this.pvcStorageClass = opts.pvcStorageClass;
    this.pvcStorageSize = opts.pvcStorageSize;
    this.forwardedEnv = opts.forwardedEnv;
    this.trustedOrgs = opts.trustedOrgs;
    this.trustedUsers = opts.trustedUsers;
  }

  // Mint a per-task workspace volume: a PVC hydrated from the latest ready
  // VolumeSnapshot in `pvcNamespace` (k8s) or a copy of `reposBaseVolume`
  // (docker). Naming includes a random suffix so retries on the same task
  // don't collide with a still-Terminating PVC from a prior attempt. Throws if
  // the source is missing — a hard config / cluster-state error, not something
  // to silently mount-less around.
  private async mintPvcForTask(taskId: string): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 8);
    const pvcName = `devbox-pvc-${taskId}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (this.sandboxRuntime === "docker") {
      await this.docker.createVolumeFromBase({ name: pvcName, baseVolume: this.reposBaseVolume });
      return pvcName;
    }
    const snapshotName = await getLatestVolumeSnapshotName(
      this.pvcNamespace,
      this.snapshotNamePrefix,
    );
    if (!snapshotName) {
      throw new Error(
        `No readyToUse VolumeSnapshot found in namespace=${this.pvcNamespace}` +
          (this.snapshotNamePrefix ? ` with prefix=${this.snapshotNamePrefix}` : ""),
      );
    }
    await createPvcFromSnapshot({
      name: pvcName,
      namespace: this.pvcNamespace,
      snapshotName,
      storageClassName: this.pvcStorageClass,
      storageSize: this.pvcStorageSize,
    });
    return pvcName;
  }

  // Best-effort PVC teardown. Swallows 404 (already gone — concurrent kill,
  // GC, manual cleanup) but lets other errors bubble so callers can log them.
  private async tearDownPvc(pvcName: string): Promise<void> {
    if (this.sandboxRuntime === "docker") {
      // k8s defers a mounted PVC's delete until its pod is gone
      // (pvc-protection); docker refuses to remove a volume any container
      // still uses, so kill whatever sandbox is on it first. Covers a
      // Sandbox.create that threw after the server made the container.
      const containers = await this.docker.listContainersUsingVolume(pvcName);
      // Attempt the removal even if a kill fails: a kill that timed out
      // client-side may still have freed the volume.
      const kills = await Promise.allSettled(
        containers.flatMap((c) => (c.sandboxId ? [this.killSandbox(c.sandboxId)] : [])),
      );
      await this.docker.removeVolume(pvcName);
      const failed = kills.find((k) => k.status === "rejected");
      if (failed) throw failed.reason;
      return;
    }
    try {
      await deletePvc({ name: pvcName, namespace: this.pvcNamespace });
    } catch (err) {
      if (isK8sNotFoundError(err)) return;
      throw err;
    }
  }

  private buildVolumes(claimName: string | undefined): Volume[] {
    if (!claimName) return [];
    return [
      {
        name: "workspace",
        mountPath: this.reposMountPath,
        readOnly: false,
        pvc: { claimName },
      },
    ];
  }

  async createSandboxWithPvc(task: SandboxCreateParams): Promise<{
    sandboxId: string;
    // The freshly minted PVC name. Caller persists this on the task row for
    // forensics and adoption.
    pvcName: string;
  }> {
    const env = this.buildDaemonEnv(task.experimentalFlags);

    // Mint a fresh workspace volume and attach it to this sandbox only.
    const pvcName = await this.mintPvcForTask(task.taskId);

    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.create({
        connectionConfig: this.connectionConfig,
        image: this.baseImage,
        entrypoint: HARNESS_ENTRYPOINT,
        resource: this.resource,
        timeoutSeconds: this.timeoutSeconds,
        volumes: this.buildVolumes(pvcName),
        readyTimeoutSeconds: this.readyTimeoutSeconds,
        env,
        // Server-side tags — visible via listSandboxInfos. Keep these short;
        // the full task payload lives in the inbox file, not env.
        metadata: this.buildSandboxMetadata(task),
        // Create/connect must stay fast and resilient to transient execd
        // readiness lag. Follow-up file/command reads (status/summary/archive)
        // happen best-effort in monitor paths and tolerate failures.
        skipHealthCheck: true,
      });
    } catch (err) {
      // Sandbox.create failed: tear down the PVC we just minted. We never
      // delete PVCs on normal termination.
      await this.tearDownPvc(pvcName).catch((teardownErr) => {
        logger.error("pvc_leak: tearDownPvc failed after Sandbox.create error", {
          pvcName,
          taskId: task.taskId,
          message: teardownErr instanceof Error ? teardownErr.message : String(teardownErr),
        });
      });
      throw new SandboxCreateError(task.taskId, err);
    }
    this.handles.set(sandbox.id, sandbox);
    return { sandboxId: sandbox.id, pvcName };
  }

  // Recreates a sandbox against an already-existing PVC — the post-reap /
  // post-PR-closed resume path. No minting: the PVC is the one the task was
  // first provisioned with (preserved through reaping) and is never deleted
  // here. Returns the sandbox id, adopted or created.
  //
  // PVC existence is probed EXPLICITLY (before the adoption lookup) ahead of
  // Sandbox.create: a missing PVC
  // does not fail Sandbox.create fast — the pod sits in `Pending` (volume
  // never binds) until the ready timeout (~300s) and the eventual error is a
  // timeout, not a 404. The probe surfaces a pruned PVC immediately as
  // PvcNotFoundError; the caller (runTask) lets it propagate to handleTaskError →
  // deadLetterWorkspaceMissing for the per-row dead-letter.
  //
  // A live sandbox already mounting this PVC is adopted instead of creating
  // another (see findSandboxOnPvc): the PVC is ReadWriteOnce, so a second
  // sandbox would fail Multi-Attach until the first one's TTL.
  async createSandboxFromExistingPvc(params: {
    taskId: string;
    externalId: string;
    source: string;
    pvcName: string;
    experimentalFlags?: string[];
  }): Promise<string> {
    // Probe and lookup failures (kubectl, RBAC, API server) are provisioning
    // failures like any other: retry budget, not a 1-strike fail. A pruned PVC
    // (NotFound) is the one definitive answer and keeps its own error.
    let exists: boolean;
    try {
      exists =
        this.sandboxRuntime === "docker"
          ? await this.docker.volumeExists(params.pvcName)
          : await pvcExists({ name: params.pvcName, namespace: this.pvcNamespace });
    } catch (err) {
      throw new SandboxCreateError(params.taskId, err);
    }
    if (!exists) throw new PvcNotFoundError(params.pvcName);

    // A CP pod that died mid-create, or a client that gave up before the server
    // did, leaves a sandbox no task row points at, sitting on this PVC. Reuse it.
    let existing: string | null;
    try {
      existing = await this.findSandboxOnPvc(params.pvcName, params.taskId);
    } catch (err) {
      throw new SandboxCreateError(params.taskId, err);
    }
    if (existing) {
      logger.warn("adopted the sandbox already mounting the PVC instead of creating", {
        taskId: params.taskId,
        pvcName: params.pvcName,
        sandboxId: existing,
      });
      return existing;
    }

    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.create({
        connectionConfig: this.connectionConfig,
        image: this.baseImage,
        entrypoint: HARNESS_ENTRYPOINT,
        resource: this.resource,
        timeoutSeconds: this.timeoutSeconds,
        volumes: this.buildVolumes(params.pvcName),
        readyTimeoutSeconds: this.readyTimeoutSeconds,
        env: this.buildDaemonEnv(params.experimentalFlags),
        metadata: this.buildSandboxMetadata({
          taskId: params.taskId,
          externalId: params.externalId,
          source: params.source,
        }),
        skipHealthCheck: true,
      });
    } catch (err) {
      throw new SandboxCreateError(params.taskId, err);
    }
    this.handles.set(sandbox.id, sandbox);
    return sandbox.id;
  }

  // The sandbox whose pod mounts `pvcName`, or null. Keyed on the volume, not
  // the task tag: a re-delegation moves the task to a new PVC, and an old sandbox
  // that survived its kill still carries the task's id — only what is attached to
  // this workspace is safe to reuse. The tag is still required to match as a
  // guard against a mis-bound volume. The first non-terminal pod is taken,
  // confirmed alive against the lifecycle API; a Pending one is adopted as-is and
  // reconcile takes over once it is up.
  async findSandboxOnPvc(pvcName: string, taskId: string): Promise<string | null> {
    const pods: PvcPod[] =
      this.sandboxRuntime === "docker"
        ? await this.docker.listContainersUsingVolume(pvcName)
        : await listPodsUsingPvc({ namespace: this.pvcNamespace, pvcName });
    const pod = pods.find(
      (p) => p.sandboxId !== null && !p.deleting && p.phase !== "Failed" && p.phase !== "Succeeded",
    );
    if (!pod?.sandboxId) return null;
    try {
      const info = await this.sdkManager.getSandboxInfo(pod.sandboxId);
      if (info.metadata?.task_id !== taskId) return null;
      return classifySandboxLiveness(info) === "alive" ? pod.sandboxId : null;
    } catch (err) {
      if (SandboxManager.isNotFoundError(err)) return null;
      throw err;
    }
  }

  // True if the sandbox exists and is in a live state. A 404 (tombstoned id) →
  // false; any other error (transient 5xx) bubbles so the caller can defer.
  async isSandboxAlive(sandboxId: string): Promise<boolean> {
    try {
      const info = await this.getSandboxInfo(sandboxId);
      return classifySandboxLiveness(info) === "alive";
    } catch (err) {
      if (SandboxManager.isNotFoundError(err)) return false;
      throw err;
    }
  }

  // OpenSandbox runs each sandbox as a single-replica workload, so the pod for
  // sandbox <id> is always "<id>-0", in the same namespace as the PVCs.
  private podNameForSandbox(sandboxId: string): string {
    return `${sandboxId}-0`;
  }

  // Inspect the backing k8s pod directly. The lifecycle API (getSandboxInfo) can
  // report a sandbox alive for minutes after its pod Failed / was GC'd, so a
  // reconcile stuck on Files-API 5xx uses this to fail fast on a terminal pod
  // instead of waiting out the files-unavailable window. Returns null when the
  // pod state can't be determined (kubectl/RBAC error) so the caller keeps its
  // existing time-based behaviour rather than acting on a guess.
  async getSandboxPodStatus(sandboxId: string): Promise<PodStatus | null> {
    try {
      if (this.sandboxRuntime === "docker") {
        return await this.docker.getSandboxContainerStatus(sandboxId);
      }
      return await getSandboxPodStatus({
        name: this.podNameForSandbox(sandboxId),
        namespace: this.pvcNamespace,
      });
    } catch (err) {
      logger.warn("getSandboxPodStatus failed; treating pod state as unknown", {
        sandboxId,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // WORKSPACE is the only task-specific env; the daemon derives its .harness dir
  // and all paths under it from this. The entrypoint unconditionally exec's
  // the daemon, which reads everything else (description, agent session id,
  // etc.) from the inbox file payload. Shared by both create paths.
  private buildDaemonEnv(experimentalFlags: string[] = []): Record<string, string> {
    const env: Record<string, string> = {
      WORKSPACE,
      ...this.forwardedEnv,
    };
    // Trust comes only from the control plane's own GITHUB_TRUSTED_* settings,
    // never from stray HARNESS_TRUSTED_ORGS/USERS in its env: the
    // sandbox must not trust more than the control plane validated.
    delete env.HARNESS_TRUSTED_ORGS;
    delete env.HARNESS_TRUSTED_USERS;
    if (this.trustedOrgs !== undefined) {
      env.HARNESS_TRUSTED_ORGS = this.trustedOrgs;
    }
    if (this.trustedUsers !== undefined) {
      env.HARNESS_TRUSTED_USERS = this.trustedUsers;
    }
    if (this.sandboxRuntime === "k8s") Object.assign(env, K8S_EGRESS_ENV);
    if (this.gitIdentity) {
      const { name, email } = this.gitIdentity;
      env.GIT_AUTHOR_NAME = name;
      env.GIT_AUTHOR_EMAIL = email;
      env.GIT_COMMITTER_NAME = name;
      env.GIT_COMMITTER_EMAIL = email;
    }
    for (const flag of experimentalFlags) {
      const key = experimentalEnvName(flag);
      if (!key) continue;
      env[key] = "true";
    }
    return env;
  }

  // Server-side metadata tags — visible via listSandboxInfos. Shared by both
  // create paths.
  private buildSandboxMetadata(params: {
    taskId: string;
    externalId: string;
    source: string;
  }): Record<string, string> {
    return {
      task_id: params.taskId,
      external_id: params.externalId,
      source: params.source,
    };
  }

  // Public attach — used on cross-pod takeover when `task.sandbox_id` is set.
  // Throws on 404 so caller can mark the task failed with sandbox_not_found.
  async attachSandbox(sandboxId: string): Promise<Sandbox> {
    const sandbox = await Sandbox.connect({
      connectionConfig: this.connectionConfig,
      sandboxId,
      // See create-path note. Also relevant here because an adopted sandbox
      // may be mid-shutdown / Error — default health check would throw and
      // we'd treat it as attach-failure, when we actually want getInfo() to
      // decide state.
      skipHealthCheck: true,
    });
    this.handles.set(sandboxId, sandbox);
    return sandbox;
  }

  // Monitor-loop read path. Lazy-attaches on map miss (first tick after
  // takeover), then reuses the cached handle. On 404 from the server we evict
  // the stale handle so the next caller can re-attach cleanly (future phases
  // may resurrect a sandbox id via pause/resume semantics).
  async getSandboxInfo(sandboxId: string): Promise<SandboxInfo> {
    let sandbox = this.handles.get(sandboxId);
    if (!sandbox) {
      sandbox = await this.attachSandbox(sandboxId);
    }
    try {
      return await sandbox.getInfo();
    } catch (err) {
      if (SandboxManager.isNotFoundError(err)) {
        this.handles.delete(sandboxId);
      }
      throw err;
    }
  }

  // Normal-close cleanup: drop client-side resources only. PVCs outlive their
  // sandbox by default — use `closeSandboxAndDeletePvc` when the caller knows
  // the PVC has no future and was minted by us.
  async closeSandbox(sandboxId: string): Promise<void> {
    const sandbox = this.handles.get(sandboxId);
    this.handles.delete(sandboxId);
    if (sandbox) {
      await sandbox.close();
    }
  }

  // Lost-ownership cleanup: close the sandbox AND tear down its PVC. Every
  // PVC is minted per task, so adoption paths can call this with `pvcName`
  // read from the task row.
  async closeSandboxAndDeletePvc(sandboxId: string, pvcName: string): Promise<void> {
    await this.closeSandbox(sandboxId);
    await this.tearDownPvc(pvcName);
  }

  // Force path: tell the server to terminate. Works without a local handle
  // (orphan sweep) by falling back to the admin manager. PVC is preserved —
  // see closeSandbox note.
  async killSandbox(sandboxId: string): Promise<void> {
    const sandbox = this.handles.get(sandboxId);
    this.handles.delete(sandboxId);
    try {
      if (sandbox) {
        await sandbox.kill();
        await sandbox.close().catch(() => {});
      } else {
        await this.sdkManager.killSandbox(sandboxId);
      }
    } catch (err) {
      if (SandboxManager.isNotFoundError(err)) return;
      throw err;
    }
  }

  // Admin listing — returns all sandboxes known to the server, across pods.
  async listSandboxInfos(): Promise<SandboxInfo[]> {
    const resp = await this.sdkManager.listSandboxInfos();
    return resp.items;
  }

  // Reads a file from /workspace/.harness/ inside the sandbox via the Files API.
  // Returns null if the file is missing (harness hasn't written it yet, or never
  // will). Any other error bubbles so the caller can distinguish transient
  // failures (network, execd not ready) from the definitive not-found case.
  async readHarnessFile(sandboxId: string, relPath: string): Promise<string | null> {
    const sandbox = this.handles.get(sandboxId) ?? (await this.attachSandbox(sandboxId));
    try {
      return await this.withFilesTimeout(
        sandbox.files.readFile(`${HARNESS_DIR}/${relPath}`),
        sandboxId,
      );
    } catch (err) {
      // A definitive "file not present" (ENOENT-style message) is unambiguously a
      // missing FILE — the harness hasn't written it yet (e.g. events.jsonl before
      // the daemon's first event) — so return null ("no content yet").
      //
      // A bare 404, by contrast, is the SAME signal the SDK returns for a GONE
      // SANDBOX (the execd proxy route reports a missing file and a missing sandbox
      // identically). The lifecycle API (getSandboxInfo) checked upstream in
      // reconcileOne can LAG — reporting a sandbox alive for minutes after its pod
      // died — so swallowing the 404 here would let a sandbox that dies mid-run
      // reconcile "cleanly" (no events) forever. So DON'T swallow it: let it raise,
      // and assessReconcileError reads the authoritative k8s pod to classify
      // (absent/terminal → retry/fail; still-Running → log-only). The cost is that a
      // not-yet-written events.jsonl returning a 404 during warm-up logs a reconcile
      // error + one pod read per tick until the first event — it never fails a
      // healthy task (the pod is Running).
      if (SandboxManager.isFileNotFoundError(err)) {
        return null;
      }
      logger.debug("readHarnessFile failed", {
        sandboxId,
        relPath,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Bounds a single Files-API call to reconcileFilesTimeoutMs, independent of
  // the SDK's own requestTimeoutSeconds (deliberately long for sandbox
  // creation/PVC restore). The SDK exposes no per-call abort for files.* (only
  // commands.run takes a signal), so the underlying call isn't cancelled on
  // timeout — it keeps running and settles later against the `.then` below,
  // which is already attached and swallows it; the caller here has moved on
  // and treated this as a transient failure (see isTransientSandboxError).
  private withFilesTimeout<T>(promise: Promise<T>, sandboxId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SandboxFilesTimeoutError(sandboxId, this.reconcileFilesTimeoutMs));
      }, this.reconcileFilesTimeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // Writes a file under /workspace/.harness/ inside the sandbox via the Files
  // API. Mirrors readHarnessFile error handling — sandbox-gone (404) evicts
  // the cached handle and bubbles; other errors bubble unchanged.
  async writeHarnessFile(sandboxId: string, relPath: string, content: string): Promise<void> {
    const sandbox = this.handles.get(sandboxId) ?? (await this.attachSandbox(sandboxId));
    const path = `${HARNESS_DIR}/${relPath}`;
    try {
      await this.withFilesTimeout(sandbox.files.writeFiles([{ path, data: content }]), sandboxId);
    } catch (err) {
      if (SandboxManager.isNotFoundError(err)) {
        this.handles.delete(sandboxId);
      }
      logger.debug("writeHarnessFile failed", {
        sandboxId,
        path,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Runs a shell command inside the sandbox and returns the collected
  // execution object (stdout/stderr chunks + exitCode).
  async runCommand(
    sandboxId: string,
    command: string,
    timeoutSeconds = 60,
  ): Promise<CommandExecution> {
    const sandbox = this.handles.get(sandboxId) ?? (await this.attachSandbox(sandboxId));
    try {
      return await sandbox.commands.run(command, { timeoutSeconds });
    } catch (err) {
      if (SandboxManager.isNotFoundError(err)) {
        this.handles.delete(sandboxId);
      }
      throw err;
    }
  }

  // Returns CP-facing events from events.jsonl with seq > sinceSeq, in file
  // order. Bad lines are quarantined (warn + drop) rather than thrown — an
  // exception here would block cursor advance and re-fire the same line.
  async readEvents(sandboxId: string, sinceSeq: number): Promise<HarnessEvent[]> {
    const raw = await this.readHarnessFile(sandboxId, "events.jsonl");
    if (!raw) return [];

    const lines = raw.split("\n");
    const events: HarnessEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = (lines[i] ?? "").trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        logger.warn("readEvents: skipping unparseable events.jsonl line", {
          sandboxId,
          lineIndex: i,
        });
        continue;
      }

      const event = validateHarnessEvent(parsed);
      if (!event) {
        logger.warn("readEvents: dropping malformed events.jsonl event", {
          sandboxId,
          lineIndex: i,
          eventType: isObject(parsed) ? parsed.type : undefined,
        });
        continue;
      }
      if (event.seq > sinceSeq) events.push(event);
    }
    return events;
  }

  // Reads raw bytes from an absolute sandbox path. Returns null on a 404 (the
  // file is not there). Throws for other transport failures.
  async readBytesFromSandbox(sandboxId: string, absPath: string): Promise<Uint8Array | null> {
    const sandbox = this.handles.get(sandboxId) ?? (await this.attachSandbox(sandboxId));
    try {
      return await sandbox.files.readBytes(absPath);
    } catch (err) {
      // A 404 from the Files API is a missing file, not a missing sandbox —
      // see readHarnessFile. Return null; sandbox liveness is verified
      // separately via the lifecycle API.
      if (SandboxManager.isFileNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  // Runs the harness's archive command and returns the produced tar.gz bytes
  // unchanged. What goes into the archive is owned by the harness CLI, not here.
  async extractArchive(sandboxId: string): Promise<Uint8Array | null> {
    const archivePath = `/tmp/archive-${crypto.randomUUID()}.tar.gz`;
    const exec = await this.runCommand(
      sandboxId,
      `harness archive --out ${archivePath} --override`,
      60,
    );
    if (exec.exitCode !== 0) {
      logger.warn("harness archive failed", {
        sandboxId,
        exitCode: exec.exitCode ?? null,
        stderr: formatExecutionTail(exec) || undefined,
      });
      return null;
    }

    const bytes = await this.readBytesFromSandbox(sandboxId, archivePath);
    if (!bytes) {
      logger.warn("archive file missing after harness archive succeeded", {
        sandboxId,
        archivePath,
      });
    }
    return bytes;
  }

  // Narrow check — 404 only. The SDK has other codes (e.g. INVALID_ARGUMENT)
  // that may also indicate a tombstoned id; extend this mapping when real
  // traffic surfaces them rather than guessing upfront.
  static isNotFoundError(err: unknown): boolean {
    if (err instanceof SandboxApiException) {
      return err.statusCode === 404;
    }
    return false;
  }

  // Secondary, message-based detection of "file doesn't exist" — for a Files
  // API that reports a missing file with something other than a bare 404 (the
  // readHarnessFile / readBytesFromSandbox callers already map a 404 to null).
  // Best-effort: the SDK exposes no typed code for this.
  // TODO: replace with a typed check once the SDK exposes a dedicated code.
  static isFileNotFoundError(err: unknown): boolean {
    if (err instanceof Error) {
      return /no such file|file not found|does not exist|ENOENT/i.test(err.message);
    }
    return false;
  }

  // A transient server-side error from the sandbox proxy — almost always
  // execd still warming up right after create (skipHealthCheck lets
  // Sandbox.create return before execd serves the Files API). The caller
  // should defer and retry, not fail the task. 502/503/504, or our own
  // withFilesTimeout bailing on a hung call (same warm-up symptom, just
  // caught client-side before the upstream ever answers).
  static isTransientSandboxError(err: unknown): boolean {
    if (err instanceof SandboxApiException) {
      return err.statusCode === 502 || err.statusCode === 503 || err.statusCode === 504;
    }
    return err instanceof SandboxFilesTimeoutError;
  }
}

// Sandbox state we care about for liveness. With the harness in always-on
// daemon mode, a Terminated state always means the daemon died unexpectedly.
// Used by SandboxManager.isSandboxAlive. (The reconcile loop derives liveness
// from the k8s pod status via getSandboxPodStatus, not from this lifecycle-API
// classification.)
export function classifySandboxLiveness(info: SandboxInfo): "alive" | "crashed" | "expired" {
  const now = Date.now();
  if (info.expiresAt instanceof Date && info.expiresAt.getTime() <= now) return "expired";
  const state = info.status?.state;
  const reason = info.status?.reason;
  if (state === "Failed" || state === "Error") return "crashed";
  if ((state === "Terminated" || state === "Deleted") && reason === "CONTAINER_EXITED_ERROR") {
    return "crashed";
  }
  if (state === "Terminated" || state === "Deleted") return "crashed";
  return "alive";
}

// ──────────────────── events.jsonl validation ────────────────────

// Length caps for sandbox-supplied free-text bodies. Sandbox is an untrusted
// producer — unbounded text would be relayed verbatim. Errors are short by
// nature; thought / action / response carry plan markdown + completion
// summaries that can legitimately run long, so they get the wider cap.
const MAX_AGENT_ERROR_LEN = 2000;
const MAX_AGENT_BODY_LEN = 60000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function capString(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.length > maxLen ? `${v.slice(0, maxLen)}…` : v;
}

// A `pr_url` is rendered into a Linear comment and persisted to tasks.pr_urls
// (which the GitHub webhook lookup keys off). Only accept a well-formed
// https://github.com/... URL — anything else is dropped.
function isGithubPrUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === "github.com";
}

// Runtime discriminated-union shape check for one parsed events.jsonl line.
// Returns a typed HarnessEvent on success, or null when the object does not
// match any known event shape — the caller quarantines a null result.
export function validateHarnessEvent(parsed: unknown): HarnessEvent | null {
  if (!isObject(parsed)) return null;
  // seq must be a non-negative safe integer — guards against floats, NaN,
  // Infinity, and values past 2^53-1.
  if (typeof parsed.seq !== "number" || !Number.isSafeInteger(parsed.seq) || parsed.seq < 0) {
    return null;
  }
  if (typeof parsed.type !== "string") return null;
  const ts = typeof parsed.ts === "string" ? parsed.ts : "";

  switch (parsed.type) {
    // All four generic agent emits share one shape: { inbox_id, target_id,
    // body }. target_id is always present (assignment: Linear session id; comment:
    // GH comment id; review: a per-item target_id). Body is the user-facing
    // free text — length-capped, same as the structural `error` fields.
    case "agent_thought":
    case "agent_action":
    case "agent_response":
    case "agent_error": {
      if (!isNonEmptyString(parsed.inbox_id)) return null;
      if (!isNonEmptyString(parsed.target_id)) return null;
      if (typeof parsed.body !== "string") return null;
      const maxLen = parsed.type === "agent_error" ? MAX_AGENT_ERROR_LEN : MAX_AGENT_BODY_LEN;
      return {
        seq: parsed.seq,
        ts,
        type: parsed.type,
        inbox_id: parsed.inbox_id,
        target_id: parsed.target_id,
        body: capString(parsed.body, maxLen) ?? "",
      };
    }

    case "pr_opened": {
      if (!isNonEmptyString(parsed.inbox_id)) return null;
      if (typeof parsed.repo !== "string") return null;
      // pr_url must be a well-formed github.com URL — it is both persisted and
      // rendered. A malformed value drops the whole event.
      if (!isGithubPrUrl(parsed.pr_url)) return null;
      if (typeof parsed.branch !== "string") return null;
      if (typeof parsed.commit_sha !== "string") return null;
      return {
        seq: parsed.seq,
        ts,
        type: "pr_opened",
        inbox_id: parsed.inbox_id,
        repo: parsed.repo,
        pr_url: parsed.pr_url,
        branch: parsed.branch,
        commit_sha: parsed.commit_sha,
      };
    }

    case "completed": {
      // Bare terminal marker — `status` is optional (only assignment rounds carry
      // one; comment/review don't). When present it must be one of the four
      // known values; missing or other → drop the field (forensic-only) but
      // accept the event.
      if (!isNonEmptyString(parsed.inbox_id)) return null;
      const rawStatus = parsed.status;
      const status =
        rawStatus === "completed" ||
        rawStatus === "partial_failure" ||
        rawStatus === "no_action" ||
        rawStatus === "failed"
          ? rawStatus
          : undefined;
      return {
        seq: parsed.seq,
        ts,
        type: "completed",
        inbox_id: parsed.inbox_id,
        ...(status !== undefined ? { status } : {}),
      };
    }

    default:
      return null;
  }
}

function formatExecutionTail(exec: CommandExecution): string {
  const stderr = exec.logs.stderr
    .map((entry) => entry.text)
    .join("")
    .trim();
  if (!stderr) return "";
  return ` stderr=${stderr.slice(0, 200)}`;
}
