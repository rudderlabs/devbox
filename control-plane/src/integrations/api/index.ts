import type { Integration, IntegrationDefinition } from "../types";
import { type ApiSettings, parseApiSettings } from "./config";

// On with API_ENABLED=true, the switch that also mounts /api. Its settings
// (config.ts) shape the tasks it creates; /api's own settings, such as auth and
// allowed hosts, are core's (apiConfig.ts), since /api serves every source's
// tasks.
export const api: IntegrationDefinition<ApiSettings> = {
  name: "api",
  createsTasks: true,
  parseConfig: parseApiSettings,
  create: () => new ApiIntegration(),
  disabledStatus: () => ({ enabled: false }),
};

// API tasks have no outbound channel: the task_events log carries replies and
// failures (failTaskInbox / markFailed write round_failed there). No webhook:
// the /api controller and ApiTaskService call its TaskService.
export class ApiIntegration implements Integration {
  async deliver(): Promise<void> {
    // Nothing to post.
  }

  async status(): Promise<{ enabled: true }> {
    return { enabled: true };
  }
}
