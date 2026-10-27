export type AgentSessionCreated = {
  action: "created";
  agentSessionId: string;
  issue: {
    id: string;
    title: string;
    description: string;
    url: string;
  };
};

export type AgentSessionPrompted = {
  action: "prompted";
  agentSessionId: string;
  activityBody: string;
  issue: { id: string };
  // The agent-activity id (agentActivity.id) — idempotency key for the prompted
  // webhook, stored as the inbox row's externalId.
  activityId: string;
};

// Linear cancel button → `prompted` event with `agentActivity.signal === "stop"`.
// We don't support cancellation yet; surface a message back to the user instead
// of letting the "stop" body land in the inbox as a comment.
export type AgentSessionStopRequested = {
  action: "stop_requested";
  agentSessionId: string;
};

export type ParsedAgentSessionEvent =
  | AgentSessionCreated
  | AgentSessionPrompted
  | AgentSessionStopRequested;

export type HandleAgentSessionResult = { status: "ok" } | { status: "session_not_found" };
