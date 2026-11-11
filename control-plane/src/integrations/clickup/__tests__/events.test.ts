import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { delegation, isTrusted, parseAssignment, parseComment, verifySignature } from "../events";
import {
  assignmentEvent,
  BOT,
  CLICKBOT,
  COMMENT_ID,
  commentEvent,
  DATE,
  HUMAN,
  ITEM_ID,
  TASK_ID,
  tag,
  text,
  user,
} from "./fixtures";

describe("verifySignature", () => {
  const body = JSON.stringify(assignmentEvent());
  const hex = (b: string, secret: string) => createHmac("sha256", secret).update(b).digest("hex");

  it("accepts the hex HMAC-SHA256 of the raw body under the secret", () => {
    expect(verifySignature(body, hex(body, "s3cret"), "s3cret")).toBe(true);
    expect(verifySignature(body, hex(body, "s3cret").toUpperCase(), "s3cret")).toBe(true);
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["another secret's signature", hex(body, "other")],
    ["a signature over another body", hex(`${body} `, "s3cret")],
    ["a prefixed signature", `sha256=${hex(body, "s3cret")}`],
    ["a short signature", hex(body, "s3cret").slice(0, 63)],
    ["a non-hex signature", "z".repeat(64)],
  ])("refuses %s", (_, header) => {
    expect(verifySignature(body, header, "s3cret")).toBe(false);
  });

  it("verifies nothing under an empty secret", () => {
    expect(verifySignature(body, hex(body, ""), "")).toBe(false);
  });
});

describe("parseAssignment", () => {
  it("reads the bot being added as an assignee", () => {
    expect(parseAssignment(assignmentEvent(), BOT)).toEqual({
      taskId: TASK_ID,
      historyItemId: ITEM_ID,
      date: Number(DATE),
      actor: { id: HUMAN, role: 3 },
    });
  });

  it("reads the actor's role as null when it is null or missing", () => {
    expect(parseAssignment(assignmentEvent({ actor: CLICKBOT }), BOT)?.actor).toEqual({
      id: -1,
      role: null,
    });
    const { role: _r, ...noRole } = user(HUMAN);
    expect(parseAssignment(assignmentEvent({ actor: noRole }), BOT)?.actor).toEqual({
      id: HUMAN,
      role: null,
    });
  });

  it("takes a user id written as digits", () => {
    const event = assignmentEvent();
    const [item] = event.history_items;
    if (!item) throw new Error("no item");
    (item.after as { id: unknown }).id = String(BOT);
    expect(parseAssignment(event, BOT)?.taskId).toBe(TASK_ID);
  });

  it.each([
    ["removing the bot", assignmentEvent({ field: "assignee_rem" })],
    ["adding someone else", assignmentEvent({ assignee: HUMAN })],
    ["another event", { ...assignmentEvent(), event: "taskUpdated" }],
    ["a task id with capitals", assignmentEvent({ taskId: "ABC0001" })],
    ["a task id with a slash", assignmentEvent({ taskId: "abc/../x" })],
    ["a history item id that isn't digits", assignmentEvent({ itemId: "1e3" })],
    ["a history item id with a leading zero", assignmentEvent({ itemId: "0123" })],
    ["a date that isn't digits", assignmentEvent({ date: "2026-01-01" })],
    ["an actor without an id", assignmentEvent({ actor: { username: "x", role: 3 } })],
    ["no history", { ...assignmentEvent(), history_items: "x" }],
  ])("is null for %s", (_, payload) => {
    expect(parseAssignment(payload, BOT)).toBeNull();
  });

  it("is null, never a throw, for odd payloads", () => {
    for (const p of [null, undefined, 1, "x", [], {}, { event: "taskAssigneeUpdated" }]) {
      expect(parseAssignment(p, BOT)).toBeNull();
    }
  });

  it("orders by the history item's date and names the delegation by task and item", () => {
    const a = parseAssignment(assignmentEvent(), BOT);
    if (!a) throw new Error("no assignment");
    expect(delegation(a)).toEqual({ id: `${TASK_ID}:${ITEM_ID}`, order: Number(DATE) });
    const later = parseAssignment(
      assignmentEvent({ itemId: "1000000000000000009", date: "1767225600001" }),
      BOT,
    );
    if (!later) throw new Error("no assignment");
    expect(delegation(later).order).toBeGreaterThan(delegation(a).order);
  });
});

describe("parseComment", () => {
  it("reads a comment with its ids, author, privacy and mention", () => {
    const parts = [tag(BOT), text(" please fix the footer\n")];
    expect(parseComment(commentEvent(parts), BOT, "devbox")).toEqual({
      taskId: TASK_ID,
      commentId: COMMENT_ID,
      author: { id: HUMAN, role: 3 },
      parts,
      mentionsBot: true,
      private: false,
    });
  });

  it("marks a private comment", () => {
    const parsed = parseComment(
      commentEvent([text("@devbox x")], { isPrivate: true }),
      BOT,
      "devbox",
    );
    expect(parsed?.private).toBe(true);
  });

  it("finds a typed @name as a mention, and no mention without one", () => {
    expect(parseComment(commentEvent([text("@DevBox go\n")]), BOT, "devbox")?.mentionsBot).toBe(
      true,
    );
    expect(parseComment(commentEvent([text("go\n")]), BOT, "devbox")?.mentionsBot).toBe(false);
    expect(parseComment(commentEvent([tag(HUMAN), text(" go")]), BOT, "devbox")?.mentionsBot).toBe(
      false,
    );
  });

  it("falls back to the plain text when there are no parts", () => {
    const event = commentEvent([]);
    const comment = event.history_items[0]?.comment as Record<string, unknown>;
    delete comment.comment;
    comment.text_content = "@devbox try again";
    const parsed = parseComment(event, BOT, "devbox");
    expect(parsed?.parts).toEqual([{ text: "@devbox try again" }]);
    expect(parsed?.mentionsBot).toBe(true);
  });

  it.each([
    ["another event", { ...commentEvent([]), event: "taskUpdated" }],
    ["a comment id that isn't digits", commentEvent([], { commentId: "abc" })],
    ["a bad task id", commentEvent([], { taskId: "Task-1" })],
    ["an author without an id", commentEvent([], { author: { role: 3 } })],
  ])("is null for %s", (_, payload) => {
    expect(parseComment(payload, BOT, "devbox")).toBeNull();
  });

  it("is null, never a throw, for odd payloads", () => {
    for (const p of [null, 1, "x", [], {}, { event: "taskCommentPosted", history_items: [1] }]) {
      expect(parseComment(p, BOT, "devbox")).toBeNull();
    }
  });
});

describe("isTrusted", () => {
  it.each([
    [1, true],
    [2, true],
    [3, true],
    [4, false],
    [null, false],
    [0, false],
    [5, false],
  ])("role %p: %p", (role, trusted) => {
    expect(isTrusted({ id: HUMAN, role }, BOT)).toBe(trusted);
  });

  it("never trusts the bot, nor ClickBot", () => {
    expect(isTrusted({ id: BOT, role: 1 }, BOT)).toBe(false);
    expect(isTrusted({ id: -1, role: null }, BOT)).toBe(false);
  });
});
