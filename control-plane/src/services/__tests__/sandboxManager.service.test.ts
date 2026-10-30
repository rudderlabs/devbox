import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { PvcPod } from "../../clients/k8s";
import { PvcNotFoundError, SandboxCreateError, SandboxFilesTimeoutError } from "../../errors";
import type { HarnessEvent } from "../../types/harnessEvent";

// k8s client — track calls so we can assert tear-down behavior.
const createPvcFromSnapshot = mock(() => Promise.resolve());
const deletePvc = mock(() => Promise.resolve());
const getLatestVolumeSnapshotName = mock(() =>
  Promise.resolve("repos-2026-04-27" as string | null),
);
const isK8sNotFoundError = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  (err as { code?: number }).code === 404;

const pvcExists = mock(() => Promise.resolve(true));
type PvcPodStub = { sandboxId: string | null; phase?: string; deleting?: boolean };
const listPodsUsingPvc = mock((_opts: { namespace: string; pvcName: string }) =>
  Promise.resolve([] as PvcPodStub[]),
);
mock.module("../../clients/k8s", () => ({
  createPvcFromSnapshot,
  deletePvc,
  pvcExists,
  listPodsUsingPvc,
  getLatestVolumeSnapshotName,
  isK8sNotFoundError,
  getSandboxPodStatus: mock(() => Promise.resolve({ exists: true, oomKilled: false })),
  patchSecret: mock(() => Promise.resolve()),
}));

// docker client — the SANDBOX_RUNTIME=docker backend, injected via the
// `docker` option (no mock.module, so nothing leaks into the client's tests).
const createVolumeFromBase = mock((_opts: { name: string; baseVolume: string }) =>
  Promise.resolve(),
);
const removeVolume = mock((_name: string) => Promise.resolve());
const volumeExists = mock((_name: string) => Promise.resolve(true));
const listContainersUsingVolume = mock((_name: string) => Promise.resolve([] as PvcPod[]));
const getSandboxContainerStatus = mock((_sandboxId: string) =>
  Promise.resolve({ exists: true, phase: "Running", oomKilled: false }),
);
const fakeDocker = {
  createVolumeFromBase,
  removeVolume,
  volumeExists,
  listContainersUsingVolume,
  getSandboxContainerStatus,
};

// opensandbox SDK — Sandbox.create is the only path we exercise here.
// SdkSandboxManager.create returns an instance with listSandboxInfos / killSandbox;
// we don't hit those in these tests but the ctor calls .create().
const commandRun = mock(() =>
  Promise.resolve({
    exitCode: 0,
    logs: { stdout: [] as { text: string }[], stderr: [] as { text: string }[] },
    result: [],
  }),
);
const readBytes = mock(() => Promise.resolve(new Uint8Array([1, 2, 3])));
const sandboxCreate = mock(() =>
  Promise.resolve({
    id: "sbx-1",
    close: () => Promise.resolve(),
    kill: () => Promise.resolve(),
    commands: { run: commandRun },
    files: { readBytes, readFile: () => Promise.resolve(""), writeFiles: () => Promise.resolve() },
  }),
);
const sandboxConnect = mock((_opts: { sandboxId: string }) =>
  Promise.resolve({
    id: "sbx-1",
    close: () => Promise.resolve(),
    kill: () => Promise.resolve(),
    commands: { run: commandRun },
    files: { readBytes, readFile: () => Promise.resolve(""), writeFiles: () => Promise.resolve() },
  }),
);
type SandboxInfoStub = {
  id?: string;
  metadata?: Record<string, string>;
  status?: { state: string };
  createdAt?: Date;
  expiresAt?: Date | null;
};
type ListStub = {
  items: SandboxInfoStub[];
  pagination?: { hasNextPage: boolean; totalItems: number };
};
const sdkManagerInstance = {
  listSandboxInfos: mock(
    (_filter?: { metadata?: Record<string, string>; page?: number; pageSize?: number }) =>
      Promise.resolve({ items: [] } as ListStub),
  ),
  killSandbox: mock((_id: string) => Promise.resolve()),
  getSandboxInfo: mock((_id: string) =>
    Promise.resolve({
      status: { state: "Running" },
      expiresAt: null,
      metadata: { task_id: "task-1" },
    } as SandboxInfoStub),
  ),
};

mock.module("@alibaba-group/opensandbox", () => ({
  // Mirror the real ConnectionConfig surface: getBaseUrl()
  // ({proto}://{domain}/v1) and headers. Bun mock.module is process-global — keep
  // this shape complete so sibling suites that touch it don't break.
  ConnectionConfig: class {
    domain: string;
    headers: Record<string, string> = {};
    constructor(opts: { domain: string }) {
      this.domain = opts.domain;
    }
    getBaseUrl(): string {
      return `http://${this.domain}/v1`;
    }
  },
  Sandbox: { create: sandboxCreate, connect: sandboxConnect },
  // Mirror real SDK signature: constructor(opts: { statusCode, message? }).
  // Bun mock.module is process-global; a mismatched signature here leaks
  // into other test files that construct SandboxApiException via the real
  // shape (e.g. taskProcessor.service.test.ts).
  SandboxApiException: class extends Error {
    statusCode: number;
    constructor(opts: { statusCode: number; message?: string } = { statusCode: 500 }) {
      super(opts.message ?? "");
      this.statusCode = opts.statusCode;
    }
  },
  SandboxManager: { create: () => sdkManagerInstance },
}));

const { SandboxManager, K8S_EGRESS_ENV } = await import("../sandboxManager.service");
const { pickForwardedEnv } = await import("../../forwardedEnv");

const baseOpts = {
  domain: "localhost:7000",
  sandboxRuntime: "k8s" as const,
  reposBaseVolume: "devbox-repos",
  baseImage: "devbox-dev:local",
  resourceCpu: "2",
  resourceMemory: "24Gi",
  timeoutSeconds: 1200,
  reposMountPath: "/workspace",
  requestTimeoutSeconds: 300,
  readyTimeoutSeconds: 300,
  reconcileFilesTimeoutMs: 20_000,
  forwardedEnv: {},
  pvcNamespace: "opensandbox",
  pvcStorageClass: "ebs-sc",
  pvcStorageSize: "15Gi",
  snapshotNamePrefix: "repos-",
};

const taskParams = {
  taskId: "task-1",
  externalId: "issue-1",
  source: "linear",
  metadata: {},
};

describe("SandboxManager", () => {
  beforeEach(() => {
    createPvcFromSnapshot.mockReset();
    createPvcFromSnapshot.mockImplementation(() => Promise.resolve());
    deletePvc.mockReset();
    deletePvc.mockImplementation(() => Promise.resolve());
    getLatestVolumeSnapshotName.mockReset();
    getLatestVolumeSnapshotName.mockImplementation(() => Promise.resolve("repos-2026-04-27"));
    sandboxCreate.mockReset();
    sandboxCreate.mockImplementation(() =>
      Promise.resolve({
        id: "sbx-1",
        close: () => Promise.resolve(),
        kill: () => Promise.resolve(),
        commands: { run: commandRun },
        files: {
          readBytes,
          readFile: () => Promise.resolve(""),
          writeFiles: () => Promise.resolve(),
        },
      }),
    );
    commandRun.mockReset();
    commandRun.mockImplementation(() =>
      Promise.resolve({ exitCode: 0, logs: { stdout: [], stderr: [] }, result: [] }),
    );
    readBytes.mockReset();
    readBytes.mockImplementation(() => Promise.resolve(new Uint8Array([1, 2, 3])));
    pvcExists.mockReset();
    pvcExists.mockImplementation(() => Promise.resolve(true));
    createVolumeFromBase.mockReset();
    createVolumeFromBase.mockImplementation(() => Promise.resolve());
    removeVolume.mockReset();
    removeVolume.mockImplementation(() => Promise.resolve());
    volumeExists.mockReset();
    volumeExists.mockImplementation(() => Promise.resolve(true));
    listContainersUsingVolume.mockReset();
    listContainersUsingVolume.mockImplementation(() => Promise.resolve([]));
    getSandboxContainerStatus.mockReset();
    getSandboxContainerStatus.mockImplementation(() =>
      Promise.resolve({ exists: true, phase: "Running", oomKilled: false }),
    );
    listPodsUsingPvc.mockReset();
    listPodsUsingPvc.mockImplementation(() => Promise.resolve([]));
    sdkManagerInstance.getSandboxInfo.mockReset();
    sdkManagerInstance.getSandboxInfo.mockImplementation(() =>
      Promise.resolve({
        status: { state: "Running" },
        expiresAt: null,
        metadata: { task_id: "task-1" },
      }),
    );

    // sdkManagerInstance is reachable through the process-global SDK mock.module;
    // reset here so no suite leaves a rejecting list/kill behind for later files.
    sdkManagerInstance.listSandboxInfos.mockReset();
    sdkManagerInstance.listSandboxInfos.mockImplementation(() => Promise.resolve({ items: [] }));
    sdkManagerInstance.killSandbox.mockReset();
    sdkManagerInstance.killSandbox.mockImplementation(() => Promise.resolve());
  });

  describe("createSandboxWithPvc — snapshot path", () => {
    it("mints a PVC named devbox-pvc-<taskId>-<rand> from the latest snapshot and returns it", async () => {
      const mgr = new SandboxManager(baseOpts);

      const result = await mgr.createSandboxWithPvc(taskParams);

      expect(sandboxCreate).toHaveBeenCalledTimes(1);
      const sandboxCreateCalls = sandboxCreate.mock.calls as unknown as Array<
        [{ resource: { cpu: string; memory: string } }]
      >;
      if (!sandboxCreateCalls[0]) throw new Error("expected sandbox create call");
      expect(sandboxCreateCalls[0][0].resource).toEqual({ cpu: "2", memory: "24Gi" });

      expect(getLatestVolumeSnapshotName).toHaveBeenCalledWith("opensandbox", "repos-");
      expect(createPvcFromSnapshot).toHaveBeenCalledTimes(1);
      const calls = createPvcFromSnapshot.mock.calls as unknown as Array<
        [{ name: string; snapshotName: string }]
      >;
      if (!calls[0]) throw new Error("expected mint call");
      const mintArg = calls[0][0];
      expect(mintArg.name).toMatch(/^devbox-pvc-task-1-[a-z0-9]{6}$/);
      expect(mintArg.snapshotName).toBe("repos-2026-04-27");
      expect(result.pvcName).toBe(mintArg.name);
      expect(result.sandboxId).toBe("sbx-1");
    });

    it("tears down the minted PVC when Sandbox.create throws", async () => {
      const mgr = new SandboxManager(baseOpts);
      sandboxCreate.mockImplementation(() => Promise.reject(new Error("create failed")));

      await expect(mgr.createSandboxWithPvc(taskParams)).rejects.toThrow("create failed");

      expect(createPvcFromSnapshot).toHaveBeenCalledTimes(1);
      expect(deletePvc).toHaveBeenCalledTimes(1);
      const mintCalls = createPvcFromSnapshot.mock.calls as unknown as Array<[{ name: string }]>;
      const deleteCalls = deletePvc.mock.calls as unknown as Array<[{ name: string }]>;
      if (!mintCalls[0] || !deleteCalls[0]) throw new Error("expected mint+delete");
      expect(deleteCalls[0][0].name).toBe(mintCalls[0][0].name);
    });

    it("throws clearly when no eligible snapshot exists", async () => {
      const mgr = new SandboxManager(baseOpts);
      getLatestVolumeSnapshotName.mockImplementation(() => Promise.resolve(null));

      await expect(mgr.createSandboxWithPvc(taskParams)).rejects.toThrow(
        /No readyToUse VolumeSnapshot found/,
      );
      expect(createPvcFromSnapshot).not.toHaveBeenCalled();
      expect(sandboxCreate).not.toHaveBeenCalled();
    });
  });

  describe("createSandboxWithPvc — trusted orgs/users env propagation", () => {
    const envOf = (): Record<string, string> => {
      const calls = sandboxCreate.mock.calls as unknown as Array<[{ env: Record<string, string> }]>;
      if (!calls[0]) throw new Error("expected sandbox create call");
      return calls[0][0].env;
    };

    it("omits both when not configured", async () => {
      await new SandboxManager(baseOpts).createSandboxWithPvc(taskParams);
      expect("HARNESS_TRUSTED_ORGS" in envOf()).toBe(false);
      expect("HARNESS_TRUSTED_USERS" in envOf()).toBe(false);
      expect("HARNESS_TRUSTED_ORG" in envOf()).toBe(false);
    });

    it("takes trust only from the control plane's own settings, never from HARNESS_TRUSTED_*", async () => {
      await new SandboxManager({
        ...baseOpts,
        forwardedEnv: { HARNESS_TRUSTED_USERS: "gollum", HARNESS_TRUSTED_ORGS: "evil" },
        trustedOrgs: "acme",
      }).createSandboxWithPvc(taskParams);
      expect(envOf()).toEqual({
        WORKSPACE: "/workspace",
        ...K8S_EGRESS_ENV,
        HARNESS_TRUSTED_ORGS: "acme",
      });
    });

    it("forwards each one exactly when configured", async () => {
      await new SandboxManager({ ...baseOpts, trustedOrgs: "acme,widgets" }).createSandboxWithPvc(
        taskParams,
      );
      expect(envOf().HARNESS_TRUSTED_ORGS).toBe("acme,widgets");
      expect("HARNESS_TRUSTED_USERS" in envOf()).toBe(false);
    });

    it("forwards trusted users alone", async () => {
      await new SandboxManager({ ...baseOpts, trustedUsers: "frodo,samwise" }).createSandboxWithPvc(
        taskParams,
      );
      expect(envOf().HARNESS_TRUSTED_USERS).toBe("frodo,samwise");
      expect("HARNESS_TRUSTED_ORGS" in envOf()).toBe(false);
    });
  });

  describe("createSandboxWithPvc — runtime and identity env", () => {
    const envOf = (): Record<string, string> => {
      const calls = sandboxCreate.mock.calls as unknown as Array<[{ env: Record<string, string> }]>;
      if (!calls[0]) throw new Error("expected sandbox create call");
      return calls[0][0].env;
    };

    it("routes egress through iron-proxy on k8s", async () => {
      await new SandboxManager(baseOpts).createSandboxWithPvc(taskParams);
      expect(K8S_EGRESS_ENV).toEqual({
        IRON_PROXY_EGRESS: "true",
        NODE_EXTRA_CA_CERTS: "/run/iron-proxy/ca.crt",
        SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
        REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
        CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
      });
      expect(envOf()).toEqual({ WORKSPACE: "/workspace", ...K8S_EGRESS_ENV });
    });

    it("adds nothing on docker, where the local image bakes it in", async () => {
      const dockerOpts = { ...baseOpts, sandboxRuntime: "docker" as const, docker: fakeDocker };
      await new SandboxManager(dockerOpts).createSandboxWithPvc(taskParams);
      expect(envOf()).toEqual({ WORKSPACE: "/workspace" });
    });

    it("sets the commit identity when configured", async () => {
      await new SandboxManager({
        ...baseOpts,
        gitIdentity: { name: "Ada", email: "ada@example.com" },
      }).createSandboxWithPvc(taskParams);
      expect(envOf()).toEqual({
        WORKSPACE: "/workspace",
        ...K8S_EGRESS_ENV,
        GIT_AUTHOR_NAME: "Ada",
        GIT_AUTHOR_EMAIL: "ada@example.com",
        GIT_COMMITTER_NAME: "Ada",
        GIT_COMMITTER_EMAIL: "ada@example.com",
      });
    });
  });

  describe("experimental flag env propagation", () => {
    it("sets HARNESS_EXP flags for fresh sandbox creation", async () => {
      const mgr = new SandboxManager(baseOpts);

      await mgr.createSandboxWithPvc({
        ...taskParams,
        experimentalFlags: ["FAST_PATH", "TRACE2"],
      });

      const calls = sandboxCreate.mock.calls as unknown as Array<[{ env: Record<string, string> }]>;
      if (!calls[0]) throw new Error("expected sandbox create call");
      expect(calls[0][0].env.HARNESS_EXP_FAST_PATH).toBe("true");
      expect(calls[0][0].env.HARNESS_EXP_TRACE2).toBe("true");
    });

    it("lets per-task tokens override a forwarded experimental flag value", async () => {
      const mgr = new SandboxManager({
        ...baseOpts,
        forwardedEnv: { HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING: "false" },
      });

      await mgr.createSandboxWithPvc({
        ...taskParams,
        experimentalFlags: ["DEEPAGENTS_EVENT_STREAMING"],
      });

      const calls = sandboxCreate.mock.calls as unknown as Array<[{ env: Record<string, string> }]>;
      if (!calls[0]) throw new Error("expected sandbox create call");
      expect(calls[0][0].env.HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING).toBe("true");
    });

    it("sets HARNESS_EXP flags when recreating from an existing PVC", async () => {
      const mgr = new SandboxManager(baseOpts);

      await mgr.createSandboxFromExistingPvc({
        taskId: "task-1",
        externalId: "issue-1",
        source: "linear",
        pvcName: "pvc-1",
        experimentalFlags: ["FAST_PATH"],
      });

      const calls = sandboxCreate.mock.calls as unknown as Array<[{ env: Record<string, string> }]>;
      if (!calls[0]) throw new Error("expected sandbox create call");
      expect(calls[0][0].env.HARNESS_EXP_FAST_PATH).toBe("true");
    });

    it("drops experimental flags that would create Service-link-shaped env names", async () => {
      const mgr = new SandboxManager(baseOpts);

      await mgr.createSandboxWithPvc({
        ...taskParams,
        experimentalFlags: ["FAST_PATH", "PORT", "SERVICE_HOST", "PORT_53_UDP"],
      });

      const calls = sandboxCreate.mock.calls as unknown as Array<[{ env: Record<string, string> }]>;
      if (!calls[0]) throw new Error("expected sandbox create call");
      expect(calls[0][0].env.HARNESS_EXP_FAST_PATH).toBe("true");
      expect(calls[0][0].env.HARNESS_EXP_PORT).toBeUndefined();
      expect(calls[0][0].env.HARNESS_EXP_SERVICE_HOST).toBeUndefined();
      expect(calls[0][0].env.HARNESS_EXP_PORT_53_UDP).toBeUndefined();
    });
  });

  describe("HARNESS env propagation", () => {
    it("forwards allowlisted HARNESS settings unchanged", async () => {
      const mgr = new SandboxManager({
        ...baseOpts,
        forwardedEnv: {
          HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING: "true",
          HARNESS_LLM_BASE_URL: "https://llm.example.test/v1",
          HARNESS_LLM_API_KEY: "proxy-llm-dummy-token",
          HARNESS_LLM_PROVIDER: "anthropic",
          HARNESS_PLANNING_REASONING_EFFORT: "xhigh",
        },
      });

      await mgr.createSandboxWithPvc(taskParams);

      const calls = sandboxCreate.mock.calls as unknown as Array<[{ env: Record<string, string> }]>;
      if (!calls[0]) throw new Error("expected sandbox create call");
      expect(calls[0][0].env).toEqual({
        WORKSPACE: "/workspace",
        ...K8S_EGRESS_ENV,
        HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING: "true",
        HARNESS_LLM_BASE_URL: "https://llm.example.test/v1",
        HARNESS_LLM_API_KEY: "proxy-llm-dummy-token",
        HARNESS_LLM_PROVIDER: "anthropic",
        HARNESS_PLANNING_REASONING_EFFORT: "xhigh",
      });
    });

    it("never forwards a real secret or the CLI token", async () => {
      const mgr = new SandboxManager({
        ...baseOpts,
        forwardedEnv: pickForwardedEnv({
          GITHUB_TOKEN: "real",
          LLM_API_KEY: "real",
          DEVBOX_CLI_TOKEN: "x",
          HARNESS_LLM_API_KEY: "proxy-llm-dummy-token",
        }),
      });

      await mgr.createSandboxWithPvc(taskParams);

      const calls = sandboxCreate.mock.calls as unknown as Array<[{ env: Record<string, string> }]>;
      if (!calls[0]) throw new Error("expected sandbox create call");
      expect(calls[0][0].env).toEqual({
        WORKSPACE: "/workspace",
        ...K8S_EGRESS_ENV,
        HARNESS_LLM_API_KEY: "proxy-llm-dummy-token",
      });
    });

    it("sets no LLM settings of its own", async () => {
      const mgr = new SandboxManager(baseOpts);

      await mgr.createSandboxWithPvc(taskParams);

      const calls = sandboxCreate.mock.calls as unknown as Array<[{ env: Record<string, string> }]>;
      if (!calls[0]) throw new Error("expected sandbox create call");
      expect(calls[0][0].env).toEqual({ WORKSPACE: "/workspace", ...K8S_EGRESS_ENV });
    });
  });

  describe("createSandboxWithPvc — inbox env", () => {
    it("passes WORKSPACE and omits task-content + task-identity env vars", async () => {
      const mgr = new SandboxManager(baseOpts);

      await mgr.createSandboxWithPvc({
        ...taskParams,
        taskId: "task-xyz",
        externalId: "uuid-abc-123",
      });

      const calls = sandboxCreate.mock.calls as unknown as Array<
        [{ env: Record<string, string>; metadata: Record<string, string> }]
      >;
      if (!calls[0]) throw new Error("expected sandbox create call");
      const arg = calls[0][0];
      expect(arg.env.WORKSPACE).toBe("/workspace");
      expect(arg.env.DEVBOX_DIR).toBeUndefined();
      // Task identity + content + reply-destination env vars are gone — the
      // daemon reads id/external_id/source/payload from the inbox file instead.
      expect(arg.env.TASK_ID).toBeUndefined();
      expect(arg.env.EXTERNAL_ID).toBeUndefined();
      expect(arg.env.SOURCE).toBeUndefined();
      expect(arg.env.TITLE).toBeUndefined();
      expect(arg.env.DESCRIPTION).toBeUndefined();
      expect(arg.env.EXTERNAL_URL).toBeUndefined();
      expect(arg.env.EXTERNAL_IDENTIFIER).toBeUndefined();
      expect(arg.env.TASK_JSON).toBeUndefined();
      expect(arg.env.AGENT_SESSION_ID).toBeUndefined();
      expect(arg.metadata).toEqual({
        task_id: "task-xyz",
        external_id: "uuid-abc-123",
        source: "linear",
      });
    });
  });

  describe("withFilesTimeout", () => {
    it("isTransientSandboxError treats SandboxFilesTimeoutError as transient", () => {
      expect(
        SandboxManager.isTransientSandboxError(new SandboxFilesTimeoutError("sbx-1", 20_000)),
      ).toBe(true);
    });

    it("readHarnessFile rejects with SandboxFilesTimeoutError when the read hangs past reconcileFilesTimeoutMs", async () => {
      sandboxConnect.mockImplementationOnce(() =>
        Promise.resolve({
          id: "sbx-1",
          close: () => Promise.resolve(),
          kill: () => Promise.resolve(),
          commands: { run: commandRun },
          files: {
            readBytes,
            readFile: () => new Promise<string>(() => {}),
            writeFiles: () => Promise.resolve(),
          },
        }),
      );
      const mgr = new SandboxManager({
        ...baseOpts,
        reconcileFilesTimeoutMs: 5,
      });

      await expect(mgr.readHarnessFile("sbx-1", "events.jsonl")).rejects.toBeInstanceOf(
        SandboxFilesTimeoutError,
      );
    });

    it("writeHarnessFile rejects with SandboxFilesTimeoutError when the write hangs past reconcileFilesTimeoutMs", async () => {
      sandboxConnect.mockImplementationOnce(() =>
        Promise.resolve({
          id: "sbx-1",
          close: () => Promise.resolve(),
          kill: () => Promise.resolve(),
          commands: { run: commandRun },
          files: {
            readBytes,
            readFile: () => Promise.resolve(""),
            writeFiles: () => new Promise<void>(() => {}),
          },
        }),
      );
      const mgr = new SandboxManager({
        ...baseOpts,
        reconcileFilesTimeoutMs: 5,
      });

      await expect(mgr.writeHarnessFile("sbx-1", "session.json", "{}")).rejects.toBeInstanceOf(
        SandboxFilesTimeoutError,
      );
    });
  });

  describe("readEvents", () => {
    const mgrWith = (raw: string | null) => {
      const mgr = new SandboxManager(baseOpts);
      (mgr as unknown as { readHarnessFile: () => Promise<string | null> }).readHarnessFile = () =>
        Promise.resolve(raw);
      return mgr;
    };

    it("returns [] when the events file is empty / missing", async () => {
      expect(await mgrWith(null).readEvents("sbx", 0)).toEqual([]);
      expect(await mgrWith("").readEvents("sbx", 0)).toEqual([]);
    });

    it("returns events with seq > sinceSeq in file order", async () => {
      // Daemon serializes seq assignment + append under the events.lock
      // flock, so file order is seq order — readEvents trusts that and
      // returns lines as encountered.
      const raw = [
        JSON.stringify({
          seq: 1,
          ts: "t",
          type: "agent_action",
          inbox_id: "i",
          target_id: "tgt",
          body: "Planning",
        }),
        JSON.stringify({
          seq: 2,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "plan",
        }),
        JSON.stringify({
          seq: 3,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "x",
        }),
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 1);
      expect(events.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("drops a torn trailing line", async () => {
      const raw = [
        JSON.stringify({
          seq: 1,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "ok",
        }),
        '{"seq":3,"type":"agent_th', // torn
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 0);
      expect(events.map((e) => e.seq)).toEqual([1]);
    });

    it("treats a torn trailing line as expected even with trailing blank lines", async () => {
      const raw = [
        JSON.stringify({
          seq: 1,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "ok",
        }),
        '{"seq":2,"type":"agent_th', // torn — last non-blank line
        "",
        "",
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 0);
      expect(events.map((e) => e.seq)).toEqual([1]);
    });

    it("parses around an unparseable non-trailing line (true gap) and keeps the rest", async () => {
      const raw = [
        JSON.stringify({
          seq: 1,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "a",
        }),
        "{not json at all}", // mid-file gap — a real lost event
        JSON.stringify({
          seq: 3,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "c",
        }),
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 0);
      // Seq 1 and 3 still parsed; the gap line is skipped (and warned).
      expect(events.map((e) => e.seq)).toEqual([1, 3]);
    });

    it("drops the unknown `status` value from a completed event (kept forensic-only)", async () => {
      // A bad `status` should not invalidate the event — `status` is forensic
      // only. Validator strips an unknown value and keeps the rest.
      const raw = [
        JSON.stringify({
          seq: 1,
          ts: "t",
          type: "completed",
          inbox_id: "i",
          status: "bogus",
        }),
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 0);
      expect(events).toHaveLength(1);
      const ev = events[0];
      if (ev?.type === "completed") {
        expect(ev).not.toHaveProperty("status");
      } else {
        throw new Error("expected a completed event");
      }
    });

    it("accepts a well-formed completed marker (status optional)", async () => {
      // completed is a bare terminal marker. Assignment rounds carry status;
      // comment/review rounds omit it. Both forms are accepted.
      const raw = [
        JSON.stringify({
          seq: 1,
          ts: "t",
          type: "completed",
          inbox_id: "i",
          status: "completed",
        }),
        JSON.stringify({ seq: 2, ts: "t", type: "completed", inbox_id: "i" }),
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 0);
      expect(events).toHaveLength(2);
      const [withStatus, noStatus] = events;
      if (withStatus?.type === "completed") {
        expect(withStatus.status).toBe("completed");
      } else {
        throw new Error("expected a completed event");
      }
      if (noStatus?.type === "completed") {
        expect(noStatus).not.toHaveProperty("status");
      } else {
        throw new Error("expected a completed event");
      }
    });

    it("drops events with a non-numeric seq or unknown type", async () => {
      const raw = [
        JSON.stringify({
          seq: "1",
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "x",
        }),
        JSON.stringify({ seq: 2, ts: "t", type: "bogus_event", inbox_id: "i" }),
        JSON.stringify({
          seq: 3,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "ok",
        }),
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 0);
      expect(events.map((e) => e.seq)).toEqual([3]);
    });

    it("drops a pr_opened whose pr_url is not a github.com https URL", async () => {
      const raw = [
        JSON.stringify({
          seq: 1,
          ts: "t",
          type: "pr_opened",
          inbox_id: "i",
          repo: "r",
          pr_url: "javascript:alert(1)", // malformed — not https github.com
          branch: "b",
          commit_sha: "sha",
        }),
        JSON.stringify({
          seq: 2,
          ts: "t",
          type: "pr_opened",
          inbox_id: "i",
          repo: "r",
          pr_url: "https://github.com/o/r/pull/2", // valid
          branch: "b",
          commit_sha: "sha",
        }),
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 0);
      expect(events.map((e) => e.seq)).toEqual([2]);
    });

    it("drops an event with a fractional or negative seq", async () => {
      const raw = [
        JSON.stringify({
          seq: 1.5,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "frac",
        }),
        JSON.stringify({
          seq: -3,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "neg",
        }),
        JSON.stringify({
          seq: 4,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: "ok",
        }),
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 0);
      expect(events.map((e) => e.seq)).toEqual([4]);
    });

    it("length-caps a sandbox-supplied agent_error body", async () => {
      const huge = "x".repeat(5000);
      const raw = JSON.stringify({
        seq: 1,
        ts: "t",
        type: "agent_error",
        inbox_id: "i",
        target_id: "tgt",
        body: huge,
      });
      const events = await mgrWith(raw).readEvents("sbx", 0);
      expect(events).toHaveLength(1);
      const err = events[0] as Extract<HarnessEvent, { type: "agent_error" }>;
      // The body is capped to 2000 chars + an ellipsis (far short of raw 5000).
      expect(err.body.length).toBeLessThanOrEqual(2001);
    });

    it("drops the harness's retryable_assignment_failure flag from an agent_error", async () => {
      // characterization: changes in phase 1a (spec §4: validateHarnessEvent copies it when === true)
      const raw = JSON.stringify({
        seq: 1,
        ts: "t",
        type: "agent_error",
        inbox_id: "i",
        target_id: "tgt",
        body: "RuntimeError: boom",
        retryable_assignment_failure: true,
      });
      expect(await mgrWith(raw).readEvents("sbx", 0)).toEqual([
        {
          seq: 1,
          ts: "t",
          type: "agent_error",
          inbox_id: "i",
          target_id: "tgt",
          body: "RuntimeError: boom",
        },
      ]);
    });

    it("agent_thought/action/response use the wider 60k cap (plan markdown + completion summaries can run long)", async () => {
      const huge = "y".repeat(5000);
      const raw = [
        JSON.stringify({
          seq: 1,
          ts: "t",
          type: "agent_thought",
          inbox_id: "i",
          target_id: "tgt",
          body: huge,
        }),
        JSON.stringify({
          seq: 2,
          ts: "t",
          type: "agent_action",
          inbox_id: "i",
          target_id: "tgt",
          body: huge,
        }),
      ].join("\n");
      const events = await mgrWith(raw).readEvents("sbx", 0);
      expect(events).toHaveLength(2);
      const thought = events[0] as Extract<HarnessEvent, { type: "agent_thought" }>;
      const action = events[1] as Extract<HarnessEvent, { type: "agent_action" }>;
      // 5000 chars is under the 60000 cap → body passes through unchanged.
      expect(thought.body.length).toBe(5000);
      expect(action.body.length).toBe(5000);
    });

    it("agent_thought is truncated past the 60k cap", async () => {
      const huge = "y".repeat(60001);
      const raw = JSON.stringify({
        seq: 1,
        ts: "t",
        type: "agent_thought",
        inbox_id: "i",
        target_id: "tgt",
        body: huge,
      });
      const events = await mgrWith(raw).readEvents("sbx", 0);
      const thought = events[0] as Extract<HarnessEvent, { type: "agent_thought" }>;
      // 60000 chars + ellipsis.
      expect(thought.body.length).toBe(60001);
      expect(thought.body.endsWith("…")).toBe(true);
    });
  });

  describe("createSandboxFromExistingPvc — adopts the sandbox already on the PVC", () => {
    const recreateParams = {
      taskId: "task-1",
      externalId: "issue-1",
      source: "linear",
      pvcName: "pvc-1",
    };
    const pod = (sandboxId: string | null, phase = "Running", deleting = false): PvcPodStub => ({
      sandboxId,
      phase,
      deleting,
    });
    const podsOf =
      (...pods: PvcPodStub[]) =>
      () =>
        Promise.resolve(pods);
    const infoOf = (taskId: string, state = "Running", expiresAt: Date | null = null) => ({
      status: { state },
      expiresAt,
      metadata: { task_id: taskId },
    });

    it("returns the sandbox whose pod mounts the PVC and creates nothing", async () => {
      const mgr = new SandboxManager(baseOpts);
      listPodsUsingPvc.mockImplementation(podsOf(pod("leftover")));

      const id = await mgr.createSandboxFromExistingPvc(recreateParams);

      expect(id).toBe("leftover");
      expect(listPodsUsingPvc).toHaveBeenCalledWith({ namespace: "opensandbox", pvcName: "pvc-1" });
      expect(sdkManagerInstance.getSandboxInfo).toHaveBeenCalledWith("leftover");
      expect(sandboxCreate).not.toHaveBeenCalled();
      expect(sdkManagerInstance.killSandbox).not.toHaveBeenCalled();
    });

    it("takes the first non-terminal pod, a Pending one included", async () => {
      const mgr = new SandboxManager(baseOpts);
      listPodsUsingPvc.mockImplementation(
        podsOf(pod("dead", "Failed"), pod("pending", "Pending"), pod("later", "Running")),
      );

      await expect(mgr.findSandboxOnPvc("pvc-1", "task-1")).resolves.toBe("pending");
    });

    it("never adopts a sandbox tagged with another task, even on this PVC", async () => {
      const mgr = new SandboxManager(baseOpts);
      listPodsUsingPvc.mockImplementation(podsOf(pod("theirs")));
      sdkManagerInstance.getSandboxInfo.mockImplementation(() => Promise.resolve(infoOf("task-2")));

      const id = await mgr.createSandboxFromExistingPvc(recreateParams);

      expect(id).toBe("sbx-1");
      expect(sandboxCreate).toHaveBeenCalledTimes(1);
    });

    it("does not adopt when the lifecycle API no longer knows the pod's sandbox", async () => {
      const mgr = new SandboxManager(baseOpts);
      const { SandboxApiException } = await import("@alibaba-group/opensandbox");
      listPodsUsingPvc.mockImplementation(podsOf(pod("gone")));
      sdkManagerInstance.getSandboxInfo.mockImplementation(() =>
        Promise.reject(new SandboxApiException({ statusCode: 404 })),
      );

      await expect(mgr.findSandboxOnPvc("pvc-1", "task-1")).resolves.toBeNull();
    });

    it("does not adopt a sandbox the lifecycle API reports expired or crashed", async () => {
      const mgr = new SandboxManager(baseOpts);
      listPodsUsingPvc.mockImplementation(podsOf(pod("expired")));
      sdkManagerInstance.getSandboxInfo.mockImplementation(() =>
        Promise.resolve(infoOf("task-1", "Running", new Date(0))),
      );
      await expect(mgr.findSandboxOnPvc("pvc-1", "task-1")).resolves.toBeNull();

      sdkManagerInstance.getSandboxInfo.mockImplementation(() =>
        Promise.resolve(infoOf("task-1", "Error")),
      );
      await expect(mgr.findSandboxOnPvc("pvc-1", "task-1")).resolves.toBeNull();
    });

    it("ignores terminating, terminal or unlabeled pods on the PVC and creates", async () => {
      const mgr = new SandboxManager(baseOpts);
      listPodsUsingPvc.mockImplementation(
        podsOf(
          pod("going", "Running", true),
          pod("crashed", "Failed"),
          pod("done", "Succeeded"),
          pod(null, "Running"),
        ),
      );

      const id = await mgr.createSandboxFromExistingPvc(recreateParams);

      expect(id).toBe("sbx-1");
      expect(sandboxCreate).toHaveBeenCalledTimes(1);
    });

    it("creates directly when no pod mounts the PVC", async () => {
      const mgr = new SandboxManager(baseOpts);

      await mgr.createSandboxFromExistingPvc(recreateParams);

      expect(sandboxCreate).toHaveBeenCalledTimes(1);
      expect(sdkManagerInstance.killSandbox).not.toHaveBeenCalled();
    });

    it("wraps a failed pod lookup as SandboxCreateError without creating", async () => {
      const mgr = new SandboxManager(baseOpts);
      listPodsUsingPvc.mockImplementation(() => Promise.reject(new Error("pods is forbidden")));

      const err = await mgr.createSandboxFromExistingPvc(recreateParams).catch((e) => e);

      expect(err).toBeInstanceOf(SandboxCreateError);
      expect(err.message).toContain("pods is forbidden");
      expect(sandboxCreate).not.toHaveBeenCalled();
    });

    it("wraps a failed PVC probe as SandboxCreateError, keeping NotFound distinct", async () => {
      const mgr = new SandboxManager(baseOpts);
      pvcExists.mockImplementation(() => Promise.reject(new Error("api server unreachable")));

      const err = await mgr.createSandboxFromExistingPvc(recreateParams).catch((e) => e);

      expect(err).toBeInstanceOf(SandboxCreateError);
      expect(err.message).toContain("api server unreachable");
      expect(listPodsUsingPvc).not.toHaveBeenCalled();
    });

    it("wraps a Sandbox.create failure as SandboxCreateError with the cause attached", async () => {
      const mgr = new SandboxManager(baseOpts);
      const cause = new Error("The operation timed out.");
      cause.name = "TimeoutError";
      sandboxCreate.mockImplementation(() => Promise.reject(cause));

      const err = await mgr.createSandboxFromExistingPvc(recreateParams).catch((e) => e);

      expect(err).toBeInstanceOf(SandboxCreateError);
      expect(err.cause).toBe(cause);
      expect(err.message).toContain("The operation timed out.");
    });

    it("reports a pruned PVC before looking for pods", async () => {
      const mgr = new SandboxManager(baseOpts);
      pvcExists.mockImplementation(() => Promise.resolve(false));

      await expect(mgr.createSandboxFromExistingPvc(recreateParams)).rejects.toBeInstanceOf(
        PvcNotFoundError,
      );
      expect(listPodsUsingPvc).not.toHaveBeenCalled();
      expect(sandboxCreate).not.toHaveBeenCalled();
    });
  });

  describe("closeSandbox / killSandbox — PVC preservation", () => {
    it("closeSandbox does NOT delete the PVC", async () => {
      const mgr = new SandboxManager(baseOpts);
      await mgr.createSandboxWithPvc(taskParams);

      await mgr.closeSandbox("sbx-1");

      expect(deletePvc).not.toHaveBeenCalled();
    });

    it("killSandbox does NOT delete the PVC", async () => {
      const mgr = new SandboxManager(baseOpts);
      await mgr.createSandboxWithPvc(taskParams);

      await mgr.killSandbox("sbx-1");

      expect(deletePvc).not.toHaveBeenCalled();
    });

    it("closeSandboxAndDeletePvc tears down the minted PVC", async () => {
      const mgr = new SandboxManager(baseOpts);
      const handleKill = mock(() => Promise.resolve());
      sandboxCreate.mockImplementation(() =>
        Promise.resolve({
          id: "sbx-1",
          close: () => Promise.resolve(),
          kill: handleKill,
          commands: { run: commandRun },
          files: {
            readBytes,
            readFile: () => Promise.resolve(""),
            writeFiles: () => Promise.resolve(),
          },
        }),
      );
      const result = await mgr.createSandboxWithPvc(taskParams);

      await mgr.closeSandboxAndDeletePvc(result.sandboxId, result.pvcName);

      expect(deletePvc).toHaveBeenCalledTimes(1);
      const calls = deletePvc.mock.calls as unknown as Array<[{ name: string }]>;
      expect(calls[0]?.[0].name).toBe(result.pvcName);
      // k8s defers the delete itself; the orphan is closed, never killed.
      expect(sdkManagerInstance.killSandbox).not.toHaveBeenCalled();
      expect(handleKill).not.toHaveBeenCalled();
    });
  });

  describe("docker runtime", () => {
    const dockerOpts = { ...baseOpts, sandboxRuntime: "docker" as const, docker: fakeDocker };

    it("mints a per-task volume copied from the base volume, never touching k8s", async () => {
      const mgr = new SandboxManager(dockerOpts);

      const result = await mgr.createSandboxWithPvc(taskParams);

      expect(createVolumeFromBase).toHaveBeenCalledTimes(1);
      const arg = createVolumeFromBase.mock.calls[0]?.[0];
      expect(arg?.name).toMatch(/^devbox-pvc-task-1-[a-z0-9]{6}$/);
      expect(arg?.baseVolume).toBe("devbox-repos");
      expect(result.pvcName).toBe(arg?.name as string);
      const calls = sandboxCreate.mock.calls as unknown as Array<
        [{ volumes: Array<{ pvc: { claimName: string } }> }]
      >;
      expect(calls[0]?.[0].volumes[0]?.pvc.claimName).toBe(result.pvcName);
      expect(getLatestVolumeSnapshotName).not.toHaveBeenCalled();
      expect(createPvcFromSnapshot).not.toHaveBeenCalled();
    });

    it("removes the minted volume when Sandbox.create throws", async () => {
      const mgr = new SandboxManager(dockerOpts);
      sandboxCreate.mockImplementation(() => Promise.reject(new Error("create failed")));

      await expect(mgr.createSandboxWithPvc(taskParams)).rejects.toThrow("create failed");

      expect(removeVolume).toHaveBeenCalledTimes(1);
      expect(removeVolume.mock.calls[0]?.[0]).toBe(createVolumeFromBase.mock.calls[0]?.[0].name);
      expect(deletePvc).not.toHaveBeenCalled();
    });

    it("does not create a sandbox when the copy fails", async () => {
      const mgr = new SandboxManager(dockerOpts);
      createVolumeFromBase.mockImplementation(() =>
        Promise.reject(new Error("Base volume devbox-repos not found")),
      );

      await expect(mgr.createSandboxWithPvc(taskParams)).rejects.toThrow(/Base volume/);
      expect(sandboxCreate).not.toHaveBeenCalled();
    });

    it("closeSandboxAndDeletePvc kills the sandbox on the volume, then removes it", async () => {
      const mgr = new SandboxManager(dockerOpts);
      const order: string[] = [];
      listContainersUsingVolume.mockImplementation(() =>
        Promise.resolve([{ sandboxId: "sbx-1", phase: "Running", deleting: false }]),
      );
      sdkManagerInstance.killSandbox.mockImplementation(() => {
        order.push("kill");
        return Promise.resolve();
      });
      removeVolume.mockImplementation(() => {
        order.push("rm");
        return Promise.resolve();
      });

      await mgr.closeSandboxAndDeletePvc("sbx-1", "devbox-pvc-task-1-abc123");

      expect(listContainersUsingVolume).toHaveBeenCalledWith("devbox-pvc-task-1-abc123");
      expect(sdkManagerInstance.killSandbox).toHaveBeenCalledWith("sbx-1");
      expect(order).toEqual(["kill", "rm"]);
      expect(deletePvc).not.toHaveBeenCalled();
    });

    it("kills a container the server made before Sandbox.create threw, then removes the volume", async () => {
      const mgr = new SandboxManager(dockerOpts);
      sandboxCreate.mockImplementation(() => Promise.reject(new Error("client timeout")));
      listContainersUsingVolume.mockImplementation(() =>
        Promise.resolve([
          { sandboxId: "sbx-late", phase: "Pending", deleting: false },
          { sandboxId: null, phase: "Running", deleting: false },
        ]),
      );

      await expect(mgr.createSandboxWithPvc(taskParams)).rejects.toThrow("client timeout");

      expect(sdkManagerInstance.killSandbox).toHaveBeenCalledTimes(1);
      expect(sdkManagerInstance.killSandbox).toHaveBeenCalledWith("sbx-late");
      expect(removeVolume).toHaveBeenCalledTimes(1);
    });

    it("still removes the volume when a kill fails, then surfaces the kill error", async () => {
      const mgr = new SandboxManager(dockerOpts);
      listContainersUsingVolume.mockImplementation(() =>
        Promise.resolve([{ sandboxId: "sbx-1", phase: "Running", deleting: false }]),
      );
      sdkManagerInstance.killSandbox.mockImplementation(() =>
        Promise.reject(new Error("kill timeout")),
      );

      await expect(
        mgr.closeSandboxAndDeletePvc("sbx-1", "devbox-pvc-task-1-abc123"),
      ).rejects.toThrow("kill timeout");
      expect(removeVolume).toHaveBeenCalledWith("devbox-pvc-task-1-abc123");
    });

    it("resume probes the docker volume and throws PvcNotFoundError when it is gone", async () => {
      const mgr = new SandboxManager(dockerOpts);
      volumeExists.mockImplementation(() => Promise.resolve(false));

      await expect(
        mgr.createSandboxFromExistingPvc({
          taskId: "task-1",
          externalId: "issue-1",
          source: "linear",
          pvcName: "devbox-pvc-task-1-abc123",
        }),
      ).rejects.toBeInstanceOf(PvcNotFoundError);
      expect(pvcExists).not.toHaveBeenCalled();
      expect(sandboxCreate).not.toHaveBeenCalled();
    });

    it("resume adopts the live sandbox container on the volume", async () => {
      const mgr = new SandboxManager(dockerOpts);
      listContainersUsingVolume.mockImplementation(() =>
        Promise.resolve([{ sandboxId: "sbx-live", phase: "Running", deleting: false }]),
      );

      const id = await mgr.createSandboxFromExistingPvc({
        taskId: "task-1",
        externalId: "issue-1",
        source: "linear",
        pvcName: "devbox-pvc-task-1-abc123",
      });

      expect(id).toBe("sbx-live");
      expect(listContainersUsingVolume).toHaveBeenCalledWith("devbox-pvc-task-1-abc123");
      expect(listPodsUsingPvc).not.toHaveBeenCalled();
      expect(sandboxCreate).not.toHaveBeenCalled();
    });

    it("reads sandbox status from the docker container", async () => {
      const mgr = new SandboxManager(dockerOpts);
      getSandboxContainerStatus.mockImplementation(() =>
        Promise.resolve({ exists: true, phase: "Failed", oomKilled: true }),
      );

      const status = await mgr.getSandboxPodStatus("sbx-1");

      expect(getSandboxContainerStatus).toHaveBeenCalledWith("sbx-1");
      expect(status).toEqual({ exists: true, phase: "Failed", oomKilled: true });
    });

    it("treats a docker status error as unknown (null)", async () => {
      const mgr = new SandboxManager(dockerOpts);
      getSandboxContainerStatus.mockImplementation(() => Promise.reject(new Error("daemon down")));

      expect(await mgr.getSandboxPodStatus("sbx-1")).toBeNull();
    });
  });

  describe("extractArchive", () => {
    it("runs harness archive and returns archive bytes unchanged", async () => {
      const mgr = new SandboxManager(baseOpts);
      await mgr.createSandboxWithPvc(taskParams);

      const archive = await mgr.extractArchive("sbx-1");

      expect(archive).toEqual(new Uint8Array([1, 2, 3]));
      const runCalls = commandRun.mock.calls as unknown as Array<[string]>;
      expect(runCalls[0]?.[0]).toMatch(
        /^harness archive --out \/tmp\/archive-[0-9a-f-]+\.tar\.gz --override$/,
      );
      const archivePath = (readBytes.mock.calls[0] as [string] | undefined)?.[0];
      expect(archivePath).toMatch(/^\/tmp\/archive-[0-9a-f-]+\.tar\.gz$/);
    });

    it("returns null when harness archive exits non-zero", async () => {
      const mgr = new SandboxManager(baseOpts);
      await mgr.createSandboxWithPvc(taskParams);
      commandRun.mockImplementationOnce(() =>
        Promise.resolve({ exitCode: 1, logs: { stdout: [], stderr: [] }, result: [] }),
      );

      const archive = await mgr.extractArchive("sbx-1");

      expect(archive).toBeNull();
      expect(readBytes).not.toHaveBeenCalled();
    });

    it("returns null when archive file is missing after harness succeeds", async () => {
      const mgr = new SandboxManager(baseOpts);
      await mgr.createSandboxWithPvc(taskParams);
      readBytes.mockImplementationOnce(() => Promise.reject(new Error("file not found")));

      const archive = await mgr.extractArchive("sbx-1");

      expect(archive).toBeNull();
    });
  });
});
