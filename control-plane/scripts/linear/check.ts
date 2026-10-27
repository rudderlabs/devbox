// The Linear check before startup requests a client-credentials token for the
// configured app, then fetches the identity it acts as. Each failure
// names the cause and the next action; the client secret never appears in a
// message.
//
// A Linear app answers "Entity not found: Organization" for a while after it
// is created (about a minute, seen on a new app): the check retries that one
// answer, with a fresh token each time, before it fails.
import { LinearTokenError, requestClientCredentialsToken } from "../../src/clients/linearOauth";
import { CredentialRejected, type Fetch, PreflightError } from "../up/preflight";

export type LinearIdentity = { viewerName: string; workspaceName: string; urlKey: string };

export class LinearCheckError extends PreflightError {}

const GRAPHQL_URL = "https://api.linear.app/graphql";
const QUERY = "{ viewer { name } organization { name urlKey } }";
const UNREACHABLE = "can't reach api.linear.app: check this machine's egress or proxy";
const NEW_APP = /Entity not found: Organization/;
const RETRY_MS = 5_000;
const RETRY_FOR_MS = 60_000;

export type CheckLinearOptions = {
  sleep?: (ms: number) => Promise<void>;
  // Told once, before the first retry.
  log?: (line: string) => void;
};

// Linear's answer while it is still setting up a new app.
class AppNotReady extends LinearCheckError {}

function tokenFailure(err: unknown): Error {
  if (!(err instanceof LinearTokenError)) return err as Error;
  if (err.code === "invalid_client") {
    return new CredentialRejected(
      "Linear rejected the client ID or LINEAR_CLIENT_SECRET (invalid_client): copy them again from the app's page in Linear (Settings → API → Applications)",
    );
  }
  if (err.description?.includes("client_credentials")) {
    return new LinearCheckError(
      "the Linear app does not allow client credentials: turn it on in Linear (Settings → API → Applications → the app)",
    );
  }
  // No status: the request never got an answer.
  if (err.status === undefined) return new LinearCheckError(UNREACHABLE);
  return new LinearCheckError(`Linear check failed: ${err.message}`);
}

type GraphqlAnswer = {
  data?: {
    viewer?: { name?: unknown };
    organization?: { name?: unknown; urlKey?: unknown };
  };
  errors?: Array<{ message?: unknown }>;
};

export async function checkLinear(
  clientId: string,
  clientSecret: string,
  fetch: Fetch,
  opts: CheckLinearOptions = {},
): Promise<LinearIdentity> {
  const sleep = opts.sleep ?? Bun.sleep;
  for (let waited = 0; ; waited += RETRY_MS) {
    try {
      return await checkOnce(clientId, clientSecret, fetch);
    } catch (err) {
      if (!(err instanceof AppNotReady) || waited >= RETRY_FOR_MS) throw err;
      if (waited === 0) {
        opts.log?.(
          `Linear does not know the app's workspace yet, as for a new app: trying again for up to ${RETRY_FOR_MS / 1000} seconds`,
        );
      }
      await sleep(RETRY_MS);
    }
  }
}

async function checkOnce(
  clientId: string,
  clientSecret: string,
  fetch: Fetch,
): Promise<LinearIdentity> {
  let accessToken: string;
  try {
    ({ accessToken } = await requestClientCredentialsToken(
      { clientId, clientSecret },
      fetch as typeof globalThis.fetch,
    ));
  } catch (err) {
    throw tokenFailure(err);
  }

  let res: Response;
  try {
    res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY }),
    });
  } catch {
    throw new LinearCheckError(UNREACHABLE);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new LinearCheckError(`Linear check failed: the identity query returned ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as GraphqlAnswer;
  if (body.errors?.length) {
    const messages = body.errors.map((e) => String(e.message ?? "unknown error")).join("; ");
    const failed = `Linear check failed: the identity query failed: ${messages}`;
    if (NEW_APP.test(messages)) {
      throw new AppNotReady(
        `${failed}. A new Linear app answers this for about a minute: run the command again`,
      );
    }
    throw new LinearCheckError(failed);
  }
  const viewerName = body.data?.viewer?.name;
  const workspaceName = body.data?.organization?.name;
  const urlKey = body.data?.organization?.urlKey;
  if (
    typeof viewerName !== "string" ||
    typeof workspaceName !== "string" ||
    typeof urlKey !== "string"
  ) {
    throw new LinearCheckError(
      "Linear check failed: the identity query's answer has no viewer or organization",
    );
  }
  return { viewerName, workspaceName, urlKey };
}
