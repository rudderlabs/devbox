import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import {
  delegation,
  isNonHuman,
  issueContext,
  parseAssignment,
  parseComment,
  verifySignature,
} from "../events";

// Synthetic ids and payloads, shaped like Jira Cloud's admin webhooks.
const BOT = "5e0f1a2b3c4d5e6f7a8b9c0d";
const HUMAN = "5c3e2f1a9b8d7c6e5f4a3b21";
const OTHER = "5d4c3b2a1f0e9d8c7b6a5f43";
const BOT_NAME = "devbox";

function user(accountId: string, accountType = "atlassian") {
  return {
    self: `https://example.atlassian.net/rest/api/2/user?accountId=${accountId}`,
    accountId,
    displayName: "Some Person",
    active: true,
    timeZone: "UTC",
    accountType,
  };
}

type Item = Record<string, unknown>;

function item(field: string, from: string | null, to: string | null, extra: Item = {}): Item {
  return {
    field,
    fieldtype: "jira",
    fieldId: field,
    from,
    fromString: null,
    to,
    toString: null,
    ...extra,
  };
}

function issueEvent(webhookEvent: string, items: Item[], changelogId = "10101") {
  return {
    timestamp: 1_700_000_000_000,
    webhookEvent,
    issue_event_type_name:
      webhookEvent === "jira:issue_created" ? "issue_created" : "issue_assigned",
    user: user(HUMAN),
    issue: {
      id: "10042",
      self: "https://example.atlassian.net/rest/api/2/issue/10042",
      key: "DEMO-7",
      fields: {
        summary: "Fix the login page",
        description: "The button is *broken*",
        reporter: user(OTHER),
        assignee: user(BOT),
        security: null,
        status: { name: "To Do", id: "10000" },
      },
    },
    changelog: { id: changelogId, items },
  };
}

function commentEvent(body: string, commentId = "10077", issueId = "10042") {
  return {
    timestamp: 1_700_000_000_000,
    webhookEvent: "comment_created",
    eventType: "primaryAction",
    comment: {
      self: `https://example.atlassian.net/rest/api/2/issue/${issueId}/comment/${commentId}`,
      id: commentId,
      author: user(HUMAN),
      body,
      updateAuthor: user(HUMAN),
      created: "2026-01-01T00:00:00.000+0000",
      updated: "2026-01-01T00:00:00.000+0000",
      jsdPublic: true,
    },
    issue: {
      id: issueId,
      key: "DEMO-7",
      fields: { summary: "Fix the login page", assignee: user(BOT, "app") },
    },
  };
}

describe("verifySignature", () => {
  const secret = "webhook-test-secret";
  const body = JSON.stringify(commentEvent("hello"));
  const sign = (b: string, s = secret) =>
    `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

  it("accepts the HMAC-SHA256 of the raw body", () => {
    expect(verifySignature(body, sign(body), secret)).toBe(true);
  });

  it("accepts upper-case hex", () => {
    const header = sign(body);
    expect(verifySignature(body, `sha256=${header.slice(7).toUpperCase()}`, secret)).toBe(true);
  });

  it("rejects a tampered body or signature", () => {
    expect(verifySignature(`${body} `, sign(body), secret)).toBe(false);
    const header = sign(body);
    const flipped = header.slice(0, -1) + (header.endsWith("0") ? "1" : "0");
    expect(verifySignature(body, flipped, secret)).toBe(false);
    expect(verifySignature(body, sign(body, "another-secret"), secret)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, "", secret)).toBe(false);
  });

  it("rejects a wrong prefix or a malformed digest", () => {
    const hex = sign(body).slice(7);
    expect(verifySignature(body, hex, secret)).toBe(false);
    expect(verifySignature(body, `sha1=${hex}`, secret)).toBe(false);
    expect(verifySignature(body, `SHA256=${hex}`, secret)).toBe(false);
    expect(verifySignature(body, `sha256=${hex.slice(2)}`, secret)).toBe(false);
    expect(verifySignature(body, `sha256=${hex}00`, secret)).toBe(false);
    expect(verifySignature(body, `sha256=${"z".repeat(64)}`, secret)).toBe(false);
  });

  it("verifies nothing without a secret", () => {
    expect(verifySignature(body, sign(body, ""), "")).toBe(false);
  });
});

describe("parseAssignment", () => {
  it("reads an issue_updated that assigns the bot", () => {
    const a = parseAssignment(issueEvent("jira:issue_updated", [item("assignee", null, BOT)]), BOT);
    expect(a).toEqual({
      issueId: "10042",
      issueKey: "DEMO-7",
      changelogId: "10101",
      actor: { accountId: HUMAN, accountType: "atlassian" },
      reporter: { accountId: OTHER, accountType: "atlassian" },
      securityLevel: "unset",
      title: "Fix the login page",
      descriptionWiki: "The button is *broken*",
    });
  });

  it("reads an issue created already assigned to the bot (only issue_created is sent)", () => {
    const created = issueEvent("jira:issue_created", [
      item("Status", null, "10000", { fieldId: "status" }),
      item("priority", null, "3"),
      item("summary", null, null),
      item("assignee", null, BOT),
      item("reporter", null, OTHER),
    ]);
    expect(parseAssignment(created, BOT)?.changelogId).toBe("10101");
  });

  it("ignores an issue created without the bot as assignee", () => {
    const created = issueEvent("jira:issue_created", [
      item("Status", null, "10000", { fieldId: "status" }),
      item("reporter", null, OTHER),
    ]);
    expect(parseAssignment(created, BOT)).toBeNull();
  });

  it("ignores an un-assign, to someone else or to nobody", () => {
    const toOther = issueEvent("jira:issue_updated", [item("assignee", BOT, OTHER)]);
    const toNobody = issueEvent("jira:issue_updated", [item("assignee", BOT, null)]);
    expect(parseAssignment(toOther, BOT)).toBeNull();
    expect(parseAssignment(toNobody, BOT)).toBeNull();
  });

  it("ignores an assignment to someone else", () => {
    expect(
      parseAssignment(issueEvent("jira:issue_updated", [item("assignee", null, OTHER)]), BOT),
    ).toBeNull();
  });

  it("matches the item by field name, not fieldId alone, and never a custom field", () => {
    const byIdOnly = item("Assignee", null, BOT, { fieldId: "assignee" });
    const custom = item("assignee", null, BOT, {
      fieldtype: "custom",
      fieldId: "customfield_10050",
    });
    expect(parseAssignment(issueEvent("jira:issue_updated", [byIdOnly]), BOT)).toBeNull();
    expect(parseAssignment(issueEvent("jira:issue_updated", [custom]), BOT)).toBeNull();
  });

  it("tells a restricted issue from an open one, and both from a payload that leaves it out", () => {
    const withSecurity = (security?: unknown) => {
      const e = issueEvent("jira:issue_updated", [item("assignee", null, BOT)]);
      const fields = e.issue.fields as Record<string, unknown>;
      if (security === undefined) delete fields.security;
      else fields.security = security;
      return parseAssignment(e, BOT)?.securityLevel;
    };
    expect(withSecurity({ id: "10000", name: "Staff only" })).toBe("set");
    expect(withSecurity(null)).toBe("unset");
    expect(withSecurity()).toBe("unknown");
  });

  it("reads a missing description as empty and a missing reporter as null", () => {
    const e = issueEvent("jira:issue_updated", [item("assignee", null, BOT)]);
    const fields = e.issue.fields as Record<string, unknown>;
    fields.description = null;
    delete fields.reporter;
    const a = parseAssignment(e, BOT);
    expect(a?.descriptionWiki).toBe("");
    expect(a?.reporter).toBeNull();
  });

  it("ignores other events", () => {
    const e = { ...issueEvent("jira:issue_updated", [item("assignee", null, BOT)]) };
    expect(parseAssignment({ ...e, webhookEvent: "comment_created" }, BOT)).toBeNull();
    expect(parseAssignment({ ...e, webhookEvent: "jira:issue_deleted" }, BOT)).toBeNull();
  });

  it("is null for malformed ids, a missing actor, or a payload that isn't an object", () => {
    const ok = () => issueEvent("jira:issue_updated", [item("assignee", null, BOT)]);
    const variants: Array<(e: ReturnType<typeof ok>) => unknown> = [
      (e) => ({ ...e, issue: { ...e.issue, id: "10042/../1" } }),
      (e) => ({ ...e, issue: { ...e.issue, id: 10042 } }),
      (e) => ({ ...e, issue: { ...e.issue, key: "DEMO-7/../x" } }),
      (e) => ({ ...e, issue: { ...e.issue, fields: undefined } }),
      (e) => ({ ...e, changelog: { ...e.changelog, id: "abc" } }),
      (e) => ({ ...e, changelog: { ...e.changelog, items: "assignee" } }),
      (e) => ({ ...e, user: undefined }),
      (e) => ({ ...e, user: { accountId: "" } }),
      // One spelling per id, and every id a safe integer.
      (e) => ({ ...e, issue: { ...e.issue, id: "010042" } }),
      (e) => ({ ...e, changelog: { ...e.changelog, id: "0" } }),
      (e) => ({ ...e, changelog: { ...e.changelog, id: "9".repeat(16) } }),
      (e) => ({ ...e, changelog: { ...e.changelog, id: "9".repeat(400) } }),
      // Account ids are short runs of letters, digits, ":", "_" and "-".
      (e) => ({ ...e, user: { accountId: "abc/../def" } }),
      (e) => ({ ...e, user: { accountId: "abc def" } }),
      (e) => ({ ...e, user: { accountId: "a".repeat(129) } }),
    ];
    for (const v of variants) expect(parseAssignment(v(ok()), BOT)).toBeNull();
    const longest = { ...ok(), changelog: { ...ok().changelog, id: "9".repeat(15) } };
    expect(
      delegation(parseAssignment(longest, BOT) ?? { issueId: "", changelogId: "" }).order,
    ).toBe(999_999_999_999_999);
    const colonId = { ...ok(), user: user("557058:0f1e2d3c-aaaa-bbbb-cccc-111122223333") };
    expect(parseAssignment(colonId, BOT)?.actor.accountId).toContain(":");
    for (const p of [null, undefined, "x", 42, [], {}]) expect(parseAssignment(p, BOT)).toBeNull();
    expect(parseAssignment(ok(), "")).toBeNull();
  });
});

describe("delegation", () => {
  it("is issue id and changelog id, ordered by the changelog id", () => {
    const first = parseAssignment(
      issueEvent("jira:issue_updated", [item("assignee", null, BOT)], "10210"),
      BOT,
    );
    const again = parseAssignment(
      issueEvent("jira:issue_updated", [item("assignee", OTHER, BOT)], "10215"),
      BOT,
    );
    if (!first || !again) throw new Error("expected both assignments to parse");
    expect(delegation(first)).toEqual({ id: "10042:10210", order: 10210 });
    expect(delegation(again).order).toBeGreaterThan(delegation(first).order);
  });
});

describe("parseComment", () => {
  it("keeps a comment id equal to its issue id apart from it", () => {
    const c = parseComment(commentEvent("hi", "10042", "10042"), BOT, BOT_NAME);
    expect(c).toEqual({
      issueId: "10042",
      commentId: "10042",
      author: { accountId: HUMAN, accountType: "atlassian" },
      bodyWiki: "hi",
      mentionsBot: false,
      assignedToBot: true,
      restricted: false,
    });
  });

  it("sees whether the bot is the issue's assignee", () => {
    const assigned = (assignee: unknown) => {
      const e = commentEvent("hi");
      const fields = { ...e.issue.fields, assignee };
      return parseComment({ ...e, issue: { ...e.issue, fields } }, BOT, BOT_NAME)?.assignedToBot;
    };
    expect(assigned(user(BOT, "app"))).toBe(true);
    expect(assigned(user(HUMAN))).toBe(false);
    expect(assigned(null)).toBe(false);
    expect(assigned(undefined)).toBe(false);
    expect(assigned({ accountId: `${BOT}]` })).toBe(false);
  });

  it("sees a mention picked from Jira's picker", () => {
    const c = parseComment(commentEvent(`[~accountid:${BOT}] please retry`), BOT, BOT_NAME);
    expect(c?.mentionsBot).toBe(true);
  });

  it("sees a typed @name as a whole word, in any case", () => {
    for (const body of [
      "@devbox please retry",
      "thanks @DevBox.",
      "(@devbox)",
      "hey\n@devbox: go",
    ]) {
      expect(parseComment(commentEvent(body), BOT, BOT_NAME)?.mentionsBot).toBe(true);
    }
  });

  it("matches a display name with spaces or regex characters literally", () => {
    expect(parseComment(commentEvent("@Dev Box (bot) go"), BOT, "Dev Box (bot)")?.mentionsBot).toBe(
      true,
    );
    expect(parseComment(commentEvent("@devXbox go"), BOT, "dev.box")?.mentionsBot).toBe(false);
  });

  it("does not count lookalikes as a mention", () => {
    for (const body of [
      "@devboxer can you look",
      "@devbox-ci ran",
      "mail devbox@example.com",
      "user@devbox.example.com",
      "devbox, please",
      `[~accountid:${OTHER}] please retry`,
      `[~accountid:${BOT}x] please retry`,
    ]) {
      expect(parseComment(commentEvent(body), BOT, BOT_NAME)?.mentionsBot).toBe(false);
    }
  });

  it("ignores mentions inside {code} and {noformat} blocks", () => {
    for (const body of [
      `{code}[~accountid:${BOT}]{code} done`,
      "{noformat}@devbox{noformat} done",
      "{code:bash}\ncurl @devbox\n{code}",
    ]) {
      expect(parseComment(commentEvent(body), BOT, BOT_NAME)?.mentionsBot).toBe(false);
    }
    expect(parseComment(commentEvent("{code}x{code} @devbox go"), BOT, BOT_NAME)?.mentionsBot).toBe(
      true,
    );
    // An unclosed block is prose, as the converter treats it.
    expect(parseComment(commentEvent("{code} @devbox go"), BOT, BOT_NAME)?.mentionsBot).toBe(true);
  });

  it("lets Jira's italic underscores hug a typed mention, but not a longer name", () => {
    for (const body of ["_@devbox please_", "_please @devbox_", "(_@devbox_)"]) {
      expect(parseComment(commentEvent(body), BOT, BOT_NAME)?.mentionsBot).toBe(true);
    }
    for (const body of ["@devbox_ci ran", "@devbox__", "foo_@devbox", "@devbox/cli is fine"]) {
      expect(parseComment(commentEvent(body), BOT, BOT_NAME)?.mentionsBot).toBe(false);
    }
  });

  it("marks a comment restricted to a role, a group or service-desk staff", () => {
    const restricted = (extra: Record<string, unknown>) => {
      const e = commentEvent("hi");
      return parseComment({ ...e, comment: { ...e.comment, ...extra } }, BOT, BOT_NAME)?.restricted;
    };
    expect(restricted({ visibility: { type: "role", value: "Administrators" } })).toBe(true);
    expect(restricted({ visibility: { type: "group", identifier: "a-group-id" } })).toBe(true);
    expect(restricted({ jsdPublic: false })).toBe(true);
    expect(restricted({ jsdPublic: true })).toBe(false);
    expect(restricted({ visibility: null })).toBe(false);
  });

  it("never matches every @ when the bot name is blank", () => {
    expect(parseComment(commentEvent("@someone"), BOT, " ")?.mentionsBot).toBe(false);
  });

  it("is null for other events and malformed comments", () => {
    const ok = () => commentEvent("hi");
    expect(parseComment({ ...ok(), webhookEvent: "comment_updated" }, BOT, BOT_NAME)).toBeNull();
    const variants: Array<(e: ReturnType<typeof ok>) => unknown> = [
      (e) => ({ ...e, comment: { ...e.comment, id: "10077?x=1" } }),
      (e) => ({ ...e, comment: { ...e.comment, body: { type: "doc", content: [] } } }),
      (e) => ({ ...e, comment: { ...e.comment, author: undefined } }),
      (e) => ({ ...e, issue: { ...e.issue, id: "" } }),
      (e) => ({ ...e, issue: undefined }),
      (e) => ({ ...e, comment: { ...e.comment, id: "007" } }),
      (e) => ({ ...e, comment: { ...e.comment, author: { accountId: "x]y" } } }),
    ];
    for (const v of variants) expect(parseComment(v(ok()), BOT, BOT_NAME)).toBeNull();
    expect(parseComment(null, BOT, BOT_NAME)).toBeNull();
  });
});

describe("isNonHuman", () => {
  it("is true for app and customer accounts only", () => {
    expect(isNonHuman({ accountId: OTHER, accountType: "app" })).toBe(true);
    expect(isNonHuman({ accountId: OTHER, accountType: "customer" })).toBe(true);
    expect(isNonHuman({ accountId: OTHER, accountType: "atlassian" })).toBe(false);
    expect(isNonHuman({ accountId: OTHER })).toBe(false);
  });
});

describe("issueContext", () => {
  const withFields = (fields: Record<string, unknown>) => ({ issue: { id: "10042", fields } });

  it("reads the project key, upper-cased, and the creator from either event", () => {
    expect(
      issueContext(withFields({ project: { key: "demo" }, creator: user(OTHER, "atlassian") })),
    ).toEqual({ projectKey: "DEMO", creator: { accountId: OTHER, accountType: "atlassian" } });
    expect(issueContext(commentEvent("hi"))).toEqual({ projectKey: null, creator: null });
  });

  it("is null for a missing or malformed key or creator", () => {
    for (const fields of [
      {},
      { project: { key: "../X" }, creator: { accountId: "x]y" } },
      { project: "DEMO", creator: "someone" },
    ]) {
      expect(issueContext(withFields(fields))).toEqual({ projectKey: null, creator: null });
    }
    expect(issueContext(null)).toEqual({ projectKey: null, creator: null });
  });
});
