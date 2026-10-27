import { LinearClient, LinearErrorType, parseLinearError } from "@linear/sdk";
import {
  type ClientCredentialsToken,
  type LinearCredentials,
  LinearTokenError,
  requestClientCredentialsToken,
} from "../clients/linearOauth";
import type { logger } from "../logger";

type Logger = typeof logger;

// Renew a cached token once less than this much of its lifetime remains.
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

const NOT_CONFIGURED = "Linear is not configured";

type CachedToken = { token: string; expiresAt: number };

// Is this error from LinearGraphQLClient.request an authentication failure?
// That method throws the raw GraphQLClientError (LinearClient only wraps it with
// parseLinearError afterwards), so the HTTP status sits on `response.status`.
// A LinearError carries it on `status`. Linear also reports an expired or
// revoked token as a GraphQL error of type "authentication error".
function isAuthFailure(err: unknown): boolean {
  const e = err as { status?: unknown; response?: { status?: unknown } } | null;
  if (e?.status === 401 || e?.response?.status === 401) return true;
  return parseLinearError(err as Error).errors?.[0]?.type === LinearErrorType.AuthenticationError;
}

// Holds the control plane's Linear app token (client-credentials grant). It is
// requested on first use, cached in memory, renewed when less than 24h remain,
// and renewed early when Linear rejects it. Construction never calls Linear, so
// a bad secret surfaces through `lastTokenError` instead of failing boot.
export class LinearTokenProvider {
  private readonly creds: LinearCredentials | undefined;
  private readonly requestToken: (c: LinearCredentials) => Promise<ClientCredentialsToken>;
  private readonly now: () => number;
  private readonly apiUrl: string | undefined;
  private readonly log: Pick<Logger, "warn" | "error"> | undefined;

  private cached: CachedToken | null = null;
  // Collapses concurrent token requests into one.
  private inFlight: Promise<string> | null = null;
  private lastError: string | null = null;

  constructor(deps: {
    creds: LinearCredentials | undefined;
    requestToken?: (c: LinearCredentials) => Promise<ClientCredentialsToken>;
    now?: () => number;
    apiUrl?: string;
    log?: Pick<Logger, "warn" | "error">;
  }) {
    this.creds = deps.creds;
    this.requestToken = deps.requestToken ?? ((c) => requestClientCredentialsToken(c));
    this.now = deps.now ?? Date.now;
    this.apiUrl = deps.apiUrl;
    this.log = deps.log;
  }

  // The message of the last failed token request, or null once one succeeds.
  get lastTokenError(): string | null {
    return this.lastError;
  }

  // A valid access token. `force` skips the cache (Linear rejected the token).
  async getAccessToken(force = false): Promise<string> {
    const creds = this.requireCreds();
    if (!force && this.cached && this.cached.expiresAt - this.now() >= RENEW_BEFORE_MS) {
      return this.cached.token;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchToken(creds).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  // A LinearClient that, when Linear answers 401, renews the token and retries
  // the call once. Covers SDK calls (`request`) and raw queries (`rawRequest`).
  async getAuthorizedLinearClient(): Promise<LinearClient> {
    let current = await this.getAccessToken();
    const client = new LinearClient({ accessToken: current, apiUrl: this.apiUrl });
    // LinearClient sends every query through this instance's `request`, read at
    // call time, so wrapping it covers all calls made through the client.
    const gql = client.client;
    const withRetry =
      <A extends unknown[], R>(send: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        // The token this request goes out with; `current` may change while it
        // is in flight if a concurrent call renews first.
        const sent = current;
        try {
          return await send(...args);
        } catch (err) {
          if (!isAuthFailure(err)) throw err;
          current = await this.renewAfterRejection(sent);
          gql.setHeader("Authorization", `Bearer ${current}`);
          this.log?.warn("Linear rejected the access token; retrying with a renewed one");
          return send(...args);
        }
      };
    gql.request = withRetry(gql.request.bind(gql)) as typeof gql.request;
    gql.rawRequest = withRetry(gql.rawRequest.bind(gql)) as typeof gql.rawRequest;
    return client;
  }

  // Another call may already have replaced the rejected token: reuse that one
  // instead of requesting yet another.
  private renewAfterRejection(rejected: string): Promise<string> {
    if (this.cached && this.cached.token !== rejected) return this.getAccessToken();
    return this.getAccessToken(true);
  }

  private requireCreds(): LinearCredentials {
    if (!this.creds) throw new Error(NOT_CONFIGURED);
    return this.creds;
  }

  private async fetchToken(creds: LinearCredentials): Promise<string> {
    try {
      const { accessToken, expiresAt } = await this.requestToken(creds);
      this.cached = { token: accessToken, expiresAt: expiresAt.getTime() };
      this.lastError = null;
      return accessToken;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      const details = err instanceof LinearTokenError ? { status: err.status, code: err.code } : {};
      this.log?.error("Linear token request failed", { reason: this.lastError, ...details });
      throw err;
    }
  }
}
