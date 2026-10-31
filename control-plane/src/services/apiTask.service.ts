import { ApiError } from "../errors";
import type { TaskIntake } from "../integrations/intake";
import type { TaskSource } from "../integrations/types";
import type { ApiTaskRecord, ApiTaskRepository } from "../repositories/apiTask.repository";
import { apiSessionTarget } from "../repositories/inbox.repository";
import type { TaskEventRepository, TaskEventRow } from "../repositories/taskEvent.repository";
import type {
  ApiEventEnvelope,
  ApiPr,
  ApiTask,
  ApiTaskState,
  ListEventsResponse,
  ListTasksResponse,
  SendMessageResponse,
  SseStateData,
} from "../types/api";
import { extractExperimentalFlags } from "./experimentalFlags";

export type Principal = { tokenId: string; name: string };
export type CreateTaskInput = {
  title: string;
  description: string | null;
  experimentalFlags: string[];
};
export type ListTasksInput = {
  source?: TaskSource;
  createdBy?: "me" | string;
  state?: ApiTaskState;
  before?: string;
  limit: number;
};
export type ApiTaskServiceOptions = {
  publicBaseUrl: string;
  now: () => Date;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = () => new ApiError(404, "task_not_found", "Task not found");
const NOT_API = () =>
  new ApiError(409, "not_api_task", "Only API tasks can be changed through the API");

// The /api use cases read every task and write only API tasks, through
// TaskIntake. All settings arrive through the constructor so this module never
// imports ../config; that keeps process-global mock.module replacements from
// leaking into these tests.
export class ApiTaskService {
  constructor(
    private apiTaskRepo: ApiTaskRepository,
    private intake: Pick<TaskIntake, "assign" | "restart" | "followUp">,
    private taskEventRepo: TaskEventRepository,
    private opts: ApiTaskServiceOptions,
  ) {}

  // The task row, its assignment round and task_created, in one transaction.
  // The key comes from api_task_key_seq and is also the task's external id.
  async create(principal: Principal | null, input: CreateTaskInput): Promise<ApiTask> {
    const { taskId } = await this.intake.assign({
      source: "api",
      key: { sequence: "api" },
      title: input.title,
      description: input.description,
      flags: input.experimentalFlags,
      url: (t) => `${this.opts.publicBaseUrl}/api/tasks/${t.key}`,
      target: (t) => apiSessionTarget(t.id),
      createdBy: principal?.tokenId,
    });
    return this.get(taskId);
  }

  async list(principal: Principal | null, input: ListTasksInput): Promise<ListTasksResponse> {
    const createdBy = input.createdBy === "me" ? (principal?.tokenId ?? null) : input.createdBy;
    const rows = await this.apiTaskRepo.list({
      source: input.source,
      createdBy,
      state: input.state,
      before: input.before,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    return {
      tasks: page.map((r) => this.toApiTask(r)),
      next_before: rows.length > input.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async get(ref: string): Promise<ApiTask> {
    return this.toApiTask(await this.resolve(ref));
  }

  // A comment round (external_id = a new UUID) and message_queued in one
  // transaction. A round in progress doesn't block it: the new row queues
  // behind it, as on Linear.
  async sendMessage(ref: string, body: string): Promise<SendMessageResponse> {
    const task = await this.resolveApiTask(ref);
    const result = await this.intake.followUp({
      task: { id: task.id, key: task.key },
      message: {
        source: "api",
        kind: "comment",
        external_id: crypto.randomUUID(),
        payload: { target_id: task.id, body, pr: null, created_at: this.opts.now().toISOString() },
      },
      targets: [apiSessionTarget(task.id)],
    });
    // A fresh external id and no PR guard: nothing can drop it.
    if (!("roundId" in result)) throw new Error(`sendMessage: round dropped (${result.dropped})`);
    return { round_id: result.roundId };
  }

  // Same restart as a re-delegation, plus the full new definition and
  // task_restarted. The input replaces the current title/description/flags;
  // nothing is merged. The previous sandbox is killed afterwards.
  async restart(ref: string, input: CreateTaskInput): Promise<ApiTask> {
    const task = await this.resolveApiTask(ref);
    await this.intake.restart(task.id, {
      title: input.title,
      description: input.description,
      flags: input.experimentalFlags,
    });
    return this.get(task.id);
  }

  async events(ref: string, after: number, limit: number): Promise<ListEventsResponse> {
    const task = await this.resolve(ref);
    if (task.source !== "api") return { events: [], next_after: 0, logging: "unavailable" };
    const events = await this.eventsAfter(task.id, after, limit);
    return { events, next_after: events[events.length - 1]?.id ?? after, logging: "available" };
  }

  async streamTarget(ref: string): Promise<{ id: string; source: TaskSource }> {
    const task = await this.resolve(ref);
    return { id: task.id, source: task.source };
  }

  async streamState(taskId: string): Promise<SseStateData> {
    const s = await this.apiTaskRepo.getStreamState(taskId);
    if (!s) throw NOT_FOUND();
    return s;
  }

  async eventsAfter(taskId: string, after: number, limit: number): Promise<ApiEventEnvelope[]> {
    return (await this.taskEventRepo.listAfter(taskId, after, limit)).map(toEnvelope);
  }

  // :ref is a task id (UUID shape) or a task key (case-insensitive).
  private async resolve(ref: string): Promise<ApiTaskRecord> {
    const task = UUID_RE.test(ref)
      ? await this.apiTaskRepo.findById(ref)
      : await this.apiTaskRepo.findByKey(ref);
    if (!task) throw NOT_FOUND();
    return task;
  }

  private async resolveApiTask(ref: string): Promise<ApiTaskRecord> {
    const task = await this.resolve(ref);
    if (task.source !== "api") throw NOT_API();
    return task;
  }

  private toApiTask(r: ApiTaskRecord): ApiTask {
    return {
      id: r.id,
      key: r.key,
      source: r.source,
      title: r.title,
      description: r.description,
      external_url: r.external_url,
      created_by:
        r.created_by && r.creator_name ? { id: r.created_by, name: r.creator_name } : null,
      experimental_flags: extractExperimentalFlags(r.metadata),
      state: r.state,
      sandbox_live: r.sandbox_id !== null,
      prs: prsOf(r.pr_urls),
      rounds: r.rounds,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    };
  }
}

function prsOf(prUrls: unknown): ApiPr[] {
  if (!Array.isArray(prUrls)) return [];
  const out: ApiPr[] = [];
  for (const item of prUrls) {
    if (!item || typeof item !== "object") continue;
    const { repo, url, branch } = item as Record<string, unknown>;
    if (typeof repo === "string" && typeof url === "string" && typeof branch === "string") {
      out.push({ repo, url, branch });
    }
  }
  return out;
}

function toEnvelope(e: TaskEventRow): ApiEventEnvelope {
  return {
    id: e.id,
    task_id: e.task_id,
    origin: e.origin,
    type: e.type,
    round_id: e.inbox_id,
    seq: e.seq,
    created_at: e.created_at.toISOString(),
    data: e.data,
  };
}
