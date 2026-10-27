import { afterEach, describe, expect, it, spyOn } from "bun:test";

const { LINEAR_SCOPES, LinearTokenError, requestClientCredentialsToken } = await import(
  "../linearOauth"
);

type Recorded = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_BODY = {
  access_token: "t",
  expires_in: 2591999,
  scope: "app:assignable app:mentionable read write",
  token_type: "Bearer",
};

let nowSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = undefined;
});

describe("requestClientCredentialsToken", () => {
  it("posts the client-credentials grant with the fixed scopes", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, OK_BODY));
    await requestClientCredentialsToken({ clientId: "id", clientSecret: "s" }, fetchImpl);

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [Recorded];
    expect(url).toBe("https://api.linear.app/oauth/token");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "client_credentials",
      client_id: "id",
      client_secret: "s",
      scope: LINEAR_SCOPES,
    });
  });

  it("returns the token and its expiry", async () => {
    const now = 1_760_000_000_000;
    nowSpy = spyOn(Date, "now").mockReturnValue(now);
    const { fetchImpl } = fakeFetch(() => json(200, OK_BODY));

    const token = await requestClientCredentialsToken(
      { clientId: "id", clientSecret: "s" },
      fetchImpl,
    );

    expect(token).toEqual({
      accessToken: "t",
      expiresAt: new Date(now + 2591999000),
      scope: "app:assignable app:mentionable read write",
    });
  });

  it("surfaces the OAuth error code without the body", async () => {
    const secret = "very-secret-client-value";
    const { fetchImpl } = fakeFetch(() =>
      json(401, { error: "invalid_client", error_description: "Invalid client" }),
    );

    const err = await requestClientCredentialsToken(
      { clientId: "id", clientSecret: secret },
      fetchImpl,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LinearTokenError);
    const tokenErr = err as InstanceType<typeof LinearTokenError>;
    expect({
      status: tokenErr.status,
      code: tokenErr.code,
      description: tokenErr.description,
    }).toEqual({ status: 401, code: "invalid_client", description: "Invalid client" });
    expect(tokenErr.message).not.toContain(secret);
  });

  it("wraps network errors", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;

    const err = await requestClientCredentialsToken(
      { clientId: "id", clientSecret: "s" },
      fetchImpl,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LinearTokenError);
    expect((err as Error).message.startsWith("Linear token request failed: ")).toBe(true);
  });
});
