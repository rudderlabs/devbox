import { logger } from "../logger";

// Work that goes on after its caller returned: an integration's
// onRoundFinished, the PR assignee mirror, a Slack post, a restart's sandbox
// kill. TaskProcessor.stop() drains it before the process exits.
export class BackgroundWork {
  private readonly running = new Map<Promise<void>, { taskId: string; what: string }>();

  // `what` names the work in the logs. A rejection is logged here; work that
  // wants its own message catches first.
  track(taskId: string, what: string, work: Promise<unknown>): void {
    const p: Promise<void> = work
      .then(
        () => {},
        (err) => {
          const e = err instanceof Error ? err : new Error(String(err));
          logger.error(`detached ${what} work failed`, {
            taskId,
            message: e.message,
            stack: e.stack,
          });
        },
      )
      .finally(() => this.running.delete(p));
    this.running.set(p, { taskId, what });
  }

  // Waits for tracked work until `deadline` settles, then logs what is still
  // running; the process exits right after. Work tracked meanwhile (say, a
  // restart's sandbox kill from a webhook still being served) is waited for too.
  async drain(deadline: Promise<void>): Promise<void> {
    let expired = false;
    void deadline.then(() => {
      expired = true;
    });
    while (this.running.size > 0 && !expired) {
      await Promise.race([Promise.allSettled(this.running.keys()), deadline]);
    }
    for (const { taskId, what } of this.running.values()) {
      logger.warn("hook abandoned at shutdown", { event: "hook_abandoned", taskId, hook: what });
    }
  }
}
