import type { Integration, IntegrationDefinition } from "../types";

// On with API_ENABLED=true, the switch that mounts /api; the rest of the API's
// settings are core's (apiConfig.ts).
export const api: IntegrationDefinition<true> = {
  name: "api",
  createsTasks: true,
  parseConfig: (env) => (env.API_ENABLED === "true" ? true : undefined),
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
