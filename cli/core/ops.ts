// The core's operations bound to an API client; the interface layer calls only these.
import type { ApiEventEnvelope, ApiTask, MeResponse } from "../../control-plane/src/types/api";
import { whoami } from "./account";
import type { ApiClient } from "./api";
import {
  type CoreDeps,
  type FollowItem,
  type FollowOptions,
  followTask,
  type HistoryOptions,
  taskHistory,
} from "./events";
import {
  type CreatedTask,
  type CreateTaskOptions,
  createTask,
  type ListTasksOptions,
  listTasks,
  type RestartedTask,
  type RestartTaskOptions,
  restartTask,
  type SendMessageOptions,
  type SentMessage,
  sendMessage,
  showTask,
} from "./tasks";

export type CoreOps = {
  whoami(): Promise<MeResponse>;
  listTasks(o: ListTasksOptions): Promise<ApiTask[]>;
  showTask(ref: string): Promise<ApiTask>;
  createTask(o: CreateTaskOptions): Promise<CreatedTask>;
  sendMessage(o: SendMessageOptions): Promise<SentMessage>;
  restartTask(o: RestartTaskOptions): Promise<RestartedTask>;
  taskHistory(o: HistoryOptions): AsyncGenerator<ApiEventEnvelope>;
  followTask(o: FollowOptions): AsyncGenerator<FollowItem>;
};

export function bindCore(api: ApiClient, deps: CoreDeps): CoreOps {
  return {
    whoami: () => whoami(api),
    listTasks: (o) => listTasks(api, o),
    showTask: (ref) => showTask(api, ref),
    createTask: (o) => createTask(api, o),
    sendMessage: (o) => sendMessage(api, o),
    restartTask: (o) => restartTask(api, o),
    taskHistory: (o) => taskHistory(api, o),
    followTask: (o) => followTask(api, o, deps),
  };
}
