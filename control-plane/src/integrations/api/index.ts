import type { Integration } from "../types";

// API tasks have no outbound channel: the task_events log carries replies and
// failures (failTaskInbox / markFailed write round_failed there).
export const apiIntegration: Integration = {
  name: "api",
  async deliver() {
    // Nothing to post.
  },
};
