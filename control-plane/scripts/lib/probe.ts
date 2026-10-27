// The unsigned probe of the webhook URL (Linear and GitHub): an empty POST without a
// signature header. devbox with the integration on answers it 401 "invalid signature" before parsing, and
// records nothing. No secret is used.
import type { Fetch } from "../up/preflight";

export type ProbeResult = { ok: true } | { ok: false; message: string };

const ENABLED = {
  Linear: "integrations.linear.enabled",
  GitHub: "integrations.githubApp.enabled",
} as const;

const TIMEOUT_MS = 10_000;
const BODY_LIMIT = 300;

const truncate = (text: string): string =>
  text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…` : text;

export async function probeWebhook(
  publicUrl: string,
  path: "/webhook/linear" | "/webhook/github",
  fetch: Fetch,
  opts: { fromApiIngress: boolean; integration: "Linear" | "GitHub" },
): Promise<ProbeResult> {
  const url = `${publicUrl}${path}`;
  const failed = (what: string): ProbeResult => ({
    ok: false,
    message: `the webhook URL ${url} got ${what}`,
  });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const cause =
      (err as { name?: unknown } | null)?.name === "TimeoutError"
        ? `no answer within ${TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
    const vpn = opts.fromApiIngress
      ? " The URL comes from ingress.api, which may be reachable only over a VPN: enable a public ingress.webhooks in the target file"
      : "";
    return failed(
      `no answer (${cause}): the public URL does not reach devbox. Is the tunnel down, or the Ingress or DNS not ready yet?${vpn}`,
    );
  }
  if (res.status === 404) {
    await res.body?.cancel();
    return failed(
      `404: something answered, but not devbox with ${opts.integration} on. Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that ${ENABLED[opts.integration]} is true and applied, or restart the control plane`,
    );
  }
  const text = (await res.text().catch(() => "")).trim();
  if (res.status === 401 && isInvalidSignature(text)) return { ok: true };
  return failed(`${res.status}: ${truncate(text)}`);
}

function isInvalidSignature(text: string): boolean {
  try {
    return (JSON.parse(text) as { error?: unknown } | null)?.error === "invalid signature";
  } catch {
    return false;
  }
}
