import { type FileHandle, open, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type CommandExecution, ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { pickForwardedEnv } from "../src/forwardedEnv";
import { parseTrustList } from "../src/integrationsConfig";

export const WORKSPACE = "/workspace";
export const HARNESS_DIR = `${WORKSPACE}/.harness`;
const HARNESS_ROOT = "/opt/harness";
const DAEMON_LOG = `${HARNESS_DIR}/daemon.log`;
const DAEMON_PID = `${HARNESS_DIR}/daemon.pid`;

// Infrastructure settings only. Callers own sandbox lifetime, identity, metadata,
// local state, and the order in which these operations run.
export interface SandboxConfig {
  connectionConfig: ConnectionConfig;
  namespace: string;
  storageClass: string;
  storageSize: string;
  snapshotPrefix: string;
  image: string;
  resourceCpu: string;
  resourceMemory: string;
  readyTimeoutSeconds: number;
  daemonEnv: Record<string, string>;
}

export function envPositiveInteger(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function joinTrustList(name: "GITHUB_TRUSTED_ORGS" | "GITHUB_TRUSTED_USERS"): string | undefined {
  const values = parseTrustList(process.env[name]);
  return values.length > 0 ? values.join(",") : undefined;
}

export function loadSandboxConfig(): SandboxConfig {
  const daemonEnv: Record<string, string> = {
    WORKSPACE,
    GITHUB_TOKEN: process.env.GITHUB_SANDBOX_TOKEN ?? "proxy-github-dummy-token",
    ...pickForwardedEnv(process.env),
  };
  delete daemonEnv.HARNESS_TRUSTED_ORGS;
  delete daemonEnv.HARNESS_TRUSTED_USERS;
  const trustedOrgs = joinTrustList("GITHUB_TRUSTED_ORGS");
  if (trustedOrgs !== undefined) daemonEnv.HARNESS_TRUSTED_ORGS = trustedOrgs;
  const trustedUsers = joinTrustList("GITHUB_TRUSTED_USERS");
  if (trustedUsers !== undefined) daemonEnv.HARNESS_TRUSTED_USERS = trustedUsers;
  return {
    connectionConfig: new ConnectionConfig({
      domain: process.env.OPENSANDBOX_DOMAIN ?? "localhost:8080",
      apiKey: process.env.OPENSANDBOX_API_KEY,
      requestTimeoutSeconds: envPositiveInteger("SANDBOX_REQUEST_TIMEOUT_SECONDS", 300),
      useServerProxy: true,
    }),
    namespace: process.env.PVC_NAMESPACE ?? "devbox-sandboxes",
    storageClass: process.env.PVC_STORAGE_CLASS ?? "",
    storageSize: process.env.PVC_STORAGE_SIZE ?? "15Gi",
    snapshotPrefix: process.env.SNAPSHOT_NAME_PREFIX ?? "repos-",
    image: process.env.SANDBOX_IMAGE ?? "devbox-dev:local",
    resourceCpu: process.env.SANDBOX_RESOURCE_CPU ?? "2",
    resourceMemory: process.env.SANDBOX_RESOURCE_MEMORY ?? "8Gi",
    readyTimeoutSeconds: envPositiveInteger("SANDBOX_READY_TIMEOUT_SECONDS", 300),
    daemonEnv,
  };
}

export function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

// Removes the lock at `path` when the process it names no longer exists, and
// reports whether the path is free to try again. The pid is read through a
// handle, and the file is unlinked only if `path` still names that same file
// (device and inode) when checked, so a lock another controller created while
// the pid was being checked is left alone. A replacement between that check
// and the unlink can still be removed: there is no unlink-by-handle, and Bun
// exposes no flock. That leaves a window of two syscalls, acceptable for a
// developer-run controller. An unreadable lock (EACCES, a directory) throws
// its error rather than reporting the lock busy.
async function removeStaleLock(path: string): Promise<boolean> {
  let held: FileHandle;
  try {
    held = await open(path, "r");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
  try {
    const pid = Number((await held.readFile("utf8")).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0 || processAlive(pid)) return false;
    const heldStat = await held.stat();
    const current = await stat(path).catch((error) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!current) return true;
    if (current.ino !== heldStat.ino || current.dev !== heldStat.dev) return false;
    await unlink(path).catch(() => {});
    return true;
  } finally {
    await held.close().catch(() => {});
  }
}

// Single-controller lock. A lock left by a process that no longer exists is
// removed automatically, so an interrupted controller never needs manual cleanup.
export async function acquireLockFile(
  path: string,
  busyMessage: string,
): Promise<() => Promise<void>> {
  let lock: FileHandle | undefined;
  for (let attempt = 0; attempt < 2 && !lock; attempt++) {
    try {
      lock = await open(path, "wx");
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if (attempt === 0 && (await removeStaleLock(path))) continue;
      throw new Error(busyMessage);
    }
  }
  if (!lock) throw new Error(busyMessage);
  const handle = lock;
  try {
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
  return async () => {
    try {
      await handle.close();
    } finally {
      await unlink(path).catch((error) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  };
}

export async function connectSandbox(
  sandboxId: string,
  config: SandboxConfig = loadSandboxConfig(),
): Promise<Sandbox> {
  return Sandbox.connect({
    sandboxId,
    connectionConfig: config.connectionConfig,
    skipHealthCheck: true,
  });
}

export async function validateHarnessWorktree(path: string): Promise<string> {
  const worktree = resolve(path);
  try {
    if (!(await stat(worktree)).isDirectory())
      throw new Error(`Worktree is not a directory: ${worktree}`);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new Error(`Worktree does not exist: ${worktree}`);
    throw error;
  }
  for (const relativePath of ["src/harness", "scripts"]) {
    const sourcePath = join(worktree, relativePath);
    try {
      if (!(await stat(sourcePath)).isDirectory())
        throw new Error(`Expected a directory at ${sourcePath}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT"))
        throw new Error(`Not a harness worktree; missing ${sourcePath}`);
      throw error;
    }
  }
  return worktree;
}

export async function runCheckedProcess(command: string[], description: string): Promise<string> {
  const proc = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${description} failed with exit code ${exitCode}: ${stderr.trim() || stdout.trim() || "no output"}`,
    );
  }
  return stdout;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function printExecution(execution: CommandExecution, sanitize = false): void {
  const output = {
    stdout: execution.logs.stdout.map((entry) => entry.text).join(""),
    stderr: execution.logs.stderr.map((entry) => entry.text).join(""),
  };
  const stdout = sanitize ? errorMessage(output.stdout) : output.stdout;
  const stderr = sanitize ? errorMessage(output.stderr) : output.stderr;
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

export function requireSuccessfulExecution(execution: CommandExecution, description: string): void {
  if (execution.exitCode !== 0) {
    throw new Error(
      `${description} failed with remote exit code ${execution.exitCode ?? "unknown"}`,
    );
  }
}

export async function runRemoteChecked(
  sandbox: Sandbox,
  command: string,
  description: string,
  timeoutSeconds = 300,
): Promise<CommandExecution> {
  const execution = await sandbox.commands.run(command, { timeoutSeconds });
  if (execution.exitCode !== 0) printExecution(execution, true);
  requireSuccessfulExecution(execution, description);
  return execution;
}

export async function createSourceArchive(worktree: string, path: string): Promise<void> {
  await runCheckedProcess(
    [
      "tar",
      "-czf",
      path,
      "--exclude=.git",
      "--exclude=__pycache__",
      "--exclude=*.pyc",
      "-C",
      worktree,
      "src/harness",
      "scripts",
    ],
    "Creating the harness source archive",
  );
}

export type HarnessTarget = {
  copyFile(localPath: string, remotePath: string): Promise<void>;
  run(command: string, description: string, timeoutSeconds: number): Promise<void>;
};

export function sandboxHarnessTarget(sandbox: Sandbox, namespace: string): HarnessTarget {
  return {
    copyFile: async (localPath, remotePath) => {
      await runCheckedProcess(
        [
          process.env.KUBECTL_BIN ?? "kubectl",
          "cp",
          localPath,
          `${namespace}/${sandbox.id}-0:${remotePath}`,
          "-c",
          "sandbox",
        ],
        "Copying harness source",
      );
    },
    run: async (command, description, timeoutSeconds) => {
      await runRemoteChecked(sandbox, command, description, timeoutSeconds);
    },
  };
}

// Installs an existing archive. The caller owns its creation, checksum, retention,
// and daemon lifecycle; this operation owns remote staging and replacement rollback.
export async function installHarnessSource(
  target: HarnessTarget,
  archivePath: string,
): Promise<void> {
  const operationId = crypto.randomUUID();
  const remoteArchive = `/tmp/harness-source-${operationId}.tar.gz`;
  const stagingRoot = `/tmp/harness-source-${operationId}`;
  const backupRoot = `/tmp/harness-source-backup-${operationId}`;
  try {
    await target.copyFile(archivePath, remoteArchive);
    const replaceScript = [
      "set -eu",
      "old_harness_moved=0",
      "old_scripts_moved=0",
      "new_harness_moved=0",
      "new_scripts_moved=0",
      "committed=0",
      "restore_source() {",
      '  if [ "$committed" -eq 0 ]; then',
      `    if [ "$new_harness_moved" -eq 1 ]; then rm -rf ${shellQuote(`${HARNESS_ROOT}/src/harness`)}; fi`,
      `    if [ "$new_scripts_moved" -eq 1 ]; then rm -rf ${shellQuote(`${HARNESS_ROOT}/scripts`)}; fi`,
      `    if [ "$old_harness_moved" -eq 1 ]; then mv ${shellQuote(`${backupRoot}/src/harness`)} ${shellQuote(`${HARNESS_ROOT}/src/harness`)}; fi`,
      `    if [ "$old_scripts_moved" -eq 1 ]; then mv ${shellQuote(`${backupRoot}/scripts`)} ${shellQuote(`${HARNESS_ROOT}/scripts`)}; fi`,
      "  fi",
      `  rm -rf ${shellQuote(stagingRoot)} ${shellQuote(backupRoot)}`,
      "}",
      "trap restore_source EXIT",
      `rm -rf ${shellQuote(stagingRoot)} ${shellQuote(backupRoot)}`,
      `mkdir -p ${shellQuote(stagingRoot)} ${shellQuote(`${backupRoot}/src`)}`,
      `tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(stagingRoot)}`,
      `test -d ${shellQuote(`${stagingRoot}/src/harness`)}`,
      `test -d ${shellQuote(`${stagingRoot}/scripts`)}`,
      `mv ${shellQuote(`${HARNESS_ROOT}/src/harness`)} ${shellQuote(`${backupRoot}/src/harness`)}`,
      "old_harness_moved=1",
      `mv ${shellQuote(`${HARNESS_ROOT}/scripts`)} ${shellQuote(`${backupRoot}/scripts`)}`,
      "old_scripts_moved=1",
      `mv ${shellQuote(`${stagingRoot}/src/harness`)} ${shellQuote(`${HARNESS_ROOT}/src/harness`)}`,
      "new_harness_moved=1",
      `mv ${shellQuote(`${stagingRoot}/scripts`)} ${shellQuote(`${HARNESS_ROOT}/scripts`)}`,
      "new_scripts_moved=1",
      "committed=1",
      `rm -rf ${shellQuote(stagingRoot)} ${shellQuote(backupRoot)}`,
      "trap - EXIT",
    ].join("\n");
    await target.run(`bash -lc ${shellQuote(replaceScript)}`, "Extracting harness source", 300);
  } finally {
    await target
      .run(
        `rm -rf ${shellQuote(remoteArchive)} ${shellQuote(stagingRoot)}`,
        "Cleaning harness source staging",
        30,
      )
      .catch(() => {});
  }
}

export async function syncHarnessDependencies(target: HarnessTarget): Promise<void> {
  await target.run(
    `cd ${HARNESS_ROOT} && uv sync --frozen --no-dev`,
    "Synchronizing frozen production dependencies",
    600,
  );
}

export async function bootstrapSandbox(
  sandbox: Sandbox,
  logPath = `${HARNESS_DIR}/bootstrap.log`,
): Promise<void> {
  await runRemoteChecked(
    sandbox,
    `mkdir -p ${HARNESS_DIR} && bash ${HARNESS_ROOT}/scripts/bootstrap.sh >${shellQuote(logPath)} 2>&1 || { tail -n 100 ${shellQuote(logPath)} >&2; exit 1; }`,
    "Bootstrapping the sandbox",
    300,
  );
}

export async function stopDaemon(sandbox: Sandbox, pidPath = DAEMON_PID): Promise<void> {
  await runRemoteChecked(
    sandbox,
    [
      `if [ -f ${shellQuote(pidPath)} ]; then`,
      `  pid=$(cat ${shellQuote(pidPath)})`,
      '  kill "$pid" 2>/dev/null || true',
      '  for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done',
      '  kill -9 "$pid" 2>/dev/null || true',
      `  rm -f ${shellQuote(pidPath)}`,
      "fi",
      "pkill -f '^/opt/harness/.venv/bin/harness daemon$' 2>/dev/null || true",
    ].join("\n"),
    "Stopping the harness daemon",
    30,
  );
}

export async function daemonRunning(sandbox: Sandbox, pidPath = DAEMON_PID): Promise<boolean> {
  const execution = await sandbox.commands.run(
    `[ -f ${shellQuote(pidPath)} ] && kill -0 "$(cat ${shellQuote(pidPath)})" 2>/dev/null`,
    { timeoutSeconds: 30 },
  );
  return execution.exitCode === 0;
}

export async function startDaemon(
  sandbox: Sandbox,
  logPath = DAEMON_LOG,
  pidPath = DAEMON_PID,
): Promise<void> {
  await runRemoteChecked(
    sandbox,
    [
      `mkdir -p ${HARNESS_DIR}/inbox`,
      `nohup ${HARNESS_ROOT}/.venv/bin/harness daemon >>${shellQuote(logPath)} 2>&1 </dev/null &`,
      "pid=$!",
      `echo "$pid" > ${shellQuote(pidPath)}`,
      "sleep 1",
      'kill -0 "$pid"',
    ].join("\n"),
    "Starting the harness daemon",
    30,
  );
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  let sanitized = raw;
  for (const [name, secret] of Object.entries(process.env)) {
    if (
      !secret ||
      !/(authorization|credential|password|secret|token|api_?key|foundry_key)/i.test(name)
    )
      continue;
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  return sanitized
    .replace(
      /(authorization)(["']?\s*[:=]\s*["']?)(?:(?:basic|bearer)\s+)?[^\s,;}"']+/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /(api[-_ ]?key|password|token|secret)(["']?\s*[:=]\s*["']?)[^\s,;}"']+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/bearer\s+[^\s,;}]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:api_?key|password|token|secret)=)[^&#\s]+/gi, "$1[REDACTED]");
}
