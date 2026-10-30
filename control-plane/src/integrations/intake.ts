import type { Task } from "../db/schema";
import { logger } from "../logger";
import {
  apiSessionTarget,
  type InboxRepository,
  type NewInboxMessage,
  type ReplyTarget,
  type ReplyTargetSpec,
  taskIdentity,
} from "../repositories/inbox.repository";
import type { TaskRepository } from "../repositories/task.repository";
import type { IntegrationHooks } from "../services/integrationHooks";
import type { SandboxManager } from "../services/sandboxManager.service";
import type { InboxMessage, TaskIdentity } from "../types/inboxMessage";
import type { IntegrationName, Person, TaskSource } from "./types";

// The only way modules create work (§3, §5).

export type TaskRef = { id: string; key: string };
type Draft<M> = M extends InboxMessage
  ? Pick<M, "source" | "kind" | "external_id"> & { payload: Omit<M["payload"], keyof TaskIdentity> }
  : never;
export type InboxMessageDraft = Draft<Exclude<InboxMessage, { kind: "assignment" }>>;

export interface TaskIntake {
  assign(p: {
    source: TaskSource;
    externalId?: string; // required with a hint key; with a sequence key the new key is used
    key: { hint: string } | { sequence: "api" };
    title: string;
    description: string | null; // Markdown/plain; flags already stripped; bot mention stripped
    flags: string[]; // modules parse with parseExperimentalFlags; intake never parses
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

  restart(
    taskId: string,
    def: { title: string; description: string | null; flags: string[] },
  ): Promise<void>;

  followUp(p: {
    task: Pick<Task, "id" | "key">;
    message: InboxMessageDraft;
    targets: ReplyTarget[];
    prUrl?: string;
  }): Promise<{ roundId: string } | { dropped: "duplicate" | "stale" | "ci_limit" }>;

  findTask(source: TaskSource, externalId: string): Promise<Task | null>;
  findTaskByPrUrl(prUrl: string): Promise<Task | null>;
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

export class Intake implements TaskIntake {
  constructor(
    private taskRepo: TaskRepository,
    private inboxRepo: InboxRepository,
    private sandboxManager: Pick<SandboxManager, "killSandbox">,
    private hooks: Pick<IntegrationHooks, "detach">,
    private opts: { apiKeyPrefix: string; ciResultMaxPerTask: number },
  ) {}

  async assign(p: Parameters<TaskIntake["assign"]>[0]): ReturnType<TaskIntake["assign"]> {
    if ("hint" in p.key && !p.externalId) throw new Error("assign: a hint key needs externalId");
    const { prevSandboxId, prevTargetId, ...t } = await this.taskRepo.assign({
      ...p,
      key:
        "hint" in p.key
          ? { hint: p.key.hint.replace(/[^A-Za-z0-9-]/g, "-") } // branch-safe
          : { sequencePrefix: this.opts.apiKeyPrefix },
      target: (ref) => {
        const target = p.target(ref);
        checkTargets(p.source, [target]);
        return target;
      },
    });
    this.killPreempted(t.id, prevSandboxId, "preempted re-delegation");
    return { taskId: t.id, key: t.key, result: t.result, previousTargetId: prevTargetId };
  }

  // API only: today's API restart, with the definition replacing the current
  // title, description and flags.
  async restart(
    taskId: string,
    def: { title: string; description: string | null; flags: string[] },
  ): Promise<void> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new Error(`restart: task ${taskId} not found`);
    const { prevSandboxId } = await this.taskRepo.restartTaskWithInbox({
      taskId,
      inboxPayload: {
        title: def.title,
        description: def.description,
        external_url: task.externalUrl,
        target_id: taskId,
      },
      inboxReplyTargets: [apiSessionTarget(taskId)],
      api: { title: def.title, description: def.description, experimentalFlags: def.flags },
    });
    this.killPreempted(taskId, prevSandboxId, "API restart");
  }

  async followUp(p: Parameters<TaskIntake["followUp"]>[0]): ReturnType<TaskIntake["followUp"]> {
    const { task, message, targets } = p;
    // A review's payload carries one target id per thread instead.
    if ("target_id" in message.payload && message.payload.target_id !== targets[0]?.id) {
      throw new Error("followUp: payload.target_id must equal targets[0].id");
    }
    checkTargets(message.source, targets);
    return this.inboxRepo.appendFollowUp({
      taskId: task.id,
      message: {
        ...message,
        payload: { ...message.payload, ...taskIdentity(task) },
      } as NewInboxMessage,
      replyTargets: targets,
      prUrl: p.prUrl,
      ciResultMax: this.opts.ciResultMaxPerTask,
    });
  }

  findTask(source: TaskSource, externalId: string): Promise<Task | null> {
    return this.taskRepo.findByExternalId(source, externalId);
  }

  findTaskByPrUrl(prUrl: string): Promise<Task | null> {
    return this.taskRepo.findByPrUrl(prUrl);
  }

  // A restart's preempted sandbox, killed after commit in the tracked detached
  // set so shutdown drains it. The old workspace volume is kept (§15 bug 6).
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

function checkTargets(source: IntegrationName, targets: ReplyTarget[]): void {
  for (const t of targets) {
    if (TARGET_OWNER[t.spec.kind] !== source) {
      throw new Error(`a ${source} round can't carry a ${t.spec.kind} reply target`);
    }
  }
}
