import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { appJwt } from "../jwt";
import { GithubAppError, githubAppFetch, mintInstallationToken } from "../mint";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const NOW = new Date("2026-10-19T12:00:00Z");
const TOKEN = "ghs_secretInstallationToken0123456789";

type Recorded = { url: string; method?: string; headers: Record<string, string>; body?: string };

function fakeFetch(status: number, body: unknown) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body as string | undefined,
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const ok = { token: TOKEN, expires_at: "2026-10-19T13:00:00Z" };
const mint = (fetch: ReturnType<typeof fakeFetch>["fetch"], repositories?: string[]) =>
  mintInstallationToken({
    appId: 123,
    installationId: 456,
    privateKeyPem: privateKey,
    repositories,
    fetch,
    apiBase: "https://api.github.com",
    now: () => NOW,
  });

describe("mintInstallationToken", () => {
  it("POSTs to the installation's access_tokens with the App JWT", async () => {
    const f = fakeFetch(201, ok);
    expect(await mint(f.fetch, ["a", "b"])).toEqual({
      token: TOKEN,
      expiresAt: "2026-10-19T13:00:00Z",
    });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0] as Recorded;
    expect(call.url).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(call.method).toBe("POST");
    expect(call.headers).toEqual({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt(123, privateKey, NOW)}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    });
    expect(JSON.parse(call.body as string)).toEqual({ repositories: ["a", "b"] });
  });

  it("sends {} when repositories is omitted or empty", async () => {
    for (const repositories of [undefined, []]) {
      const f = fakeFetch(201, ok);
      await mint(f.fetch, repositories);
      expect(JSON.parse(f.calls[0]?.body as string)).toEqual({});
    }
  });

  for (const status of [401, 404, 422]) {
    it(`throws GithubAppError on ${status} without leaking credentials`, async () => {
      const f = fakeFetch(status, { message: `nope ${status}`, documentation_url: "x" });
      const err = await mint(f.fetch, ["a"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GithubAppError);
      const e = err as GithubAppError;
      expect(e.status).toBe(status);
      expect(e.message).toBe(
        `GitHub POST /app/installations/456/access_tokens: HTTP ${status}: nope ${status}`,
      );
      const jwt = appJwt(123, privateKey, NOW);
      for (const secret of [privateKey, jwt, TOKEN]) {
        expect(e.message).not.toContain(secret);
        expect(e.body).not.toContain(secret);
      }
    });
  }

  it("rejects a 2xx without token or expires_at", async () => {
    const f = fakeFetch(201, { token: TOKEN });
    const err = (await mint(f.fetch).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("GitHub token response is missing token or expires_at");
  });
});

describe("mintInstallationToken expiry", () => {
  it("rejects an unparseable expires_at", async () => {
    const f = fakeFetch(201, { token: TOKEN, expires_at: "soon" });
    const err = (await mint(f.fetch).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('GitHub token response has an invalid expires_at: "soon"');
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("githubAppFetch", () => {
  it("times out a call that never answers", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const err = (await githubAppFetch(
      "/app/installations/456/access_tokens",
      { method: "POST", jwt: "j" },
      { fetch: hang, apiBase: "https://api.github.com", timeoutMs: 20 },
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(
      "GitHub POST /app/installations/456/access_tokens: timed out after 0.02 s",
    );
  });

  it("passes a 30 s abort signal by default", async () => {
    let signal: AbortSignal | null | undefined;
    await githubAppFetch(
      "/app",
      { method: "GET", jwt: "j" },
      {
        fetch: async (_url, init) => {
          signal = init?.signal;
          return new Response("{}");
        },
        apiBase: "https://api.github.com",
      },
    );
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("calls a jwt signer on each request", async () => {
    const f = fakeFetch(200, { id: 1 });
    let n = 0;
    const jwt = () => `jwt-${++n}`;
    const deps = { fetch: f.fetch, apiBase: "https://gh.example.com" };
    expect(await githubAppFetch("/app", { method: "GET", jwt }, deps)).toEqual({ id: 1 });
    await githubAppFetch("/app", { method: "GET", jwt }, deps);
    expect(f.calls.map((c) => c.headers.authorization)).toEqual(["Bearer jwt-1", "Bearer jwt-2"]);
    expect(f.calls[0]?.url).toBe("https://gh.example.com/app");
    expect(f.calls[0]?.body).toBeUndefined();
  });

  it("uses a token as the bearer and returns null for an empty body", async () => {
    const f = fakeFetch(204, "");
    const out = await githubAppFetch(
      "/installation/repositories",
      { method: "DELETE", token: "t" },
      { fetch: f.fetch, apiBase: "https://api.github.com" },
    );
    expect(out).toBeNull();
    expect(f.calls[0]?.headers.authorization).toBe("Bearer t");
  });

  it("truncates GitHub's message to 300 characters and keeps a non-JSON body", async () => {
    const long = "x".repeat(400);
    const f = fakeFetch(500, long);
    const err = (await githubAppFetch(
      "/app",
      { method: "GET", jwt: "j" },
      { fetch: f.fetch, apiBase: "https://api.github.com" },
    ).catch((e: unknown) => e)) as GithubAppError;
    expect(err.status).toBe(500);
    expect(err.message).toBe(`GitHub GET /app: HTTP 500: ${"x".repeat(300)}`);
    expect(err.reason).toBe("x".repeat(300));
  });
});
