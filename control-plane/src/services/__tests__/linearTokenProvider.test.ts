import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ClientCredentialsToken, LinearCredentials } from "../../clients/linearOauth";

const { LinearTokenError } = await import("../../clients/linearOauth");
const { LinearTokenProvider } = await import("../linearTokenProvider");

const CREDS: LinearCredentials = { clientId: "id", clientSecret: "s" };
const NOW = 1_760_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function tokens(...items: Array<{ accessToken: string; expiresAt: number }>) {
  const queue = [...items];
  return mock(async (_c: LinearCredentials): Promise<ClientCredentialsToken> => {
    const next = queue.shift();
    if (!next) throw new Error("no more tokens");
    return { accessToken: next.accessToken, expiresAt: new Date(next.expiresAt), scope: "" };
  });
}

const silentLog = { warn: () => {}, error: () => {} };

function unauthorized(): Response {
  return Response.json(
    {
      errors: [
        { message: "Authentication required", extensions: { type: "authentication error" } },
      ],
    },
    { status: 401 },
  );
}

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("LinearTokenProvider", () => {
  it("requests a token on first use and reuses it", async () => {
    const requestToken = tokens({ accessToken: "t1", expiresAt: NOW + 30 * DAY_MS });
    const p = new LinearTokenProvider({
      creds: CREDS,
      requestToken,
      now: () => NOW,
      log: silentLog,
    });

    expect(await p.getAccessToken()).toBe("t1");
    expect(await p.getAccessToken()).toBe("t1");
    expect(requestToken).toHaveBeenCalledTimes(1);
    expect(requestToken.mock.calls[0]).toEqual([CREDS]);
  });

  it("renews when less than 24h remain", async () => {
    const requestToken = tokens(
      { accessToken: "t1", expiresAt: NOW + DAY_MS - 1 },
      { accessToken: "t2", expiresAt: NOW + 30 * DAY_MS },
    );
    const p = new LinearTokenProvider({
      creds: CREDS,
      requestToken,
      now: () => NOW,
      log: silentLog,
    });

    expect(await p.getAccessToken()).toBe("t1");
    expect(await p.getAccessToken()).toBe("t2");
    expect(requestToken).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent requests", async () => {
    const requestToken = tokens({ accessToken: "t1", expiresAt: NOW + 30 * DAY_MS });
    const p = new LinearTokenProvider({
      creds: CREDS,
      requestToken,
      now: () => NOW,
      log: silentLog,
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => p.getAccessToken()));

    expect(results).toEqual(["t1", "t1", "t1", "t1", "t1"]);
    expect(requestToken).toHaveBeenCalledTimes(1);
  });

  it("keeps the last error and does not throw at construction", async () => {
    let fail = true;
    const requestToken = mock(async (): Promise<ClientCredentialsToken> => {
      if (fail) throw new LinearTokenError("x");
      return { accessToken: "t1", expiresAt: new Date(NOW + 30 * DAY_MS), scope: "" };
    });
    const p = new LinearTokenProvider({
      creds: CREDS,
      requestToken,
      now: () => NOW,
      log: silentLog,
    });
    expect(p.lastTokenError).toBeNull();

    await expect(p.getAccessToken()).rejects.toThrow("x");
    expect(p.lastTokenError).toBe("x");

    fail = false;
    expect(await p.getAccessToken()).toBe("t1");
    expect(p.lastTokenError).toBeNull();
  });

  it("retries a Linear call once after a 401", async () => {
    const seen: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const auth = req.headers.get("authorization") ?? "";
        seen.push(auth);
        if (auth === "Bearer t2") return Response.json({ data: { viewer: { id: "u1" } } });
        return Response.json(
          {
            errors: [
              {
                message: "Authentication required",
                extensions: { type: "authentication error" },
              },
            ],
          },
          { status: 401 },
        );
      },
    });
    const requestToken = tokens(
      { accessToken: "t1", expiresAt: NOW + 30 * DAY_MS },
      { accessToken: "t2", expiresAt: NOW + 30 * DAY_MS },
    );
    const p = new LinearTokenProvider({
      creds: CREDS,
      requestToken,
      now: () => NOW,
      apiUrl: `http://localhost:${server.port}/graphql`,
      log: silentLog,
    });

    const viewer = await (await p.getAuthorizedLinearClient()).viewer;

    expect(viewer.id).toBe("u1");
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("passes a second 401 through without another retry", async () => {
    const seen: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("authorization") ?? "");
        return unauthorized();
      },
    });
    const requestToken = tokens(
      { accessToken: "t1", expiresAt: NOW + 30 * DAY_MS },
      { accessToken: "t2", expiresAt: NOW + 30 * DAY_MS },
    );
    const p = new LinearTokenProvider({
      creds: CREDS,
      requestToken,
      now: () => NOW,
      apiUrl: `http://localhost:${server.port}/graphql`,
      log: silentLog,
    });

    const client = await p.getAuthorizedLinearClient();

    await expect(client.viewer).rejects.toThrow();
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("reuses a token another call already renewed when a late 401 arrives", async () => {
    // Two calls go out with t1. The first 401 comes back at once and its retry
    // renews to t2; the second 401 is held until t2 has been used, so it lands
    // after the renewal. It must retry with t2, not request a third token.
    const seen: string[] = [];
    let t1Count = 0;
    let t2Seen: () => void = () => {};
    const t2Used = new Promise<void>((resolve) => {
      t2Seen = resolve;
    });
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const auth = req.headers.get("authorization") ?? "";
        seen.push(auth);
        if (auth === "Bearer t1") {
          t1Count += 1;
          if (t1Count === 2) await t2Used;
          return unauthorized();
        }
        t2Seen();
        return Response.json({ data: { viewer: { id: "u1" } } });
      },
    });
    const requestToken = tokens(
      { accessToken: "t1", expiresAt: NOW + 30 * DAY_MS },
      { accessToken: "t2", expiresAt: NOW + 30 * DAY_MS },
      { accessToken: "t3", expiresAt: NOW + 30 * DAY_MS },
    );
    const p = new LinearTokenProvider({
      creds: CREDS,
      requestToken,
      now: () => NOW,
      apiUrl: `http://localhost:${server.port}/graphql`,
      log: silentLog,
    });
    const client = await p.getAuthorizedLinearClient();

    const [a, b] = await Promise.all([client.viewer, client.viewer]);

    expect([a.id, b.id]).toEqual(["u1", "u1"]);
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["Bearer t1", "Bearer t1", "Bearer t2", "Bearer t2"]);
  });

  it("retries a raw request once after a 401", async () => {
    const seen: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const auth = req.headers.get("authorization") ?? "";
        seen.push(auth);
        if (auth === "Bearer t2") return Response.json({ data: { viewer: { id: "u1" } } });
        return unauthorized();
      },
    });
    const requestToken = tokens(
      { accessToken: "t1", expiresAt: NOW + 30 * DAY_MS },
      { accessToken: "t2", expiresAt: NOW + 30 * DAY_MS },
    );
    const p = new LinearTokenProvider({
      creds: CREDS,
      requestToken,
      now: () => NOW,
      apiUrl: `http://localhost:${server.port}/graphql`,
      log: silentLog,
    });

    const client = await p.getAuthorizedLinearClient();
    const { data } = await client.client.rawRequest<
      { viewer: { id: string } },
      Record<string, never>
    >("query { viewer { id } }");

    expect(data).toEqual({ viewer: { id: "u1" } });
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("throws when Linear is not configured", async () => {
    const requestToken = tokens();
    const p = new LinearTokenProvider({ creds: undefined, requestToken, log: silentLog });

    await expect(p.getAccessToken()).rejects.toThrow("Linear is not configured");
    await expect(p.getAuthorizedLinearClient()).rejects.toThrow("Linear is not configured");
    expect(requestToken).not.toHaveBeenCalled();
  });
});
