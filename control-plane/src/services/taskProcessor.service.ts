import type { SandboxInfo } from "@alibaba-group/opensandbox";
import { emitAction, emitThought, setIssueStarted } from "../clients/linear";
import { config } from "../config";
import type { Task } from "../db/schema";
import { PvcNotFoundError, SandboxCreateError } from "../errors";
import { SEND_TIMEOUT_MS, withTimeout } from "../integrations/http";
import type { Integration, IntegrationName } from "../integrations/types";
import { logger } from "../logger";
import type { InboxRepository } from "../repositories/inbox.repository";
import type { TaskRepository } from "../repositories/task.repository";
import type { EventDispatcher } from "./eventDispatcher";
import { extractExperimentalFlags } from "./experimentalFlags";
import type { InboxService } from "./inbox.service";
import type { LinearTokenProvider } from "./linearTokenProvider";
import type { ReplyHolds } from "./replyHolds";
import { type PodStatus, SandboxManager } from "./sandboxManager.service";
import type { SlackNotifierService } from "./slackNotifier.service";

// Reconcile loop. tick = heartbeat + idle reaper + reconcile-owned + claim.
// Replaces the status.json-polling state machine: the task's state is derived
// from owner_id + sandbox_id + pending inbox rows; per-task progress is the
// `tasks.last_observed_event_seq` cursor into events.jsonl.
export class TaskProcessorService {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private sleepAbort: AbortController | null = null;
  private readonly inflight = new Set<Promise<void>>();
  // First tick (per task) we saw the backing pod ABSENT (kubectl NotFound). A
  // pod can be briefly gone between create and scheduling, so absence gets a
  // grace window (config.sandboxAbsentGraceMs) before we fail. Cleared the
  // moment the pod reappears or the task reconciles cleanly.
  private readonly sandboxAbsentSince = new Map<string, number>();
  // First tick (per task) the reconcile path saw a *persistent* Files-API 5xx
  // with the pod still alive — execd data plane dead behind a live pod. A
  // momentary 5xx right after create is normal warm-up and we defer; one that
  // never clears would defer forever, so after config.sandboxFilesUnavailableFailMs
  // the task is failed. Cleared on the first clean reconcile.
  private readonly reconcileFilesUnavailableSince = new Map<string, number>();
  private readonly taskRepo: TaskRepository;
  private readonly inboxRepo: InboxRepository;
  private readonly linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">;
  private readonly sandboxManager: SandboxManager;
  private readonly eventDispatcher: EventDispatcher;
  private readonly inboxService: InboxService;
  private readonly slackNotifier: SlackNotifierService;
  private readonly integrations: Record<IntegrationName, Integration>;
  private readonly holds: ReplyHolds;
  // Sources this build has an integration for; claimNext and
  // listInFlightOwnedBy see only these tasks (§10).
  private readonly taskSources: Task["source"][];

  constructor(
    taskRepo: TaskRepository,
    inboxRepo: InboxRepository,
    linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">,
    sandboxManager: SandboxManager,
    eventDispatcher: EventDispatcher,
    inboxService: InboxService,
    slackNotifier: SlackNotifierService,
    integrations: Record<IntegrationName, Integration>,
    holds: ReplyHolds,
    taskSources: Task["source"][],
  ) {
    this.taskRepo = taskRepo;
    this.inboxRepo = inboxRepo;
    this.linearTokenProvider = linearTokenProvider;
    this.sandboxManager = sandboxManager;
    this.eventDispatcher = eventDispatcher;
    this.inboxService = inboxService;
    this.slackNotifier = slackNotifier;
    this.integrations = integrations;
    this.holds = holds;
    this.taskSources = taskSources;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.sleepAbort?.abort();

    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }

    const drain = Promise.allSettled([...this.inflight]);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, config.shutdownDrainMs));
    await Promise.race([drain, timeout]);

    // Backdate own heartbeat so any survivors become immediately reclaimable
    // instead of waiting the full LEASE_TIMEOUT_MS.
    await this.taskRepo.backdateHeartbeatsOwnedBy(config.podId).catch((err) => {
      logErr("shutdown heartbeat backdating failed", err);
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        logErr("poll tick failed", err);
      }
      if (!this.running) break;
      this.sleepAbort = new AbortController();
      await cancellableSleep(config.taskPollIntervalMs, this.sleepAbort.signal);
    }
  }

  private async tick(): Promise<void> {
    // 1. Heartbeat refresh — keep owned-task leases warm.
    await this.taskRepo.heartbeatOwnedBy(config.podId);

    // 2. Idle reaper — kill sandboxes idle past the ceiling, release leases.
    await this.reapIdle().catch((err) => logErr("reapIdle failed", err));

    // 3. Reconcile owned tasks with live sandboxes. Each task's lease is renewed
    //    right before its reconcile, so slow sends on earlier tasks can't let it
    //    outlive the lease mid-tick; 0 rows means a sibling took it over.
    const owned = await this.taskRepo.listInFlightOwnedBy(config.podId, this.taskSources);
    for (const task of owned) {
      const renewed = await this.taskRepo.heartbeatTask({ taskId: task.id, ownerId: config.podId });
      if (renewed.length === 0) {
        logger.info("lease lost before reconcile; skipping", { taskId: task.id });
        continue;
      }
      await this.reconcileOne(task)
        .then(() => {
          logger.debug("reconcileOne: succeeded", { taskId: task.id, sandboxId: task.sandboxId });
          this.onCleanReconcile(task);
        })
        .catch((err) => {
          logger.debug("reconcileOne: failed", {
            taskId: task.id,
            sandboxId: task.sandboxId,
            message: err instanceof Error ? err.message : String(err),
          });
          this.assessReconcileError(task, err);
        });
    }

    // Drop grace/window timers and reply holds for any task this pod no longer
    // owns (lease handed off, retried away, or terminally failed). Keyed by
    // task.id with no other GC, these Maps would otherwise leak for the process
    // lifetime AND let a stale `since` from a prior ownership epoch skip the
    // grace/window on a re-claimed task's first fault. `owned` is this tick's
    // owned, sandbox-bound set.
    const ownedIds = new Set(owned.map((t) => t.id));
    for (const id of this.sandboxAbsentSince.keys())
      if (!ownedIds.has(id)) this.sandboxAbsentSince.delete(id);
    for (const id of this.reconcileFilesUnavailableSince.keys())
      if (!ownedIds.has(id)) this.reconcileFilesUnavailableSince.delete(id);
    this.holds.retain(ownedIds);

    // 4. Claim new work (fresh-pending OR comment-pickup OR stale-lease
    //    takeover — single predicate).
    const claimed = await this.taskRepo.claimNext({
      ownerId: config.podId,
      leaseTimeoutMs: config.leaseTimeoutMs,
      maxConcurrentSandboxes: config.maxConcurrentSandboxes,
      sources: this.taskSources,
    });
    if (claimed) this.dispatch(claimed);
  }

  private async reapIdle(): Promise<void> {
    const reaped = await this.taskRepo.reapIdleTasks({
      ownerId: config.podId,
      leaseTimeoutMs: config.leaseTimeoutMs,
      idleMs: config.idleSandboxKillMs,
    });
    for (const row of reaped) {
      if (row.sandboxId) await this.killSandboxQuietly(row.sandboxId);
    }
  }

  // Sole kill wrapper — swallows errors (best-effort teardown). Used by the idle
  // reaper and by failTask so the kill `.catch` pattern lives in one place.
  private async killSandboxQuietly(sandboxId: string): Promise<void> {
    await this.sandboxManager.killSandbox(sandboxId).catch((e) => logErr("killSandbox failed", e));
  }

  private dispatch(task: Task): void {
    const p = this.runTask(task)
      .catch((err) => this.handleTaskError(task, err))
      // Nothing awaits p, so a throw from handleTaskError itself (e.g. a DB
      // error releasing the lease) would be an unhandled rejection. Log it.
      .catch((err) => logErr(`handleTaskError failed for task ${task.id}`, err))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  // Creates or attaches a sandbox. Branches on `sandbox_id` nullability:
  // (sandbox_id=null) is a fresh provision; (sandbox_id set) is an adoption.
  //
  // Linear and API tasks share this path; Linear-only emits are gated below.
  private async runTask(task: Task): Promise<void> {
    if (task.sandboxId) {
      // Adoption — resume the existing sandbox. Attach is best-effort: a failure
      // here (404 for a gone sandbox, a transient connect blip) does NOT fail the
      // task. The next reconcile tick is the single owner of liveness — its error
      // handler reads the pod (absent → grace, terminal → fail) — so we just log
      // and let reconcile assess.
      await this.sandboxManager
        .attachSandbox(task.sandboxId)
        .catch((err) =>
          logErr(`attachSandbox(${task.sandboxId}) failed; reconcile will assess`, err),
        );
      return;
    }

    // Provisioning — recreate-from-PVC (resume) OR fresh. This is pure WORK: it
    // RAISES on any failure and the dispatch `.catch` → handleTaskError is the
    // single place that classifies it (pruned PVC → dead-letter, transient →
    // defer, else → fail). The only `try`s below are resource-teardown that needs
    // create-call locals, and they re-throw so handleTaskError still runs.
    if (task.pvcName) {
      // Recreate-from-PVC: the sandbox is gone (idle reaper, PR-closed, or a
      // failed sandbox being retried) but the PVC is preserved. A claimed task
      // always owes work, so ALWAYS spin a fresh sandbox against that PVC, persist
      // it, then deliver any pending rows — 'delivered' rows resume from the
      // workspace the PVC carries.
      const sandboxId = await this.sandboxManager.createSandboxFromExistingPvc({
        taskId: task.id,
        externalId: task.externalId,
        source: task.source,
        pvcName: task.pvcName,
        experimentalFlags: extractExperimentalFlags(task.metadata),
      });
      // Never kill the sandbox on a failure here — with adoption it may already
      // be a peer's. It stays on the task's PVC for the next provision to adopt.
      const claimed = await this.taskRepo.setSandboxId({
        taskId: task.id,
        ownerId: config.podId,
        sandboxId,
      });
      if (claimed.length === 0) {
        // Lease reclaimed mid-recreate — self-evict. The sandbox stays for the new
        // owner to adopt (never kill here: with adoption it may be theirs already).
        logger.info("setSandboxId lost lease mid-recreate; self-evicting", {
          taskId: task.id,
          sandboxId,
        });
        return;
      }
      // sandbox_id is now persisted, so a sweep throw is classified by
      // handleTaskError like any other: transient → defer (releaseLeaseIfNoSandbox
      // no-ops since the sandbox is present, next tick re-sweeps); non-transient →
      // failTask, which kills the persisted sandbox (it reads sandbox_id from the
      // DB, not this stale closure) — no leak, no local teardown needed.
      await this.inboxService.sweepUndelivered({ ...task, sandboxId });
      return;
    }

    // Fresh provision. Linear tasks: assert issue state + lifecycle emits on
    // the agent session. API tasks have no Linear surface; their log gets
    // sandbox_started from attachSandboxResources instead.
    const isLinear = task.source === "linear";
    if (isLinear) {
      try {
        const client = await this.linearTokenProvider.getAuthorizedLinearClient();
        await setIssueStarted(client, task.externalId);
      } catch (err) {
        logErr(`setIssueStarted failed for task ${task.id}`, err);
      }
    }

    // Reply target id on the assignment inbox row is the canonical destination
    // for task-scoped lifecycle emits. A claimed task must have an assignment
    // row (claimNext requires at least one non-terminal inbox row, and the
    // `created` path always inserts one) — a missing target id means the row
    // was deleted out from under us, which is a hard invariant break.
    const replyTargetId = await this.inboxRepo.getAssignmentReplyTargetId(task.id);
    if (!replyTargetId) {
      throw new Error(`runTask: assignment inbox row missing reply target for task ${task.id}`);
    }
    if (isLinear) {
      try {
        const client = await this.linearTokenProvider.getAuthorizedLinearClient();
        await emitAction(client, replyTargetId, "Provisioning", "infra");
      } catch (err) {
        logErr(`emitAction(Provisioning) failed for task ${task.id}`, err);
      }
    }

    // WORKSPACE is the only task-specific input passed at creation; the daemon
    // derives its .harness dir from it and reads everything else from the inbox file
    // payload.
    const { sandboxId, pvcName } = await this.sandboxManager.createSandboxWithPvc({
      taskId: task.id,
      externalId: task.externalId,
      source: task.source,
      metadata: task.metadata,
      experimentalFlags: extractExperimentalFlags(task.metadata),
    });

    // createSandboxWithPvc has succeeded, so a real sandbox exists and a PVC
    // was minted. Everything from here until the resources
    // are persisted must clean those up on ANY failure. attachSandboxResources
    // returning 0 rows (lost lease) is one such failure; a THROW from it (e.g. a
    // transient DB error) is another — without this try/catch that throw would
    // escape to handleTaskError → failTask. failTask kills the task's sandbox by
    // reading sandbox_id from the DB, but attachSandboxResources is the call that
    // persists it — on its failure the DB sandbox_id is still NULL, so failTask
    // can't reach the created sandbox + minted PVC. Tear them down here using the
    // locals from the create call.
    try {
      const advanced = await this.taskRepo.attachSandboxResources({
        taskId: task.id,
        ownerId: config.podId,
        sandboxId,
        pvcName,
      });
      if (advanced.length === 0) {
        // Lost ownership between create and persist — the sandbox is orphaned.
        // Tear down the PVC we just minted.
        await this.sandboxManager.closeSandboxAndDeletePvc(sandboxId, pvcName).catch((err) => {
          logErr(`pvc_leak: closeSandboxAndDeletePvc(${sandboxId}, ${pvcName}) failed`, err);
        });
        return;
      }

      if (isLinear) {
        try {
          const client = await this.linearTokenProvider.getAuthorizedLinearClient();
          await emitThought(
            client,
            replyTargetId,
            `Sandbox provisioned.\n- sandboxId: \`${sandboxId}\`\n- pvcName: \`${pvcName}\``,
          );
        } catch (err) {
          logErr(`emitThought(provisioned-ids) failed for task ${task.id}`, err);
        }
      }
      // No further Linear emit here — the daemon emits the Planning action via
      // events.jsonl once it starts processing the inbox file.
    } catch (err) {
      // A throw after a successful create (e.g. attachSandboxResources hit a
      // transient DB error). The created sandbox + minted PVC would otherwise
      // leak — failTask kills the task's DB sandbox_id, still NULL here because
      // attachSandboxResources (the persist) failed. Tear them down with the
      // create-call locals, then re-throw so handleTaskError still classifies +
      // handles the error.
      await this.sandboxManager
        .closeSandboxAndDeletePvc(sandboxId, pvcName)
        .catch((teardownErr) => {
          logErr(
            `pvc_leak: closeSandboxAndDeletePvc(${sandboxId}, ${pvcName}) failed after attach error`,
            teardownErr,
          );
        });
      throw err;
    }
  }

  // Reconcile is pure WORK. It contains NO error handling — no try/catch, no
  // `.catch`. It does the happy-path operations and RAISES on any problem; the
  // single tick `.catch` → assessReconcileError is the one place that detects and
  // handles every fault (it reads the k8s pod to classify liveness). A dead /
  // absent sandbox surfaces here as a thrown error from getSandboxInfo / sweep /
  // readEvents and propagates straight through, untouched.
  private async reconcileOne(task: Task): Promise<void> {
    logger.debug("reconcileOne: entry", { taskId: task.id, sandboxId: task.sandboxId });

    // Reaped tasks (sandbox_id NULL, PVC preserved) are resumed by the
    // recreate-from-PVC sweep on a new inbox row, not here.
    if (!task.sandboxId) return;

    // Ownership precondition — must gate BEFORE sweep: the sandbox's create-time
    // `task_id` tag has to be ours, else a sibling task owns it and sweeping inbox
    // files / reading events.jsonl would cross-contaminate the two tasks. On a
    // mismatch, fail WITHOUT killing (a sibling owns it). getSandboxInfo itself is
    // NOT caught — if it throws (dead/unreachable sandbox) it propagates to the
    // handler, which reads the pod to decide.
    const info = await this.sandboxManager.getSandboxInfo(task.sandboxId);
    const owner = info.metadata?.task_id;
    if (owner && owner !== task.id) return this.failCrossedBinding(task, info);

    // Sweep: deliver any undelivered inbox rows to the sandbox.
    await this.inboxService.sweepUndelivered(task);

    // A held event waiting out its Retry-After: skip this task's events this
    // tick (the sweep above still hands new rounds to the sandbox).
    if (this.holds.waiting(task.id)) return;

    // Read events.jsonl since cursor; dispatch each new event. Re-fetch the
    //    task between events because dispatcher cases mutate task state
    //    (appendPrUrl, setSandboxId).
    let currentTask: Task | null = task;
    const events = await this.sandboxManager.readEvents(task.sandboxId, task.lastObservedEventSeq);
    for (const event of events) {
      if (currentTask === null) break; // self-evict: lease lost or task gone

      const result = await this.eventDispatcher.handle(event, currentTask);
      switch (result) {
        case "ok":
        case "dropped":
          break;
        case "hold":
          // A send failed before anything went out. Stop BEFORE advancing the
          // cursor and return normally (not a reconcile error): the event is
          // retried on a later tick, and nothing after it runs ahead of it.
          return;
        case "self_evict":
          // An owner-guarded write inside the dispatcher (e.g. appendPrUrl)
          // returned 0 rows — the lease was taken over mid-tick. Stop BEFORE
          // advancing the cursor: a sibling pod owns this task and will resume
          // from its own cursor.
          logger.info("dispatcher self-evicted (lease lost); stopping reconcile", {
            taskId: currentTask.id,
            seq: event.seq,
          });
          return;
        case "abort":
          // The dispatcher found a foreign durable event in this task's stream (a
          // cross-task leak). Stop here WITHOUT advancing the cursor — we neither
          // apply nor skip past the leaked event. The task intentionally halts
          // (and re-logs each tick) so the leak surfaces for an operator rather
          // than being silently absorbed. Detail is in `cross_task_leak_detected`.
          logger.error("reconcile halted: cross-task leak detected; not advancing cursor", {
            event: "reconcile_halted_cross_task_leak",
            taskId: currentTask.id,
            taskExternalId: currentTask.externalId,
            sandboxId: currentTask.sandboxId,
            podId: config.podId,
            seq: event.seq,
          });
          return;
        default: {
          const _exhaustive: never = result;
          void _exhaustive;
        }
      }

      const advanced = await this.taskRepo.recordEventCursor({
        taskId: currentTask.id,
        ownerId: config.podId,
        event,
      });
      if (advanced.length === 0) {
        // Owner-guard failed: lease taken over, OR cursor regression attempt.
        // Self-evict: a sibling pod will resume from its cursor.
        logger.info("cursor advance failed (lease lost or stale); self-evicting", {
          taskId: currentTask.id,
          seq: event.seq,
        });
        break;
      }
      // The cursor is past any held event now.
      this.holds.release(currentTask.id);
      // A dropped send (timed out or failed for good) ends this task's events
      // for the tick, so a slow or failing platform can't eat the tick.
      if (result === "dropped") break;

      // Re-fetch (owner-scoped) to pick up dispatcher mutations (pr_urls
      // append, etc.). An owner-scoped fetch returns null on a takeover in the
      // gap, so the next iteration self-evicts before the next handle().
      currentTask = await this.taskRepo.getByIdOwnedBy(currentTask.id, config.podId);
    }
  }

  // THE single error-detection-and-handling function for reconcile failures. The
  // tick funnels every reconcileOne throw here; nothing else decides defer-vs-fail.
  // (Crossed binding is the one exception — it's a pre-sweep precondition handled
  // inline in reconcileOne, since it must gate before sweep.)
  //
  //   1. transient Files-API 5xx → execd warming up (defer within the window) or
  //      dead behind a live pod (fail past it). Handled FIRST and WITHOUT a pod
  //      read — this is the common warm-up case right after create, fired every
  //      tick, so the hot path must not fork kubectl.
  //   2. otherwise read the k8s pod (lazily, only for non-transient failures):
  //      terminal (Failed/Succeeded) → failTask; absent → grace then failTask.
  //   3. anything else (a code bug, an odd file error) → log + retry; never fail.
  private async assessReconcileError(task: Task, err: unknown): Promise<void> {
    if (SandboxManager.isTransientSandboxError(err)) {
      await this.deferOrFailFilesWindow(task, err);
      return;
    }

    // Non-transient failure — ask k8s what the backing pod is doing. sandboxId is
    // always set here (reconcileOne early-returns when it's null, and
    // listInFlightOwnedBy yields only sandbox-bound tasks); the guard just narrows
    // the type — the repo lints against a `!` assertion.
    if (!task.sandboxId) return;

    const pod = await this.sandboxManager.getSandboxPodStatus(task.sandboxId);
    if (pod) {
      // Absent → grace window before failing (a pod can be briefly gone before it
      // schedules). Present + terminal phase (Failed/Succeeded) → fail now.
      if (!pod.exists) return this.deferOrFailAbsent(task, pod);
      // Pod is confirmed PRESENT — any absent-grace timer from an earlier tick is
      // stale; drop it on BOTH the terminal and the alive-but-still-failing paths,
      // else a later absence would read the old `since` and fail before its grace.
      this.sandboxAbsentSince.delete(task.id);
      if (pod.phase === "Failed" || pod.phase === "Succeeded") {
        await this.retryTask(task, {
          event: pod.oomKilled ? "sandbox_oom" : "sandbox_pod_terminal",
          giveUpMessage: podFailureMessage(pod),
          logFields: {
            podPhase: pod.phase,
            terminatedReason: pod.terminatedReason ?? null,
            exitCode: pod.exitCode ?? null,
            oomKilled: pod.oomKilled,
          },
        });
        return;
      }
    }
    this.reconcileFilesUnavailableSince.delete(task.id);
    logErr(`reconcile failed for task ${task.id}`, err);
  }

  // Crossed binding: the sandbox's create-time task_id tag belongs to another
  // task. Fail WITHOUT killing (it's not ours to kill), and log enough identifiers
  // to compare the bound task with the sandbox's owner tags and live state.
  private async failCrossedBinding(task: Task, info: SandboxInfo): Promise<void> {
    logger.error("crossed_sandbox_binding: sandbox task_id tag does not match its bound task", {
      event: "crossed_sandbox_binding",
      podId: config.podId,
      taskId: task.id,
      taskExternalId: task.externalId,
      taskExternalUrl: task.externalUrl,
      taskPvcName: task.pvcName,
      taskOwnerId: task.ownerId,
      taskLastObservedEventSeq: task.lastObservedEventSeq,
      taskUpdatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : null,
      sandboxId: task.sandboxId,
      sandboxOwnerTaskId: info.metadata?.task_id ?? null,
      sandboxOwnerExternalId: info.metadata?.external_id ?? null,
      sandboxOwnerSource: info.metadata?.source ?? null,
      sandboxMetadata: info.metadata ?? null,
      sandboxState: info.status?.state ?? null,
      sandboxStateReason: info.status?.reason ?? null,
      sandboxExpiresAt: info.expiresAt instanceof Date ? info.expiresAt.toISOString() : null,
      action: "failing task without killing sandbox (a sibling task owns it)",
    });
    await this.failTask(task, CROSSED_BINDING_MESSAGE, { killSandbox: false }).catch((e) =>
      logErr(`failTask (crossed-binding) failed for task ${task.id}`, e),
    );
  }

  // Absent backing pod (kubectl NotFound). A pod can be briefly gone before it
  // schedules, so the first sighting only starts a grace window; once
  // config.sandboxAbsentGraceMs elapses the task is failed. The grace timer is
  // cleared the moment the pod reappears (a clean reconcile → onCleanReconcile).
  private async deferOrFailAbsent(task: Task, pod: PodStatus): Promise<void> {
    const now = Date.now();
    const since = this.sandboxAbsentSince.get(task.id);
    if (since === undefined) {
      this.sandboxAbsentSince.set(task.id, now);
      logger.warn(`sandbox pod absent for task ${task.id}; starting grace window`, {
        event: "sandbox_pod_absent",
        taskId: task.id,
        taskExternalId: task.externalId,
        sandboxId: task.sandboxId,
        podId: config.podId,
        graceMs: config.sandboxAbsentGraceMs,
      });
      return;
    }
    if (now - since < config.sandboxAbsentGraceMs) return;
    this.sandboxAbsentSince.delete(task.id);
    await this.retryTask(task, {
      event: "sandbox_pod_absent",
      giveUpMessage: podFailureMessage(pod),
      logFields: { podPhase: "absent", graceMs: config.sandboxAbsentGraceMs },
    });
  }

  // Transient Files-API 5xx — execd warming up right after create (defer) or dead
  // behind a still-serving pod (fail once the window elapses). No pod read here:
  // this is the per-tick warm-up hot path, kept kubectl-free on purpose. Window
  // measured from the FIRST consecutive 5xx; a clean reconcile resets it. NOTE:
  // because we don't read the pod here, an OOM/terminal pod whose execd returns
  // 5xx fails at window-expiry with the generic message, not a fast OOM-specific
  // one (the trade for keeping warm-up cheap).
  private async deferOrFailFilesWindow(task: Task, _err: unknown): Promise<void> {
    const now = Date.now();
    const since = this.reconcileFilesUnavailableSince.get(task.id) ?? now;
    this.reconcileFilesUnavailableSince.set(task.id, since);
    const unavailableForMs = now - since;

    if (unavailableForMs < config.sandboxFilesUnavailableFailMs) {
      return;
    }

    this.reconcileFilesUnavailableSince.delete(task.id);
    await this.retryTask(task, {
      event: "sandbox_files_unavailable",
      giveUpMessage: FILES_UNAVAILABLE_MESSAGE,
      logFields: { unavailableForMs },
    });
  }

  // Reset per-task reconcile state after a CLEAN reconcile (no throw). A clean
  // reconcile means the pod is back and serving — clear the in-memory absent-pod
  // grace and Files-API window so a future blip starts a fresh timer. The DURABLE
  // metadata.retryCount is NOT cleared here: it is a lifetime sandbox-failure
  // budget bounded by maxTaskRetries, reset only by a genuine re-delegation
  // (restartTaskWithInbox). Resetting it on any clean tick let an OOM / crash-
  // after-progress sandbox wipe its budget each cycle and retry forever (a clean
  // tick reliably occurs between re-provision and the eventual crash).
  private onCleanReconcile(task: Task): void {
    this.reconcileFilesUnavailableSince.delete(task.id);
    this.sandboxAbsentSince.delete(task.id);
  }

  // Retry a task whose SANDBOX failed transiently (terminal/absent pod, dead
  // execd) instead of failing it: kill the dead sandbox and RESUME on the same
  // PVC. requeueForRetry keeps pvc_name / cursor / pr_urls (only drops sandbox_id)
  // and RELEASES the lease, so claimNext re-provisions the task from the preserved
  // workspace — on this pod or another, within the concurrency cap — rather than
  // starting clean. Bounded by a DURABLE per-task counter in tasks.metadata
  // (`retryCount`) — read from the task we loaded this tick, bumped atomically
  // inside requeueForRetry. It is a LIFETIME failure budget: NOT reset on a clean
  // reconcile (that let an OOM-after-progress loop run forever), only by a genuine
  // re-delegation (restartTaskWithInbox). The durability is what lets us release
  // the lease safely: the cap stays fleet-wide across the handoff.
  // Past config.maxTaskRetries we give up and failTask with the caller's message.
  // The structured `event` + `logFields` describe the failure; retryTask adds the
  // attempt count.
  private async retryTask(
    task: Task,
    opts: { event: string; giveUpMessage: string; logFields: Record<string, unknown> },
  ): Promise<void> {
    // The closure is from tick start (listInFlightOwnedBy); the files-unavailable /
    // absent-grace windows that lead here span multiple ticks and can outlast the
    // lease, so by now another pod may have taken over this task and ADOPTED its
    // sandbox. Re-read owner-scoped before any kill: a lease-losing pod must NOT
    // kill a sandbox a sibling is actively using. Mirrors failTask's getByIdOwnedBy
    // guard. (While we still own the task its sandbox_id can't change under us —
    // reconcile never re-provisions an owned task — so the closure's sandboxId is
    // the live one; the re-read only decides WHETHER we still own it.)
    const current = await this.taskRepo.getByIdOwnedBy(task.id, config.podId).catch((e) => {
      logErr(`retryTask: getByIdOwnedBy failed for ${task.id}`, e);
      return null;
    });
    if (!current) return; // lease lost (or task gone) — a sibling owns it; don't kill/requeue

    const attempt = retryCountOf(task.metadata) + 1;
    const base = {
      event: opts.event,
      taskId: task.id,
      taskExternalId: task.externalId,
      sandboxId: task.sandboxId,
      podId: config.podId,
      ...opts.logFields,
    };

    // No surviving non-terminal inbox row → the task's work is already complete or
    // fully dead-lettered; there is nothing to resume. Requeuing would STRAND it
    // (claimNext needs a 'pending'/'delivered' row; reconcile + the idle reaper
    // need sandbox_id IS NOT NULL — none would ever re-pick it) and leak the minted
    // PVC. Treat the dead sandbox as a clean terminal — kill it and release the
    // lease (clearing sandbox_id), exactly as the idle reaper would have — WITHOUT
    // burning a retry-budget unit on finished work. On a list error → null → fall
    // through to the normal retry path rather than risk skipping a real resume.
    const surviving = await this.inboxRepo.listNonTerminalByTask(task.id).catch((e) => {
      logErr(`retryTask: listNonTerminalByTask failed for ${task.id}`, e);
      return null;
    });
    if (surviving && surviving.length === 0) {
      // Kill BEFORE clearing sandbox_id — same discipline as the retry branch
      // below. releaseLease(alsoClearSandbox) nulls sandbox_id, after which nothing
      // can find this sandbox to kill it (reaper + reconcile filter sandbox_id IS
      // NOT NULL). So if we cleared first and the kill had silently failed, a still-
      // live sandbox would leak until its TTL and (RWO PVC) block re-provision. Kill
      // directly (not the swallowing killSandboxQuietly); on a non-404 failure log
      // and return WITHOUT releasing, so the next reconcile tick re-attempts.
      if (task.sandboxId) {
        try {
          await this.sandboxManager.killSandbox(task.sandboxId);
        } catch (e) {
          logErr(`retryTask: killSandbox (no surviving work) failed for ${task.id}; deferring`, e);
          return;
        }
      }
      await this.taskRepo
        .releaseLease({ taskId: task.id, ownerId: config.podId, alsoClearSandbox: true })
        .catch((e) =>
          logErr(`retryTask: releaseLease (no surviving work) failed for ${task.id}`, e),
        );
      logger.info(`sandbox died with no surviving work for task ${task.id}; clean terminal`, base);
      return;
    }

    if (attempt > config.maxTaskRetries) {
      logger.error(`sandbox failed for task ${task.id}; retries exhausted, failing`, {
        ...base,
        retriesExhausted: true,
        maxTaskRetries: config.maxTaskRetries,
      });
      await this.failTask(task, opts.giveUpMessage).catch((e) =>
        logErr(`failTask (retries-exhausted) failed for task ${task.id}`, e),
      );
      return;
    }

    logger.warn(`sandbox failed for task ${task.id}; retrying (attempt ${attempt})`, {
      ...base,
      attempt,
      maxTaskRetries: config.maxTaskRetries,
    });

    // Kill the dead sandbox BEFORE releasing the lease / clearing sandbox_id.
    // requeueForRetry NULLs sandbox_id and releases the lease, after which NO code
    // path can find this sandbox to kill it (reconcile + the idle reaper both
    // filter `sandbox_id IS NOT NULL`, and failTask reads the *current* id). So if
    // we cleared first and the kill then failed (swallowed), the live pod would be
    // orphaned until its server-side TTL — and, on an RWO PVC, would block the
    // re-provision from mounting the same volume. killSandbox returns on a 404
    // (already gone) and throws otherwise: on a non-404 failure we DON'T requeue,
    // leaving the lease + sandbox_id in place so the next reconcile tick re-attempts
    // the kill (the sandbox stays reachable). task.sandboxId is set for our own
    // terminal/absent/dead-execd sandbox and null on the create-failure path
    // (nothing was persisted; the recreate sweep handles the server-side leftover).
    if (task.sandboxId) {
      try {
        await this.sandboxManager.killSandbox(task.sandboxId);
      } catch (e) {
        logErr(`retryTask: killSandbox failed for task ${task.id}; deferring retry`, e);
        return;
      }
    }

    const requeued = await this.taskRepo
      .requeueForRetry({ taskId: task.id, ownerId: config.podId, retryCount: attempt })
      .catch((e) => {
        logErr(`requeueForRetry failed for task ${task.id}`, e);
        return false;
      });
    if (!requeued) {
      // Lease lost (a sibling pod took over) or the reset failed — self-evict.
      // The durable count stays in metadata for whoever owns the task next.
      return;
    }
    // requeueForRetry released the lease, so the task is back in the claim pool
    // with a pending row + preserved PVC — claimNext re-provisions it (here or on
    // another pod, within the concurrency cap). The dead sandbox is already killed
    // (above). Drop our in-memory grace timers for a task we no longer own.
    this.sandboxAbsentSince.delete(task.id);
    this.reconcileFilesUnavailableSince.delete(task.id);
  }

  private async releaseLeaseIfNoSandbox(taskId: string, reason: string): Promise<void> {
    const latest = await this.taskRepo.getByIdOwnedBy(taskId, config.podId);
    if (!latest) return;
    if (latest.sandboxId !== null) {
      logger.info(`skipping lease release after ${reason}; sandbox already assigned`, { taskId });
      return;
    }
    await this.taskRepo.releaseLease({ taskId, ownerId: config.podId });
    logger.info(`released lease after ${reason}`, { taskId });
  }

  // Hard task failure (provision failure, sandbox timeout/crash, sandbox
  // unreachable). Dead-letter the task's open inbox rows, tell every reply
  // target on the rows this call dead-lettered why their round didn't complete
  // (each @harness comment + the Linear session), kill the sandbox, release the
  // lease. The dead-letter is what keeps the task from wedging: a
  // 'pending'/'delivered' row left behind is un-claimable to no end (claimNext
  // needs 'pending' but the task has no sandbox) and pins the idle reaper.
  // killSandbox=false is for a crossed binding: the sandbox isn't ours to kill (a
  // sibling task owns it). We still dead-letter our rows + release the lease
  // (which clears our sandbox_id), so the task fails cleanly. The structured
  // failure log lives at each call site (with its pod/forensic detail); failTask
  // only does the dead-letter, broadcast + teardown.
  private async failTask(
    task: Task,
    message: string,
    opts: { killSandbox?: boolean } = {},
  ): Promise<void> {
    const { killSandbox = true } = opts;
    const nonTerminal = await this.inboxRepo
      .listNonTerminalByTask(task.id)
      .catch((e): Awaited<ReturnType<InboxRepository["listNonTerminalByTask"]>> => {
        logErr(`failTask: listNonTerminalByTask failed for ${task.id}`, e);
        return [];
      });
    // Dead-letter the inbox rows FIRST, and BEFORE releaseLease — failTaskInbox
    // is owner-guarded and needs owner_id still set. Only the rows it
    // transitions get a failure message, so a racing restart or a late
    // `completed` can't draw a "Task failed" on a live or finished round.
    const failed = await this.inboxRepo
      .failTaskInbox({ taskId: task.id, ownerId: config.podId, reason: message })
      .catch((e) => {
        logErr(`failTaskInbox failed for task ${task.id}`, e);
        return [] as { id: string }[];
      });
    const failedIds = new Set(failed.map((r) => r.id));
    const failedRows = nonTerminal.filter((r) => failedIds.has(r.id));
    if (failed.length > 0) {
      logger.warn("inbox rows dead-lettered on task failure", {
        taskId: task.id,
        inboxIds: failed.map((r) => r.id),
        reason: message,
      });
    }

    // Dedupe by target id — a Linear-source task has many rows sharing the
    // same linear_session target id; posting once per id keeps the user from
    // seeing the same error N times. At most once: there is no cursor to hold,
    // so a delivery error (RetryableError included) is logged and dropped.
    const seen = new Set<string>();
    for (const row of failedRows) {
      // A source this build has no integration for (say, rows written by a
      // newer build before a rollback) gets no notice; its row is still failed.
      const integration: Integration | undefined = this.integrations[row.source];
      if (!integration) {
        logger.warn("failTask: no integration for the row's source; notice skipped", {
          taskId: task.id,
          inboxId: row.id,
          source: row.source,
        });
        continue;
      }
      for (const t of row.reply_targets) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        await withTimeout(SEND_TIMEOUT_MS, (signal) =>
          integration.deliver({ signal, log: logger }, t, {
            type: "failure",
            cause: "task_failed",
            round: row,
            summary: message,
          }),
        ).catch((e) => logErr(`failTask: post to ${t.spec.kind} target ${t.id} failed`, e));
      }
    }

    // Kill the sandbox the task ACTUALLY holds, read from the DB — NOT the
    // dispatch-time `task` closure, whose sandbox_id can be stale (a recreate
    // persists a fresh sandbox_id via setSandboxId after dispatch; the closure
    // still reads null, so killing it would leak the live sandbox). Owner-scoped:
    // null on a takeover means a sibling now owns it and we must not kill it.
    if (killSandbox) {
      const current = await this.taskRepo.getByIdOwnedBy(task.id, config.podId);
      if (current?.sandboxId) await this.killSandboxQuietly(current.sandboxId);
    }
    // Slack failure update to the configured channel. Gated on the ASSIGNMENT
    // (top-level) round being among the rows just dead-lettered, mirroring the
    // completion path's kind === "assignment" gate in eventDispatcher. Without
    // this, a failing follow-up comment/review/ci_result round (a new inbox row
    // on the SAME Linear task, appended after the assignment already completed
    // and posted "✅ devbox completed") would post a contradictory "❌ devbox
    // failed" into that same thread — only the top-level delegated task should
    // ever notify Slack. Tying it to this failTaskInbox transition also keeps it
    // at-most-once. Fire-and-forget: a Slack outage must not affect teardown;
    // the notifier no-ops when Slack is disabled.
    if (failedRows.some((r) => r.kind === "assignment") && task.source === "linear") {
      const client = await this.linearTokenProvider.getAuthorizedLinearClient().catch((e) => {
        logErr("failTask: getAuthorizedLinearClient failed", e);
        return null;
      });
      if (client) {
        void this.slackNotifier
          .notifyTerminal(client, task, "failed", message)
          .catch((e) => logErr(`slack failure notify failed for task ${task.id}`, e));
      }
    }
    await this.taskRepo.releaseLease({
      taskId: task.id,
      ownerId: config.podId,
      alsoClearSandbox: true,
    });
  }

  // THE single classifier for everything runTask raises (it's the dispatch
  // `.catch`). runTask is pure work; this is the only place that decides what a
  // provisioning failure means:
  //   1. pruned PVC → dead-letter the task's open rows + release (can't resume).
  //   2. transient warm-up blip → defer. releaseLeaseIfNoSandbox releases ONLY
  //      when no sandbox got persisted, so a sweep throw after a persisted
  //      recreate keeps its lease + sandbox for the next reconcile tick.
  //   3. anything else → fail. Raw err.message can carry URL/token bits, so it
  //      stays in server logs only; the user sees a generic message.
  private async handleTaskError(task: Task, err: unknown): Promise<void> {
    if (err instanceof PvcNotFoundError) {
      // A throw here (a DB error) must not skip the release: an unreleased lease
      // with no sandbox stays heartbeated by this pod and is never re-claimed.
      await this.inboxService
        .deadLetterWorkspaceMissing(task)
        .catch((e) => logErr(`deadLetterWorkspaceMissing failed for task ${task.id}`, e));
      await this.taskRepo
        .releaseLease({ taskId: task.id, ownerId: config.podId, alsoClearSandbox: true })
        .catch((e) => logErr(`releaseLease after workspace-missing failed for task ${task.id}`, e));
      return;
    }
    if (err instanceof SandboxCreateError) {
      // Provisioning failed before a sandbox id was persisted (create, the PVC
      // probe / pod lookup in front of it, or the setSandboxId write). A transient
      // server reply (502/503/504) defers like any warm-up blip: no budget spent,
      // the next tick tries again, which rides out a server rollout. Everything
      // else — a client-side abort (Bun's 300s fetch cap, the SDK timer, a
      // dropped connection; the server may still finish that sandbox) or any
      // other reply — spends a durable retry unit: requeueForRetry releases the
      // lease with pvc_name intact and the next claim adopts the leftover instead
      // of creating again. A bad request (4xx) costs a few wasted attempts, which
      // beats losing a task to a cause this classifier didn't anticipate.
      // Deliberately NOT the budget-less defer branch below — that would loop a
      // 300s timeout forever.
      if (SandboxManager.isTransientSandboxError(err.cause)) {
        logErr(`provision deferred for task ${task.id} (server replied 5xx)`, err);
        await this.releaseLeaseIfNoSandbox(task.id, "deferred provision");
        return;
      }
      logErr(`provisioning failed for task ${task.id}; spending a retry unit`, err);
      await this.retryTask(task, {
        event: "sandbox_create_failed",
        giveUpMessage: PROVISION_FAILED_MESSAGE,
        logFields: { message: err.message },
      });
      return;
    }
    if (SandboxManager.isTransientSandboxError(err)) {
      logErr(`provision deferred for task ${task.id} (sandbox warming up)`, err);
      await this.releaseLeaseIfNoSandbox(task.id, "deferred provision");
      return;
    }
    logErr(`runTask failed for task ${task.id}`, err);
    // failTask dead-letters the task's inbox rows (failTaskInbox) — without that
    // the still-'pending' row would be re-claimed next tick into the same
    // provision failure, an unbounded claim→provision→fail loop. 1-strike: a
    // one-off transient provision failure dead-letters the task just like a
    // persistent one.
    await this.failTask(task, PROVISION_FAILED_MESSAGE).catch((e) =>
      logErr(`failTask itself failed for task ${task.id}`, e),
    );
  }
}

// ──────────────────── module-private helpers ────────────────────

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function logErr(msg: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(msg, { message: e.message, stack: e.stack });
}

// Durable per-task sandbox-failure retry count, read from tasks.metadata. Absent
// / malformed reads as 0 so a missing key (fresh task, re-delegation that reset
// metadata) starts a clean budget. Written by requeueForRetry; a LIFETIME counter
// reset only by a re-delegation (restartTaskWithInbox), never on a clean reconcile.
function retryCountOf(metadata: unknown): number {
  if (metadata && typeof metadata === "object" && "retryCount" in metadata) {
    const v = (metadata as { retryCount?: unknown }).retryCount;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  }
  return 0;
}

// ──────────────────── user-facing failure messages ────────────────────
// No internal details (exit codes, reasons, log pointers) leak to the user —
// those go to the structured server logs at each call site.

const PROVISION_FAILED_MESSAGE = "Task failed — check control-plane logs for details.";
const FILES_UNAVAILABLE_MESSAGE =
  "Sandbox became unreachable (its file API was unavailable too long).";
const CROSSED_BINDING_MESSAGE =
  "Sandbox binding was crossed (infrastructure issue); check control-plane logs for details.";

// Terminal-pod message (absent OR terminal-phase pod). OOM gets a specific,
// actionable line — it's the common, confusing case (and `oomKilled` can be a
// false negative for nested/child OOMs; see clients/k8s.ts).
function podFailureMessage(pod: PodStatus): string {
  if (pod.oomKilled) {
    return (
      "The sandbox ran out of memory and was killed (it hit its " +
      `${config.opensandbox.sandboxResourceMemory} memory limit). ` +
      "Reduce the task's memory use or raise the sandbox memory limit, then re-delegate the task to retry."
    );
  }
  if (!pod.exists) {
    return "The sandbox was terminated and no longer exists. Re-delegate the task to retry.";
  }
  return "The sandbox stopped unexpectedly. Re-delegate the task to retry.";
}
