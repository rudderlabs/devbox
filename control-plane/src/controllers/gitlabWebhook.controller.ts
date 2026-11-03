import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import {
  awardNoteEmoji,
  fetchGroupMembers,
  getUserIdByUsername,
  listOpenMergeRequestsForBranch,
  mrWebUrl,
} from "../clients/gitlab";
import type { TaskIntake } from "../integrations/intake";
import type { GitlabWebhooksConfig } from "../integrationsConfig";
import { logger } from "../logger";
import type { ReplyTargetSpec } from "../repositories/inbox.repository";
import type { InboxService } from "../services/inbox.service";
import { mentionRegex, TRUSTED_SET_TTL_MS } from "./githubWebhook.controller";

// ──── Parsed event surface ────
//
// parseGitlabEvent reduces the raw GitLab event types to this union and applies
// the trigger rules:
//  - Note Hook on a merge request, action create, not a system note → require
//    @<bot>; a DiffNote keeps its file and line, so the reply threads on the diff
//  - Pipeline Hook with status failed → ci_result (per merge request)
//  - Merge Request Hook (approve, update, close…) is not handled: GitLab has
//    no batched "review submitted" event with content, each note arrives alone
export type ParsedGitlabEvent =
  | {
      kind: "comment";
      userId: number;
      username: string;
      project: { id: number; path: string; webUrl: string };
      mrIid: number;
      mrAuthorId: number;
      mrUrl: string;
      noteId: number;
      body: string;
      // ISO-8601 created_at of the note; "" when absent.
      createdAt: string;
      spec: Extract<ReplyTargetSpec, { kind: "mr_note" | "mr_diff_note" }>;
    }
  | {
      kind: "pipeline";
      userId: number;
      project: { id: number; path: string; webUrl: string };
      pipelineId: number;
      pipelineIid: number;
      name: string;
      status: string;
      ref: string;
      sha: string;
      url: string;
      // The merge request the pipeline ran for, when GitLab names one (a
      // merge request pipeline). A branch pipeline names none: the controller
      // looks the open merge requests of `ref` up.
      mrIid: number | null;
    };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const id = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// How far a delivery's webhook-timestamp may sit from now (replay protection).
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

// The actor's immutable numeric id — the value the trust gate checks. 0 for an
// unknown shape, so the gate fails closed.
export function extractUserId(payload: unknown): number {
  return id(rec(rec(payload).user).id);
}

function project(p: Rec): { id: number; path: string; webUrl: string } | null {
  const proj = rec(p.project);
  const projectId = id(proj.id);
  const path = str(proj.path_with_namespace);
  const webUrl = str(proj.web_url).replace(/\/+$/, "");
  if (!projectId || !path || !webUrl) return null;
  return { id: projectId, path, webUrl };
}

export function parseGitlabEvent(
  eventHeader: string | undefined,
  payload: unknown,
  mention: RegExp,
): ParsedGitlabEvent | null {
  const p = rec(payload);
  const proj = project(p);
  if (!proj) return null;

  if (eventHeader === "Note Hook") {
    const note = rec(p.object_attributes);
    if (str(note.noteable_type) !== "MergeRequest") return null;
    // Only new notes (older instances send no action; an edit is "update").
    const action = str(note.action);
    if (action && action !== "create") return null;
    if (note.system === true) return null;
    const merge = rec(p.merge_request);
    const mrIid = id(merge.iid);
    const noteId = id(note.id);
    const body = str(note.note);
    if (!mrIid || !noteId) return null;
    if (!mention.test(body)) return null;
    const base = { projectId: proj.id, project: proj.path, mrIid, noteId };
    const discussionId = str(note.discussion_id) || undefined;
    let spec: Extract<ReplyTargetSpec, { kind: "mr_note" | "mr_diff_note" }>;
    if (str(note.type) === "DiffNote" && discussionId) {
      const position = rec(note.position);
      const line = num(position.new_line ?? position.old_line);
      spec = {
        kind: "mr_diff_note",
        ...base,
        discussionId,
        path: str(position.new_path) || str(position.old_path),
        line: Number.isFinite(line) ? line : 0,
      };
    } else {
      spec = { kind: "mr_note", ...base, ...(discussionId ? { discussionId } : {}) };
    }
    return {
      kind: "comment",
      userId: extractUserId(payload),
      username: str(rec(p.user).username),
      project: proj,
      mrIid,
      mrAuthorId: id(merge.author_id),
      mrUrl: mrWebUrl(proj.webUrl, mrIid),
      noteId,
      body,
      createdAt: str(note.created_at),
      spec,
    };
  }

  if (eventHeader === "Pipeline Hook") {
    const attrs = rec(p.object_attributes);
    const status = str(attrs.status);
    const pipelineId = id(attrs.id);
    if (!pipelineId || !status) return null;
    // Only failed pipelines need the agent; success, canceled and skipped are noise.
    if (status !== "failed") return null;
    const pipelineIid = id(attrs.iid) || pipelineId;
    const merge = rec(p.merge_request);
    const mrIid = id(merge.iid);
    return {
      kind: "pipeline",
      userId: extractUserId(payload),
      project: proj,
      pipelineId,
      pipelineIid,
      name: str(attrs.name) || `Pipeline #${pipelineIid}`,
      status,
      ref: str(attrs.ref),
      sha: str(attrs.sha),
      url: str(attrs.url) || `${proj.webUrl}/-/pipelines/${pipelineId}`,
      mrIid: mrIid || null,
    };
  }

  return null;
}

// Standard Webhooks verification (GitLab 19.0+): webhook-signature holds
// space-separated `v1,<base64 HMAC-SHA256>` values over
// `<webhook-id>.<webhook-timestamp>.<body>`, keyed by the base64-decoded token
// after its `whsec_` prefix.
export function verifyGitlabSignature(
  body: string,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  signingToken: string,
  nowMs: number,
): "ok" | "missing" | "stale" | "mismatch" {
  const { id: messageId, timestamp, signature } = headers;
  if (!messageId || !timestamp || !signature) return "missing";
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts * 1000) > SIGNATURE_TOLERANCE_MS) return "stale";
  let key: Buffer;
  try {
    key = Buffer.from(signingToken.replace(/^whsec_/, ""), "base64");
  } catch {
    return "mismatch";
  }
  if (key.length === 0) return "mismatch";
  const expected = createHmac("sha256", key).update(`${messageId}.${timestamp}.${body}`).digest();
  for (const candidate of signature.split(" ")) {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) continue;
    const provided = Buffer.from(value, "base64");
    if (provided.length === expected.length && timingSafeEqual(expected, provided)) return "ok";
  }
  return "mismatch";
}

function equalSecrets(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class GitlabWebhookController {
  // The trusted set (numeric user ids: every member of each trusted group plus
  // each trusted username), cached as a promise so concurrent deliveries share
  // one fetch; a rejection clears it, a value expires after TRUSTED_SET_TTL_MS.
  private trustedPromise: Promise<ReadonlySet<number>> | null = null;
  private trustedFetchedAt = 0;

  private readonly mention: RegExp;
  private lastVerifiedAt: number | null = null;

  constructor(
    private inboxService: Pick<InboxService, "enqueueGitlabComment" | "enqueueGitlabCiResult">,
    private intake: Pick<TaskIntake, "findTaskByPrUrl">,
    private readonly settings: GitlabWebhooksConfig,
    private readonly opts: { ciResultEnabled: boolean },
    private readonly now: () => number = Date.now,
  ) {
    this.mention = mentionRegex(settings.botUsername);
  }

  lastWebhookAt(): string | null {
    return this.lastVerifiedAt === null ? null : new Date(this.lastVerifiedAt).toISOString();
  }

  // One info line per rejected delivery: event name, GitLab's delivery id, why.
  private reject(c: Context, reason: string): void {
    logger.info("gitlab_webhook.rejected", {
      event: c.req.header("x-gitlab-event"),
      deliveryId: c.req.header("webhook-id") ?? c.req.header("idempotency-key"),
      reason,
    });
  }

  private getTrusted(): Promise<ReadonlySet<number>> {
    if (this.trustedPromise && this.now() - this.trustedFetchedAt >= TRUSTED_SET_TTL_MS) {
      this.trustedPromise = null;
    }
    if (!this.trustedPromise) {
      this.trustedFetchedAt = this.now();
      this.trustedPromise = (async () => {
        const trusted = new Set<number>();
        for (const group of this.settings.trustedGroups) {
          const members = await fetchGroupMembers(group);
          if (members.size === 0) {
            // A real failure mode (wrong group, a token without access): throw
            // so the next delivery retries instead of caching an empty gate.
            throw new Error(`trusted group member list is empty: ${group}`);
          }
          for (const member of members) trusted.add(member);
        }
        for (const username of this.settings.trustedUsers) {
          const userId = await getUserIdByUsername(username);
          if (userId === null) {
            logger.warn("trusted username did not resolve; ignoring it", { username });
            continue;
          }
          trusted.add(userId);
        }
        if (trusted.size === 0) throw new Error("trusted set is empty");
        return trusted;
      })().catch((err) => {
        this.trustedPromise = null;
        throw err;
      });
    }
    return this.trustedPromise;
  }

  // Signature first when a signing token is configured; the legacy secret
  // token is accepted only when it is configured and the delivery carries no
  // signature (GitLab's documented migration path).
  private verify(c: Context, body: string): boolean {
    const { signingToken, secretToken } = this.settings;
    const signature = c.req.header("webhook-signature");
    if (signingToken && (signature || !secretToken)) {
      return (
        verifyGitlabSignature(
          body,
          {
            id: c.req.header("webhook-id"),
            timestamp: c.req.header("webhook-timestamp"),
            signature,
          },
          signingToken,
          this.now(),
        ) === "ok"
      );
    }
    const provided = c.req.header("x-gitlab-token");
    return Boolean(secretToken && provided && equalSecrets(provided, secretToken));
  }

  async handleWebhook(c: Context): Promise<Response> {
    const body = await c.req.text();
    if (!this.verify(c, body)) {
      this.reject(c, "signature");
      return c.json({ error: "invalid signature" }, 401);
    }
    this.lastVerifiedAt = this.now();

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      logger.warn("gitlab webhook rejected: invalid json", { bodyPreview: body.slice(0, 200) });
      return c.json({ error: "invalid json" }, 400);
    }
    const eventHeader = c.req.header("x-gitlab-event");
    const parsed = parseGitlabEvent(eventHeader, payload, this.mention);
    if (!parsed) return c.json({ status: "ignored" }, 200);

    if (parsed.kind === "comment") {
      // The bot's own notes (its replies, a retry hint that names itself) must
      // not loop back through here.
      if (parsed.userId === this.settings.botUserId) {
        this.reject(c, "self_event");
        return c.json({ status: "ignored", reason: "bot self-event" }, 200);
      }
      // Scope: only merge requests the agent opened itself, before the trust
      // gate and the DB lookup so unrelated activity fans out into nothing.
      if (parsed.mrAuthorId !== this.settings.botUserId) {
        this.reject(c, "not_bot_mr");
        return c.json({ status: "ignored", reason: "merge request not opened by bot" }, 200);
      }
    }

    // Actor-trust gate: the signature proves the delivery came from GitLab;
    // this proves the actor is a member of a trusted group or a trusted user,
    // by immutable numeric id. A failed pipeline on the bot's branch is the
    // bot's own push, so the bot passes for pipelines only.
    const botPipeline = parsed.kind === "pipeline" && parsed.userId === this.settings.botUserId;
    if (!botPipeline) {
      let trusted: ReadonlySet<number>;
      try {
        trusted = await this.getTrusted();
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        logger.error("gitlab webhook 503: trusted set fetch failed", {
          eventHeader,
          message: e.message,
        });
        return c.json({ error: "service unavailable" }, 503);
      }
      if (!parsed.userId || !trusted.has(parsed.userId)) {
        this.reject(c, "not_trusted");
        return c.json({ error: "forbidden" }, 403);
      }
    }

    try {
      if (parsed.kind === "pipeline") {
        if (!this.opts.ciResultEnabled) {
          return c.json({ status: "ignored", reason: "ci_result disabled" }, 200);
        }
        const mrIids =
          parsed.mrIid !== null
            ? [parsed.mrIid]
            : parsed.ref
              ? (await listOpenMergeRequestsForBranch(parsed.project.id, parsed.ref)).map(
                  (m) => m.iid,
                )
              : [];
        for (const mrIid of mrIids) {
          const prUrl = mrWebUrl(parsed.project.webUrl, mrIid);
          const task = await this.intake.findTaskByPrUrl(prUrl);
          if (!task) continue;
          await this.inboxService.enqueueGitlabCiResult({
            task,
            pipelineId: parsed.pipelineId,
            name: parsed.name,
            status: parsed.status,
            url: parsed.url,
            sha: parsed.sha,
            ref: parsed.ref,
            projectId: parsed.project.id,
            project: parsed.project.path,
            mrIid,
            prUrl,
          });
        }
        return c.json({ status: "ok" }, 200);
      }

      const task = await this.intake.findTaskByPrUrl(parsed.mrUrl);
      if (!task) return c.json({ status: "ignored" }, 200);
      await this.inboxService.enqueueGitlabComment({
        task,
        noteId: parsed.noteId,
        body: parsed.body,
        spec: parsed.spec,
        project: parsed.project.path,
        prUrl: parsed.mrUrl,
        createdAt: parsed.createdAt,
      });
      // Fire-and-forget 👀: GitLab answers a repeated award with 404, which the
      // client treats as done, so a redelivery is a no-op.
      void awardNoteEmoji(parsed.project.id, parsed.mrIid, parsed.noteId, "eyes").catch(
        (err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          logger.warn("gitlab award fire-and-forget failed", {
            message: e.message,
            stack: e.stack,
          });
        },
      );
      return c.json({ status: "ok" }, 200);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error("handleGitlabWebhook failed", {
        eventKind: parsed.kind,
        message: e.message,
        stack: e.stack,
      });
      return c.json({ error: "internal" }, 500);
    }
  }
}
