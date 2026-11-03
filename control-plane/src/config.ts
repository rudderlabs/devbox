import { parseApiConfig } from "./apiConfig";
import { parseGithubTokenSettings } from "./clients/githubToken";
import { pickForwardedEnv } from "./forwardedEnv";
import { parseGithubConfig, parseLinearConfig, parseSlackConfig } from "./integrationsConfig";
import { parseSandboxGitIdentity, parseSandboxRuntimeConfig } from "./sandboxConfig";

// Optional numeric env with a default. Unset or empty/whitespace-only → `def`.
// A PRESENT but non-finite value (typo, "Infinity", a Helm-rendered garbage
// string) THROWS at boot instead of silently coercing to 0/NaN. This matters
// for safety knobs like the ci_result loop breaker: `Number(env ?? d)` would
// let "" / "abc" map to 0/NaN, which the breaker reads as "disabled" — silently
// removing the only guard against a runaway sandbox-recreate loop. An explicit
// finite 0/negative still passes through (a documented, intentional disable).
function optionalNumber(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Env var ${name} must be a number`);
  return value;
}

const taskPollIntervalMs = Number(process.env.TASK_POLL_INTERVAL_MS ?? 5000);

// Lease is generous (120s) to cover long GC pauses, Linear API latency spikes,
// and file reads from the sandbox. Longer is safer: it prevents a peer pod from
// reclaiming the task mid-transition and racing on handler emits. The cost is
// slower recovery on a genuinely-dead pod, which is acceptable since task work
// is minutes-long to begin with.
const leaseTimeoutMs = Number(process.env.LEASE_TIMEOUT_MS ?? 120000);
if (leaseTimeoutMs <= taskPollIntervalMs) {
  throw new Error(
    `LEASE_TIMEOUT_MS (${leaseTimeoutMs}) must be greater than TASK_POLL_INTERVAL_MS (${taskPollIntervalMs}); ` +
      "a slow tick would otherwise self-evict an active task",
  );
}

// optionalNumber lets a present, finite 0/negative value through (a documented
// intentional disable for knobs like the ci_result loop breaker) — but for a
// TIMEOUT, 0/negative means "expire immediately," not "off": every reconcile
// Files-API call would instant-timeout fleet-wide instead of being disabled.
const reconcileFilesTimeoutMs = optionalNumber("SANDBOX_RECONCILE_FILES_TIMEOUT_MS", 20_000);
if (reconcileFilesTimeoutMs <= 0) {
  throw new Error(
    `SANDBOX_RECONCILE_FILES_TIMEOUT_MS (${reconcileFilesTimeoutMs}) must be a positive number; ` +
      "a value <= 0 would instant-timeout every reconcile Files-API call",
  );
}

const sandbox = parseSandboxRuntimeConfig(process.env);

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox",
  port: Number(process.env.PORT ?? 3000),
  autoMigrate: process.env.AUTO_MIGRATE === "true",
  podId: crypto.randomUUID(),
  taskPollIntervalMs,
  leaseTimeoutMs,
  shutdownDrainMs: Number(process.env.SHUTDOWN_DRAIN_MS ?? 10000),
  // Global cap across all pods. Enforced inside the claim CTE by counting
  // live-lease rows only — zombie rows from dead pods don't block new claims.
  maxConcurrentSandboxes: Number(process.env.MAX_CONCURRENT_SANDBOXES ?? 50),
  // Idle reaper: kill a sandbox after this long with no inbox/event activity
  // (default 15 min). Lease released, PVC stays — future inbox events
  // recreate the sandbox from PVC.
  idleSandboxKillMs: Number(process.env.IDLE_SANDBOX_KILL_MS ?? 15 * 60_000),
  // Backstop for a sandbox whose pod is still *Running* but whose execd Files
  // API keeps returning 5xx (events read / inbox write) — execd-dead behind a
  // healthy pod, not warming up. Fail the task after this long of *continuous*
  // Files-API unavailability instead of deferring the reconcile forever (a
  // silent wedge). Terminal or absent pods are caught immediately by the direct
  // pod-status check, so this timer only governs the dead-execd-behind-a-live-
  // pod case.
  sandboxFilesUnavailableFailMs: Number(
    process.env.SANDBOX_FILES_UNAVAILABLE_FAIL_MS ?? 10 * 60_000,
  ),
  // Grace for an ABSENT backing pod (kubectl NotFound). A pod can be briefly
  // absent between sandbox-create and scheduling, so we don't fail the first
  // time we see it gone — we wait this long for it to appear, then fail the
  // task. A pod that EXISTS in a terminal phase (Failed/Succeeded) is failed
  // immediately, with no grace.
  sandboxAbsentGraceMs: optionalNumber("SANDBOX_ABSENT_GRACE_MS", 2 * 60_000),
  // Max automatic retries for a task whose SANDBOX failed (terminal/absent pod,
  // dead execd). Each retry kills the dead sandbox and RESUMES the task on the
  // SAME PVC (workspace / event cursor / PRs preserved); the lease is released so
  // any pod re-provisions it within the concurrency cap. Counted via a DURABLE
  // per-task counter in tasks.metadata.retryCount, so the budget is fleet-wide and
  // survives pod restart / lease takeover. It is a LIFETIME budget — NOT reset on a
  // clean reconcile; only a genuine re-delegation (a new Linear agent session →
  // restartTaskWithInbox) clears it. Past this many, the task is failed for good.
  // optionalNumber (not raw Number) so a non-numeric env throws at boot
  // rather than yielding NaN, which would make `attempt > NaN` always false and
  // silently disable the cap → an unbounded retry/sandbox-recreate loop.
  maxTaskRetries: optionalNumber("MAX_TASK_RETRIES", 3),
  // Undefined unless LINEAR_ENABLED=true; then LINEAR_CLIENT_ID,
  // LINEAR_CLIENT_SECRET and LINEAR_WEBHOOK_SECRET are required. Parsed by
  // integrationsConfig.ts.
  linear: parseLinearConfig(process.env),
  // Undefined unless SLACK_ENABLED=true; then SLACK_BOT_TOKEN (xoxb-…, posts
  // task-completion updates) and SLACK_CHANNEL_ID (C…) are required. The token
  // matches the /token/i log-redaction pattern. Parsed by integrationsConfig.ts.
  slack: parseSlackConfig(process.env),
  github: {
    // The control plane's own GitHub token (it runs outside the sandbox
    // egress path, so it needs a real one): GITHUB_TOKEN_FILE (a mounted
    // Secret, re-read on a TTL) or GITHUB_TOKEN. See clients/githubToken.ts.
    tokenSettings: parseGithubTokenSettings(process.env),
    // Webhook settings (secret, bot identity, trust lists). Undefined unless
    // GITHUB_WEBHOOKS_ENABLED=true; then the secret, bot and trust settings are
    // required. Trust lists are also parsed with webhooks off so they can be
    // forwarded to the sandbox. Parsed by integrationsConfig.ts.
    ...parseGithubConfig(process.env),
    // Feature flag: enable workflow_run CI result inbox enqueue. Disabled by
    // default until the harness is ready to consume ci_result inbox rows.
    ciResultEnabled: process.env.GITHUB_CI_RESULT_ENABLED === "true",
    // Loop breaker: max ci_result ROWS we forward to the harness per task.
    // harness fixes CI → pushes → CI re-runs → can fail again → fix → … a
    // runaway burns sandbox time and Linear noise. Once a task has this many
    // ci_result rows, further CI failures are dropped at enqueue. NOTE: the unit
    // is failed-workflow_run rows, NOT fix-cycles — a push that fails N parallel
    // CI workflows writes N rows, so on a multi-workflow repo the cap is reached
    // in ~max/N pushes. Size it with your workflow fan-out in mind. Configurable;
    // an explicit 0 (or negative) disables the breaker.
    ciResultMaxPerTask: optionalNumber("GITHUB_CI_RESULT_MAX_PER_TASK", 20),
  },
  opensandbox: {
    domain: process.env.OPENSANDBOX_DOMAIN ?? "localhost:8080",
    // Optional: local/dev deployments may not require API key auth.
    apiKey: process.env.OPENSANDBOX_API_KEY,
    // OpenSandbox SDK forwards this as resourceLimits.cpu.
    sandboxResourceCpu: process.env.SANDBOX_RESOURCE_CPU ?? "2",
    // OpenSandbox SDK forwards this as resourceLimits.memory.
    sandboxResourceMemory: sandbox.sandboxResourceMemory,
    timeoutSeconds: Number(process.env.SANDBOX_TIMEOUT_SECONDS ?? 1800),
    // The harness image (harness/). Its entrypoint runs once and exits, which
    // is what lets the monitor loop reach a terminal sandbox state.
    baseImage: sandbox.baseImage,
    // Default 30s isn't enough when the PVC is WaitForFirstConsumer and an
    // EBS snapshot restore happens at pod-schedule time. Bun's fetch aborts any
    // request that stays silent for 300s regardless of this value
    // (oven-sh/bun#16682), so above 300 it has no effect on the current runtime.
    // A create that outlives it is re-provisioned through the task's durable
    // retry budget (handleTaskError → retryTask, bounded by maxTaskRetries).
    requestTimeoutSeconds: Number(process.env.SANDBOX_REQUEST_TIMEOUT_SECONDS ?? 300),
    // Passed to the SDK but inert: both create paths use skipHealthCheck: true,
    // so the SDK never runs the readiness poll this bounds.
    readyTimeoutSeconds: Number(process.env.SANDBOX_READY_TIMEOUT_SECONDS ?? 300),
    // Bounds a single reconcile-tick Files-API call (readEvents/
    // sweepUndelivered), independent of requestTimeoutSeconds above — that one
    // stays long deliberately for sandbox creation/PVC restore, but a live
    // reconcile can't afford to wait that long: a hung upstream response would
    // block tick() past LEASE_TIMEOUT_MS and get the task's lease stolen by
    // another pod instead of retrying cleanly on this one. Validated above.
    reconcileFilesTimeoutMs,
    // Commit identity for sandboxes; see sandboxConfig.ts.
    gitIdentity: parseSandboxGitIdentity(process.env),
    // Only the reviewed HARNESS_* names in forwardedEnv.ts cross into the
    // sandbox. New harness settings require an explicit contract update, so
    // platform-injected variables and stray control-plane values stay out. Real
    // secrets never use a forwarded name; HARNESS_LLM_API_KEY is the egress
    // proxy's placeholder. Per-task #devbox:exp:FLAG tokens can still force the
    // corresponding HARNESS_EXP_FLAG to "true".
    forwardedEnv: pickForwardedEnv(process.env),
    // ──── Workspace volume config ────
    // Every task gets its own workspace volume, minted at first provision and
    // kept for resumes until deleted by configured retention or operations.
    // `sandboxRuntime` picks where it is minted from:
    //   k8s    — PVC hydrated from the newest `readyToUse: true` VolumeSnapshot
    //            in `pvcNamespace` (the repo-snapshot-builder CronJob's output).
    //   docker — Docker named volume copied from `reposBaseVolume` (local
    //            stack; OpenSandbox's docker runtime maps claimName → volume).
    sandboxRuntime: sandbox.sandboxRuntime,
    reposBaseVolume: process.env.REPOS_BASE_VOLUME ?? "devbox-repos",
    // Filter discovery to snapshots whose name starts with this prefix. Our
    // periodic snapshotter names them `repos-<timestamp>`; override only if
    // a different stream should drive hydration.
    snapshotNamePrefix: process.env.SNAPSHOT_NAME_PREFIX ?? "repos-",
    reposMountPath: process.env.REPOS_MOUNT_PATH ?? "/workspace",
    pvcNamespace: sandbox.pvcNamespace,
    pvcStorageClass: sandbox.pvcStorageClass,
    pvcStorageSize: process.env.PVC_STORAGE_SIZE ?? "15Gi",
  },
  // /api settings. Parsed by apiConfig.ts; a bad value fails boot.
  api: parseApiConfig(process.env),
};
