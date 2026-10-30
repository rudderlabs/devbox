import type { LinearClient } from "@linear/sdk";
import { emitAction, emitError, emitResponse, emitThought } from "../../clients/linear";
import type { ReplyTarget } from "../../repositories/inbox.repository";
import { WORKSPACE_MISSING_MESSAGE } from "../../services/inbox.service";
import type { LinearTokenProvider } from "../../services/linearTokenProvider";
import { type Outbound, RetryableError, type SendCtx } from "../outbound";
import type { Integration } from "../types";

// Linear rounds post to the agent session. target.id IS the agent session id
// by construction (the enqueue paths stamp the live session id). The session
// is private to the workspace, so a failure shows its raw detail.
export class LinearIntegration implements Integration {
  readonly name = "linear";

  constructor(
    private linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">,
  ) {}

  async deliver(_ctx: SendCtx, target: ReplyTarget, message: Outbound): Promise<void> {
    if (target.spec.kind !== "linear_session") {
      throw new Error(`linear cannot deliver to a ${target.spec.kind} target`);
    }
    const client = await this.client();
    switch (message.type) {
      case "reply":
        await emitResponse(client, target.id, message.body);
        return;
      case "progress":
        if (message.kind === "thought") await emitThought(client, target.id, message.body);
        // The daemon's body is the full action label (e.g. "Planning",
        // "Addressing comment"). Linear renders `<action> <parameter>`
        // concatenated, so a non-empty parameter appends a noisy suffix
        // ("Addressing comment task"). Pass empty parameter — the body
        // already carries everything the user should see.
        else if (message.kind === "action") await emitAction(client, target.id, message.body, "");
        else await emitError(client, target.id, message.body);
        return;
      case "failure": {
        // task_failed and a failed assignment carry the summary; a crashed
        // comment round carries only the detail.
        const text =
          message.cause === "workspace_missing"
            ? WORKSPACE_MISSING_MESSAGE
            : (message.summary ?? message.detail);
        if (text) await emitError(client, target.id, text);
        return;
      }
    }
  }

  // Nothing has been sent when the token fetch fails, so the caller may retry.
  private async client(): Promise<LinearClient> {
    try {
      return await this.linearTokenProvider.getAuthorizedLinearClient();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RetryableError(`Linear token fetch failed: ${msg}`);
    }
  }
}
