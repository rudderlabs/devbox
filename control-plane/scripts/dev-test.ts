import { link, mkdir, mkdtemp, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Sandbox, SandboxApiException } from "@alibaba-group/opensandbox";
import {
  createPvcFromSnapshot,
  deletePvc,
  getLatestVolumeSnapshotName,
  isK8sNotFoundError,
} from "../src/clients/k8s";
import type { InboxMessage, PrScope, TaskIdentity } from "../src/types/inboxMessage";
import {
  acquireLockFile,
  bootstrapSandbox,
  connectSandbox,
  createSourceArchive,
  envPositiveInteger,
  errorMessage,
  HARNESS_DIR,
  installHarnessSource,
  isNodeError,
  loadSandboxConfig,
  printExecution,
  requireSuccessfulExecution,
  runCheckedProcess,
  runRemoteChecked,
  type SandboxConfig,
  sandboxHarnessTarget,
  shellQuote,
  startDaemon,
  stopDaemon,
  syncHarnessDependencies,
  validateHarnessWorktree,
  WORKSPACE,
} from "./harness-sandbox";

const REPO_ROOT = resolve(import.meta.dir, "..");
const STATE_PATH = join(REPO_ROOT, ".dev-test.state");
const STATE_LOCK_PATH = `${STATE_PATH}.lock`;
const DAEMON_LOG = `${HARNESS_DIR}/dev-test-daemon.log`;
const DAEMON_PID = `${HARNESS_DIR}/dev-test-daemon.pid`;
const KUBECTL = process.env.KUBECTL_BIN ?? "kubectl";

const USAGE = `Usage: bun run dev-test <command> [options]

Lifecycle:
  up --worktree <path>              Create a snapshot-backed sandbox
  push                              Replace harness source and restart the daemon
  logs [--events <n>] [--daemon <n>]  Tail events and daemon output (default: 50/100)
  exec -- <remote command...>       Run a command inside the sandbox
  archive [--out <path>]            Capture a harness-compatible .tgz archive
  down                              Delete the sandbox, PVC, and local state

Typed inbox seeding:
  seed assignment --title <text> [--description <text>] [--task-key <key>]
  seed comment --body <text> [--task-key <key>] [--pr-repo <repo> --pr-url <url>]
  seed review [--body <text>] --pr-repo <repo> --pr-url <url>
              [--inline <path:line:body> ...] [--task-key <key>]
  seed ci_result --pr-repo <repo> --pr-url <url> [--conclusion <value>]
                 [--workflow-name <name>] [--workflow-path <path>]
                 [--run-url <url>] [--head-sha <sha>] [--head-branch <branch>]

Environment: OPENSANDBOX_DOMAIN, OPENSANDBOX_API_KEY, SANDBOX_IMAGE,
PVC_NAMESPACE, PVC_STORAGE_CLASS, PVC_STORAGE_SIZE, SNAPSHOT_NAME_PREFIX,
SANDBOX_RESOURCE_CPU, SANDBOX_RESOURCE_MEMORY, and allowlisted HARNESS_* settings.`;

class UsageError extends Error {}

interface DevTestState {
  sandboxId: string;
  pvcName: string;
  worktree: string;
}

interface DevTestConfig extends SandboxConfig {
  timeoutSeconds: number;
}

type OptionSpec = Record<string, { repeatable?: boolean }>;
type ParsedOptions = Record<string, string[]>;

function parseOptions(args: string[], specs: OptionSpec): ParsedOptions {
  const parsed: ParsedOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name?.startsWith("--") || name === "--") {
      throw new UsageError(`Unexpected argument: ${name ?? ""}`);
    }
    const spec = specs[name];
    if (!spec) throw new UsageError(`Unknown option: ${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`Option ${name} requires a value`);
    }
    const values = parsed[name] ?? [];
    if (!spec.repeatable && values.length > 0) {
      throw new UsageError(`Option ${name} may only be specified once`);
    }
    values.push(value);
    parsed[name] = values;
    index += 1;
  }
  return parsed;
}

function option(options: ParsedOptions, name: string): string | undefined {
  return options[name]?.[0];
}

function requiredOption(options: ParsedOptions, name: string): string {
  const value = option(options, name);
  if (!value) throw new UsageError(`Missing required option: ${name}`);
  return value;
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new UsageError(`Unexpected argument: ${args[0]}`);
}

function positiveInteger(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`${optionName} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new UsageError(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function loadConfig(): DevTestConfig {
  return {
    ...loadSandboxConfig(),
    timeoutSeconds: envPositiveInteger("DEV_TEST_SANDBOX_TIMEOUT_SECONDS", 24 * 60 * 60),
  };
}

function validateState(value: unknown): DevTestState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${STATE_PATH} must contain a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["sandboxId", "pvcName", "worktree"] as const;
  const unexpectedKeys = Object.keys(record).filter(
    (key) => !expectedKeys.includes(key as (typeof expectedKeys)[number]),
  );
  if (unexpectedKeys.length > 0) {
    throw new Error(`${STATE_PATH} has unexpected fields: ${unexpectedKeys.join(", ")}`);
  }
  for (const key of expectedKeys) {
    if (typeof record[key] !== "string" || record[key].trim() === "") {
      throw new Error(`${STATE_PATH} has an invalid ${key}`);
    }
  }
  if (
    (record.pvcName as string).length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(record.pvcName as string)
  ) {
    throw new Error(`${STATE_PATH} has an invalid pvcName`);
  }
  if (!isAbsolute(record.worktree as string)) {
    throw new Error(`${STATE_PATH} has a non-absolute worktree`);
  }
  return {
    sandboxId: record.sandboxId as string,
    pvcName: record.pvcName as string,
    worktree: record.worktree as string,
  };
}

async function readState(): Promise<DevTestState> {
  let raw: string;
  try {
    raw = await readFile(STATE_PATH, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`No dev-test state found at ${STATE_PATH}; run 'bun run dev-test up' first`);
    }
    throw error;
  }
  try {
    return validateState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${STATE_PATH} contains invalid JSON`);
    throw error;
  }
}

async function stateExists(): Promise<boolean> {
  try {
    await stat(STATE_PATH);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function writeState(state: DevTestState): Promise<void> {
  const tempPath = `${STATE_PATH}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    await link(tempPath, STATE_PATH).catch((error) => {
      if (isNodeError(error, "EEXIST")) {
        throw new Error(`Refusing to replace existing state at ${STATE_PATH}`);
      }
      throw error;
    });
  } finally {
    await unlink(tempPath).catch((error) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
}

async function removeState(): Promise<void> {
  await unlink(STATE_PATH).catch((error) => {
    if (!isNodeError(error, "ENOENT")) throw error;
  });
}

function timestampForName(): string {
  return new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

function pvcName(): string {
  return `devbox-dev-test-${timestampForName()}-${crypto.randomUUID().slice(0, 6)}`.toLowerCase();
}

async function commandUp(args: string[]): Promise<void> {
  const options = parseOptions(args, { "--worktree": {} });
  const worktree = await validateHarnessWorktree(requiredOption(options, "--worktree"));
  if (await stateExists()) {
    throw new Error(
      `Refusing to replace existing state at ${STATE_PATH}; run 'bun run dev-test down' first`,
    );
  }

  const releaseUpLock = await acquireLockFile(
    STATE_LOCK_PATH,
    `Another dev-test up is already running (${STATE_LOCK_PATH} exists)`,
  );
  try {
    if (await stateExists()) {
      throw new Error(
        `Refusing to replace existing state at ${STATE_PATH}; run 'bun run dev-test down' first`,
      );
    }
    await createDevSandbox(worktree);
  } finally {
    await releaseUpLock();
  }
}

async function createDevSandbox(worktree: string): Promise<void> {
  const config = loadConfig();
  const snapshotName = await getLatestVolumeSnapshotName(config.namespace, config.snapshotPrefix);
  if (!snapshotName) {
    throw new Error(
      `No ready VolumeSnapshot found in namespace ${config.namespace}` +
        (config.snapshotPrefix ? ` with prefix ${config.snapshotPrefix}` : ""),
    );
  }

  const newPvcName = pvcName();
  const tempDirectory = await mkdtemp(join(tmpdir(), "devbox-dev-test-"));
  const archivePath = join(tempDirectory, "source.tar.gz");
  let pvcCreated = false;
  let sandbox: Sandbox | undefined;
  try {
    await createSourceArchive(worktree, archivePath);
    if (!config.storageClass) {
      throw new Error("PVC_STORAGE_CLASS is required: the StorageClass for the test PVC");
    }
    await createPvcFromSnapshot({
      name: newPvcName,
      namespace: config.namespace,
      snapshotName,
      storageClassName: config.storageClass,
      storageSize: config.storageSize,
    });
    pvcCreated = true;
    console.log(`Created PVC ${config.namespace}/${newPvcName} from ${snapshotName}`);

    sandbox = await Sandbox.create({
      connectionConfig: config.connectionConfig,
      image: config.image,
      entrypoint: ["tail", "-f", "/dev/null"],
      resource: { cpu: config.resourceCpu, memory: config.resourceMemory },
      timeoutSeconds: config.timeoutSeconds,
      volumes: [
        {
          name: "workspace",
          mountPath: WORKSPACE,
          readOnly: false,
          pvc: { claimName: newPvcName },
        },
      ],
      readyTimeoutSeconds: config.readyTimeoutSeconds,
      env: config.daemonEnv,
      metadata: {
        source: "dev-test",
        task_id: `dev-test-${Date.now()}`,
        external_id: `dev-test-${Date.now()}`,
      },
      skipHealthCheck: true,
    });
    console.log(`Created sandbox ${sandbox.id}; waiting for command API readiness`);
    await sandbox.waitUntilReady({
      readyTimeoutSeconds: config.readyTimeoutSeconds,
      pollingIntervalMillis: 1_000,
    });

    const target = sandboxHarnessTarget(sandbox, config.namespace);
    await installHarnessSource(target, archivePath);
    await syncHarnessDependencies(target);
    await bootstrapSandbox(sandbox, `${HARNESS_DIR}/dev-test-bootstrap.log`);
    await startDaemon(sandbox, DAEMON_LOG, DAEMON_PID);
    await writeState({ sandboxId: sandbox.id, pvcName: newPvcName, worktree });
    console.log(`Dev sandbox ready; state written to ${STATE_PATH}`);
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (sandbox) {
      await sandbox.kill().catch((cleanupError) => {
        if (!isSandboxNotFoundError(cleanupError)) cleanupErrors.push(errorMessage(cleanupError));
      });
    }
    if (pvcCreated) {
      await deletePvc({ name: newPvcName, namespace: config.namespace }).catch((cleanupError) => {
        if (!isK8sNotFoundError(cleanupError)) cleanupErrors.push(errorMessage(cleanupError));
      });
    }
    if (cleanupErrors.length > 0) {
      console.error(`Rollback also encountered: ${cleanupErrors.join("; ")}`);
    }
    throw error;
  } finally {
    await sandbox?.close().catch(() => {});
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function commandPush(args: string[]): Promise<void> {
  assertNoArgs(args);
  const state = await readState();
  const config = loadConfig();
  const worktree = await validateHarnessWorktree(state.worktree);
  const tempDirectory = await mkdtemp(join(tmpdir(), "devbox-dev-test-"));
  const archivePath = join(tempDirectory, "source.tar.gz");
  let sandbox: Sandbox | undefined;
  let stopped = false;
  let restarted = false;
  try {
    await createSourceArchive(worktree, archivePath);
    sandbox = await connectSandbox(state.sandboxId, config);
    await stopDaemon(sandbox, DAEMON_PID);
    stopped = true;
    const target = sandboxHarnessTarget(sandbox, config.namespace);
    await installHarnessSource(target, archivePath);
    await syncHarnessDependencies(target);
    await startDaemon(sandbox, DAEMON_LOG, DAEMON_PID);
    restarted = true;
    console.log(`Pushed ${state.worktree} and restarted the daemon`);
  } finally {
    if (sandbox && stopped && !restarted) {
      await startDaemon(sandbox, DAEMON_LOG, DAEMON_PID).catch((error) => {
        console.error(`Could not restore the daemon after push failure: ${errorMessage(error)}`);
      });
    }
    await sandbox?.close().catch(() => {});
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function commandLogs(args: string[]): Promise<void> {
  const options = parseOptions(args, { "--events": {}, "--daemon": {} });
  const events = positiveInteger(option(options, "--events") ?? "50", "--events");
  const daemon = positiveInteger(option(options, "--daemon") ?? "100", "--daemon");
  const state = await readState();
  const config = loadConfig();
  const sandbox = await connectSandbox(state.sandboxId, config);
  try {
    const execution = await sandbox.commands.run(
      [
        `echo '== events.jsonl (last ${events}) =='`,
        `[ ! -f ${HARNESS_DIR}/events.jsonl ] || tail -n ${events} ${HARNESS_DIR}/events.jsonl`,
        `echo '== dev-test-daemon.log (last ${daemon}) =='`,
        `[ ! -f ${DAEMON_LOG} ] || tail -n ${daemon} ${DAEMON_LOG}`,
      ].join("\n"),
      { timeoutSeconds: 30 },
    );
    printExecution(execution);
    requireSuccessfulExecution(execution, "Reading sandbox logs");
  } finally {
    await sandbox.close().catch(() => {});
  }
}

async function commandExec(args: string[]): Promise<void> {
  const commandArgs = args[0] === "--" ? args.slice(1) : args;
  if (commandArgs.length === 0) throw new UsageError("exec requires a remote command");
  const remoteCommand = commandArgs.map(shellQuote).join(" ");
  const state = await readState();
  const config = loadConfig();
  const sandbox = await connectSandbox(state.sandboxId, config);
  try {
    const execution = await sandbox.commands.run(remoteCommand);
    printExecution(execution);
    const exitCode = execution.exitCode;
    if (exitCode === null || exitCode === undefined) {
      throw new Error("Remote command completed without an exit code");
    }
    process.exitCode = exitCode;
  } finally {
    await sandbox.close().catch(() => {});
  }
}

async function commandArchive(args: string[]): Promise<void> {
  const options = parseOptions(args, { "--out": {} });
  const state = await readState();
  const config = loadConfig();
  const outputPath = resolve(
    option(options, "--out") ??
      join(REPO_ROOT, `${basename(state.worktree)}-${timestampForName()}.archive.tgz`),
  );
  const partialPath = `${outputPath}.${crypto.randomUUID()}.partial`;
  const remotePath = `/tmp/dev-test-archive-${crypto.randomUUID()}.tar.gz`;
  const podName = `${state.sandboxId}-0`;
  const sandbox = await connectSandbox(state.sandboxId, config);
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await runRemoteChecked(
      sandbox,
      `harness archive --out ${shellQuote(remotePath)} --override`,
      "Creating harness archive",
      120,
    );
    await runCheckedProcess(
      [KUBECTL, "cp", `${config.namespace}/${podName}:${remotePath}`, partialPath, "-c", "sandbox"],
      `Copying archive from assumed OpenSandbox pod ${config.namespace}/${podName}`,
    );
    await rename(partialPath, outputPath);
    console.log(`Archive written to ${outputPath}`);
  } finally {
    await rm(partialPath, { force: true });
    await sandbox.commands.run(`rm -f ${shellQuote(remotePath)}`).catch(() => {});
    await sandbox.close().catch(() => {});
  }
}

function buildPrScope(options: ParsedOptions, required: boolean): PrScope | null {
  const repo = option(options, "--pr-repo");
  const url = option(options, "--pr-url");
  if ((repo && !url) || (!repo && url)) {
    throw new UsageError("--pr-repo and --pr-url must be supplied together");
  }
  if (!repo || !url) {
    if (required) throw new UsageError("--pr-repo and --pr-url are required");
    return null;
  }
  return { repo, pr_url: url };
}

const SEED_COMMON = {
  "--task-key": {},
  "--target": {},
  "--external-id": {},
} satisfies OptionSpec;

function seedIdentity(options: ParsedOptions): {
  id: string;
  targetId: string;
  externalId: string;
  taskKey: string;
  createdAt: string;
} {
  return {
    id: crypto.randomUUID(),
    targetId: option(options, "--target") ?? crypto.randomUUID(),
    externalId: option(options, "--external-id") ?? `dev-test-${Date.now()}`,
    taskKey: option(options, "--task-key") ?? "TEST-1",
    createdAt: new Date().toISOString(),
  };
}

function seedTaskIdentity(identity: { taskKey: string }): TaskIdentity {
  return {
    task_id: crypto.randomUUID(),
    task_key: identity.taskKey,
  };
}

function buildSeedMessage(kind: string, args: string[]): InboxMessage {
  if (kind === "assignment") {
    const options = parseOptions(args, {
      ...SEED_COMMON,
      "--title": {},
      "--description": {},
      "--external-url": {},
    });
    const identity = seedIdentity(options);
    return {
      id: identity.id,
      source: "linear",
      kind: "assignment",
      external_id: identity.externalId,
      payload: {
        title: requiredOption(options, "--title"),
        description: option(options, "--description") ?? null,
        ...seedTaskIdentity(identity),
        external_url:
          option(options, "--external-url") ??
          `https://linear.app/dev-test/issue/${encodeURIComponent(identity.taskKey)}`,
        target_id: identity.targetId,
      },
    };
  }

  if (kind === "comment") {
    const options = parseOptions(args, {
      ...SEED_COMMON,
      "--body": {},
      "--pr-repo": {},
      "--pr-url": {},
    });
    const identity = seedIdentity(options);
    const pr = buildPrScope(options, false);
    const common = {
      id: identity.id,
      kind: "comment" as const,
      external_id: identity.externalId,
      payload: {
        target_id: identity.targetId,
        body: requiredOption(options, "--body"),
        ...seedTaskIdentity(identity),
        pr,
        created_at: identity.createdAt,
      },
    };
    return pr ? { ...common, source: "github" } : { ...common, source: "linear" };
  }

  if (kind === "review") {
    const options = parseOptions(args, {
      ...SEED_COMMON,
      "--body": {},
      "--pr-repo": {},
      "--pr-url": {},
      "--inline": { repeatable: true },
    });
    const identity = seedIdentity(options);
    const pr = buildPrScope(options, true);
    if (!pr) throw new UsageError("Review PR scope is required");
    return {
      id: identity.id,
      source: "github",
      kind: "review",
      external_id: identity.externalId,
      payload: {
        review_body: { target_id: identity.targetId, body: option(options, "--body") ?? "" },
        inline_comments: (options["--inline"] ?? []).map(parseInlineComment),
        ...seedTaskIdentity(identity),
        pr,
        created_at: identity.createdAt,
      },
    };
  }

  if (kind === "ci_result") {
    const options = parseOptions(args, {
      ...SEED_COMMON,
      "--pr-repo": {},
      "--pr-url": {},
      "--workflow-name": {},
      "--workflow-path": {},
      "--conclusion": {},
      "--run-url": {},
      "--head-sha": {},
      "--head-branch": {},
    });
    const identity = seedIdentity(options);
    const pr = buildPrScope(options, true);
    if (!pr) throw new UsageError("CI result PR scope is required");
    const conclusion = option(options, "--conclusion") ?? "failure";
    const validConclusions = new Set([
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "success",
      "timed_out",
    ]);
    if (!validConclusions.has(conclusion)) {
      throw new UsageError(`Invalid --conclusion: ${conclusion}`);
    }
    return {
      id: identity.id,
      source: "github",
      kind: "ci_result",
      external_id: identity.externalId,
      payload: {
        target_id: identity.targetId,
        workflow_name: option(options, "--workflow-name") ?? "CI",
        workflow_path: option(options, "--workflow-path") ?? ".github/workflows/ci.yml",
        conclusion,
        run_url: option(options, "--run-url") ?? "https://github.com/dev-test/actions/runs/1",
        head_sha: option(options, "--head-sha") ?? "dev-test",
        head_branch: option(options, "--head-branch") ?? "dev-test",
        ...seedTaskIdentity(identity),
        pr,
      },
    };
  }

  throw new UsageError(`Unknown seed kind: ${kind}`);
}

function parseInlineComment(value: string): {
  target_id: string;
  path: string;
  line: number;
  body: string;
} {
  const firstColon = value.indexOf(":");
  const secondColon = firstColon === -1 ? -1 : value.indexOf(":", firstColon + 1);
  if (firstColon <= 0 || secondColon === -1) {
    throw new UsageError(`Invalid --inline value '${value}'; expected path:line:body`);
  }
  const path = value.slice(0, firstColon);
  const rawLine = value.slice(firstColon + 1, secondColon);
  const body = value.slice(secondColon + 1);
  if (!body) throw new UsageError(`Invalid --inline value '${value}'; body must not be empty`);
  const line = positiveInteger(rawLine, "inline line");
  return { target_id: crypto.randomUUID(), path, line, body };
}

async function commandSeed(args: string[]): Promise<void> {
  const kind = args[0];
  if (!kind) throw new UsageError("seed requires assignment, comment, review, or ci_result");
  const message = buildSeedMessage(kind, args.slice(1));
  const state = await readState();
  const config = loadConfig();
  const sandbox = await connectSandbox(state.sandboxId, config);
  const inboxPath = `${HARNESS_DIR}/inbox/${message.id}.json`;
  try {
    await runRemoteChecked(sandbox, `mkdir -p ${HARNESS_DIR}/inbox`, "Creating inbox directory");
    await sandbox.files.writeFiles([
      { path: inboxPath, data: `${JSON.stringify(message, null, 2)}\n` },
    ]);
    console.log(`Seeded ${message.source}/${message.kind} at ${inboxPath}`);
  } finally {
    await sandbox.close().catch(() => {});
  }
}

function isSandboxNotFoundError(error: unknown): boolean {
  return error instanceof SandboxApiException && error.statusCode === 404;
}

async function commandDown(args: string[]): Promise<void> {
  assertNoArgs(args);
  const state = await readState();
  const config = loadConfig();
  let sandboxRemoved = false;
  let pvcRemoved = false;
  let sandbox: Sandbox | undefined;

  try {
    try {
      sandbox = await connectSandbox(state.sandboxId, config);
      await sandbox.kill();
      sandboxRemoved = true;
      console.log(`Deleted sandbox ${state.sandboxId}`);
    } catch (error) {
      if (isSandboxNotFoundError(error)) {
        sandboxRemoved = true;
        console.log(`Sandbox ${state.sandboxId} is already absent`);
      } else {
        throw error;
      }
    } finally {
      await sandbox?.close().catch(() => {});
    }

    try {
      await deletePvc({ name: state.pvcName, namespace: config.namespace });
      pvcRemoved = true;
      console.log(`Deleted PVC ${config.namespace}/${state.pvcName}`);
    } catch (error) {
      if (isK8sNotFoundError(error)) {
        pvcRemoved = true;
        console.log(`PVC ${config.namespace}/${state.pvcName} is already absent`);
      } else {
        throw error;
      }
    }
  } finally {
    if (sandboxRemoved && pvcRemoved) await removeState();
  }
  console.log(`Removed ${STATE_PATH}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "up":
      await commandUp(args);
      return;
    case "push":
      await commandPush(args);
      return;
    case "logs":
      await commandLogs(args);
      return;
    case "exec":
      await commandExec(args);
      return;
    case "archive":
      await commandArchive(args);
      return;
    case "seed":
      await commandSeed(args);
      return;
    case "down":
      await commandDown(args);
      return;
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`dev-test: ${errorMessage(error)}`);
  if (error instanceof UsageError) console.error(`\n${USAGE}`);
  process.exitCode = 1;
}
