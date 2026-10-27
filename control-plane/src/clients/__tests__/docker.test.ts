import { describe, expect, it } from "bun:test";

// Nothing mock.module's ../docker (SandboxManager tests inject a fake), so
// this always gets the real implementation regardless of file order.
const {
  createVolumeFromBase,
  isDockerNotFoundError,
  parseContainerStatus,
  parseContainersUsingVolume,
  removeVolume,
} = await import("../docker");

function cliError(stderr: string): Error {
  return Object.assign(new Error(`docker exited 1: ${stderr}`), { stderr });
}

describe("parseContainersUsingVolume", () => {
  it("maps sandbox id label + state to PvcPod rows", () => {
    const out = "sbx-1\trunning\nsbx-2\texited\nsbx-3\tremoving\n\tcreated\n";

    expect(parseContainersUsingVolume(out)).toEqual([
      { sandboxId: "sbx-1", phase: "Running", deleting: false },
      { sandboxId: "sbx-2", phase: "Failed", deleting: false },
      { sandboxId: "sbx-3", phase: "Unknown", deleting: true },
      // Unlabelled container (e.g. the copy helper) → no sandbox id.
      { sandboxId: null, phase: "Pending", deleting: false },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseContainersUsingVolume("")).toEqual([]);
    expect(parseContainersUsingVolume("\n")).toEqual([]);
  });
});

describe("parseContainerStatus", () => {
  const inspect = (State: Record<string, unknown>) => JSON.stringify([{ State }]);

  it("running container: no terminal details", () => {
    expect(parseContainerStatus(inspect({ Status: "running", ExitCode: 0 }))).toEqual({
      exists: true,
      phase: "Running",
      terminatedReason: undefined,
      exitCode: undefined,
      oomKilled: false,
    });
  });

  it("exited 0 → Succeeded", () => {
    const s = parseContainerStatus(inspect({ Status: "exited", ExitCode: 0 }));
    expect(s.phase).toBe("Succeeded");
    expect(s.exitCode).toBe(0);
  });

  it("exited non-zero → Failed with the docker error as reason", () => {
    const s = parseContainerStatus(
      inspect({ Status: "exited", ExitCode: 1, Error: "bootstrap failed" }),
    );
    expect(s).toMatchObject({
      phase: "Failed",
      exitCode: 1,
      terminatedReason: "bootstrap failed",
      oomKilled: false,
    });
  });

  it("OOMKilled flag or a terminal 137 exit → oomKilled", () => {
    expect(
      parseContainerStatus(inspect({ Status: "exited", ExitCode: 137, OOMKilled: true })),
    ).toMatchObject({ phase: "Failed", terminatedReason: "OOMKilled", oomKilled: true });
    expect(parseContainerStatus(inspect({ Status: "exited", ExitCode: 137 })).oomKilled).toBe(true);
  });

  it("created → Pending", () => {
    expect(parseContainerStatus(inspect({ Status: "created", ExitCode: 0 })).phase).toBe("Pending");
  });

  it("empty inspect array → absent", () => {
    expect(parseContainerStatus("[]")).toEqual({ exists: false, oomKilled: false });
  });
});

describe("task volume name guard", () => {
  // Rejected before any docker call, so these never touch the daemon.
  it("refuses to remove or create a volume that is not a minted task volume", async () => {
    for (const name of ["devbox-repos", "devbox_postgres_data", "-f", ""]) {
      await expect(removeVolume(name)).rejects.toThrow(/Refusing non-task volume name/);
      await expect(createVolumeFromBase({ name, baseVolume: "devbox-repos" })).rejects.toThrow(
        /Refusing non-task volume name/,
      );
    }
  });
});

describe("isDockerNotFoundError", () => {
  it("matches docker's missing volume/container wording", () => {
    expect(isDockerNotFoundError(cliError("Error response from daemon: no such volume"))).toBe(
      true,
    );
    expect(isDockerNotFoundError(cliError("Error: No such container: abc"))).toBe(true);
    expect(isDockerNotFoundError(cliError("Error: No such object: abc"))).toBe(true);
  });

  it("does not match other failures", () => {
    expect(
      isDockerNotFoundError(cliError("Error response from daemon: remove x: volume is in use")),
    ).toBe(false);
    expect(isDockerNotFoundError(new Error("boom"))).toBe(false);
    expect(isDockerNotFoundError("no such volume")).toBe(false);
  });
});
