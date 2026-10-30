import { TokenFetchError } from "../integrations/http";

// ── Client-credentials token ─────────────────────────────────────────────────
// The exports in this section are pure: they never read `config`.

// Fixed scopes requested with every client-credentials token.
export const LINEAR_SCOPES = "read,write,app:assignable,app:mentionable";

const TOKEN_URL = "https://api.linear.app/oauth/token";
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export type LinearCredentials = { clientId: string; clientSecret: string };

export type ClientCredentialsToken = { accessToken: string; expiresAt: Date; scope: string };

// A failed token request. `code` and `description` are the OAuth `error` and
// `error_description` fields; the response body is never kept otherwise. A
// TokenFetchError: nothing was sent with the missing token, so a send may retry.
export class LinearTokenError extends TokenFetchError {
  status?: number;
  code?: string;
  description?: string;

  constructor(
    message: string,
    details: { status?: number; code?: string; description?: string } = {},
  ) {
    super(message);
    this.name = "LinearTokenError";
    this.status = details.status;
    this.code = details.code;
    this.description = details.description;
  }
}

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export async function requestClientCredentialsToken(
  creds: LinearCredentials,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ClientCredentialsToken> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: LINEAR_SCOPES,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    throw new LinearTokenError(`Linear token request failed: ${msg}`);
  }

  const body = await readJson(res);
  if (!res.ok) {
    const code = stringField(body, "error");
    const description = stringField(body, "error_description");
    const detail = code ? `: ${code}${description ? ` (${description})` : ""}` : "";
    throw new LinearTokenError(`Linear token request failed with status ${res.status}${detail}`, {
      status: res.status,
      code,
      description,
    });
  }

  const accessToken = stringField(body, "access_token");
  const expiresIn = (body as { expires_in?: unknown } | undefined)?.expires_in;
  if (!accessToken || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new LinearTokenError("Linear token response is missing access_token or expires_in", {
      status: res.status,
    });
  }
  return {
    accessToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scope: stringField(body, "scope") ?? "",
  };
}
