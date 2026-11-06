import { type CodeHostAdapter, codeHosts } from "../codeHosts";
import type { Task } from "../db/schema";
import { SEND_TIMEOUT_MS, withTimeout } from "../integrations/http";
import type { PrRef } from "../integrations/types";
import { logger } from "../logger";
import type { BackgroundWork } from "./backgroundWork";
import type { IntegrationRegistry } from "./integrationRegistry";

// The code hosts, as core sees them. The harness opens pull requests with the
// sandbox's git token; the control plane then introduces itself on each new
// one and assigns it to the task's person. What that takes on each host is its
// adapter (src/codeHosts/); this class picks the adapter by the pull request's
// URL. The GitHub and GitLab integrations are separate: they only turn
// comments, reviews and CI results into rounds.
export class CodeHost {
  constructor(
    // assignee(): the task's own integration's person. prMentionLogin(host):
    // set while the host's integration turns @-mentions on PRs into rounds.
    private registry: Pick<IntegrationRegistry, "for" | "prMentionLogin">,
    private background: Pick<BackgroundWork, "track">,
    // Bounds the onboarding comment, awaited inside the tick like a send, and
    // an adapter's lookups before it assigns. Assigning the PR has no limit of
    // its own: it runs in BackgroundWork, which shutdown drains until a deadline.
    private sendTimeoutMs = SEND_TIMEOUT_MS,
    private hosts: readonly CodeHostAdapter[] = codeHosts,
  ) {}

  // The PR a pr_opened event reports, with the code host its URL belongs to
  // (null for a URL none of them knows).
  prRef(e: { pr_url: string; repo: string; branch: string }): PrRef {
    const host = this.hosts.find((h) => h.owns(e.pr_url))?.name ?? null;
    return { url: e.pr_url, repo: e.repo, branch: e.branch, host };
  }

  // A pr_opened for a PR the task hasn't recorded yet: the onboarding comment
  // (awaited and bounded), then the assignee mirror in BackgroundWork, since
  // its upstream round trips must not stall the tick and nothing reads its
  // result. A replay before the PR is recorded runs it again, so a PR can get
  // the comment twice. Best-effort: never throws.
  async prOpened(task: Task, pr: PrRef): Promise<void> {
    const host = this.hosts.find((h) => h.name === pr.host);
    if (!host) return; // a URL no code host knows — skip
    await this.postOnboardingComment(task, pr, host);
    if (host.assign) {
      this.background.track(task.id, "assignee", this.mirrorAssignee(task, pr, host));
    }
  }

  private async postOnboardingComment(task: Task, pr: PrRef, host: CodeHostAdapter): Promise<void> {
    // The comment explains @-mentions, which only work while the host's
    // integration takes them (its webhooks are on).
    const botLogin = this.registry.prMentionLogin(host.name);
    if (!botLogin) return;
    await withTimeout(this.sendTimeoutMs, (signal) =>
      host.comment(pr.url, host.onboardingBody(botLogin, task.key), signal),
    ).catch((err) => logErr("onboarding comment post failed", err));
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

// Untrusted values (e.g. sandbox-written pr_url) belong in `meta`, never in
// `msg`: metadata is JSON-stringified by the logger while the message is
// emitted raw, so a newline in an interpolated message would forge log lines.
function logErr(msg: string, err: unknown, meta: Record<string, unknown> = {}): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(msg, { ...meta, message: e.message, stack: e.stack });
}
