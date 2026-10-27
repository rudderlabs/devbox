import { afterEach, describe, expect, it, mock } from "bun:test";

const {
  emitAction,
  emitError,
  emitResponse,
  emitThought,
  getIssueHumanAssignee,
  parseLinearIssueIdentifier,
  setIssueStarted,
  uploadIssueAttachment,
} = await import("../linearApi.ts" + "?linear-impl-test");

describe("parseLinearIssueIdentifier", () => {
  it("extracts identifier from a standard Linear issue URL", () => {
    expect(
      parseLinearIssueIdentifier("https://linear.app/example/issue/ABC-2944/test-ticket"),
    ).toBe("ABC-2944");
  });

  it("extracts identifier when URL has no trailing slug", () => {
    expect(parseLinearIssueIdentifier("https://linear.app/example/issue/ABC-2944")).toBe(
      "ABC-2944",
    );
  });

  it("extracts identifier when URL ends in trailing slash", () => {
    expect(parseLinearIssueIdentifier("https://linear.app/example/issue/ABC-2944/")).toBe(
      "ABC-2944",
    );
  });

  it("extracts identifier across multi-letter team prefixes and longer numbers", () => {
    expect(parseLinearIssueIdentifier("https://linear.app/acme/issue/ABC-12345/big-refactor")).toBe(
      "ABC-12345",
    );
  });

  it("upper-cases lowercase identifiers", () => {
    expect(parseLinearIssueIdentifier("https://linear.app/acme/issue/xyz-7/x")).toBe("XYZ-7");
  });

  it("preserves identifier when URL has a query string", () => {
    expect(parseLinearIssueIdentifier("https://linear.app/acme/issue/ABC-2944?utm_source=x")).toBe(
      "ABC-2944",
    );
  });

  it("returns null for non-Linear URLs", () => {
    expect(parseLinearIssueIdentifier("https://example.com/foo/bar")).toBeNull();
  });

  it("returns the raw segment uppercased — parser trusts Linear-formatted input", () => {
    expect(parseLinearIssueIdentifier("https://linear.app/x/issue/notanid/oops")).toBe("NOTANID");
  });

  it("returns null for null", () => {
    expect(parseLinearIssueIdentifier(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseLinearIssueIdentifier(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseLinearIssueIdentifier("")).toBeNull();
  });
});

describe("agent activity emits", () => {
  it("decorates thoughts with the thought emoji", async () => {
    const createAgentActivity = mock(() => Promise.resolve());

    await emitThought({ createAgentActivity } as never, "sess-1", "I'm narrowing the change");

    expect(createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "thought", body: "💭 I'm narrowing the change" },
    });
  });

  it("decorates errors with the warning emoji", async () => {
    const createAgentActivity = mock(() => Promise.resolve());

    await emitError({ createAgentActivity } as never, "sess-1", "Build gate failed");

    expect(createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "error", body: "⚠️ Build gate failed" },
    });
  });

  it("decorates only the action field for actions", async () => {
    const createAgentActivity = mock(() => Promise.resolve());

    await emitAction({ createAgentActivity } as never, "sess-1", "Provisioning", "infra");

    expect(createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "action", action: "⚡ Provisioning", parameter: "infra" },
    });
  });

  it("leaves responses verbatim", async () => {
    const createAgentActivity = mock(() => Promise.resolve());

    await emitResponse({ createAgentActivity } as never, "sess-1", "Final reply");

    expect(createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "response", body: "Final reply" },
    });
  });
});

describe("getIssueHumanAssignee", () => {
  // The SDK's issue.assignee getter is a lazy fetch — model it as a promise
  // property on a stub issue. The client is a plain parameter, so no
  // mock.module is needed.
  const clientWithAssignee = (assignee: unknown) =>
    ({ issue: () => Promise.resolve({ assignee: Promise.resolve(assignee) }) }) as never;

  it("projects a human assignee including gitHubUserId and email", async () => {
    const out = await getIssueHumanAssignee(
      clientWithAssignee({
        id: "usr-1",
        name: "Ada Lovelace",
        displayName: "ada",
        email: "ada@acme.com",
        gitHubUserId: "583231",
        app: false,
        isMe: false,
      }),
      "issue-1",
    );
    expect(out).toEqual({
      id: "usr-1",
      name: "Ada Lovelace",
      displayName: "ada",
      email: "ada@acme.com",
      gitHubUserId: "583231",
    });
  });

  it("normalizes a missing gitHubUserId to null", async () => {
    const out = await getIssueHumanAssignee(
      clientWithAssignee({ id: "usr-1", name: "n", displayName: "d", app: false, isMe: false }),
      "issue-1",
    );
    expect(out?.gitHubUserId).toBeNull();
  });

  it("returns null when the issue is unassigned", async () => {
    expect(await getIssueHumanAssignee(clientWithAssignee(undefined), "issue-1")).toBeNull();
  });

  it("returns null when the assignee is the authenticated app user (isMe)", async () => {
    expect(
      await getIssueHumanAssignee(
        clientWithAssignee({ id: "app-1", name: "harness", displayName: "harness", isMe: true }),
        "issue-1",
      ),
    ).toBeNull();
  });

  it("returns null when the assignee is any agent/app user", async () => {
    expect(
      await getIssueHumanAssignee(
        clientWithAssignee({
          id: "app-2",
          name: "bot",
          displayName: "bot",
          app: true,
          isMe: false,
        }),
        "issue-1",
      ),
    ).toBeNull();
  });
});

describe("uploadIssueAttachment", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uploads bytes to Linear fileUpload target and creates issue attachment", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fileUpload = mock(() =>
      Promise.resolve({
        success: true,
        uploadFile: {
          uploadUrl: "https://storage.example/upload",
          assetUrl: "https://storage.example/asset/run.tgz",
          headers: [{ key: "x-test", value: "123" }],
        },
      }),
    );
    const createAttachment = mock(() => Promise.resolve());
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200 } as Response),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await uploadIssueAttachment(
      {
        fileUpload,
        createAttachment,
      } as never,
      {
        issueId: "issue-1",
        title: "Harness run archive",
        subtitle: "Task task-1",
        filename: "harness-run-task-1.tar.gz",
        contentType: "application/gzip",
        bytes,
        metadata: { taskId: "task-1" },
      },
    );

    expect(fileUpload).toHaveBeenCalledWith("application/gzip", "harness-run-task-1.tar.gz", 3);
    expect(fetchMock).toHaveBeenCalledWith("https://storage.example/upload", {
      method: "PUT",
      headers: {
        "Content-Type": "application/gzip",
        "Cache-Control": "public, max-age=31536000",
        "x-test": "123",
      },
      body: bytes,
    });
    expect(createAttachment).toHaveBeenCalledWith({
      issueId: "issue-1",
      title: "Harness run archive",
      subtitle: "Task task-1",
      url: "https://storage.example/asset/run.tgz",
      metadata: { taskId: "task-1" },
    });
  });

  it("throws when storage upload returns non-2xx", async () => {
    const fetchMock = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () => Promise.resolve("<Error>MalformedSecurityHeader</Error>"),
      } as Response),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await expect(
      uploadIssueAttachment(
        {
          fileUpload: () =>
            Promise.resolve({
              success: true,
              uploadFile: {
                uploadUrl: "https://storage.example/upload",
                assetUrl: "https://storage.example/asset/run.tgz",
                headers: [],
              },
            }),
          createAttachment: () => Promise.resolve(),
        } as never,
        {
          issueId: "issue-1",
          title: "Harness run archive",
          filename: "harness-run-task-1.tar.gz",
          contentType: "application/gzip",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ),
    ).rejects.toThrow(/HTTP 400.*MalformedSecurityHeader/);
  });

  it("throws when fileUpload returns success false", async () => {
    await expect(
      uploadIssueAttachment(
        {
          fileUpload: () => Promise.resolve({ success: false, uploadFile: null }),
          createAttachment: () => Promise.resolve(),
        } as never,
        {
          issueId: "issue-1",
          title: "Harness run archive",
          filename: "harness-run-task-1.tar.gz",
          contentType: "application/gzip",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ),
    ).rejects.toThrow(/fileUpload rejected/);
  });
});

describe("setIssueStarted", () => {
  // The state cache is module-level, so every test uses its own team id.
  function fakeClient(teamId: string, nodes: Array<{ id: string; position: number }>) {
    const workflowStates = mock((_args: unknown) => Promise.resolve({ nodes }));
    const updateIssue = mock((_id: string, _input: unknown) => Promise.resolve());
    const client = {
      issue: () => Promise.resolve({ team: Promise.resolve({ id: teamId }) }),
      workflowStates,
      updateIssue,
    };
    return { client: client as never, workflowStates, updateIssue };
  }

  it("moves the issue to the team's first started state", async () => {
    const f = fakeClient("team-first", [
      { id: "s2", position: 2 },
      { id: "s1", position: 1 },
    ]);
    await setIssueStarted(f.client, "issue-1");
    expect(f.updateIssue.mock.calls).toEqual([["issue-1", { stateId: "s1" }]]);
    expect(f.workflowStates.mock.calls).toEqual([
      [
        {
          filter: { team: { id: { eq: "team-first" } }, type: { eq: "started" } },
          first: 50,
        },
      ],
    ]);
  });

  it("caches the state per team", async () => {
    const f = fakeClient("team-cache", [{ id: "s1", position: 1 }]);
    await setIssueStarted(f.client, "issue-1");
    await setIssueStarted(f.client, "issue-2");
    expect(f.workflowStates).toHaveBeenCalledTimes(1);
    expect(f.updateIssue).toHaveBeenCalledTimes(2);
  });

  it("throws when the team has no started state", async () => {
    const f = fakeClient("team-none", []);
    await expect(setIssueStarted(f.client, "issue-1")).rejects.toThrow(
      'No workflow state of type "started" for team team-none',
    );
    expect(f.updateIssue).not.toHaveBeenCalled();
  });
});
