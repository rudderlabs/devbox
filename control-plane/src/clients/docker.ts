// Docker-volume counterparts of the k8s PVC helpers in ./k8s, for the local
// stack (SANDBOX_RUNTIME=docker). OpenSandbox's docker runtime maps a sandbox's
// `pvc.claimName` to a Docker named volume, so a per-task "PVC" here is a named
// volume copied from a base volume built by scripts/build-repos-volume.sh.
// Shells out to the docker CLI for the same reason ./k8s shells out to kubectl:
// one uniform auth/transport path, and the overhead is dwarfed by sandbox boot.
import type { PodStatus, PvcPod } from "./k8s";

const DOCKER = process.env.DOCKER_BIN ?? "docker";
// Throwaway container that copies the base volume into a task volume.
const COPY_IMAGE = "alpine:3.20";
// Label OpenSandbox stamps on every sandbox container (not on its egress
// sidecar); its value is the lifecycle-API sandbox id.
const SANDBOX_ID_LABEL = "opensandbox.io/id";
// Marks volumes minted by the control plane so leaked ones can be pruned with
// `docker volume prune -a --filter label=devbox.task-volume`.
const TASK_VOLUME_LABEL = "devbox.task-volume";
// Shape of every name SandboxManager mints. Create/remove refuse anything
// else: names come back from the task row, and a tampered row must not be
// able to make the CP delete an arbitrary host volume.
const TASK_VOLUME_NAME = /^devbox-pvc-[a-z0-9-]+$/;

function assertTaskVolumeName(name: string): void {
  if (!TASK_VOLUME_NAME.test(name)) throw new Error(`Refusing non-task volume name: ${name}`);
}

async function runDocker(args: string[]): Promise<string> {
  const proc = Bun.spawn([DOCKER, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    const err = new Error(
      `docker ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`,
    );
    (err as Error & { stderr: string }).stderr = stderr;
    throw err;
  }
  return stdout;
}

// docker CLI wording for a missing volume/container ("no such volume",
// "No such container", "No such object").
export function isDockerNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const stderr = (err as Error & { stderr?: string }).stderr ?? "";
  return /no such (volume|container|object)/i.test(stderr);
}

export async function volumeExists(name: string): Promise<boolean> {
  try {
    await runDocker(["volume", "inspect", name]);
    return true;
  } catch (err) {
    if (isDockerNotFoundError(err)) return false;
    throw err;
  }
}

// Creates `name` and fills it with a copy of `baseVolume`. The base must be
// probed first: `docker run -v base:/src` would silently create an empty base
// and hand the task an empty workspace. On copy failure the half-filled volume
// is removed so the caller never sees a partial workspace.
export async function createVolumeFromBase(opts: {
  name: string;
  baseVolume: string;
}): Promise<void> {
  assertTaskVolumeName(opts.name);
  if (!(await volumeExists(opts.baseVolume))) {
    throw new Error(
      `Base volume ${opts.baseVolume} not found; build it with scripts/build-repos-volume.sh`,
    );
  }
  await runDocker(["volume", "create", "--label", `${TASK_VOLUME_LABEL}=true`, opts.name]);
  try {
    await runDocker([
      "run",
      "--rm",
      "-v",
      `${opts.baseVolume}:/src:ro`,
      "-v",
      `${opts.name}:/dst`,
      COPY_IMAGE,
      "cp",
      "-a",
      "/src/.",
      "/dst/",
    ]);
  } catch (err) {
    await removeVolume(opts.name).catch(() => {});
    throw err;
  }
}

// Swallows "already gone"; any other failure (e.g. still in use) bubbles.
export async function removeVolume(name: string): Promise<void> {
  assertTaskVolumeName(name);
  try {
    await runDocker(["volume", "rm", name]);
  } catch (err) {
    if (isDockerNotFoundError(err)) return;
    throw err;
  }
}

// docker container State.Status → the k8s pod phase vocabulary callers expect.
function phaseFor(state: string | undefined, exitCode: number | undefined): string | undefined {
  switch (state) {
    case "created":
      return "Pending";
    case "running":
    case "paused":
    case "restarting":
      return "Running";
    case "exited":
    case "dead":
      return exitCode === 0 ? "Succeeded" : "Failed";
    default:
      return state === undefined ? undefined : "Unknown";
  }
}

// Parses `docker ps --format '{{.Label "opensandbox.io/id"}}\t{{.State}}'`.
// Containers without the label (e.g. the copy helper) map to sandboxId null.
// `docker ps` has no exit code, so an exited container reads as Failed — the
// only consumer treats Failed and Succeeded alike (not adoptable).
export function parseContainersUsingVolume(stdout: string): PvcPod[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [id = "", state = ""] = line.split("\t");
      return {
        sandboxId: id.trim() || null,
        phase: phaseFor(state.trim(), undefined),
        deleting: state.trim() === "removing",
      };
    });
}

export async function listContainersUsingVolume(name: string): Promise<PvcPod[]> {
  const out = await runDocker([
    "ps",
    "-a",
    "--filter",
    `volume=${name}`,
    "--format",
    `{{.Label "${SANDBOX_ID_LABEL}"}}\t{{.State}}`,
  ]);
  return parseContainersUsingVolume(out);
}

type ContainerInspect = {
  State?: { Status?: string; ExitCode?: number; OOMKilled?: boolean; Error?: string };
};

// Maps `docker inspect` output (a JSON array) to the k8s PodStatus shape.
// Exit details are only reported for a terminal container, matching the k8s
// side where a running pod has no terminated state.
export function parseContainerStatus(inspectJson: string): PodStatus {
  const [container] = JSON.parse(inspectJson) as ContainerInspect[];
  if (!container) return { exists: false, oomKilled: false };
  const state = container.State;
  const phase = phaseFor(state?.Status, state?.ExitCode);
  const terminal = phase === "Failed" || phase === "Succeeded";
  const oomKilled = state?.OOMKilled === true || (terminal && state?.ExitCode === 137);
  return {
    exists: true,
    phase,
    terminatedReason: terminal ? (oomKilled ? "OOMKilled" : state?.Error || undefined) : undefined,
    exitCode: terminal ? state?.ExitCode : undefined,
    oomKilled,
  };
}

// The sandbox container's status, looked up by OpenSandbox's id label. No
// container → `{exists:false}`; a real docker error throws (caller treats that
// as unknown).
export async function getSandboxContainerStatus(sandboxId: string): Promise<PodStatus> {
  const ids = (
    await runDocker(["ps", "-a", "-q", "--filter", `label=${SANDBOX_ID_LABEL}=${sandboxId}`])
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return { exists: false, oomKilled: false };
  try {
    return parseContainerStatus(await runDocker(["inspect", ids[0] as string]));
  } catch (err) {
    // Removed between `ps` and `inspect`.
    if (isDockerNotFoundError(err)) return { exists: false, oomKilled: false };
    throw err;
  }
}
