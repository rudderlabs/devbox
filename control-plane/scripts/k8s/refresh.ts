// `k8s:refresh-snapshot` starts a Job from the snapshot builder's CronJob and
// polls until it succeeds or uses up its attempts.
import { type Kube, KubeError, REPO_SNAPSHOTS, SANDBOX_NAMESPACE } from "./run";

const POLL_MS = 5000;
const LIMIT_MS = 30 * 60_000;
// The CronJob's backoffLimit is 2: three attempts.
const ATTEMPTS = 3;

export const stamp = (d: Date) => d.toISOString().replace(/[-:T]|\.\d+Z$/g, "");

export async function refreshSnapshot(
  k: Kube,
  deps: { sleep: (ms: number) => Promise<void>; log: (line: string) => void; now: () => Date },
): Promise<string> {
  const job = `devbox-snapshot-builder-manual-${stamp(deps.now())}`;
  await k.kubectlOk([
    "create",
    "job",
    job,
    "--from=cronjob/devbox-snapshot-builder",
    "-n",
    SANDBOX_NAMESPACE,
  ]);
  deps.log(`running ${job}`);
  for (let waited = 0; ; waited += POLL_MS) {
    const status = await k.kubectlOk([
      "get",
      "job",
      job,
      "-n",
      SANDBOX_NAMESPACE,
      "-o",
      "jsonpath={.status.succeeded}/{.status.failed}",
    ]);
    const [succeeded = 0, failed = 0] = status
      .trim()
      .split("/")
      .map((n) => Number(n || 0));
    if (succeeded > 0) break;
    if (failed >= ATTEMPTS) {
      const logs = await k.kubectl(["logs", `job/${job}`, "-n", SANDBOX_NAMESPACE, "--tail=50"]);
      throw new KubeError(
        `the snapshot builder failed:\n${logs.stdout.trim() || logs.stderr.trim()}`,
      );
    }
    if (waited >= LIMIT_MS) {
      throw new KubeError("the snapshot builder did not finish within 30 minutes");
    }
    await deps.sleep(POLL_MS);
  }
  const name = (
    await k.kubectlOk([
      "get",
      "volumesnapshot",
      "-n",
      SANDBOX_NAMESPACE,
      "-l",
      REPO_SNAPSHOTS,
      "--sort-by=.metadata.creationTimestamp",
      "-o",
      "jsonpath={.items[-1:].metadata.name}",
    ])
  ).trim();
  deps.log(`snapshot ${name} is ready`);
  return name;
}
