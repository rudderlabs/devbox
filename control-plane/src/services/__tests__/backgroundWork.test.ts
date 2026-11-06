import { describe, expect, it, spyOn } from "bun:test";
import { BackgroundWork } from "../backgroundWork";

const { logger } = await import("../../logger");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("BackgroundWork", () => {
  it("drain also waits for work tracked while it drains", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const background = new BackgroundWork();
      let finished = false;
      background.track(
        "task-1",
        "onRoundFinished",
        sleep(10).then(() =>
          // A webhook still being served restarts a task meanwhile.
          background.track(
            "task-2",
            "killSandbox",
            sleep(20).then(() => {
              finished = true;
            }),
          ),
        ),
      );
      await background.drain(sleep(500));

      expect(finished).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("drain logs hook_abandoned for what is still running at the deadline", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const background = new BackgroundWork();
      let finished = false;
      background.track(
        "task-1",
        "slack",
        sleep(10).then(() => {
          finished = true;
        }),
      );
      // Outlives the drain deadline below.
      background.track("task-2", "assignee", sleep(200));
      await background.drain(sleep(50));

      expect(finished).toBe(true);
      expect(warn.mock.calls).toEqual([
        [
          "hook abandoned at shutdown",
          { event: "hook_abandoned", taskId: "task-2", hook: "assignee" },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs work that fails and stops tracking it", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => logger);
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const background = new BackgroundWork();
      background.track("task-1", "slack", Promise.reject(new Error("channel_not_found")));
      await background.drain(sleep(50));

      expect(error).toHaveBeenCalledWith("detached slack work failed", {
        taskId: "task-1",
        message: "channel_not_found",
        stack: expect.any(String),
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
