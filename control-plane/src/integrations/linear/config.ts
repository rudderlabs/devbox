import { missingError, parseSwitch, present } from "../env";

export type LinearConfig = {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
};

const LINEAR_NAMES = ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"] as const;

// Linear is on only with LINEAR_ENABLED=true; then all three settings are
// required. With the switch off the settings are ignored. The old
// LINEAR_REDIRECT_URI is no longer read and is ignored.
export function parseLinearConfig(
  env: Record<string, string | undefined>,
): LinearConfig | undefined {
  if (!parseSwitch(env, "LINEAR_ENABLED")) return undefined;
  const values = LINEAR_NAMES.map((name) => present(env, name));
  const missing = LINEAR_NAMES.filter((_, i) => values[i] === undefined);
  if (missing.length > 0) throw missingError("LINEAR_ENABLED", missing);
  const [clientId, clientSecret, webhookSecret] = values as [string, string, string];
  return { clientId, clientSecret, webhookSecret };
}
