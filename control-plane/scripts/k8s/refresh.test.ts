import { describe, expect, it } from "bun:test";
import { fakeRunner, type Step } from "./fakeRunner";
import { refreshSnapshot } from "./refresh";
import { KubeError, kube, type RunResult } from "./run";

const kc = (...args: string[]) => ["kubectl", "--context", "kind-devbox", ...args];
const step = (cmd: string[], result?: Partial<RunResult>): Step => ({ cmd, result });
const JOB = "devbox-snapshot-builder-manual-20261014120000";
const CREATE = kc(
  "create",
  "job",
  JOB,
  "--from=cronjob/devbox-snapshot-builder",
  "-n",
  "devbox-sandboxes",
);
const STATUS = kc(
  "get",
  "job",
  JOB,
  "-n",
  "devbox-sandboxes",
  "-o",
  "jsonpath={.status.succeeded}/{.status.failed}",
);
const NEWEST = kc(
  "get",
  "volumesnapshot",
  "-n",
  "devbox-sandboxes",
  "-l",
  "app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder",
  "--sort-by=.metadata.creationTimestamp",
  "-o",
  "jsonpath={.items[-1:].metadata.name}",
);

function run(script: Step[]) {
  const f = fakeRunner(script);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const result = refreshSnapshot(kube(f.runner, "kind-devbox"), {
    sleep: async (ms) => void sleeps.push(ms),
    log: (line) => void logs.push(line),
    now: () => new Date("2026-10-14T12:00:00Z"),
  });
  return { f, sleeps, logs, result };
}

describe("refreshSnapshot", () => {
  it("runs the builder, waits for it and returns the newest snapshot", async () => {
    const script = [
      step(CREATE),
      step(STATUS, { stdout: "/" }),
      step(STATUS, { stdout: "1/" }),
      step(NEWEST, { stdout: "repos-20261014120130\n" }),
    ];
    const r = run(script);
    expect(await r.result).toBe("repos-20261014120130");
    r.f.done();
    expect(r.f.calls.map((c) => c.cmd.join(" "))).toEqual(script.map((s) => s.cmd.join(" ")));
    expect(r.sleeps).toEqual([5000]);
    expect(r.logs).toEqual([`running ${JOB}`, "snapshot repos-20261014120130 is ready"]);
  });

  it("shows the builder's logs when it fails", async () => {
    const LOGS = kc("logs", `job/${JOB}`, "-n", "devbox-sandboxes", "--tail=50");
    const script = [
      step(CREATE),
      step(STATUS, { stdout: "/3" }),
      step(LOGS, { stdout: "fatal: repository not found\n" }),
    ];
    const r = run(script);
    await expect(r.result).rejects.toThrow(
      new KubeError("the snapshot builder failed:\nfatal: repository not found"),
    );
    r.f.done();
    expect(r.f.calls.map((c) => c.cmd.join(" "))).toEqual(script.map((s) => s.cmd.join(" ")));
  });

  it("gives up after 30 minutes", async () => {
    // One poll at 0 s and one after each 5 s sleep, up to 30 minutes.
    const polls = 30 * 12 + 1;
    const script = [
      step(CREATE),
      ...Array.from({ length: polls }, () => step(STATUS, { stdout: "/" })),
    ];
    const r = run(script);
    await expect(r.result).rejects.toThrow(
      new KubeError("the snapshot builder did not finish within 30 minutes"),
    );
    r.f.done();
    expect(r.sleeps).toEqual(Array.from({ length: polls - 1 }, () => 5000));
  });
});
