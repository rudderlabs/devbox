import { missingError, parseSwitch, present } from "../env";

export type ClickUpConfig = {
  // The workspace id: tasks from any other workspace are refused, and the
  // member list (for creators' roles) is read from it.
  teamId: string;
  // The bot account: its user id (to spot assignments, mentions and its own
  // events) and username (people type "@<name>" as a mention, and failure
  // notices name it).
  botUserId: number;
  botName: string;
  // Status names devbox moves a task to; an absent one means no move.
  statuses: { started?: string; done?: string; failed?: string };
  // The bot's personal token (pk_…).
  apiToken: string;
  // HMAC secret for /webhook/clickup (X-Signature), from the webhook's create response.
  webhookSecret: string;
};

const TEAM_ID = /^\d{1,20}$/;
const USER_ID = /^[1-9]\d{0,14}$/;

// ClickUp is on only with CLICKUP_ENABLED=true; then every setting read with
// need() is required, and each value is checked. CLICKUP_STATUS_STARTED,
// CLICKUP_STATUS_DONE and CLICKUP_STATUS_FAILED are optional. With the switch
// off the settings are ignored. Errors never echo a value. No CLICKUP_* name
// is forwarded to sandboxes.
export function parseClickUpConfig(
  env: Record<string, string | undefined>,
): ClickUpConfig | undefined {
  if (!parseSwitch(env, "CLICKUP_ENABLED")) return undefined;
  const missing: string[] = [];
  const need = (name: string): string => {
    const value = present(env, name);
    if (value === undefined) missing.push(name);
    return value ?? "";
  };
  const teamId = need("CLICKUP_TEAM_ID");
  const botUserId = need("CLICKUP_BOT_USER_ID");
  const botName = need("CLICKUP_BOT_NAME");
  const apiToken = need("CLICKUP_API_TOKEN");
  const webhookSecret = need("CLICKUP_WEBHOOK_SECRET");
  if (missing.length > 0) throw missingError("CLICKUP_ENABLED", missing);

  if (!TEAM_ID.test(teamId)) throw new Error("CLICKUP_TEAM_ID must be digits only");
  if (!USER_ID.test(botUserId)) throw new Error("CLICKUP_BOT_USER_ID must be a positive integer");
  return {
    teamId,
    botUserId: Number(botUserId),
    botName,
    statuses: {
      started: present(env, "CLICKUP_STATUS_STARTED"),
      done: present(env, "CLICKUP_STATUS_DONE"),
      failed: present(env, "CLICKUP_STATUS_FAILED"),
    },
    apiToken,
    webhookSecret,
  };
}
