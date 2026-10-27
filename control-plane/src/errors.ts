import type { ApiErrorCode } from "./types/api";

// Thrown by SandboxManager.createSandboxFromExistingPvc when the task's PVC no
// longer exists, for example after operator deletion or a retention job. runTask's
// recreate-from-PVC path lets it propagate to handleTaskError, which calls
// InboxService.deadLetterWorkspaceMissing to per-row dead-letter the task's open
// inbox rows (a missing workspace can't be resumed).
export class PvcNotFoundError extends Error {
  constructor(public pvcName: string) {
    super(`PVC "${pvcName}" not found`);
    this.name = "PvcNotFoundError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PvcNotFoundError);
    }
  }
}

// Thrown when a single reconcile-tick Files-API call (readHarnessFile /
// writeHarnessFile) outruns SandboxManager's reconcileFilesTimeoutMs. Bounds
// an individual call independently of the SDK's own requestTimeoutSeconds
// (kept long — 300s+ — for sandbox creation/PVC restore), so a hung upstream
// on THIS call can't block reconcileOne long enough to blow LEASE_TIMEOUT_MS.
// SandboxManager.isTransientSandboxError treats this the same as a 502/503/504:
// defer and retry next tick, don't fail the task.
export class SandboxFilesTimeoutError extends Error {
  constructor(
    public sandboxId: string,
    public timeoutMs: number,
  ) {
    super(`Files-API call to sandbox ${sandboxId} timed out after ${timeoutMs}ms`);
    this.name = "SandboxFilesTimeoutError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SandboxFilesTimeoutError);
    }
  }
}

// Thrown when provisioning fails before a sandbox id is persisted: Sandbox.create
// itself, the PVC probe / pod lookup in front of it, or the setSandboxId write
// after it — with the underlying error as `cause`. handleTaskError classifies on
// the cause: a transient server reply defers, anything else spends a durable
// retry unit. The sandbox that may already exist on the task's PVC is left
// alone; the next claim's recreate path adopts it instead of creating again.
export class SandboxCreateError extends Error {
  constructor(
    public taskId: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Sandbox.create failed for task ${taskId}: ${detail}`, { cause });
    this.name = "SandboxCreateError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SandboxCreateError);
    }
  }
}

// A request-level failure the API controller maps straight to its status and
// error body. The message is user-facing: never put internals in it.
export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409 | 500,
    public code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
