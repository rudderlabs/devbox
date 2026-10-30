import type { Integration } from "../types";

export type ApiStatus = { enabled: boolean };

// API tasks have no outbound channel: the task_events log carries replies and
// failures (failTaskInbox / markFailed write round_failed there). No webhook:
// the /api controller and ApiTaskService call TaskIntake.
export class ApiIntegration implements Integration<ApiStatus> {
  readonly name = "api";

  // API_ENABLED.
  constructor(readonly enabled: boolean) {}

  async deliver(): Promise<void> {
    // Nothing to post.
  }

  async status(): Promise<ApiStatus> {
    return { enabled: this.enabled };
  }
}
