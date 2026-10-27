import { describe, expect, it } from "bun:test";
import { fakeRunner } from "./fakeRunner";
import { KubeError, kube } from "./run";

describe("kube", () => {
  it("names the context on every call", async () => {
    const f = fakeRunner([
      { cmd: ["kubectl", "--context", "c", "get", "ns"], result: { stdout: "ok" } },
      { cmd: ["helm", "--kube-context", "c", "list"], result: { stdout: "fine" } },
    ]);
    const k = kube(f.runner, "c");
    expect(await k.kubectlOk(["get", "ns"])).toBe("ok");
    expect(await k.helmOk(["list"])).toBe("fine");
    f.done();
  });

  it("throws the stderr when kubectlOk fails", async () => {
    const f = fakeRunner([
      {
        cmd: ["kubectl", "--context", "c", "get", "pods", "-n", "x"],
        result: { code: 1, stderr: "boom\n" },
      },
    ]);
    await expect(kube(f.runner, "c").kubectlOk(["get", "pods", "-n", "x"])).rejects.toThrow(
      new KubeError("kubectl get pods -n failed: boom"),
    );
  });
});
