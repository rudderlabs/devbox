import { type CodeHostAdapter, codeHosts } from "../codeHosts";
import type { Task } from "../db/schema";
import { SEND_TIMEOUT_MS } from "../integrations/http";
import type { PrRef } from "../integrations/types";
import { logger } from "../logger";
import type { BackgroundWork } from "./backgroundWork";
import type { IntegrationRegistry } from "./integrationRegistry";

// The code hosts, as core sees them. The harness opens pull requests with the
// sandbox's git token. On each new one, the host's own integration introduces
// itself (its onPrOpened: whatever is written on a pull request is the
// integration's), and core assigns the pull request to the task's person
// through the host's adapter (src/codeHosts/), which works with the
// integration off too. This class picks both by the pull request's URL.
export class CodeHost {
  constructor(
    // for(host).onPrOpened(): the host's integration, skipped while it is
    // off. for(task.source).assignee(): the task's own integration's person.
    private registry: Pick<IntegrationRegistry, "for">,
    private background: Pick<BackgroundWork, "track">,
    // Bounds an adapter's lookups before it assigns. Assigning the PR has no
    // limit of its own: it runs in BackgroundWork, which shutdown drains until
    // a deadline.
    private sendTimeoutMs = SEND_TIMEOUT_MS,
    private hosts: readonly CodeHostAdapter[] = codeHosts,
  ) {}

  // The PR a pr_opened event reports, with the code host its URL belongs to
  // (null for a URL none of them knows).
  prRef(e: { pr_url: string; repo: string; branch: string }): PrRef {
    const host = this.hosts.find((h) => h.owns(e.pr_url))?.name ?? null;
    return { url: e.pr_url, repo: e.repo, branch: e.branch, host };
  }

  // A pr_opened for a PR the task hasn't recorded yet. The host's integration
  // gets it first (awaited, and bounded by the registry): it posts the
  // onboarding comment, which explains @-mentions, so only an enabled
  // integration, one that takes them, does. Then the assignee mirror, in
  // BackgroundWork, since its upstream round trips must not stall the tick
  // and nothing reads its result. A replay before the PR is recorded runs
  // both again, so a PR can get the comment twice. Best-effort: never throws.
  async prOpened(task: Task, pr: PrRef): Promise<void> {
    const host = this.hosts.find((h) => h.name === pr.host);
    if (!host) return; // a URL no code host knows — skip
    // No run to compare with (runId null), and the PR is new to the task
    // (firstTime). The registry logs a failure; only a RetryableError escapes
    // it, and holding the event is the task's own integration's business, so
    // it is dropped here.
    await this.registry
      .for(host.name)
      .onPrOpened(task, null, pr, true)
      .catch((err) => logErr("the code host integration's onPrOpened failed", err, task, pr));
    if (host.assign) {
      this.background.track(task.id, "assignee", this.mirrorAssignee(task, pr, host));
    }
  }

  // Assigns the PR to the task's person, through the account their platform
  // links to them on this host.
  //
  // Best-effort by contract: never rejects, a failure must not block dispatch
  // or the cursor.
  private async mirrorAssignee(task: Task, pr: PrRef, host: CodeHostAdapter): Promise<void> {
    // undefined: no assignee() (API tasks), or the lookup failed (logged).
    const person = await this.registry.for(task.source).assignee(task, { prUrl: pr.url });
    if (person === undefined) return;
    if (!person) {
      logger.info("PR assignee mirror skipped", {
        event: "pr_assignee.result",
        status: "skipped",
        reason: "no_human_assignee",
        taskId: task.id,
        prUrl: pr.url,
      });
      return;
    }
    await host.assign?.(pr.url, person, { taskId: task.id, timeoutMs: this.sendTimeoutMs });
  }
}

// The untrusted pr_url goes in the metadata, never in the message.
function logErr(msg: string, err: unknown, task: Task, pr: PrRef): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(msg, { taskId: task.id, prUrl: pr.url, message: e.message, stack: e.stack });
}
