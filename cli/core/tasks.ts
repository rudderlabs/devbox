// Task operations. Every command's logic lives in core, even when it is one
// API call today, so new behaviour has one obvious home.
import type {
  ApiTask,
  ApiTaskSource,
  ApiTaskState,
  CreateTaskRequest,
  SendMessageResponse,
} from "../../control-plane/src/types/api";
import type { ApiClient } from "./api";
import { type From, roundStart } from "./events";

export type ListTasksOptions = {
  source?: ApiTaskSource;
  mine: boolean;
  state?: ApiTaskState;
  limit?: number;
};

const PAGE_SIZE = 100;

// Pages through the list until every task (or `o.limit` of them) is collected.
export async function listTasks(api: ApiClient, o: ListTasksOptions): Promise<ApiTask[]> {
  const tasks: ApiTask[] = [];
  let before: string | undefined;
  while (o.limit === undefined || tasks.length < o.limit) {
    const page = await api.listTasks({
      source: o.source,
      created_by: o.mine ? "me" : undefined,
      state: o.state,
      limit: o.limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, o.limit - tasks.length),
      before,
    });
    tasks.push(...page.tasks);
    if (page.next_before === null) break;
    before = page.next_before;
  }
  return tasks;
}

export function showTask(api: ApiClient, ref: string): Promise<ApiTask> {
  return api.getTask(ref);
}

export type CreateTaskOptions = {
  title: string;
  description?: string;
  experimentalFlags: string[];
};
export type SendMessageOptions = { ref: string; body: string };
export type RestartTaskOptions = {
  ref: string;
  title?: string;
  description?: string;
  experimentalFlags?: string[];
};
export type CreatedTask = { task: ApiTask; from: From };
export type SentMessage = { message: SendMessageResponse; from: From };
export type RestartedTask = { task: ApiTask; from: From };

export async function createTask(api: ApiClient, o: CreateTaskOptions): Promise<CreatedTask> {
  const body: CreateTaskRequest = { title: o.title };
  if (o.description !== undefined) body.description = o.description;
  if (o.experimentalFlags.length > 0) body.experimental_flags = o.experimentalFlags;
  return { task: await api.createTask(body), from: { round: roundStart.created() } };
}

export async function sendMessage(api: ApiClient, o: SendMessageOptions): Promise<SentMessage> {
  const message = await api.sendMessage(o.ref, { body: o.body });
  return { message, from: { round: roundStart.message(message.round_id) } };
}

// Restart takes the whole definition, so the current one is fetched and the
// overrides laid over it. The restart goes by the fetched key, which is the
// canonical form of whatever ref the caller typed.
export async function restartTask(api: ApiClient, o: RestartTaskOptions): Promise<RestartedTask> {
  const current = await api.getTask(o.ref);
  const task = await api.restartTask(current.key, {
    title: o.title ?? current.title,
    description: o.description ?? current.description,
    experimental_flags: o.experimentalFlags ?? current.experimental_flags,
  });
  // The restart has committed before anything reads the log, so the last
  // task_restarted is this restart's (or a later one's: the last restart wins).
  return { task, from: { round: roundStart.restarted() } };
}
