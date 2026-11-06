import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Task } from "../../db/schema";
import type { Person, PrRef } from "../../integrations/types";

const postIssueComment = mock(() => Promise.resolve({ id: 1, url: "u" }));
const addPrAssignees = mock(() => Promise.resolve({ assigned: [] as string[] }));
const getUserById = mock(() => Promise.resolve({ login: "", id: 0 }));

// The full export surface of the ../../clients/github barrel.
mock.module("../../clients/github", () => ({
  postIssueComment,
  postReviewCommentReply: mock(() => Promise.resolve({ id: 1, url: "u" })),
  addIssueCommentReaction: mock(() => Promise.resolve()),
  addReviewCommentReaction: mock(() => Promise.resolve()),
  getReviewComments: mock(() => Promise.resolve([])),
  fetchOrgMembers: mock(() => Promise.resolve(new Set())),
  addPrAssignees,
  getUserById,
  getUserIdByLogin: mock(() => Promise.resolve(null)),
  requestReviewers: mock(() => Promise.resolve()),
  parsePrUrl: (url: string) => {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], prNumber: Number(m[3]) } : null;
  },
  githubTokenState: () => ({ source: "env", expiresAt: null, readAt: null, lastError: null }),
}));

// GitLab's client, as far as the code host uses it: one instance, at
// gitlab.example.com.
mock.module("../../clients/gitlab", () => ({
  parseMrUrl: (url: string) => {
    const m = url.match(/^https:\/\/gitlab\.example\.com\/(.+?)\/-\/merge_requests\/(\d+)/);
    return m ? { project: m[1], mrIid: Number(m[2]) } : null;
  },
}));

const { CodeHost } = await import("../codeHost.service");
const { BackgroundWork } = await import("../backgroundWork");
const { logger } = await import("../../logger");

const task = { id: "task-1", key: "XYZ-1", source: "linear" } as Task;
const PR_URL = "https://github.com/o/r/pull/1";
const MR_URL = "https://gitlab.example.com/platform/backend/api/-/merge_requests/3";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("CodeHost", () => {
  let assignee: ReturnType<typeof mock>;
  // The host integrations' onPrOpened, by integration name.
  const hosted = mock(
    (_name: string, _task: Task, _pr: PrRef, _runId?: string | null, _firstTime?: boolean) =>
      Promise.resolve(),
  );
  let background: InstanceType<typeof BackgroundWork>;
  let info: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;

  // A code host over a registry that records which host's integration a new
  // PR was handed to, and reports `assignee` as the task's person.
  const codeHost = (sendTimeoutMs?: number) =>
    new CodeHost(
      {
        for: (name: string) =>
          ({
            assignee,
            onPrOpened: (t: Task, runId: string | null, pr: PrRef, firstTime: boolean) =>
              hosted(name, t, pr, runId, firstTime),
          }) as never,
      },
      background,
      sendTimeoutMs,
    );
  const person = (githubAccount?: string | null): Person => ({
    id: "usr-1",
    displayName: "ada",
    email: "ada@acme.com",
    ...(githubAccount === undefined ? {} : { githubAccount }),
  });
  // The PR opened, the mirror included.
  const prOpened = async (host = codeHost()) => {
    await host.prOpened(task, host.prRef({ pr_url: PR_URL, repo: "r", branch: "b" }));
    await background.drain(sleep(500));
  };
  // The mirror's pr_assignee.result log lines.
  const results = () =>
    [...info.mock.calls, ...warn.mock.calls]
      .map(([, meta]) => meta as Record<string, unknown> | undefined)
      .filter((meta) => meta?.event === "pr_assignee.result");
  const logged = { event: "pr_assignee.result", taskId: "task-1", prUrl: PR_URL };

  beforeEach(() => {
    for (const m of [postIssueComment, addPrAssignees, getUserById, hosted]) m.mockReset();
    hosted.mockResolvedValue(undefined);
    postIssueComment.mockResolvedValue({ id: 1, url: "u" });
    addPrAssignees.mockResolvedValue({ assigned: [] });
    getUserById.mockResolvedValue({ login: "", id: 0 });
    assignee = mock(() => Promise.resolve(person(null)));
    background = new BackgroundWork();
    info = spyOn(logger, "info").mockImplementation(() => logger);
    warn = spyOn(logger, "warn").mockImplementation(() => logger);
    error = spyOn(logger, "error").mockImplementation(() => logger);
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it("prRef names the code host the URL belongs to, or null when none knows it", () => {
    const host = codeHost();
    expect(host.prRef({ pr_url: PR_URL, repo: "r", branch: "b" })).toEqual({
      url: PR_URL,
      repo: "r",
      branch: "b",
      host: "github",
    });
    expect(host.prRef({ pr_url: MR_URL, repo: "api", branch: "b" }).host).toBe("gitlab");
    // Not the configured GitLab instance, and not a github.com pull request.
    expect(
      host.prRef({ pr_url: "https://gitlab.com/o/r/-/merge_requests/1", repo: "r", branch: "b" })
        .host,
    ).toBeNull();
  });

  it("a PR on a URL no code host knows reaches no integration and looks nobody up", async () => {
    const host = codeHost();
    await host.prOpened(
      task,
      host.prRef({ pr_url: "https://example.com/o/r/pull/1", repo: "r", branch: "b" }),
    );
    await background.drain(sleep(500));
    expect(hosted).not.toHaveBeenCalled();
    expect(assignee).not.toHaveBeenCalled();
  });

  it("hands a new PR to its own host's integration, which writes on it", async () => {
    await prOpened();
    expect(hosted).toHaveBeenCalledTimes(1);
    // As a PR new to the task, and for no run in particular.
    expect(hosted).toHaveBeenCalledWith(
      "github",
      task,
      expect.objectContaining({ url: PR_URL, host: "github" }),
      null,
      true,
    );
  });

  it("drops a RetryableError from the host's integration: only the task's own integration holds", async () => {
    const { RetryableError } = await import("../../integrations/outbound");
    hosted.mockRejectedValue(new RetryableError("rate limited"));
    assignee.mockResolvedValue(person("octocat"));
    addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });
    await prOpened();
    expect(error).toHaveBeenCalledWith(
      "the code host integration's onPrOpened failed",
      expect.objectContaining({ taskId: "task-1", prUrl: PR_URL, message: "rate limited" }),
    );
    // The mirror still runs.
    expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
  });

  it("the host's integration finishes before the assignee mirror starts", async () => {
    const order: string[] = [];
    hosted.mockImplementation(async () => {
      await sleep(10);
      order.push("integration");
    });
    assignee.mockImplementation(async () => {
      order.push("assignee");
      return person(null);
    });
    await prOpened();
    expect(order).toEqual(["integration", "assignee"]);
  });

  describe("a GitLab merge request", () => {
    const mrOpened = async (host = codeHost()) => {
      await host.prOpened(task, host.prRef({ pr_url: MR_URL, repo: "api", branch: "b" }));
      await background.drain(sleep(500));
    };

    it("goes to GitLab's integration, not GitHub's", async () => {
      await mrOpened();
      expect(hosted).toHaveBeenCalledTimes(1);
      expect(hosted).toHaveBeenCalledWith(
        "gitlab",
        task,
        expect.objectContaining({ url: MR_URL, host: "gitlab" }),
        null,
        true,
      );
    });

    it("gets no assignee: nothing links a person to a GitLab account, so nobody is looked up", async () => {
      assignee.mockResolvedValue(person("octocat"));
      await mrOpened();
      expect(assignee).not.toHaveBeenCalled();
      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(results()).toEqual([]);
    });
  });

  it("an integration that can't link accounts → skip as unsupported", async () => {
    assignee.mockResolvedValue(person());
    await prOpened();
    expect(addPrAssignees).not.toHaveBeenCalled();
    expect(results()).toEqual([
      { ...logged, status: "skipped", reason: "unsupported", personId: "usr-1" },
    ]);
  });

  describe("account id to login", () => {
    it("numeric account → resolves the login via getUserById and assigns it", async () => {
      assignee.mockResolvedValue(person("583231"));
      getUserById.mockResolvedValue({ login: "octocat", id: 583231 });
      addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });

      await prOpened();

      expect(assignee).toHaveBeenCalledWith(task, { prUrl: PR_URL });
      expect(getUserById).toHaveBeenCalledWith("583231", expect.any(AbortSignal));
      expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
      expect(results()).toEqual([
        { ...logged, status: "assigned", requested: "octocat", assigned: ["octocat"] },
      ]);
    });

    it("non-numeric account is treated as a login directly (no getUserById)", async () => {
      assignee.mockResolvedValue(person("octocat"));
      addPrAssignees.mockResolvedValue({ assigned: ["octocat"] });

      await prOpened();

      expect(getUserById).not.toHaveBeenCalled();
      expect(addPrAssignees).toHaveBeenCalledWith("o", "r", 1, ["octocat"]);
    });

    it("empty login from a malformed getUserById response → skip, no assignees POST", async () => {
      assignee.mockResolvedValue(person("583231"));
      getUserById.mockResolvedValue({ login: "", id: 0 });

      await prOpened();

      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(results()).toEqual([
        { ...logged, status: "skipped", reason: "unresolved_login", personId: "usr-1" },
      ]);
    });

    it("a hung getUserById is cut at the send timeout: no assignees POST", async () => {
      assignee.mockResolvedValue(person("583231"));
      getUserById.mockImplementation(() => new Promise(() => {}));

      await prOpened(codeHost(20));

      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        "PR assignee mirror failed",
        expect.objectContaining({ taskId: "task-1", message: "timed out after 20 ms" }),
      );
    });

    it("getUserById rejection is swallowed: no throw, no assignees POST", async () => {
      assignee.mockResolvedValue(person("583231"));
      getUserById.mockRejectedValue(new Error("github down"));

      await prOpened();

      expect(addPrAssignees).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        "PR assignee mirror failed",
        expect.objectContaining({ taskId: "task-1", prUrl: PR_URL, message: "github down" }),
      );
    });
  });
});
