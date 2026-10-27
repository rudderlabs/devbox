import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAppError } from "../../src/githubToken/mint";
import { parseConfig } from "../up/config";
import {
  appIdentity,
  appSettingsUrl,
  callWithAppKey,
  checkCoverage,
  coverageMessage,
  GithubAppSetupError,
  installationSettingsUrl,
  mintAppToken,
  missingKeyMessage,
  readTokenFile,
  savedKeyFix,
  verifyApp,
} from "./githubApp";
import { PrivateKeyError } from "./githubAppKey";

const { privateKey: pem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const app = {
  enabled: true as const,
  appId: 123,
  slug: "example-devbox",
  installationId: 456,
  botUserId: 789,
  tokens: "devbox" as const,
  tokenScope: "repos" as const,
  ciResults: true,
};

const repos = parseConfig({
  repos: [
    { url: "https://github.com/example-org/a.git" },
    { url: "https://github.com/example-org/b.git" },
    { url: "https://github.com/example-org/c.git" },
  ],
  llm: { baseUrl: "https://llm.example.com/v1", model: "m1" },
}).repos;

type Req = { method: string; url: string; authorization: string | null };

function fakeFetch(routes: Record<string, [number, unknown]>) {
  const requests: Req[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const route = routes[`${method} ${url}`];
    if (!route) return new Response("not routed", { status: 599 });
    return Response.json(route[1], { status: route[0] });
  };
  return { fetch, requests };
}

describe("appIdentity", () => {
  it("is the App's bot, with its noreply address", () => {
    expect(appIdentity("example-devbox", 789)).toEqual({
      gitName: "example-devbox[bot]",
      gitEmail: "789+example-devbox[bot]@users.noreply.github.com",
    });
  });
});

describe("installationSettingsUrl", () => {
  it("is the organization's installation page for an organization account", () => {
    expect(installationSettingsUrl(app, { login: "example-org", type: "Organization" })).toBe(
      "https://github.com/organizations/example-org/settings/installations/456",
    );
  });

  it("is the user's installation page for a user account", () => {
    expect(installationSettingsUrl(app, { login: "octo", type: "User" })).toBe(
      "https://github.com/settings/installations/456",
    );
  });

  it("without the account, is the App's page listing where it is installed", () => {
    expect(installationSettingsUrl(app)).toBe(
      "https://github.com/apps/example-devbox/installations/new",
    );
  });
});

describe("checkCoverage", () => {
  const api = "https://api.github.com";

  it("returns the repos the installation does not cover: 404, or another installation", async () => {
    const f = fakeFetch({
      [`GET ${api}/repos/example-org/a/installation`]: [200, { id: 456 }],
      [`GET ${api}/repos/example-org/b/installation`]: [404, { message: "Not Found" }],
      [`GET ${api}/repos/example-org/c/installation`]: [200, { id: 999 }],
    });
    expect(await checkCoverage(app, pem, repos, f.fetch)).toEqual([
      "example-org/b",
      "example-org/c",
    ]);
    expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${api}/repos/example-org/a/installation`,
      `GET ${api}/repos/example-org/b/installation`,
      `GET ${api}/repos/example-org/c/installation`,
    ]);
    // Each call carries a freshly signed App JWT, never an installation token.
    for (const r of f.requests)
      expect(r.authorization).toMatch(/^Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("one covered repo and one 404", async () => {
    const f = fakeFetch({
      [`GET ${api}/repos/example-org/a/installation`]: [200, { id: 456 }],
      [`GET ${api}/repos/example-org/b/installation`]: [404, { message: "Not Found" }],
    });
    expect(await checkCoverage(app, pem, repos.slice(0, 2), f.fetch)).toEqual(["example-org/b"]);
  });

  it("an empty list when every repo is covered", async () => {
    const f = fakeFetch({
      [`GET ${api}/repos/example-org/a/installation`]: [200, { id: 456 }],
    });
    expect(await checkCoverage(app, pem, repos.slice(0, 1), f.fetch)).toEqual([]);
  });

  it("throws GitHub's other refusals", async () => {
    const f = fakeFetch({
      [`GET ${api}/repos/example-org/a/installation`]: [
        401,
        { message: "A JSON web token could not be decoded" },
      ],
    });
    const err = await checkCoverage(app, pem, repos.slice(0, 1), f.fetch).catch((e) => e);
    expect(err).toBeInstanceOf(GithubAppError);
    expect((err as GithubAppError).status).toBe(401);
  });
});

describe("coverageMessage", () => {
  it("names the repos and where to add them", () => {
    expect(coverageMessage(["example-org/b", "example-org/c"], "https://github.com/x")).toBe(
      'These repos are not in the GitHub App\'s installation: example-org/b, example-org/c. Add them at https://github.com/x, or run with tokenScope "installation"',
    );
  });
});

describe("callWithAppKey", () => {
  const rejected = new GithubAppError(
    "GET",
    "/repos/example-org/a/installation",
    401,
    JSON.stringify({ message: "'Expiration time' claim ('exp') is too far in the future" }),
  );

  it("returns the call's result", async () => {
    expect(await callWithAppKey(async () => 7)).toBe(7);
  });

  it("a 401 stops the run naming the clock, the App id and how to replace the key", async () => {
    const err = await callWithAppKey(async () => {
      throw rejected;
    }).catch((e) => e);
    expect(err).toEqual(
      new PrivateKeyError(
        "GitHub rejected the App's credentials: 'Expiration time' claim ('exp') is too far in the future. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, run bun run secrets rm GITHUB_APP_PRIVATE_KEY, then bun run github:setup.",
      ),
    );
  });

  it("names the target file for a Kubernetes deployment", async () => {
    const err = await callWithAppKey(async () => {
      throw rejected;
    }, savedKeyFix("devbox.k8s.json")).catch((e) => e);
    expect(err).toEqual(
      new PrivateKeyError(
        "GitHub rejected the App's credentials: 'Expiration time' claim ('exp') is too far in the future. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, run bun run secrets rm GITHUB_APP_PRIVATE_KEY --target devbox.k8s.json, then bun run github:setup --target devbox.k8s.json.",
      ),
    );
  });

  it("says how to fix the key where it came from", async () => {
    const err = await callWithAppKey(async () => {
      throw rejected;
    }, 'put the right key in Secret "my-app-key" (key private-key).').catch((e) => e);
    expect(err).toEqual(
      new PrivateKeyError(
        "GitHub rejected the App's credentials: 'Expiration time' claim ('exp') is too far in the future. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, put the right key in Secret \"my-app-key\" (key private-key).",
      ),
    );
  });

  it("other errors pass through", async () => {
    const notFound = new GithubAppError("POST", "/app/installations/456/access_tokens", 404, "{}");
    const err = await callWithAppKey(async () => {
      throw notFound;
    }).catch((e) => e);
    expect(err).toBe(notFound);
  });
});

describe("missingKeyMessage", () => {
  it("names the key's env forms and github:setup, with the target file on Kubernetes", () => {
    expect(missingKeyMessage()).toBe(
      "No private key for the GitHub App: set GITHUB_APP_PRIVATE_KEY_FILE to its path, or run bun run github:setup",
    );
    expect(missingKeyMessage("devbox.k8s.json")).toBe(
      "No private key for the GitHub App: set GITHUB_APP_PRIVATE_KEY_FILE to its path, or run bun run github:setup --target devbox.k8s.json",
    );
  });
});

describe("verifyApp", () => {
  const APP = "GET https://api.github.com/app";

  it("passes when the App id names the configured slug, signed with the App's JWT", async () => {
    const f = fakeFetch({ [APP]: [200, { id: 123, slug: "example-devbox" }] });
    await verifyApp(app, pem, f.fetch);
    expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([APP]);
    expect(f.requests[0]?.authorization).toMatch(/^Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("a 401 is the rejected-credentials message, naming the target file on Kubernetes", async () => {
    const f = fakeFetch({ [APP]: [401, { message: "Bad credentials" }] });
    expect(
      await verifyApp(app, pem, f.fetch, { target: "devbox.k8s.json" }).catch((e) => e),
    ).toEqual(
      new PrivateKeyError(
        "GitHub rejected the App's credentials: Bad credentials. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, run bun run secrets rm GITHUB_APP_PRIVATE_KEY --target devbox.k8s.json, then bun run github:setup --target devbox.k8s.json.",
      ),
    );
  });

  it("a 404 means no App has that id", async () => {
    const f = fakeFetch({ [APP]: [404, { message: "Integration not found" }] });
    expect(await verifyApp(app, pem, f.fetch).catch((e) => e)).toEqual(
      new GithubAppSetupError(
        "GitHub has no App with id 123: check integrations.githubApp.appId (the App's settings page shows its App ID)",
      ),
    );
  });

  it("another App's slug means the settings belong to another App", async () => {
    const f = fakeFetch({ [APP]: [200, { id: 123, slug: "other-devbox" }] });
    expect(await verifyApp(app, pem, f.fetch).catch((e) => e)).toEqual(
      new GithubAppSetupError(
        'integrations.githubApp.slug is "example-devbox" but App 123 is "other-devbox": run bun run github:setup',
      ),
    );
    expect(
      await verifyApp(app, pem, f.fetch, { target: "devbox.k8s.json" }).catch((e) => e),
    ).toEqual(
      new GithubAppSetupError(
        'integrations.githubApp.slug is "example-devbox" but App 123 is "other-devbox": run bun run github:setup --target devbox.k8s.json',
      ),
    );
  });

  it("returns the App's slug, page and owner", async () => {
    const f = fakeFetch({
      [APP]: [
        200,
        {
          id: 123,
          slug: "example-devbox",
          html_url: "https://github.com/apps/example-devbox",
          owner: { login: "example-org", type: "Organization", id: 9 },
        },
      ],
    });
    expect(await verifyApp(app, pem, f.fetch)).toEqual({
      slug: "example-devbox",
      htmlUrl: "https://github.com/apps/example-devbox",
      owner: { login: "example-org", type: "Organization" },
    });
  });

  it("without a configured slug (adopting an App): takes GitHub's", async () => {
    const f = fakeFetch({ [APP]: [200, { id: 123, slug: "example-devbox" }] });
    expect(await verifyApp({ appId: 123 }, pem, f.fetch)).toEqual({
      slug: "example-devbox",
      htmlUrl: "https://github.com/apps/example-devbox",
    });
    const none = fakeFetch({ [APP]: [200, { id: 123 }] });
    expect(await verifyApp({ appId: 123 }, pem, none.fetch).catch((e) => e)).toEqual(
      new GithubAppSetupError("GitHub's answer for App 123 names no slug"),
    );
  });

  it("a 404 with a message of the caller's own", async () => {
    const f = fakeFetch({ [APP]: [404, { message: "Integration not found" }] });
    expect(
      await verifyApp({ appId: 123 }, pem, f.fetch, { notFound: "no such App" }).catch((e) => e),
    ).toEqual(new GithubAppSetupError("no such App"));
  });

  it("a 401 with a message of the caller's own", async () => {
    const f = fakeFetch({ [APP]: [401, { message: "Bad credentials" }] });
    expect(
      await verifyApp({ appId: 123 }, pem, f.fetch, {
        rejected: (reason) => `GitHub rejected the key for App 123: ${reason}`,
      }).catch((e) => e),
    ).toEqual(new PrivateKeyError("GitHub rejected the key for App 123: Bad credentials"));
  });

  it("an answer without a slug says so", async () => {
    const f = fakeFetch({ [APP]: [200, { id: 123 }] });
    expect(await verifyApp(app, pem, f.fetch).catch((e) => e)).toEqual(
      new GithubAppSetupError(
        'integrations.githubApp.slug is "example-devbox" but GitHub\'s answer for App 123 names no slug: run bun run github:setup',
      ),
    );
  });
});

describe("appSettingsUrl", () => {
  it("a user's App and an organization's", () => {
    expect(appSettingsUrl("example-devbox")).toBe(
      "https://github.com/settings/apps/example-devbox",
    );
    expect(appSettingsUrl("example-devbox", { login: "example-user", type: "User" })).toBe(
      "https://github.com/settings/apps/example-devbox",
    );
    expect(appSettingsUrl("example-devbox", { login: "example-org", type: "Organization" })).toBe(
      "https://github.com/organizations/example-org/settings/apps/example-devbox",
    );
  });
});

describe("mintAppToken", () => {
  const api = "https://api.github.com";
  const GET_APP = `GET ${api}/app`;
  const APP_OK: [number, unknown] = [200, { id: 123, slug: "example-devbox" }];
  const COVER_A = `GET ${api}/repos/example-org/a/installation`;
  const MINT = `POST ${api}/app/installations/456/access_tokens`;
  const minted = { token: "ghs_minted", expires_at: "2026-10-19T13:00:00Z" };
  const one = repos.slice(0, 1);
  const calls = (f: ReturnType<typeof fakeFetch>) => f.requests.map((r) => `${r.method} ${r.url}`);

  it("checks coverage, then mints a token narrowed to the repos' names", async () => {
    const f = fakeFetch({
      [GET_APP]: APP_OK,
      [COVER_A]: [200, { id: 456 }],
      [MINT]: [201, minted],
    });
    expect(await mintAppToken(app, pem, one, { fetch: f.fetch, checkCoverage: true })).toEqual({
      token: "ghs_minted",
      expiresAt: "2026-10-19T13:00:00Z",
    });
    expect(calls(f)).toEqual([GET_APP, COVER_A, MINT]);
  });

  it("without the coverage check only mints", async () => {
    const f = fakeFetch({ [GET_APP]: APP_OK, [MINT]: [201, minted] });
    await mintAppToken(app, pem, one, { fetch: f.fetch, checkCoverage: false });
    expect(calls(f)).toEqual([GET_APP, MINT]);
  });

  it("refuses repos outside the installation before minting", async () => {
    const f = fakeFetch({
      [GET_APP]: APP_OK,
      [COVER_A]: [404, { message: "Not Found" }],
      [`GET ${api}/app/installations/456`]: [200, { account: { login: "octo", type: "User" } }],
    });
    const err = await mintAppToken(app, pem, one, { fetch: f.fetch, checkCoverage: true }).catch(
      (e) => e,
    );
    expect(err).toEqual(
      new GithubAppSetupError(
        'These repos are not in the GitHub App\'s installation: example-org/a. Add them at https://github.com/settings/installations/456, or run with tokenScope "installation"',
      ),
    );
    expect(calls(f)).toEqual([GET_APP, COVER_A, `GET ${api}/app/installations/456`]);
  });

  it("a 401 names the target file; other refusals name the call", async () => {
    const rejected = fakeFetch({
      [GET_APP]: APP_OK,
      [MINT]: [401, { message: "Bad credentials" }],
    });
    const err = await mintAppToken(app, pem, one, {
      fetch: rejected.fetch,
      checkCoverage: false,
      target: "devbox.k8s.json",
    }).catch((e) => e);
    expect(err).toEqual(
      new PrivateKeyError(
        "GitHub rejected the App's credentials: Bad credentials. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, run bun run secrets rm GITHUB_APP_PRIVATE_KEY --target devbox.k8s.json, then bun run github:setup --target devbox.k8s.json.",
      ),
    );
    const gone = fakeFetch({ [GET_APP]: APP_OK, [MINT]: [404, { message: "Not Found" }] });
    const err2 = await mintAppToken(app, pem, one, {
      fetch: gone.fetch,
      checkCoverage: false,
    }).catch((e) => e);
    expect(err2).toEqual(
      new GithubAppSetupError(
        "minting a GitHub App token failed: GitHub POST /app/installations/456/access_tokens: HTTP 404: Not Found",
      ),
    );
  });

  it("a wrong App id stops before the coverage check and the mint", async () => {
    const f = fakeFetch({ [GET_APP]: [404, { message: "Integration not found" }] });
    const err = await mintAppToken(app, pem, one, { fetch: f.fetch, checkCoverage: true }).catch(
      (e) => e,
    );
    expect(err).toEqual(
      new GithubAppSetupError(
        "GitHub has no App with id 123: check integrations.githubApp.appId (the App's settings page shows its App ID)",
      ),
    );
    expect(calls(f)).toEqual([GET_APP]);
  });

  it("tokenScope installation does not narrow", async () => {
    const f = fakeFetch({ [GET_APP]: APP_OK, [MINT]: [201, minted] });
    let body: unknown;
    const fetch = async (url: string, init?: RequestInit) => {
      if (init?.body) body = JSON.parse(String(init.body));
      return f.fetch(url, init);
    };
    await mintAppToken({ ...app, tokenScope: "installation" }, pem, one, {
      fetch,
      checkCoverage: false,
    });
    expect(body).toEqual({});
    await mintAppToken(app, pem, one, { fetch, checkCoverage: false });
    expect(body).toEqual({ repositories: ["a"] });
  });
});

describe("readTokenFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "devbox-token-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the token, trimmed", () => {
    const p = join(dir, "token");
    writeFileSync(p, "ghs_abc\n");
    expect(readTokenFile(p)).toBe("ghs_abc");
  });

  it("names the setting and the path when the file is missing, a directory or empty", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const empty = join(dir, "empty");
    writeFileSync(empty, " \n");
    expect(() => readTokenFile(join(dir, "missing"))).toThrow(
      new GithubAppSetupError(
        `integrations.githubApp.tokenFile ${join(dir, "missing")}: not found`,
      ),
    );
    expect(() => readTokenFile(sub)).toThrow(
      new GithubAppSetupError(`integrations.githubApp.tokenFile ${sub}: is a directory`),
    );
    expect(() => readTokenFile(empty)).toThrow(
      new GithubAppSetupError(`integrations.githubApp.tokenFile ${empty}: is empty`),
    );
  });
});
