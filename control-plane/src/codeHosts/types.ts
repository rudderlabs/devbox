import type { Person } from "../integrations/types";

// A code host: where the agent opens pull requests (on GitLab, merge
// requests). The harness does the git work with the sandbox's token; an
// adapter is what the control plane itself does on a new pull request, for one
// host. services/codeHost.service.ts picks the adapter by the pull request's
// URL and applies the timeouts; codeHosts/index.ts lists them all.
export interface CodeHostAdapter {
  // Also the name of the integration that turns @-mentions on this host's
  // pull requests into rounds: the onboarding comment names that
  // integration's prMentionLogin.
  readonly name: string;
  // Whether `url` is one of this host's pull requests.
  owns(url: string): boolean;
  // What the onboarding comment says: who the bot is and how to reach it on
  // this host.
  onboardingBody(mentionLogin: string, taskKey: string): string;
  // Posts a top-level comment on the pull request. Throws when it fails.
  comment(url: string, body: string, signal: AbortSignal): Promise<void>;
  // Assigns the pull request to the task's person. Best-effort by contract:
  // never rejects, and logs its outcome as pr_assignee.result. Absent when
  // nothing tells the host which of its accounts a person is.
  assign?(url: string, person: Person, ctx: AssignCtx): Promise<void>;
}

export type AssignCtx = {
  taskId: string;
  // Bounds each lookup the assignment needs first.
  timeoutMs: number;
};
