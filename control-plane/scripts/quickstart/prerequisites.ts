// The tools the chosen platform needs, all checked before anything starts, so
// the user sees every missing one at once instead of one per run. Problems
// stop the quickstart; warnings do not.
import { parseKindVersion } from "../k8s/kind";
import type { Platform } from "./choices";

// The result of a command; missing when it could not be started.
export type Ran = { code: number; stdout: string; stderr: string; missing?: boolean };
export type Run = (cmd: string[]) => Promise<Ran>;

export type Findings = { problems: string[]; warnings: string[] };

// docker info answers slowly while Docker Desktop starts.
export const DOCKER_INFO_TIMEOUT_MS = 20_000;
const MIN_COMPOSE: Version = [2, 13, 0];
const MIN_KIND: Version = [0, 24, 0];
const MIN_HELM: Version = [3, 14, 0];
// Docker Desktop's 8 GB setting reports a little less than 8 GiB.
const MIN_MEMORY_BYTES = 7.5 * 1024 ** 3;

type Version = [number, number, number];

export function parseVersion(text: string): Version | undefined {
  const m = /\bv?(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function olderThan(v: Version, min: Version): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return (v[i] ?? 0) < (min[i] ?? 0);
  return false;
}

const show = (v: Version) => v.join(".");

async function checkDocker(run: Run, f: Findings): Promise<boolean> {
  const r = await run(["docker", "info", "--format", "{{.ServerVersion}} {{.MemTotal}}"]);
  if (r.missing) {
    f.problems.push("docker not found: install Docker (Docker Desktop, or Docker Engine on Linux)");
    return false;
  }
  if (r.code !== 0) {
    f.problems.push(
      /permission denied/i.test(r.stderr)
        ? "cannot reach the Docker daemon: permission denied. Add yourself to the docker group (sudo usermod -aG docker $USER), then log out and back in"
        : `cannot reach the Docker daemon: ${r.stderr.trim().split("\n")[0] || "is it running?"}`,
    );
    return false;
  }
  const memory = Number(r.stdout.trim().split(/\s+/)[1]);
  if (Number.isFinite(memory) && memory > 0 && memory < MIN_MEMORY_BYTES) {
    f.warnings.push(
      `Docker has ${(memory / 1024 ** 3).toFixed(1)} GB of memory; devbox needs about 8 GB (Docker Desktop: Settings → Resources)`,
    );
  }
  return true;
}

async function checkCompose(run: Run, f: Findings): Promise<void> {
  const r = await run(["docker", "compose", "version", "--short"]);
  const v = r.code === 0 ? parseVersion(r.stdout) : undefined;
  if (!v) {
    f.problems.push(
      `docker compose is not working: install Docker Compose ${show(MIN_COMPOSE)} or newer`,
    );
  } else if (olderThan(v, MIN_COMPOSE)) {
    f.problems.push(
      `Docker Compose ${show(v)} is too old: devbox needs ${show(MIN_COMPOSE)} or newer`,
    );
  }
}

// A tool that only has to be there.
async function checkPresent(run: Run, f: Findings, cmd: string[]): Promise<void> {
  const r = await run(cmd);
  if (r.missing || r.code !== 0) f.problems.push(`${cmd[0]} not found: install it`);
}

async function checkVersioned(
  run: Run,
  f: Findings,
  cmd: string[],
  min: Version,
  parse: (out: string) => Version | undefined,
): Promise<void> {
  const tool = cmd[0];
  const r = await run(cmd);
  if (r.missing) {
    f.problems.push(`${tool} not found: install ${tool} ${show(min)} or newer`);
    return;
  }
  const v = r.code === 0 ? parse(r.stdout) : undefined;
  if (!v) f.problems.push(`${tool} is not working: ${r.stderr.trim().split("\n")[0]}`);
  else if (olderThan(v, min)) {
    f.problems.push(`${tool} ${show(v)} is too old: devbox needs ${show(min)} or newer`);
  }
}

export async function checkPrerequisites(platform: Platform, run: Run): Promise<Findings> {
  const f: Findings = { problems: [], warnings: [] };
  const docker = await checkDocker(run, f);
  await checkPresent(run, f, ["make", "--version"]);
  if (platform === "compose") {
    if (docker) await checkCompose(run, f);
    await checkPresent(run, f, ["openssl", "version"]);
    return f;
  }
  await checkVersioned(run, f, ["kind", "version"], MIN_KIND, (out) => {
    try {
      return parseKindVersion(out);
    } catch {
      return undefined;
    }
  });
  await checkPresent(run, f, ["kubectl", "version", "--client"]);
  await checkVersioned(run, f, ["helm", "version", "--short"], MIN_HELM, parseVersion);
  await checkPresent(run, f, ["git", "--version"]);
  f.warnings.push(
    "kind needs about 30 GB of free disk for the cluster, the images and the volumes",
  );
  return f;
}
