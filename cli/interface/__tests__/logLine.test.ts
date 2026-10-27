import { describe, expect, it } from "bun:test";
import { envelope } from "../../__tests__/fixtures";
import { renderEvent } from "../logLine";

const plain = { color: false, timeZone: "UTC" };

describe("renderEvent", () => {
  it("renders a whole fixed sequence", () => {
    const events = [
      envelope(1, "task_created", {
        title: "Fix flaky test",
        description: null,
        experimental_flags: [],
      }),
      envelope(2, "sandbox_started", { mode: "fresh" }, null),
      envelope(3, "agent_action", { body: "Planning" }),
      envelope(4, "agent_thought", { body: "Reading the test" }),
      envelope(5, "pr_opened", {
        repo: "rudderlabs/rudder-server",
        pr_url: "https://github.com/rudderlabs/rudder-server/pull/1234",
        branch: "devbox/DBX-API-7-fix",
      }),
      envelope(6, "agent_response", { body: "Fixed it.\n\nSee the PR." }),
      envelope(7, "completed", { status: "partial_failure" }),
      envelope(8, "message_queued", { body: "also update the docs" }, "round-2"),
      envelope(9, "round_failed", { reason: "The sandbox could not start." }, "round-2"),
      envelope(10, "task_restarted", { title: "Fix flaky test v2" }, "round-3"),
      envelope(11, "agent_error", { body: "Tool crashed" }, "round-3"),
      envelope(12, "completed", {}, "round-3"),
      envelope(13, "something_new", {}),
    ];
    expect(events.map((e) => renderEvent(e, plain)).join("\n")).toBe(
      [
        "12:00:01  ✚ task created: Fix flaky test",
        "12:00:02  ▸ sandbox started (fresh)",
        "12:00:03  ⚙ Planning",
        "12:00:04  … Reading the test",
        "12:00:05  ⇪ PR opened  rudderlabs/rudder-server#1234",
        "12:00:06  ✉ Fixed it.",
        "",
        "            See the PR.",
        "12:00:07  ✔ completed (partial_failure)",
        "12:00:08  → also update the docs",
        "12:00:09  ✘ round failed: The sandbox could not start.",
        "12:00:10  ↻ task restarted: Fix flaky test v2",
        "12:00:11  ✘ Tool crashed",
        "12:00:12  ✔ completed",
        "12:00:13  · something_new",
      ].join("\n"),
    );
  });

  it("colours marker and text when asked", () => {
    expect(
      renderEvent(envelope(4, "agent_thought", { body: "hmm" }), { color: true, timeZone: "UTC" }),
    ).toBe("12:00:04  \x1b[2m… hmm\x1b[0m");
  });

  it("falls back to the PR URL when it has no number", () => {
    expect(
      renderEvent(
        envelope(5, "pr_opened", { repo: "r/x", pr_url: "https://example.com/x" }),
        plain,
      ),
    ).toBe("12:00:05  ⇪ PR opened  https://example.com/x");
  });
});
