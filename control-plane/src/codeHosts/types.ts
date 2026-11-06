import type { Person } from "../integrations/types";

// A code host: where the agent opens pull requests (on GitLab, merge
// requests). The harness does the git work with the sandbox's token. An
// adapter is what core itself needs from one host: which pull request URLs are
// its own, and how to assign one to the task's person, which must work whether
// or not the host's integration is on. services/codeHost.service.ts picks the
// adapter by the pull request's URL; codeHosts/index.ts lists them all.
//
// Anything written on the pull request (the onboarding comment, replies) is
// the host's integration's, in integrations/<name>/: the service hands a new
// pull request to its onPrOpened.
export interface CodeHostAdapter {
  // Also the name of the host's integration.
  readonly name: string;
  // Whether `url` is one of this host's pull requests.
  owns(url: string): boolean;
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
