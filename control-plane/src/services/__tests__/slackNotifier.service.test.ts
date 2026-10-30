import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Task } from "../../db/schema";
import type { TaskRepository } from "../../repositories/task.repository";

// Stub the slack barrel so importing the notifier doesn't pull in the real
// client → ../config (whose required-env checks would throw at import). We
// inject our own `post` into the notifier under test, so this mock only exists
// to satisfy the import and block the config load chain. Full export surface.
// See control-plane/README.md (Conventions).
mock.module("../../clients/slack", () => ({
  postSlackMessage: mock(() => Promise.resolve({ ts: "1" })),
  lookupSlackUserIdByEmail: mock(() => Promise.resolve(null)),
}));

const { SlackNotifierService } = await import("../slackNotifier.service");

type Ctor = ConstructorParameters<typeof SlackNotifierService>;

const PR = { repo: "acme/api", url: "https://github.com/acme/api/pull/1" };

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  source: "linear",
  externalId: "issue-1",
  key: "XYZ-1",
  createdBy: null,
  title: "Fix the thing",
  externalUrl: "https://linear.app/acme/issue/ABC-1/fix",
  metadata: {},
  ownerId: "pod",
  heartbeatAt: new Date(),
  sandboxId: "sbx",
  pvcName: null,
  prUrls: [],
  lastObservedEventSeq: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("SlackNotifierService", () => {
  let post: ReturnType<typeof mock>;
  let assignee: ReturnType<typeof mock>;
  let lookupSlackUser: ReturnType<typeof mock>;
  let getById: ReturnType<typeof mock>;
  let taskRepo: TaskRepository;

  const make = (botToken = "xoxb-test", channel = "C1", sources: Ctor[3] = ["linear"]) =>
    new SlackNotifierService(
      taskRepo,
      botToken,
      channel,
      sources,
      { assignee } as unknown as Ctor[4],
      post as unknown as Ctor[5],
      lookupSlackUser as unknown as Ctor[6],
    );

  // The text posted by the single post() call.
  const postedText = (): string => (post.mock.calls[0] as unknown as [{ text: string }])[0].text;

  beforeEach(() => {
    post = mock(() => Promise.resolve({ ts: "1" }));
    assignee = mock(() => Promise.resolve(null));
    lookupSlackUser = mock(() => Promise.resolve(null));
    getById = mock((id: string) => Promise.resolve(makeTask({ id, prUrls: [PR] })));
    taskRepo = { getById } as unknown as TaskRepository;
  });

  it("posts a ✅ completion into the configured channel with the ticket + PR links", async () => {
    await make().notifyTerminal(makeTask(), "completed");

    expect(post).toHaveBeenCalledTimes(1);
    const arg = (post.mock.calls[0] as unknown as [{ channel: string; threadTs?: string }])[0];
    expect(arg.channel).toBe("C1");
    expect(arg.threadTs).toBeUndefined();
    const text = postedText();
    expect(text).toContain("✅");
    expect(text).toContain("<https://linear.app/acme/issue/ABC-1/fix|Fix the thing>");
    expect(text).toContain("<https://github.com/acme/api/pull/1|acme/api#1>");
  });

  it("uses singular 'PR' with no bullet for a single PR", async () => {
    // Default getById returns exactly one PR.
    await make().notifyTerminal(makeTask(), "completed");
    const text = postedText();
    expect(text).toContain(
      "Here is the PR for review: <https://github.com/acme/api/pull/1|acme/api#1>",
    );
    expect(text).not.toContain("•");
    expect(text).not.toContain("Here are the PRs");
  });

  it("uses plural 'PRs' with a bulleted list for multiple PRs", async () => {
    getById.mockResolvedValue(
      makeTask({
        prUrls: [PR, { repo: "acme/web", url: "https://github.com/acme/web/pull/2" }],
      }),
    );
    await make().notifyTerminal(makeTask(), "completed");
    const text = postedText();
    expect(text).toContain("Here are the PRs for review:");
    expect(text).toContain("• <https://github.com/acme/api/pull/1|acme/api#1>");
    expect(text).toContain("• <https://github.com/acme/web/pull/2|acme/web#2>");
  });

  it("uses ⚠️ for partial_failure and still lists PRs", async () => {
    await make().notifyTerminal(makeTask(), "partial_failure");
    const text = postedText();
    expect(text).toContain("⚠️");
    expect(text).toContain("acme/api");
  });

  it("uses 💤 for no_action and omits PR lines", async () => {
    await make().notifyTerminal(makeTask(), "no_action");
    const text = postedText();
    expect(text).toContain("💤");
    expect(text).not.toContain("github.com");
  });

  it("uses ❌ for failed and includes the failure message", async () => {
    await make().notifyTerminal(makeTask(), "failed", "sandbox ran out of memory");
    const text = postedText();
    expect(text).toContain("❌");
    expect(text).toContain("sandbox ran out of memory");
  });

  it("labels the ticket link 'Linear ticket' when the task has no title", async () => {
    getById.mockResolvedValue(makeTask({ title: "", prUrls: [PR] }));
    await make().notifyTerminal(makeTask({ title: "" }), "completed");
    expect(postedText()).toContain("<https://linear.app/acme/issue/ABC-1/fix|Linear ticket>");
  });

  it("re-reads the task for the freshest pr_urls (stale in-memory task had none)", async () => {
    // The task handed in predates the pr_opened write; getById returns the PR.
    await make().notifyTerminal(makeTask({ prUrls: [] }), "completed");
    expect(getById).toHaveBeenCalledWith("task-1");
    expect(postedText()).toContain("github.com/acme/api/pull/1");
  });

  it("still posts using in-memory prUrls when the getById freshness re-read throws", async () => {
    // A DB blip on the optional freshness re-read must NOT drop the whole post —
    // the thread is resolved and the in-memory task already carries the PR.
    getById.mockRejectedValue(new Error("db connection reset"));
    await make().notifyTerminal(makeTask({ prUrls: [PR] }), "completed");
    expect(post).toHaveBeenCalledTimes(1);
    expect(postedText()).toContain("<https://github.com/acme/api/pull/1|acme/api#1>");
  });

  it("no-ops when Slack is disabled (empty token) — never posts", async () => {
    await make("").notifyTerminal(makeTask(), "completed");
    expect(post).not.toHaveBeenCalled();
  });

  it("no-ops when no channel is configured", async () => {
    await make("xoxb-test", "").notifyTerminal(makeTask(), "completed");
    expect(post).not.toHaveBeenCalled();
  });

  it("skips a non-linear task", async () => {
    await make().notifyTerminal(makeTask({ source: "github" as Task["source"] }), "completed");
    expect(post).not.toHaveBeenCalled();
  });

  it("skips an API task unless SLACK_NOTIFY_SOURCES has api", async () => {
    const notifier = make();
    expect(notifier.notifies("api")).toBe(false);
    await notifier.notifyTerminal(makeTask({ source: "api" }), "completed");
    expect(post).not.toHaveBeenCalled();
  });

  it("posts for an opted-in API task: labelled by its key when untitled, never nudged", async () => {
    const task = makeTask({
      source: "api",
      key: "DBX-API-7",
      title: "",
      externalUrl: "https://devbox.example.com/api/tasks/DBX-API-7",
    });
    getById.mockResolvedValue({ ...task, prUrls: [PR] });
    await make("xoxb-test", "C1", ["linear", "api"]).notifyTerminal(task, "completed");
    expect(postedText()).toContain("<https://devbox.example.com/api/tasks/DBX-API-7|DBX-API-7>");
    expect(assignee).not.toHaveBeenCalled();
  });

  describe("connect-GitHub nudge", () => {
    // Linear's assignee() for a member who hasn't connected GitHub in Linear.
    const unmapped = {
      id: "usr-1",
      displayName: "ada",
      email: "ada@acme.com",
      codeHost: "unlinked",
    };
    const mapped = { ...unmapped, codeHost: { githubLogin: "ada" } };

    it("appends the nudge when the human assignee has no GitHub connected and PRs exist", async () => {
      assignee.mockResolvedValue(unmapped);
      await make().notifyTerminal(makeTask(), "completed");
      const text = postedText();
      expect(assignee).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        null,
        expect.anything(),
      );
      expect(text).toContain("⚠️ ada: I couldn't assign the PR to you");
      expect(text).toContain("*Linear → Settings → Connected accounts*");
      // The nudge rides directly under the PR list.
      expect(text.indexOf("Here is the PR for review")).toBeLessThan(
        text.indexOf("I couldn't assign the PR"),
      );
    });

    it("omits the nudge when the assignee is already mapped", async () => {
      assignee.mockResolvedValue(mapped);
      await make().notifyTerminal(makeTask(), "completed");
      expect(postedText()).not.toContain("Connected accounts");
    });

    it("omits the nudge when there is no human assignee", async () => {
      assignee.mockResolvedValue(null);
      await make().notifyTerminal(makeTask(), "completed");
      expect(postedText()).not.toContain("Connected accounts");
    });

    it("never checks the assignee when there are no PRs (nothing to assign)", async () => {
      getById.mockResolvedValue(makeTask({ prUrls: [] }));
      await make().notifyTerminal(makeTask(), "completed");
      expect(assignee).not.toHaveBeenCalled();
      expect(postedText()).not.toContain("Connected accounts");
    });

    it("still posts (without the nudge) when the assignee lookup fails", async () => {
      // IntegrationHooks.assignee logs the failure and yields undefined.
      assignee.mockResolvedValue(undefined);
      await make().notifyTerminal(makeTask(), "completed");
      expect(post).toHaveBeenCalledTimes(1);
      expect(postedText()).not.toContain("Connected accounts");
    });

    it("appends the nudge on partial_failure and failed too (PRs are listed there)", async () => {
      assignee.mockResolvedValue(unmapped);
      await make().notifyTerminal(makeTask(), "failed", "boom");
      expect(postedText()).toContain("I couldn't assign the PR");
    });

    it("@-mentions the assignee when their Slack id resolves from the Linear email", async () => {
      assignee.mockResolvedValue(unmapped);
      lookupSlackUser.mockResolvedValue("U0ADA");
      await make().notifyTerminal(makeTask(), "completed");
      expect(lookupSlackUser).toHaveBeenCalledWith("ada@acme.com");
      const text = postedText();
      expect(text).toContain("⚠️ <@U0ADA>: I couldn't assign the PR");
      expect(text).not.toContain("⚠️ ada:");
    });

    it("falls back to the display name when the Slack lookup finds nobody", async () => {
      assignee.mockResolvedValue(unmapped);
      lookupSlackUser.mockResolvedValue(null);
      await make().notifyTerminal(makeTask(), "completed");
      expect(postedText()).toContain("⚠️ ada: I couldn't assign the PR");
    });

    it("falls back to the display name when the Slack lookup throws", async () => {
      assignee.mockResolvedValue(unmapped);
      lookupSlackUser.mockRejectedValue(new Error("missing_scope"));
      await make().notifyTerminal(makeTask(), "completed");
      expect(postedText()).toContain("⚠️ ada: I couldn't assign the PR");
    });

    it("never looks up Slack when the assignee is already mapped", async () => {
      assignee.mockResolvedValue(mapped);
      await make().notifyTerminal(makeTask(), "completed");
      expect(lookupSlackUser).not.toHaveBeenCalled();
    });

    it("skips the Slack lookup when the assignee has no email (falls back to name)", async () => {
      assignee.mockResolvedValue({ ...unmapped, email: "" });
      await make().notifyTerminal(makeTask(), "completed");
      expect(lookupSlackUser).not.toHaveBeenCalled();
      expect(postedText()).toContain("⚠️ ada:");
    });

    it("escapes mrkdwn in the display-name fallback (no <!channel> injection)", async () => {
      assignee.mockResolvedValue({ ...unmapped, displayName: "<!channel> <@U999>" });
      lookupSlackUser.mockResolvedValue(null);
      await make().notifyTerminal(makeTask(), "completed");
      const text = postedText();
      expect(text).toContain("&lt;!channel&gt; &lt;@U999&gt;");
      expect(text).not.toContain("<!channel>");
      expect(text).not.toContain("<@U999>");
    });

    it("never checks the assignee on no_action, even when the task carries PRs", async () => {
      // no_action renders no PR section, so there is nothing for the nudge to
      // ride on — the Linear/Slack lookups must be skipped entirely.
      assignee.mockResolvedValue(unmapped);
      getById.mockResolvedValue(makeTask({ prUrls: [PR] }));
      await make().notifyTerminal(makeTask(), "no_action");
      expect(assignee).not.toHaveBeenCalled();
      expect(postedText()).not.toContain("Connected accounts");
    });
  });
});
