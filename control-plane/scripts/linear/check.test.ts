import { describe, expect, it } from "bun:test";
import { CredentialRejected, type Fetch } from "../up/preflight";
import { checkLinear, LinearCheckError } from "./check";

const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";
const SECRET = "s3cret-value";

type Req = { method: string; url: string; headers: Record<string, string>; body: string };
type Answer = [number, unknown] | Error;

function fakeFetch(routes: Record<string, Answer>): { fetch: Fetch; requests: Req[] } {
  const requests: Req[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body ?? ""),
    });
    const route = routes[String(url)];
    if (route instanceof Error) throw route;
    if (!route) return new Response("not routed", { status: 599 });
    return Response.json(route[1], { status: route[0] });
  };
  return { fetch, requests };
}

const tokenOk: Answer = [
  200,
  { access_token: "lin_oauth_tok", token_type: "Bearer", expires_in: 2592000, scope: "read" },
];

async function failure(routes: Record<string, Answer>): Promise<Error> {
  const { fetch } = fakeFetch(routes);
  try {
    await checkLinear("client-1", SECRET, fetch);
  } catch (err) {
    expect((err as Error).message).not.toContain(SECRET);
    return err as Error;
  }
  throw new Error("expected checkLinear to fail");
}

describe("checkLinear", () => {
  it("returns the identity", async () => {
    const { fetch, requests } = fakeFetch({
      [TOKEN_URL]: tokenOk,
      [GRAPHQL_URL]: [
        200,
        {
          data: {
            viewer: { name: "devbox" },
            organization: { name: "Example", urlKey: "example" },
          },
        },
      ],
    });
    expect(await checkLinear("client-1", SECRET, fetch)).toEqual({
      viewerName: "devbox",
      workspaceName: "Example",
      urlKey: "example",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(TOKEN_URL);
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({
      grant_type: "client_credentials",
      client_id: "client-1",
      client_secret: SECRET,
      scope: "read,write,app:assignable,app:mentionable",
    });
    const gql = requests[1];
    expect(gql?.method).toBe("POST");
    expect(gql?.url).toBe(GRAPHQL_URL);
    expect(gql?.headers.authorization).toBe("Bearer lin_oauth_tok");
    expect(gql?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(gql?.body ?? "")).toEqual({
      query: "{ viewer { name } organization { name urlKey } }",
    });
  });

  it("invalid_client is a rejected credential", async () => {
    const err = await failure({
      [TOKEN_URL]: [401, { error: "invalid_client", error_description: "Invalid client" }],
    });
    expect(err).toBeInstanceOf(CredentialRejected);
    expect(err.message).toBe(
      "Linear rejected the client ID or LINEAR_CLIENT_SECRET (invalid_client): copy them again from the app's page in Linear (Settings → API → Applications)",
    );
  });

  it("an app without client credentials is told to turn them on", async () => {
    const err = await failure({
      [TOKEN_URL]: [
        400,
        {
          error: "unauthorized_client",
          error_description: "Client does not support the client_credentials grant type",
        },
      ],
    });
    expect(err).toBeInstanceOf(LinearCheckError);
    expect(err).not.toBeInstanceOf(CredentialRejected);
    expect(err.message).toBe(
      "the Linear app does not allow client credentials: turn it on in Linear (Settings → API → Applications → the app)",
    );
  });

  it("a network error on the token request names the egress", async () => {
    const err = await failure({ [TOKEN_URL]: new TypeError("Unable to connect") });
    expect(err).toBeInstanceOf(LinearCheckError);
    expect(err.message).toBe("can't reach api.linear.app: check this machine's egress or proxy");
  });

  it("a network error on the GraphQL query names the egress", async () => {
    const err = await failure({
      [TOKEN_URL]: tokenOk,
      [GRAPHQL_URL]: new TypeError("Unable to connect"),
    });
    expect(err).toBeInstanceOf(LinearCheckError);
    expect(err.message).toBe("can't reach api.linear.app: check this machine's egress or proxy");
  });

  it("another token failure keeps Linear's code and description", async () => {
    const err = await failure({
      [TOKEN_URL]: [500, { error: "server_error", error_description: "try later" }],
    });
    expect(err).toBeInstanceOf(LinearCheckError);
    expect(err.message).toBe(
      "Linear check failed: Linear token request failed with status 500: server_error (try later)",
    );
  });

  it("a failed GraphQL query gives the status", async () => {
    const err = await failure({ [TOKEN_URL]: tokenOk, [GRAPHQL_URL]: [500, { oops: 1 }] });
    expect(err).toBeInstanceOf(LinearCheckError);
    expect(err.message).toBe("Linear check failed: the identity query returned 500");
  });

  it("GraphQL errors are reported", async () => {
    const err = await failure({
      [TOKEN_URL]: tokenOk,
      [GRAPHQL_URL]: [200, { errors: [{ message: "forbidden" }, { message: "nope" }] }],
    });
    expect(err).toBeInstanceOf(LinearCheckError);
    expect(err.message).toBe("Linear check failed: the identity query failed: forbidden; nope");
  });

  describe("a new app", () => {
    const notReady: Answer = [200, { errors: [{ message: "Entity not found: Organization" }] }];
    const identity: Answer = [
      200,
      {
        data: { viewer: { name: "devbox" }, organization: { name: "Example", urlKey: "example" } },
      },
    ];

    // The GraphQL answers in order; the token request always succeeds.
    function sequence(answers: Answer[]): { fetch: Fetch; tokens: () => number } {
      let tokens = 0;
      const fetch: Fetch = async (url) => {
        if (String(url) === TOKEN_URL) {
          tokens++;
          return Response.json((tokenOk as [number, unknown])[1]);
        }
        const a = answers.shift() ?? notReady;
        if (a instanceof Error) throw a;
        return Response.json(a[1], { status: a[0] });
      };
      return { fetch, tokens: () => tokens };
    }

    it("is asked again, with a new token, until Linear knows its workspace", async () => {
      const { fetch, tokens } = sequence([notReady, notReady, identity]);
      const slept: number[] = [];
      const log: string[] = [];
      const id = await checkLinear("client-1", SECRET, fetch, {
        sleep: async (ms) => void slept.push(ms),
        log: (l) => void log.push(l),
      });
      expect(id.workspaceName).toBe("Example");
      expect(slept).toEqual([5000, 5000]);
      expect(tokens()).toBe(3);
      expect(log).toEqual([
        "Linear does not know the app's workspace yet, as for a new app: trying again for up to 60 seconds",
      ]);
    });

    it("gives up after 60 seconds and says to run the command again", async () => {
      const { fetch } = sequence([]);
      const slept: number[] = [];
      const run = checkLinear("client-1", SECRET, fetch, {
        sleep: async (ms) => void slept.push(ms),
      });
      await expect(run).rejects.toThrow(
        "Linear check failed: the identity query failed: Entity not found: Organization. A new Linear app answers this for about a minute: run the command again",
      );
      await expect(run).rejects.toBeInstanceOf(LinearCheckError);
      expect(slept.reduce((a, b) => a + b, 0)).toBe(60_000);
    });

    it("other GraphQL errors are not retried", async () => {
      const { fetch } = sequence([[200, { errors: [{ message: "Entity not found: Team" }] }]]);
      const slept: number[] = [];
      await expect(
        checkLinear("client-1", SECRET, fetch, { sleep: async (ms) => void slept.push(ms) }),
      ).rejects.toThrow("Linear check failed: the identity query failed: Entity not found: Team");
      expect(slept).toEqual([]);
    });
  });

  it("an answer without the identity is refused", async () => {
    const err = await failure({
      [TOKEN_URL]: tokenOk,
      [GRAPHQL_URL]: [200, { data: { viewer: { name: "devbox" } } }],
    });
    expect(err).toBeInstanceOf(LinearCheckError);
    expect(err.message).toBe(
      "Linear check failed: the identity query's answer has no viewer or organization",
    );
  });
});
