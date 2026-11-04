import type { Task } from "../db/schema";
import type { IntegrationName, Person, TaskSource } from "../integrations/types";
import { logger } from "../logger";
import {
  type InboxRepository,
  type NewInboxMessage,
  type ReplyTarget,
  type ReplyTargetSpec,
  taskIdentity,
} from "../repositories/inbox.repository";
import type { TaskRepository } from "../repositories/task.repository";
import type {
  CiResultPayload,
  CommentPayload,
  ReviewPayload,
  TaskIdentity,
} from "../types/inboxMessage";
import type { IntegrationHooks } from "./integrationHooks";
import type { SandboxManager } from "./sandboxManager.service";

// The only way integrations create work. Each instance is bound to one
// source: the tasks and rounds it creates are that source's, and so are the
// reply targets they carry.

export type TaskRef = { id: string; key: string };

// A follow-up round as its integration builds it. The payloads are what the
// harness reads; the task identity is stamped here.
export type RoundDraft =
  | { kind: "comment"; payload: Omit<CommentPayload, keyof TaskIdentity> }
  | { kind: "review"; payload: Omit<ReviewPayload, keyof TaskIdentity> }
  | { kind: "ci_result"; payload: Omit<CiResultPayload, keyof TaskIdentity> };

export interface TaskService {
  readonly source: string;

  assign(p: {
    externalId?: string; // required with a hint key; with a sequence key the new key is used
    key: { hint: string } | { sequence: string }; // sequence: the key prefix
    title: string;
    description: string | null; // Markdown/plain; flags already stripped; bot mention stripped
    flags: string[]; // modules parse with parseExperimentalFlags; this service never parses
    url: (t: TaskRef) => string;
    target: (t: TaskRef) => ReplyTarget; // target.id = delegation id; optional target.order (monotonic number)
    requester?: Person; // tasks.metadata.requester
    createdBy?: string; // API token id
  }): Promise<{
    taskId: string;
    key: string;
    result: "created" | "restarted" | "duplicate";
    previousTargetId?: string; // a restart's replaced delegation id
  }>;

  // Replaces the task's title, description and flags and restarts it from a
  // clean slate, delegated through `target`. Only this source's tasks.
  restart(
    taskId: string,
    def: { title: string; description: string | null; flags: string[]; target: ReplyTarget },
  ): Promise<void>;

  enqueueRound(
    p: RoundDraft & {
      task: Pick<Task, "id" | "key">;
      externalId: string; // idempotency key, with the source and kind
      targets: ReplyTarget[];
      prUrl?: string; // dropped once this PR is no longer one of the task's
      // At most this many rounds of this source and kind per task; absent,
      // 0 or negative: no cap.
      limit?: number;
    },
  ): Promise<
    { roundId: string } | { dropped: "duplicate" | "stale" } | { dropped: "limit"; count: number } // count: the rounds the task already has
  >;

  findTask(externalId: string): Promise<Task | null>; // this source's task
  findTaskByPrUrl(prUrl: string): Promise<Task | null>; // any source's task
}

// Which integration each reply-target kind belongs to. Exists only for the
// check that a round's targets belong to the round's own integration.
const TARGET_OWNER: Record<ReplyTargetSpec["kind"], IntegrationName> = {
  linear_session: "linear",
  api_session: "api",
  issue_comment: "github",
  review_comment: "github",
  review_body: "github",
};

export class BoundTaskService implements TaskService {
  constructor(
    readonly source: string,
    private taskRepo: TaskRepository,
    private inboxRepo: InboxRepository,
    private sandboxManager: Pick<SandboxManager, "killSandbox">,
    private hooks: Pick<IntegrationHooks, "detach">,
  ) {}

  async assign(p: Parameters<TaskService["assign"]>[0]): ReturnType<TaskService["assign"]> {
    if ("hint" in p.key && !p.externalId) throw new Error("assign: a hint key needs externalId");
    const { prevSandboxId, prevTargetId, ...t } = await this.taskRepo.assign({
      ...p,
      // The task_source enum lists only the sources that create tasks.
      source: this.source as TaskSource,
      key:
        "hint" in p.key
          ? { hint: p.key.hint.replace(/[^A-Za-z0-9-]/g, "-") } // branch-safe
          : { sequencePrefix: p.key.sequence },
      target: (ref) => {
        const target = p.target(ref);
        checkTargets(this.source, [target]);
        // A NaN order is never "not above" the stored one, so every
        // redelivery would restart the task.
        const { order } = target;
        if (order !== undefined && !(Number.isSafeInteger(order) && order >= 0)) {
          throw new Error(`assign: target.order must be a non-negative integer, not ${order}`);
        }
        return target;
      },
    });
    this.killPreempted(t.id, prevSandboxId, "preempted re-delegation");
    return { taskId: t.id, key: t.key, result: t.result, previousTargetId: prevTargetId };
  }

  async restart(
    taskId: string,
    def: Parameters<TaskService["restart"]>[1],
  ): ReturnType<TaskService["restart"]> {
    checkTargets(this.source, [def.target]);
    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new Error(`restart: task ${taskId} not found`);
    if (task.source !== this.source) {
      throw new Error(`restart: task ${taskId} is not from ${this.source}`);
    }
    const { prevSandboxId } = await this.taskRepo.restartTaskWithInbox({
      taskId,
      inboxPayload: {
        title: def.title,
        description: def.description,
        external_url: task.externalUrl,
        target_id: def.target.id,
      },
      inboxReplyTargets: [def.target],
      api: { title: def.title, description: def.description, experimentalFlags: def.flags },
    });
    this.killPreempted(taskId, prevSandboxId, "restart");
  }

  async enqueueRound(
    p: Parameters<TaskService["enqueueRound"]>[0],
  ): ReturnType<TaskService["enqueueRound"]> {
    const { task, kind, payload, targets } = p;
    // A review's payload carries one target id per thread instead.
    if ("target_id" in payload && payload.target_id !== targets[0]?.id) {
      throw new Error("enqueueRound: payload.target_id must equal targets[0].id");
    }
    checkTargets(this.source, targets);
    return this.inboxRepo.appendFollowUp({
      taskId: task.id,
      message: {
        source: this.source,
        kind,
        external_id: p.externalId,
        payload: { ...payload, ...taskIdentity(task) },
      } as NewInboxMessage,
      replyTargets: targets,
      prUrl: p.prUrl,
      limit: p.limit,
    });
  }

  findTask(externalId: string): Promise<Task | null> {
    return this.taskRepo.findByExternalId(this.source as TaskSource, externalId);
  }

  findTaskByPrUrl(prUrl: string): Promise<Task | null> {
    return this.taskRepo.findByPrUrl(prUrl);
  }

  // A restart's preempted sandbox, killed after commit in the tracked detached
  // set so shutdown drains it. The old workspace volume is kept (a known leak).
  private killPreempted(taskId: string, sandboxId: string | null, why: string): void {
    if (!sandboxId) return;
    this.hooks.detach(
      taskId,
      "killSandbox",
      this.sandboxManager.killSandbox(sandboxId).catch((err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        logger.error(`killSandbox(${why}) failed`, {
          taskId,
          sandboxId,
          message: e.message,
          stack: e.stack,
        });
      }),
    );
  }
}

function checkTargets(source: string, targets: ReplyTarget[]): void {
  for (const t of targets) {
    if (TARGET_OWNER[t.spec.kind] !== source) {
      throw new Error(`a ${source} round can't carry a ${t.spec.kind} reply target`);
    }
  }
}
